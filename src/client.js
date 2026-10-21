/* Browser entry, deliberately dependency-free apart from DSH's shared React. */
window.__ModuleLoader__.load({
  id: 'dsh-cache-helper',
  factory(require) {
    'use strict';
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;
    const API = '/dsh-cache-helper/api';
    const POLL_MS = 1500;
    const records = new Map();
    const modalStack = [];
    const WARNING_FILTER_KEY = 'dsh-cache-helper.only-warnings.v1';
    const warningFilterListeners = new Set();
    let onlyWarningsFilter = false;
    try { onlyWarningsFilter = window.localStorage.getItem(WARNING_FILTER_KEY) === 'true'; } catch { /* Keep the filter usable when browser storage is unavailable. */ }
    function setOnlyWarningsFilter(value, persist = true) {
      const next = Boolean(value);
      if (persist) {
        try { window.localStorage.setItem(WARNING_FILTER_KEY, String(next)); } catch { /* The shared in-memory state still works. */ }
      }
      if (onlyWarningsFilter === next) return;
      onlyWarningsFilter = next;
      warningFilterListeners.forEach(listener => listener());
    }
    function subscribeWarningFilter(listener) {
      warningFilterListeners.add(listener);
      return () => { warningFilterListeners.delete(listener); };
    }
    const warningFilterSnapshot = () => onlyWarningsFilter;
    function useOnlyWarningsFilter() {
      return useSyncExternalStore(subscribeWarningFilter, warningFilterSnapshot, warningFilterSnapshot);
    }
    let locks = 0;
    let previousOverflow = '';
    const number = new Intl.NumberFormat('zh-CN');

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const exact = value => finite(value) ? number.format(Math.round(value)) : '未知';
    const short = value => !finite(value) ? '未知' : value >= 1000000
      ? `${(value / 1000000).toFixed(2).replace(/\.00$/, '')}m`
      : value >= 10000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : exact(value);
    const percent = value => !finite(value) ? '未知' : value > 0.999 && value < 1
      ? `${(value * 100).toFixed(2)}%` : `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
    function turnPercent(value) {
      if (!finite(value)) return '未知';
      let precision = 2;
      while (value < 1 && Number((value * 100).toFixed(precision)) >= 100 && precision < 6) precision += 1;
      return `${(value * 100).toFixed(precision).replace(/\.?0+$/, '')}%`;
    }
    const stepLabel = item => item && finite(item.turn)
      ? `第 ${item.turn} 轮${finite(item.step) ? ` · 步骤 ${item.step}` : ''}` : '步骤未知';
    const usageOf = item => item && (item.usage || item);
    const identity = (sessionId, pending) => pending ? `${sessionId}:${pending.id}:${pending.fingerprint}` : '';
    const changesOf = item => Array.isArray(item && item.changes) ? item.changes : [];
    function time(value) {
      if (!value) return '—';
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
    }
    function inputTotal(usage) {
      if (!usage) return null;
      if (finite(usage.promptTokens)) return usage.promptTokens;
      if (!finite(usage.inputTokens) || !finite(usage.cacheReadTokens) || !finite(usage.cacheWriteTokens)) return null;
      return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    }
    function summary(usage) {
      return usage ? `缓存命中 ${exact(usage.cacheReadTokens)} tok；命中率 ${percent(usage.hitRate)}；未缓存输入 ${exact(usage.inputTokens)} tok；缓存写入 ${exact(usage.cacheWriteTokens)} tok` : '尚无模型用量记录';
    }
    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: { ...(options && options.body ? { 'Content-Type': 'application/json' } : {}), ...(options && options.headers) },
      });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
      if (response.status === 204) return null;
      return response.json();
    }
    function recordFor(sessionId) {
      if (!records.has(sessionId)) records.set(sessionId, {
        snapshot: { sessionId, data: null, error: null, loading: true }, listeners: new Set(), timer: null, inFlight: null, version: 0,
      });
      return records.get(sessionId);
    }
    function publish(record, snapshot) {
      record.snapshot = snapshot;
      record.listeners.forEach(listener => listener(snapshot));
    }
    async function refresh(sessionId) {
      if (!sessionId) return;
      const record = recordFor(sessionId);
      if (record.inFlight) return record.inFlight.promise;
      const controller = new AbortController();
      const version = ++record.version;
      const promise = (async () => {
        try {
          const data = await request(`/session?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
          if (record.version !== version) return;
          if (!data || data.sessionId !== sessionId) throw new Error('会话数据不匹配，已忽略本次响应');
          publish(record, { sessionId, data, error: null, loading: false });
        } catch (error) {
          if (controller.signal.aborted || record.version !== version) return;
          publish(record, { ...record.snapshot, error: error.message || '连接中断', loading: false });
        } finally {
          if (record.version === version) record.inFlight = null;
        }
      })();
      record.inFlight = { controller, promise };
      return promise;
    }
    function subscribe(sessionId, listener) {
      const record = recordFor(sessionId);
      record.listeners.add(listener);
      listener(record.snapshot);
      if (!record.timer) {
        void refresh(sessionId);
        record.timer = setInterval(() => { void refresh(sessionId); }, POLL_MS);
      }
      return () => {
        record.listeners.delete(listener);
        if (record.listeners.size) return;
        clearInterval(record.timer);
        record.timer = null;
        record.inFlight?.controller.abort();
        record.inFlight = null;
        record.version += 1;
      };
    }
    function useSession(sessionId) {
      const [state, setState] = useState(() => sessionId ? recordFor(sessionId).snapshot : null);
      useEffect(() => sessionId ? subscribe(sessionId, setState) : undefined, [sessionId]);
      return sessionId ? (state && state.sessionId === sessionId ? state : recordFor(sessionId).snapshot) : null;
    }
    function Icon({ name = 'cache', size = 14 }) {
      const paths = name === 'close' ? ['M4 4l12 12M16 4L4 16']
        : name === 'warning' ? ['M10 2 1 18h18L10 2Z', 'M10 7v5M10 15v.1']
          : ['M17 6c0 2-14 2-14 0s14-2 14 0Z', 'M3 6v8c0 3 14 3 14 0V6', 'M3 10c0 3 14 3 14 0'];
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...paths.map((d, i) => h('path', { d, key: i })));
    }
    function Button({ children, className = '', ...props }) {
      return h('button', { type: 'button', ...props, className: `dch-button ${className}` }, children);
    }
    function Changes({ changes, empty = '尚无法确定原因；可能涉及服务端缓存过期或未记录的请求变更。' }) {
      return changes.length ? h('ul', { className: 'dch-changes' }, ...changes.map((change, index) => h('li', { key: `${change.kind || 'change'}-${index}` },
        typeof change === 'string' ? change : change.message || change.kind || '上下文发生变化',
        Array.isArray(change.added) && change.added.length ? h('span', { className: 'dch-dim' }, `；新增：${change.added.join('、')}`) : null,
        Array.isArray(change.removed) && change.removed.length ? h('span', { className: 'dch-dim' }, `；移除：${change.removed.join('、')}`) : null,
      ))) : h('p', { className: 'dch-dim' }, empty);
    }
    function Modal({ title, subtitle, children, onClose, className = '', busy = false, alert = false }) {
      const panel = useRef(null);
      const token = useRef({});
      const close = useRef(onClose);
      close.current = onClose;
      useEffect(() => {
        const savedFocus = document.activeElement;
        const current = token.current;
        modalStack.push(current);
        if (locks++ === 0) {
          previousOverflow = document.body.style.overflow;
          document.body.style.overflow = 'hidden';
        }
        (panel.current?.querySelector('[data-dch-autofocus]') || panel.current)?.focus();
        const onKey = event => {
          if (modalStack[modalStack.length - 1] !== current) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close.current();
          } else if (event.key === 'Tab') {
            const elements = Array.from(panel.current?.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]') || []).filter(element => element.getClientRects().length);
            if (!elements.length) { event.preventDefault(); panel.current?.focus(); return; }
            const first = elements[0], last = elements[elements.length - 1];
            if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          const index = modalStack.indexOf(current);
          if (index >= 0) modalStack.splice(index, 1);
          if (--locks === 0) document.body.style.overflow = previousOverflow;
          if (savedFocus && savedFocus.isConnected) savedFocus.focus();
        };
      }, []);
      return createPortal(h('div', {
        className: `dch-overlay${alert ? ' dch-overlay-alert' : ''}`,
        onMouseDown: event => { if (event.target === event.currentTarget) close.current(); },
      }, h('section', { ref: panel, role: alert ? 'alertdialog' : 'dialog', 'aria-modal': true, 'aria-label': title, tabIndex: -1, className: `dch-modal ${className}`, 'aria-busy': busy },
        h('header', { className: 'dch-modal-header' }, h('div', null, h('h2', null, title), subtitle ? h('p', { className: 'dch-subtitle' }, subtitle) : null),
          h(Button, { className: 'dch-icon-button', onClick: onClose, disabled: busy, 'aria-label': alert ? '取消发送并关闭警告' : '关闭缓存看板', title: alert ? '取消发送' : '关闭' }, h(Icon, { name: 'close', size: 18 }))), children)), document.body);
    }
    function Gate({ sessionId, pending, onDone, connectionError }) {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const alive = useRef(true);
      const inFlight = useRef(false);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      async function decide(decision) {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
          await request('/decision', { method: 'POST', body: JSON.stringify({ sessionId, id: pending.id, fingerprint: pending.fingerprint, decision }) });
          if (alive.current) onDone(identity(sessionId, pending));
          void refresh(sessionId);
        } catch (cause) {
          if (alive.current) setError(`${cause.message || '操作失败'}。请求仍未获准发送，请重试或取消。`);
        } finally {
          inFlight.current = false;
          if (alive.current) setBusy(false);
        }
      }
      return h(Modal, { title: '缓存可能大规模失效', subtitle: `${stepLabel(pending)} · 请求已暂停，等待你的决定`, alert: true, busy, onClose: () => { void decide('cancel'); } },
        h('div', { className: 'dch-modal-body' },
          h('div', { className: 'dch-risk' }, h(Icon, { name: 'warning', size: 24 }), h('div', null,
            h('strong', null, pending.unknown ? '无法可靠验证本次请求的缓存前缀' : `预计 ${short(pending.lossTokens)} tok 旧上下文失去复用条件`),
            h('p', null, finite(pending.lossRatio) ? `约占上一请求可复用前缀的 ${percent(pending.lossRatio)}。这些输入可能按未缓存价格重新计费。` : '继续发送可能产生较多未缓存输入费用。'))),
          pending.reason ? h('p', null, pending.reason) : null,
          h('h3', null, '检测到的变化'), h(Changes, { changes: changesOf(pending), empty: '现有记录不足以定位具体变化。' }),
          h('p', { className: 'dch-note' }, '这是发送前的风险预测；实际命中量以模型返回的 usage 为准。确认只对当前这份请求生效。'),
          connectionError ? h('p', { className: 'dch-error', role: 'status' }, '与宿主连接中断。请求保持等待，连接恢复前无法确认。') : null,
          error ? h('p', { className: 'dch-error', role: 'alert' }, error) : null),
        h('footer', { className: 'dch-modal-footer' },
          h(Button, { onClick: () => { void decide('cancel'); }, disabled: busy, 'data-dch-autofocus': true }, busy ? '正在处理…' : '取消本次发送'),
          h(Button, { className: 'dch-button-primary', disabled: busy || Boolean(connectionError), onClick: () => { void decide('confirm'); } }, '确认并发送')));
    }
    function TurnCacheReading({ sessionId, turn: turnOwner, seq }) {
      // The native turnTail owner is a TurnLocation. Keep the primitive form
      // compatible with older assemblies without ever copying owner content.
      const turn = typeof turnOwner === 'number' ? turnOwner : turnOwner?.turn;
      const state = useSession(sessionId);
      const anchor = useRef(null);
      const [mount, setMount] = useState(null);
      const [dashboardFor, setDashboardFor] = useState(null);
      const dashboardKey = `${sessionId}:${turn}`;
      useEffect(() => { setDashboardFor(null); }, [dashboardKey]);
      useEffect(() => {
        const marker = anchor.current;
        if (!marker) return;
        if (!sessionId || !finite(turn)) {
          marker.dataset.cachePhase = 'owner-missing';
          marker.dataset.cacheObserver = 'none';
          return;
        }
        const container = document.createElement('span');
        container.className = 'dch-turn-cache-portal';
        container.dataset.dshCacheHelperPortal = 'turn';
        let scheduled = false;
        let disposed = false;
        let tail = null;
        let observer = null;
        let attachmentObserver = null;
        let attachmentTimer = null;
        let attachmentScheduled = false;
        const phase = value => { if (!disposed) marker.dataset.cachePhase = value; };
        const stopAttachment = () => {
          attachmentObserver?.disconnect();
          attachmentObserver = null;
          clearTimeout(attachmentTimer);
          attachmentTimer = null;
        };
        const place = () => {
          scheduled = false;
          if (disposed || !tail) return;
          // The host has no after-usage slot. Its public turnTail slot gives
          // us a turn-local lifecycle; only this owned container is moved.
          const actions = Array.from(tail.querySelectorAll('[data-clock="end"]')).find(element => element.closest('[data-turn-tail]') === tail);
          const info = actions?.lastElementChild;
          if (!info || info.tagName !== 'SPAN') {
            container.remove();
            setMount(previous => previous === null ? previous : null);
            phase('waiting-footer');
            return;
          }
          const nativeChildren = Array.from(info.children).filter(element => element !== container);
          const last = nativeChildren[nativeChildren.length - 1];
          // Native timeEnd is a leaf span. TurnUsagePanel's span contains a
          // dialog button. Match only these known native shapes: usage+clock,
          // compact clock-only, or usage-only when the clock is unavailable.
          // Unknown host structure must not turn into a fallback action row.
          const clock = last?.tagName === 'SPAN' && last.children.length === 0 && /\b\d{2}:\d{2}\b/.test(last.textContent || '') ? last : null;
          const first = nativeChildren[0];
          const usage = first?.tagName === 'SPAN' && first.querySelector('button[aria-haspopup="dialog"]') ? first : null;
          const matched = nativeChildren.length === 2 && usage === first && clock === last
            || nativeChildren.length === 1 && Boolean(clock || usage);
          if (!matched) {
            container.remove();
            setMount(previous => previous === null ? previous : null);
            phase('unmatched-footer');
            return;
          }
          if (container.parentNode !== info || container.nextElementSibling !== clock) info.insertBefore(container, clock);
          setMount(previous => previous === container ? previous : container);
          phase('attached');
        };
        const setup = () => {
          attachmentScheduled = false;
          if (disposed || tail) return Boolean(tail);
          const candidate = marker.closest('[data-turn-tail]');
          marker.dataset.cacheTail = candidate?.getAttribute('data-turn-tail') ?? 'none';
          if (!candidate || candidate.getAttribute('data-turn-tail') !== String(turn)) {
            phase(candidate ? 'turn-mismatch' : 'waiting-tail');
            return false;
          }
          tail = candidate;
          stopAttachment();
          marker.dataset.cacheObserver = 'tail';
          observer = new MutationObserver(() => {
            if (!scheduled) { scheduled = true; queueMicrotask(place); }
          });
          observer.observe(tail, { childList: true, subtree: true });
          place();
          return true;
        };
        marker.dataset.cacheObserver = 'none';
        if (!setup()) queueMicrotask(() => {
          if (disposed || setup()) return;
          // A slot can commit inside a detached host before its parent has
          // seated that host in a turn tail. Wait for attachment via events,
          // then immediately narrow observation to the resolved tail.
          attachmentObserver = new MutationObserver(() => {
            if (!attachmentScheduled) { attachmentScheduled = true; queueMicrotask(setup); }
          });
          attachmentObserver.observe(document.documentElement, { childList: true, subtree: true });
          marker.dataset.cacheObserver = 'attachment';
          attachmentTimer = setTimeout(() => {
            if (disposed || setup()) return;
            stopAttachment();
            marker.dataset.cacheObserver = 'none';
            phase('attachment-timeout');
          }, 5000);
          setup();
        });
        return () => {
          disposed = true;
          observer?.disconnect();
          stopAttachment();
          marker.dataset.cacheObserver = 'none';
          marker.dataset.cachePhase = 'disposed';
          container.remove();
        };
      }, [sessionId, turn, seq]);
      const entry = Array.isArray(state?.data?.turns) ? state.data.turns.find(item => item.turn === turn) : null;
      const latest = entry?.latest;
      const titleBase = latest
        ? `${stepLabel({ turn, step: entry.step ?? latest.step })} · 末次实际调用\n缓存命中 ${exact(latest.cacheReadTokens)} tok / 全部输入 ${exact(inputTotal(latest))} tok\n命中率 ${turnPercent(latest.hitRate)}（缓存命中 / 全部输入）`
        : `第 ${turn} 轮 · ${state?.loading ? '正在读取末次实际调用的缓存用量' : '末次实际调用的缓存用量未知'}`;
      const title = `${titleBase}${state?.error ? '\n更新失败，显示上次读取结果；读数可能已过时。' : ''}`;
      const label = latest ? `末次缓存 ${short(latest.cacheReadTokens)} tok · ${turnPercent(latest.hitRate)}`
        : state?.loading ? '末次缓存读取中…' : '末次缓存 未知';
      return h(React.Fragment, null,
        h('span', {
          ref: anchor, className: 'dch-turn-cache-anchor', 'aria-hidden': true,
          'data-cache-turn': String(turn), 'data-cache-turn-type': typeof turn,
          'data-cache-raw-owner-type': typeof turnOwner,
          'data-cache-seq': String(seq), 'data-cache-session': sessionId ?? 'undefined', 'data-cache-phase': 'initial',
        }),
        mount ? createPortal(h(React.Fragment, null,
          h('span', {
            className: `dch-turn-cache-reading${state?.error ? ' dch-stale' : ''}`,
            'data-dsh-cache-helper': 'turn-reading', 'data-cache-turn': turn,
            title, tabIndex: 0, 'aria-label': title,
          }, label),
          h(Button, { className: 'dch-dashboard-trigger', onClick: () => { setDashboardFor(dashboardKey); }, 'aria-haspopup': 'dialog' }, '缓存看板')),
        mount) : null,
        dashboardFor === dashboardKey ? h(Dashboard, { key: dashboardKey, initialSessionId: sessionId, onClose: () => { setDashboardFor(null); } }) : null);
    }
    function CacheGate({ sessionId }) {
      const state = useSession(sessionId);
      const [finished, setFinished] = useState('');
      if (!sessionId) return null;
      const data = state && state.data;
      const pending = data && data.pending;
      const pendingKey = identity(sessionId, pending);
      return pending && pendingKey !== finished ? h(Gate, { key: pendingKey, sessionId, pending, onDone: setFinished, connectionError: state?.error }) : null;
    }
    function WarnStrip({ sessionId }) {
      const state = useSession(sessionId);
      const [expanded, setExpanded] = useState(false);
      const [showDismissed, setShowDismissed] = useState(false);
      const [busyId, setBusyId] = useState(null);
      const [error, setError] = useState(null);
      const currentSession = useRef(sessionId);
      currentSession.current = sessionId;
      useEffect(() => { setExpanded(false); setShowDismissed(false); setError(null); setBusyId(null); }, [sessionId]);
      const warnings = state?.data?.warnings || [];
      const active = warnings.filter(warning => !warning.dismissed);
      const dismissed = warnings.length - active.length;
      if (!warnings.length) return null;
      const visible = showDismissed ? warnings : active;
      const recent = active[active.length - 1] || warnings[warnings.length - 1];
      async function dismiss(warning) {
        if (busyId) return;
        setBusyId(warning.id); setError(null);
        try {
          await request('/warnings/dismiss', { method: 'POST', body: JSON.stringify({ sessionId, id: warning.id, dismissed: !warning.dismissed }) });
          await refresh(sessionId);
        } catch (cause) { if (currentSession.current === sessionId) setError(cause.message || '更新失败'); }
        finally { if (currentSession.current === sessionId) setBusyId(null); }
      }
      return h('div', { className: 'dch-warn-seat' }, h('aside', { className: `dch-warn${!active.length ? ' dch-warn-muted' : ''}`, 'data-dsh-cache-helper': 'warnings', 'aria-label': '缓存异常记录' },
        h('div', { className: 'dch-warn-heading' }, h(Button, { className: 'dch-warn-toggle', onClick: () => { setExpanded(!expanded); }, 'aria-expanded': expanded },
          h(Icon, { name: 'warning' }), h('span', null, active.length ? `WARN · ${active.length} 次缓存大规模失效` : `${warnings.length} 条缓存异常已收起`),
          h('span', { className: 'dch-warn-recent' }, `${stepLabel(recent)}${recent.recovered ? ' · 后续已恢复' : ''}`), h('span', { 'aria-hidden': true }, expanded ? '⌃' : '⌄'))),
        expanded ? h('div', { className: 'dch-warn-body' },
          h('p', { className: 'dch-note' }, '以下为响应 usage 确认的异常；后续恢复不会删除记录。原因来自上下文对比，供排查参考。'),
          dismissed ? h('label', { className: 'dch-check' }, h('input', { type: 'checkbox', checked: showDismissed, onChange: event => { setShowDismissed(event.target.checked); } }), `显示 ${dismissed} 条已收起记录`) : null,
          ...visible.slice().reverse().map(warning => h('article', { className: `dch-warning-item${warning.dismissed ? ' dch-dismissed' : ''}`, key: warning.id },
            h('div', { className: 'dch-row-between' }, h('strong', null, stepLabel(warning)), h('span', { className: 'dch-tags' }, warning.recovered ? h('span', { className: 'dch-tag dch-tag-good' }, '后续已恢复') : null, h(Button, { className: 'dch-text-button', disabled: busyId !== null, onClick: () => { void dismiss(warning); } }, busyId === warning.id ? '处理中…' : warning.dismissed ? '恢复提示' : '收起此条'))),
            h('p', null, warning.summary || '缓存大规模失效，需要分析原因。'),
            warning.reason ? h('p', { className: 'dch-dim' }, warning.reason) : null,
            h('p', { className: 'dch-dim' }, `命中率 ${percent(warning.hitRate)} · 缓存命中 ${exact(warning.cacheReadTokens)} tok · 未缓存输入 ${exact(warning.missTokens)} tok${finite(warning.lossTokens) ? ` · 估计损失 ${exact(warning.lossTokens)} tok` : ''}`),
            h(Changes, { changes: changesOf(warning) }))),
          error ? h('p', { className: 'dch-error', role: 'alert' }, error) : null) : null));
    }
    function Metric({ label, value, detail }) {
      return h('div', { className: 'dch-metric' }, h('span', null, label), h('strong', null, value), detail ? h('small', null, detail) : null);
    }
    function Dashboard({ initialSessionId, onClose, inline = false }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [query, setQuery] = useState('');
      const [selected, setSelected] = useState(initialSessionId);
      const [detail, setDetail] = useState(null);
      const [detailError, setDetailError] = useState(null);
      const [detailLoading, setDetailLoading] = useState(true);
      const onlyWarnings = useOnlyWarningsFilter();
      const [page, setPage] = useState(0);
      const revision = useRef(0);
      const detailRevision = useRef(0);
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current += 1; detailRevision.current += 1; }; }, []);
      useEffect(() => { setPage(0); }, [onlyWarnings]);
      async function load() {
        const current = ++revision.current;
        setLoading(true); setError(null);
        try {
          const next = await request('/dashboard');
          if (alive.current && current === revision.current) {
            setData(next);
            // Settings is root-scoped and may have no active conversation.
            const candidates = Array.isArray(next?.sessions) ? next.sessions.slice() : [];
            candidates.sort((a, b) => (b.warningCount || 0) - (a.warningCount || 0) || (b.cumulative?.inputTokens || 0) - (a.cumulative?.inputTokens || 0));
            setSelected(previous => previous || candidates[0]?.sessionId || null);
          }
        } catch (cause) { if (alive.current && current === revision.current) setError(cause.message || '看板读取失败'); }
        finally { if (alive.current && current === revision.current) setLoading(false); }
      }
      useEffect(() => { void load(); }, []);
      useEffect(() => {
        const current = ++detailRevision.current;
        const controller = new AbortController();
        setDetail(null); setDetailError(null); setDetailLoading(true); setPage(0);
        if (!selected) { setDetailLoading(false); return () => { controller.abort(); }; }
        request(`/session?sessionId=${encodeURIComponent(selected)}`, { signal: controller.signal }).then(next => {
          if (next?.sessionId !== selected) throw new Error('会话数据不匹配，已忽略本次响应');
          if (alive.current && detailRevision.current === current) setDetail(next);
        }).catch(cause => {
          if (!controller.signal.aborted && alive.current && detailRevision.current === current) setDetailError(cause.message || '会话读取失败');
        }).finally(() => { if (alive.current && detailRevision.current === current) setDetailLoading(false); });
        return () => { controller.abort(); };
      }, [selected, data]);
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const search = query.trim().toLowerCase();
      const shown = sessions.filter(session => !search || [session.title, session.sessionId, session.cwd].some(value => String(value || '').toLowerCase().includes(search)))
        .slice().sort((a, b) => (b.warningCount || 0) - (a.warningCount || 0) || (b.cumulative?.inputTokens || 0) - (a.cumulative?.inputTokens || 0));
      let read = 0, miss = 0, total = 0, known = 0, unknown = 0, warningCount = 0;
      for (const session of sessions) {
        const usage = session.cumulative;
        const prompt = inputTotal(usage);
        warningCount += session.warningCount || 0;
        if (!usage || !finite(usage.hitRate) || prompt === null || !finite(usage.cacheReadTokens) || !finite(usage.inputTokens)) { unknown += 1; continue; }
        known += 1;
        read += usage.cacheReadTokens; miss += usage.inputTokens; total += prompt;
      }
      const warningFor = call => (detail?.warnings || []).find(warning => warning.seq === call.seq && finite(call.seq) || warning.turn === call.turn && warning.step === call.step);
      const calls = Array.isArray(detail?.calls) ? detail.calls : [];
      const filteredCalls = calls.filter(call => !onlyWarnings || Boolean(warningFor(call)));
      const pageCount = Math.max(1, Math.ceil(filteredCalls.length / 40));
      const pageIndex = Math.min(page, pageCount - 1);
      const coverageErrors = data?.coverage?.errors;
      const errorCount = Array.isArray(coverageErrors) ? coverageErrors.length : finite(coverageErrors) ? coverageErrors : 0;
      const content = h('div', { className: 'dch-modal-body' },
          h('div', { className: 'dch-row-between dch-dashboard-toolbar' },
            h('p', { className: 'dch-note' }, '范围：DSH 主会话的已记录 usage。首个请求的冷启动不视为异常。'),
            h('label', { className: 'dch-check' }, h('input', { type: 'checkbox', checked: onlyWarnings, onChange: event => { setOnlyWarningsFilter(event.target.checked); } }), '只看异常'),
            h(Button, { onClick: () => { void load(); }, disabled: loading }, loading ? '读取中…' : '刷新')),
          error ? h('p', { className: 'dch-error', role: 'alert' }, error) : null,
          h('div', { className: 'dch-metrics' }, h(Metric, { label: '缓存命中', value: known ? `${short(read)} tok` : '未知', detail: '已知 usage 合计' }), h(Metric, { label: '加权命中率', value: total > 0 ? percent(read / total) : '未知', detail: '缓存命中 / 全部输入' }), h(Metric, { label: '未缓存输入', value: known ? `${short(miss)} tok` : '未知', detail: '不含缓存写入与输出' }), h(Metric, { label: '异常步骤', value: exact(warningCount), detail: `${sessions.length} 个会话 · ${unknown} 个命中率未知` })),
          h('div', { className: 'dch-dashboard-grid' },
            h('section', { className: 'dch-session-panel', 'aria-label': '会话列表' },
              h('input', { type: 'search', className: 'dch-search', value: query, onChange: event => { setQuery(event.target.value); }, placeholder: '搜索标题、会话 ID 或工作目录', 'aria-label': '搜索会话' }),
              h('p', { className: 'dch-note dch-session-count' }, `${shown.length} 个会话 · 优先显示异常较多的会话`),
              h('div', { className: 'dch-session-list' }, ...shown.map(session => h('button', { type: 'button', className: `dch-session${selected === session.sessionId ? ' dch-session-selected' : ''}`, key: session.sessionId, onClick: () => { setSelected(session.sessionId); }, 'aria-pressed': selected === session.sessionId },
                h('strong', null, session.title || '未命名会话'), h('span', { className: 'dch-dim dch-session-id', title: session.sessionId }, session.sessionId),
                h('span', { className: 'dch-row-between' }, h('span', null, `累计命中 ${percent(session.cumulative?.hitRate)}`), h('span', { className: session.warningCount ? 'dch-tag dch-tag-warn' : 'dch-dim' }, session.warningCount ? `${session.warningCount} 次异常` : '无异常记录')),
                session.cwd ? h('small', { className: 'dch-dim dch-ellipsis', title: session.cwd }, session.cwd) : null)), !loading && !shown.length ? h('p', { className: 'dch-empty' }, '没有匹配的会话') : null)),
            h('section', { className: 'dch-detail-panel', 'aria-label': '调用步骤明细' },
              detailLoading ? h('p', { className: 'dch-empty', role: 'status' }, '正在读取调用步骤…') : detailError ? h('p', { className: 'dch-error', role: 'alert' }, detailError) : detail ? h(React.Fragment, null,
                h('div', { className: 'dch-detail-heading' }, h('h3', null, detail.title || '未命名会话'), h('p', { className: 'dch-dim dch-session-id' }, detail.sessionId), h('p', { className: 'dch-note' }, `累计：${summary(detail.cumulative)}`)),
                h('div', { className: 'dch-row-between dch-call-toolbar' }, h('span', { className: 'dch-dim' }, `${filteredCalls.length} 个调用步骤`)),
                h('div', { className: 'dch-table-scroll' }, h('table', { className: 'dch-call-table' },
                  h('thead', null, h('tr', null, ...['调用步骤', '缓存命中', '命中率', '未缓存输入', '原因 / 状态'].map(label => h('th', { key: label, scope: 'col' }, label)))),
                  h('tbody', null, ...filteredCalls.slice(pageIndex * 40, (pageIndex + 1) * 40).map((call, index) => {
                    const usage = usageOf(call), warning = warningFor(call);
                    const changes = changesOf(warning || call);
                    return h('tr', { key: call.id || call.seq || `${call.turn}-${call.step}-${index}`, className: warning ? 'dch-call-warning' : '' },
                      h('td', null, h('strong', null, stepLabel(call)), call.at ? h('small', { className: 'dch-dim' }, time(call.at)) : null),
                      h('td', { title: exact(usage?.cacheReadTokens) }, `${short(usage?.cacheReadTokens)} tok`), h('td', null, percent(usage?.hitRate)), h('td', { title: exact(usage?.inputTokens) }, `${short(usage?.inputTokens)} tok`),
                      h('td', { className: 'dch-cause' }, warning ? h('span', { className: 'dch-tag dch-tag-warn' }, warning.recovered ? '失效 · 后续恢复' : '缓存失效') : null,
                        changes.length ? h(Changes, { changes }) : warning ? h('span', { className: 'dch-dim' }, warning.summary || '原因待排查') : h('span', { className: 'dch-dim' }, calls.indexOf(call) === 0 ? '首次记录 / 冷启动' : finite(usage?.hitRate) ? '无异常记录' : '缓存 usage 未知')));
                  })))),
                !filteredCalls.length ? h('p', { className: 'dch-empty' }, onlyWarnings ? '没有异常步骤' : '尚无调用记录') : null,
                pageCount > 1 ? h('div', { className: 'dch-pagination' }, h(Button, { disabled: pageIndex === 0, onClick: () => { setPage(pageIndex - 1); } }, '上一页'), h('span', null, `${pageIndex + 1} / ${pageCount}`), h(Button, { disabled: pageIndex + 1 >= pageCount, onClick: () => { setPage(pageIndex + 1); } }, '下一页')) : null,
              ) : h('p', { className: 'dch-empty' }, '选择一个会话查看步骤'))),
          h('p', { className: 'dch-note dch-coverage' }, data ? `生成于 ${time(data.generatedAt)} · 已扫描 ${data.coverage?.scanned ?? sessions.length} 个会话${finite(data.coverage?.limit) ? `（扫描上限 ${data.coverage.limit}）` : ''}${errorCount ? ` · ${errorCount} 个会话读取失败，统计不完整` : ''}。原因分析为本地上下文对比结果。` : '正在读取本地用量索引…'));
      return inline ? h('section', { className: 'dch-settings-dashboard', 'aria-label': '缓存有效率看板' },
        h('header', { className: 'dch-settings-heading' }, h('h2', null, '缓存有效率看板'), h('p', { className: 'dch-note' }, '按会话与调用步骤查看实际缓存命中，定位失效时点')), content)
        : h(Modal, { title: '缓存有效率看板', subtitle: '按会话与调用步骤查看实际缓存命中，定位失效时点', className: 'dch-dashboard', onClose }, content);
    }
    function CacheSettings() { return h(Dashboard, { inline: true }); }

    const STYLE = String.raw`
.dch-stale{opacity:.7}.dch-turn-cache-anchor{display:none!important}.dch-turn-cache-portal{display:inline-flex;align-items:center;flex-wrap:wrap;gap:0 6px;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}.dch-turn-cache-portal>.dch-dashboard-trigger{flex:none;font-size:inherit;line-height:inherit;padding:0;white-space:nowrap}.dch-turn-cache-reading{font:inherit;color:inherit;overflow-wrap:anywhere;outline-offset:2px}.dch-turn-cache-reading:focus-visible{outline:2px solid #5577df;border-radius:2px}[data-turn-tail] [data-clock='end']:has(.dch-turn-cache-portal){height:auto;min-height:calc(28px + var(--dsh-content-font-delta,0px));flex-wrap:wrap;row-gap:0}[data-turn-tail] [data-clock='end']>span:has(>.dch-turn-cache-portal){flex-wrap:wrap;row-gap:0;max-width:100%}
.dch-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;font:inherit;line-height:1.5;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#dedee5);border-radius:7px;padding:6px 11px;cursor:pointer;transition:background .12s}.dch-button:hover{background:var(--dsw-alias-interactive-bg-hover,#00000008)}.dch-button:disabled{opacity:.5;cursor:wait}.dch-button:focus-visible,.dch-session:focus-visible,.dch-search:focus-visible,.dch-reading-value:focus-visible{outline:2px solid #5577df;outline-offset:2px}.dch-dashboard-trigger{border:0;padding:2px 0;text-decoration:underline;text-underline-offset:2px;font-size:11px;color:inherit}.dch-button-primary{background:#4867d6;color:#fff;border-color:#4867d6}.dch-button-primary:hover{background:#3c59bf}.dch-icon-button{padding:4px;border:0;flex:none}.dch-text-button{border:0;padding:2px 3px;font-size:11px}
.dch-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:#11131d65;backdrop-filter:blur(2px);box-sizing:border-box;color:var(--dsw-alias-label-primary,#252633);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;--dch-bg:var(--dsw-alias-bg-layer-1,#fff);--dch-soft:var(--dsw-alias-interactive-bg-hover,#f6f6f9);--dch-line:var(--dsw-alias-border-l1,#e4e4ec)}.dch-overlay-alert{z-index:2147483010}.dch-overlay *{box-sizing:border-box}.dch-modal{width:620px;max-width:100%;max-height:calc(100dvh - 48px);overflow:hidden;display:flex;flex-direction:column;background:var(--dch-bg);border:1px solid var(--dch-line);border-radius:15px;box-shadow:0 18px 70px #0004;outline:none}.dch-modal-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:21px 24px 17px;border-bottom:1px solid var(--dch-line)}.dch-modal h2,.dch-modal h3,.dch-warn h3{margin:0;font-size:18px;line-height:1.5;font-weight:650}.dch-modal h3{font-size:13px}.dch-modal p{margin:8px 0}.dch-modal .dch-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary,#737382);margin:4px 0 0}.dch-modal-body{overflow:auto;padding:20px 24px;min-height:0}.dch-modal-footer{display:flex;justify-content:flex-end;gap:9px;padding:16px 24px;border-top:1px solid var(--dch-line)}.dch-risk{display:flex;gap:12px;align-items:flex-start;background:#d6a13818;border:1px solid #d6a13840;border-radius:10px;padding:15px;margin-bottom:18px}.dch-risk>svg{flex:none;margin-top:2px;color:#aa7418}.dch-risk strong{font-size:15px}.dch-risk p{margin:5px 0 0}.dch-changes{margin:7px 0;padding-left:19px}.dch-changes li+li{margin-top:3px}.dch-dim,.dch-note{color:var(--dsw-alias-label-secondary,#737382)}.dch-note{font-size:11px}.dch-error{color:#ba3434;background:#c43d3d10;border:1px solid #c43d3d30;border-radius:7px;padding:8px 11px}.dch-row-between{display:flex;justify-content:space-between;align-items:center;gap:12px}.dch-tags{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}.dch-tag{display:inline-block;font-size:10px;line-height:1.5;padding:2px 6px;border-radius:5px;white-space:nowrap}.dch-tag-warn{color:#a36a08;background:#d59b241a}.dch-tag-good{color:#20825e;background:#20825e12}.dch-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary,#737382);cursor:pointer}.dch-check input{accent-color:#4867d6}
.dch-warn-seat{box-sizing:border-box;display:flex;flex:none;flex-direction:column;align-items:center;width:100%;min-width:0;padding:0 var(--dsh-composer-side-clearance)}.dch-warn{box-sizing:border-box;flex:none;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0;background:#d59b2410;border:1px solid #d59b2445;border-radius:8px;overflow:hidden;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary,#514325)}.dch-warn-muted{border-color:var(--dsw-alias-border-l1,#dedee5);background:var(--dsw-alias-interactive-bg-hover,#f6f6f9);color:var(--dsw-alias-label-secondary,#737382)}.dch-warn-toggle{width:100%;justify-content:flex-start;border:0;border-radius:0;padding:7px 10px;text-align:left;font-size:11px}.dch-warn-toggle>svg{flex:none}.dch-warn-toggle>span:last-child{margin-left:auto}.dch-warn-recent{font-size:10px;color:var(--dsw-alias-label-secondary,#737382);margin-left:4px}.dch-warn-body{padding:0 12px 10px;max-height:250px;overflow:auto}.dch-warn-body>.dch-note{margin:2px 0 7px}.dch-warning-item{padding:10px 0 4px;border-top:1px solid #d59b2430;margin-top:7px}.dch-warning-item p{margin:4px 0}.dch-dismissed{opacity:.65}
.dch-dashboard{width:min(1180px,calc(100vw - 48px))}.dch-dashboard .dch-modal-body{padding-top:12px}.dch-dashboard-toolbar{margin-bottom:13px}.dch-dashboard-toolbar>.dch-button{flex:none;white-space:nowrap}.dch-dashboard-toolbar p{margin:0}.dch-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--dch-line);border-radius:10px;margin-bottom:20px;overflow:hidden}.dch-metric{display:flex;flex-direction:column;gap:1px;padding:12px 16px;background:var(--dch-soft)}.dch-metric+.dch-metric{border-left:1px solid var(--dch-line)}.dch-metric>span{font-size:11px;color:var(--dsw-alias-label-secondary,#737382)}.dch-metric>strong{font-size:21px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}.dch-metric>small{font-size:10px;color:var(--dsw-alias-label-secondary,#737382)}.dch-dashboard-grid{display:grid;grid-template-columns:275px minmax(0,1fr);min-height:330px;border:1px solid var(--dch-line);border-radius:10px;overflow:hidden}.dch-session-panel{padding:12px;border-right:1px solid var(--dch-line);min-width:0}.dch-search{width:100%;padding:8px 9px;background:var(--dch-bg);color:inherit;border:1px solid var(--dch-line);border-radius:7px;font:inherit;font-size:11px}.dch-session-count{margin:8px 0!important}.dch-session-list{max-height:410px;overflow:auto}.dch-session{display:flex;flex-direction:column;gap:5px;width:100%;border:1px solid transparent;background:transparent;color:inherit;text-align:left;padding:10px 9px;border-radius:7px;cursor:pointer;font:inherit;font-size:11px}.dch-session:hover{background:var(--dch-soft)}.dch-session-selected{background:#4867d60c;border-color:#4867d649}.dch-session strong{font-size:12px;font-weight:600;line-height:1.5}.dch-session-id{font-size:10px;overflow-wrap:anywhere;line-height:1.4}.dch-session .dch-row-between{width:100%;gap:4px}.dch-session small{font-size:9px}.dch-ellipsis{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dch-detail-panel{min-width:0;padding:15px}.dch-detail-heading>h3{font-size:14px;overflow-wrap:anywhere}.dch-detail-heading p{margin:4px 0}.dch-call-toolbar{padding:10px 0 8px;font-size:11px}.dch-table-scroll{width:100%;overflow:auto;max-height:365px}.dch-call-table{width:100%;border-collapse:collapse;font-size:11px;text-align:left;font-variant-numeric:tabular-nums}.dch-call-table th{font-weight:500;color:var(--dsw-alias-label-secondary,#737382);background:var(--dch-bg);position:sticky;top:0;z-index:1;white-space:nowrap}.dch-call-table th,.dch-call-table td{padding:9px 8px;border-bottom:1px solid var(--dch-line);vertical-align:top}.dch-call-table td:nth-child(2),.dch-call-table td:nth-child(3),.dch-call-table td:nth-child(4){white-space:nowrap}.dch-call-table td strong{font-size:10px;white-space:nowrap}.dch-call-table td small{display:block;font-size:9px;white-space:nowrap;margin-top:3px}.dch-call-warning{background:#d59b240b}.dch-cause{min-width:150px}.dch-cause .dch-changes{margin:5px 0 0;padding-left:13px;font-size:10px;overflow-wrap:anywhere}.dch-empty{padding:32px 10px;text-align:center;color:var(--dsw-alias-label-secondary,#737382);font-size:12px}.dch-pagination{display:flex;justify-content:flex-end;align-items:center;gap:10px;padding-top:10px;font-size:11px}.dch-pagination .dch-button{padding:3px 8px}.dch-coverage{margin:11px 0 0!important}
.dch-settings-dashboard{box-sizing:border-box;container-type:inline-size;container-name:dch-settings;min-width:0;max-width:100%;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#252633);--dch-bg:var(--dsw-alias-bg-layer-2,#fff);--dch-soft:var(--dsw-alias-interactive-bg-hover,#f6f6f9);--dch-line:var(--dsw-alias-border-l1,#e4e4ec)}.dch-settings-dashboard *{box-sizing:border-box}.dch-settings-heading{margin:0 0 16px}.dch-settings-heading h2{margin:0;font-size:18px;line-height:1.5;font-weight:650}.dch-settings-dashboard p{margin:8px 0}.dch-settings-dashboard h3{margin:0;font-size:13px;line-height:1.5;font-weight:650}.dch-settings-dashboard .dch-modal-body{padding:0;overflow:visible;min-width:0}.dch-settings-dashboard .dch-dashboard-grid{grid-template-columns:minmax(0,1fr);min-height:0}.dch-settings-dashboard .dch-session-panel{border-right:0;border-bottom:1px solid var(--dch-line)}.dch-settings-dashboard .dch-session-list{max-height:190px}.dch-settings-dashboard .dch-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.dch-settings-dashboard .dch-metric:nth-child(3){border-left:0;border-top:1px solid var(--dch-line)}.dch-settings-dashboard .dch-metric:nth-child(4){border-top:1px solid var(--dch-line)}.dch-settings-dashboard .dch-metric strong,.dch-settings-dashboard .dch-session strong{overflow-wrap:anywhere}.dch-settings-dashboard .dch-row-between{flex-wrap:wrap}.dch-settings-dashboard .dch-table-scroll{max-height:360px}.dch-settings-dashboard .dch-dashboard-toolbar{align-items:center}.dch-settings-dashboard .dch-dashboard-toolbar>p{margin:0}
@container dch-settings (max-width:340px){.dch-settings-dashboard .dch-metrics{grid-template-columns:minmax(0,1fr)}.dch-settings-dashboard .dch-metric+.dch-metric{border-left:0;border-top:1px solid var(--dch-line)}.dch-settings-dashboard .dch-dashboard-toolbar{flex-direction:column;align-items:stretch}.dch-settings-dashboard .dch-metric{padding:9px 11px}.dch-settings-dashboard .dch-session-panel,.dch-settings-dashboard .dch-detail-panel{padding:10px}.dch-settings-dashboard .dch-session{padding:8px 5px}}
.dch-dashboard-toolbar{flex-wrap:wrap}.dch-dashboard-toolbar>.dch-check{flex:none;white-space:nowrap}.dch-dashboard-toolbar>.dch-check input{margin:0;flex:none}
body[data-ds-dark-theme] .dch-tag-warn{color:#d9a956}body[data-ds-dark-theme] .dch-tag-good{color:#73bea1}body[data-ds-dark-theme] .dch-error{color:#ed9292}
@media(max-width:760px){.dch-overlay{padding:10px}.dch-modal{max-height:calc(100dvh - 20px);border-radius:11px}.dch-modal-header{padding:16px}.dch-modal-body{padding:14px 16px}.dch-modal-footer{padding:12px 16px}.dch-dashboard{width:100%}.dch-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.dch-metric{padding:9px 12px}.dch-metric:nth-child(3){border-left:0;border-top:1px solid var(--dch-line)}.dch-metric:nth-child(4){border-top:1px solid var(--dch-line)}.dch-dashboard-grid{grid-template-columns:1fr}.dch-session-panel{border-right:0;border-bottom:1px solid var(--dch-line)}.dch-session-list{max-height:150px}.dch-detail-panel{padding:12px}.dch-warn-recent{display:none}}
`;

    function apply(ctx) {
      const style = document.createElement('style');
      style.dataset.dshCacheHelper = 'true';
      style.textContent = STYLE;
      document.head.appendChild(style);
      const onFilterStorage = event => {
        if (event.key === WARNING_FILTER_KEY || event.key === null) setOnlyWarningsFilter(event.key !== null && event.newValue === 'true', false);
      };
      window.addEventListener('storage', onFilterStorage);
      const disposers = [];
      const slot = (name, id, order, component, options = {}) => {
        const disposer = ctx.slots.inject(name, () => ctx.slots.register({ name, id, order, ...options }, component));
        if (typeof disposer === 'function') disposers.push(disposer);
      };
      slot('conversation.composer.dock', 'dsh-cache-helper-gate', 1.5, CacheGate);
      slot('conversation.input.dock', 'dsh-cache-helper-warnings', 10, WarnStrip);
      slot('conversation.chat.turnTail', 'dsh-cache-helper-turn-reading', 100, TurnCacheReading);
      slot('settings.section', 'dsh-cache-helper', 200, CacheSettings, { label: '缓存看板' });
      ctx.effect(() => () => {
        style.remove();
        window.removeEventListener('storage', onFilterStorage);
        warningFilterListeners.clear();
        disposers.forEach(dispose => dispose());
        records.forEach(record => {
          clearInterval(record.timer);
          record.inFlight?.controller.abort();
          record.version += 1;
          record.listeners.clear();
        });
        records.clear();
      }, 'dsh-cache-helper client cleanup');
    }
    return { inject: ['slots'], apply };
  },
});
