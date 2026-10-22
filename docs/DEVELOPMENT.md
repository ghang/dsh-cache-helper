# 开发说明

开发、打包、安装验证和公开发布分别记录结果；本地测试通过不代表已经公开发行。GitHub Release、npm、插件榜和本机安装来源分别核验，不能用一个渠道的成功替代另一个。

## 环境与目录

使用 Node.js 22 或更新版本，使用项目的 `package-lock.json` 固定开发依赖。运行时依赖由 DSH 提供，发布包不嵌入完整宿主或另一份 React。

| 目录或文件 | 用途 |
|---|---|
| `src/` | 插件服务端、分析核心和浏览器入口 |
| `scripts/` | 构建、运行时验证、只读回放和本地发布准备 |
| `tests/` | 合成数据、假上游和浏览器回归 |
| `docs/` | 随独立源码提供的开发/发布说明和经审核、获授权的演示截图 |
| `screenshots.json` | 已审核的公开演示截图清单 |
| `.github/` | 独立仓库的 CI 配置，远端运行状态单独记录 |
| `lib/` | 构建结果；进入候选 tgz，不提交到源码 Git 历史 |
| `.release/` | 候选校验产物和报告，不提交生成产物 |

## 已有独立仓库的日常开发

本插件已经使用独立 Git 历史。后续开发从该仓库的新工作分支开始，保留现有提交、tag 和远端。不要每次迭代重新创建仓库或复制研究目录的 Git 历史。

先检查当前 checkout、未提交变更、目标宿主版本和运行中的安装来源。若 `node_modules` 是宿主 profile 的软链，不能在此目录运行 `npm ci`；使用独立 checkout 或下节的干净候选目录。已有独立依赖时，日常按修改范围运行测试，需要构建时执行 `npm run build`。准备公开前再完成一次完整候选检查。

## 生成发布候选

为避免改变运行中的 web link，可以在唯一源码目录运行白名单导出，目标必须是尚不存在的新目录：

```bash
npm run prepare:release -- --out /absolute/path/cache-helper-candidate
cd /absolute/path/cache-helper-candidate
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npx --no-install playwright install chromium
npm run check:release
```

`prepare:release` 仅复制白名单源码，不安装依赖或运行测试，也不创建 Git 仓库、提交、tag、远端或公开发行。候选是构建投影，不是第二份可编辑源码；修复回到唯一源码仓，再导出新目录。它不要求日常开发重新建立 Git 历史。独立、干净且没有宿主依赖软链的 checkout 也可直接运行候选检查。

`npm ci --ignore-scripts` 按锁文件从指定公共 registry 准备开发依赖。`npx --no-install` 只运行已安装的 Playwright，浏览器下载由这个显式步骤完成。

`check:release` 内部已经执行完整 `npm test`，随后构建、打包、解包，并用解包后的产物再次做原生运行时与浏览器验证。标准候选流程不必在它前面重复运行一次完整测试。通过后输出 `.release/dsh-cache-helper.tgz`、`.release/SHA256SUMS` 和 `.release/release-report.json`。实际通过、失败或跳过状态都要保留；检查拒绝 `node_modules` 软链及旧的宿主模块路径环境覆盖。

这些脚本针对 cache-helper 的包名、入口、宿主兼容范围和测试集编写。其他插件可复用检查顺序和证据要求，但不能直接改包名后宣称通过同一套门禁。

当前 CI 使用 Node 24，安装锁定依赖和 Chromium 后运行 `check:release`。它不执行真实仓库提交身份门禁、创建 Release、发布 npm 或提交插件榜。完整发布的入口与现有自动化边界见[发行流程](RELEASING.md)；统一发行命令尚未实现。

## 验证范围

`npm test` 覆盖分析、Session 重建、确认门禁和持久化状态。集成测试使用锁定的 DSH 运行时向本机假上游发送 HTTP；测试密钥与内容均为合成数据，不需要真实模型凭据。

浏览器回归使用本项目的 Playwright、React 和前述显式安装的 Chromium。浏览器缺失或用例跳过不能算完整验收。用于布局的样式或最小夹具应位于独立源码内部，记录来源、版本和所需许可，不依赖本机其他仓库的相对路径。

在独立候选目录执行运行时导入自检：

```bash
npm run verify:runtime
```

自检与测试使用当前目录安装的依赖。不要设置指向其他 profile、缓存或个人目录的旧 `DSH_*` 模块路径环境变量；发布检查会拒绝这些覆盖。自检 CLI 仅报告 Node 版本、模块来源类别及包名/版本，不输出个人模块路径；其他测试日志和反馈附件仍需按发布流程检查。

需要分析已有 Session 时，用只读回放工具并自行准备 `zstd`：

```bash
node scripts/replay-session.mjs /absolute/path/session.v4.jsonl.zstd
```

回放输出只应用于本机排查。会话标识、工具名和指标也可能包含私人信息，不直接附到公开 issue；原始会话不放进源码、测试夹具或候选包。

## 实现约束

- Session 是请求上下文与 usage 的事实源，不持久化第二份完整请求或响应。
- 历史请求按实际模型调用边界重建，包含 `step/start` 后才加入的 system、user、header 和 developer 更新；不把当前步骤输出纳入它自己的输入。
- 比较模型实际收到的投影，覆盖历史工具更新和 deferred 激活位置；正常尾部追加不判为旧前缀失效。
- `inputTokens`、`cacheReadTokens`、`cacheWriteTokens` 是互不重叠的计数。缺失字段保留未知，不补为零。
- 未实际发送的空流取消不覆盖已知读数；实际末次回执缺少 usage 时保持未知，不沿用此前值。
- 门禁绑定同一会话、候选指纹和历史版本，明确确认后只放行一次；停止、卸载或确认过期均不能发送。
- 插件不注册模型工具、注入提示词、读取凭据或自动调用模型做原因分析。

## 数据接口语义

`analyzeSession(records, config)` 返回派生指标，不对前端返回完整上下文。内部分析函数会随候选演进，当前不承诺独立于宿主版本的稳定外部 API。

| 字段 | 语义 |
|---|---|
| `latest` | 会话最近一次实际调用的 usage；字段缺失保持未知 |
| `turns` | 每轮末次实际调用的轻量记录；`latest` 属于该轮，不能取会话累计替代 |
| `calls` | 按调用保留轮次、步骤、序号、用量和有限差异线索 |
| `cumulative` | 会话累计指标；按输入 Token 加权，存在未知缓存字段时完整累计率保持未知 |
| `warnings` | 旧前缀大规模实际 miss 的估计、观察到的差异和可能原因；恢复不会删掉历史 |
| `coverage` | 已覆盖适配路径及重建未知情况，不能据此宣称覆盖所有模型和附件 |

web 接口使用 DSH 现有浏览器认证，模型或 API operator 不能代替用户做费用确认：

| 方法与路径 | 请求或响应 |
|---|---|
| `GET /dsh-cache-helper/api/session?sessionId=...` | 会话指标与该会话 `pending`；分析失败时已有确认仍可见 |
| `GET /dsh-cache-helper/api/dashboard` | 有扫描上限的会话概要及覆盖范围 |
| `POST /dsh-cache-helper/api/decision` | `{sessionId, id, fingerprint, decision}`；`decision` 只接受 `confirm` 或 `cancel`，旧确认返回失效状态 |
| `POST /dsh-cache-helper/api/warnings/dismiss` | `{sessionId, id, dismissed}`；只改变指定会话中已存在告警的收起状态 |

服务端状态文件只保存版本与告警收起 ID。浏览器的异常筛选只保存布尔值；不要把正文或凭据加入这些状态。

## 修改后的最小回归

| 修改面 | 必须核对 |
|---|---|
| 用量或分组 | 多轮、多步骤、末次未知、空流取消和加权累计 |
| 请求重建或投影 | 生产适配器与假上游 wire 差分、system 更新、工具增删和 deferred 激活 |
| 确认门禁 | 确认前零请求；确认一次只发送一次；取消、停止、卸载、历史变化和并发隔离 |
| 界面 | 用量与时间之间的位置、原生用量按钮、窄窗、暗色、设置页和快捷看板 |
| 发布文件 | 干净目录安装、包内入口、许可、相对链接、隐私扫描和旧包回滚 |

安装验证只使用 web profile，放在任务间隙。先记录原版本和配置，保留回滚包，再试装候选；运行中的长会话不随意变更工具相关插件。

新插件首次从研究目录迁移公开时，才通过审核白名单建立独立历史；本插件的后续版本沿用现有仓库。精确 noreply 身份、远端、公共 npm 隔离和发布授权见[发行流程](RELEASING.md)。
