# 开发候选与公开发行流程

本文件定义独立源码、提交身份、安装验证和公开发行的流程。构建与本地准备命令不自动创建 Git 仓库、提交、tag、Release、npm 发布或插件榜投稿；公开动作按当前任务的明确授权执行。已经明确授权的同一版本和目标渠道不重复询问。

本插件已使用独立公开仓库，并已发行 `0.1.2`、`0.2.0`、`0.3.0`。后续迭代沿用现有历史、身份和渠道；首次建仓、注册账号和榜单投稿不需要每版重做。发行记录、是否收录和本机是否升级仍按实际证据分别更新。

## 交付状态

| 状态 | 完成条件 |
|---|---|
| 本地候选 | 版本一致，干净构建、测试和包检查完成，生成可核对的 tgz |
| web 验证 | 候选安装到 web，确认读数、门禁、WARN、看板、停用、卸载与回滚 |
| 公开源码 | 首次迁移通过审核白名单建立独立历史；后续版本在同一仓库通过内容与身份检查后推送 |
| GitHub Release | 获授权后，上传已校验的预构建 tgz、校验值与对应版本说明，并下载验包 |
| npm | 目标账户与源正确，准确版本已公开，公共 tarball 与已验证候选的摘要及字节一致 |
| 插件榜 | 公开源码与可安装产物就绪后，按届时指南提交并等待收录 |

本地安装成功、测试通过或产物生成，都不能标记为已经公开发布。

## 已有独立仓库的每版流程

1. 在现有仓库的新工作分支修改唯一源码，按变更范围做日常验证。准备发行时更新版本、锁文件、README 和 CHANGELOG，记录升级、缓存影响及回滚方法。
2. 人工确认工作区内容与拟发布 commit 的对应关系，检查真实生效的 Git 身份。现有候选脚本记录源码内容摘要，但不会代替工作区干净检查，也不会自动绑定 commit 和 tag。
3. 按下节生成候选，完整检查只运行一次。冻结通过检查的 tgz、清单和 SHA-256；后续渠道复用该原包，不为同版本重新打包。
4. 完成候选的隔离 web 安装与行为验收，再按已有授权创建对应 tag 和发行。记录 GitHub Release 与 npm 各自的上传及公开下载结果。
5. 既有榜单条目只有元数据、仓库或下载地址变化时才需要按当时规则更新；每版仍需核对稳定下载地址与市场刷新状态。

已发行版本、tag 和资产不覆盖。后续文档或代码修订属于下一次待发行变更，不能重打或替换任何已发行版本。

## 本地候选流程

在源码目录先导出到一个尚不存在的新目录，再在该候选目录使用锁文件运行：

```bash
npm run prepare:release -- --out /absolute/path/cache-helper-candidate
cd /absolute/path/cache-helper-candidate
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npx --no-install playwright install chromium
npm run check:release
```

`prepare:release` 仅白名单导出，不安装依赖、不运行测试或创建 Git 仓库。候选只是构建投影，修复回到唯一源码仓后重新导出。源目录中若存在指向宿主 profile 的 `node_modules` 软链，不能在源目录执行 `npm ci`。候选目录单独安装锁定依赖与 Chromium，不改变运行中的 profile。没有宿主依赖软链的独立干净 checkout 也可直接检查，不要求重新创建历史。

`check:release` 内部已经运行完整 `npm test`，再执行构建、打包、解包及产物的原生/浏览器二次验证；标准候选无需在它前面重复跑完整测试。检查拒绝 `node_modules` 软链和旧的宿主模块路径环境覆盖。检查失败、浏览器未准备好或用例跳过时，不能标记完整通过。它不会安装到实际 web profile、创建提交或执行公开发布；web 试装仍按 README 单独验收。

该门禁是 cache-helper 专用实现，包含固定包名、入口、许可、宿主范围和测试集。其他插件复用流程时需要定义自己的契约；它不是已经通用化的发布器。

本地校验产物为：

```text
.release/dsh-cache-helper.tgz
.release/SHA256SUMS
.release/release-report.json
```

保留实际输出和检查结果，产物与报告不提交到源码历史。

每次候选至少记录版本、Node/DSH 版本、源码状态、测试通过/失败/跳过数量、web 验证范围、产物文件名、SHA-256 和完整打包清单。日志存本机，公开摘要使用脱敏结果。

打包前先干净构建。仅有源码、没有 `lib` 的包不能安装；在没有构建结果时直接运行 `npm pack --ignore-scripts` 可能生成缺入口的包。准备脚本应明确执行构建并校验产物，不能依赖安装端自动执行构建脚本。

## 候选包门禁

| 检查 | 要求 |
|---|---|
| 版本 | `package.json`、README、CHANGELOG、tgz 内清单和检查报告一致；仅本地生成时记录为候选，公开发行以实际 Release 为准 |
| 运行入口 | 包内包含 `lib` 的服务端和浏览器入口、bundle patch，以及所需的相对模块 |
| 依赖 | 宿主包使用声明的 peer 范围，开发依赖与锁文件可重现；不捆绑另一份宿主或 React |
| 兼容性 | 使用宿主识别的 `engines.dsh`；运行依赖另由 peers 声明，版本范围与实际验证分别陈述 |
| 文档与许可 | README、LICENSE、CHANGELOG 和其引用的本地文档在包内，链接均可解析 |
| 隐私 | 包内没有凭据、个人绝对路径、原始会话文件或未经授权的私人/公司信息；演示图逐张审核 |
| 内容清单 | 逐项核对 `npm pack --dry-run --ignore-scripts`；包含的每个文件都有用途 |
| 可安装性 | 从独立临时目录检查候选；安装验证只进 web，不修改日常桌面 profile |

自动化测试截图使用合成会话和合成标题。真实会话仅在所有者明确授权后用于功能演示，截图保留必要行为与实际指标，原始 Session 不导出。发布前复核整个画面及裁切范围中的内容，检查账号、余额、认证链接、目录和会话标识；裁切本身不能替代审查。每张图的来源与授权范围记录在图片说明中。

现有内容扫描覆盖常见个人路径、邮箱、私钥、部分 GitHub/API 凭据模式、`npm_` 前缀 Token 和锁文件源；本机 `localhost`、IPv4/IPv6 回环 URL 中的非空认证参数、片段 Token 及用户名/密码也会阻断。错误只报告文件、行号和规则，不输出匹配值。

源码导出与运行包采用相同的敏感路径规则：拒绝 `.npmrc`、`.yarnrc`、常见凭据/密钥文件、profile/Session 存储目录以及 JSONL 日志（含压缩形式），`docs/` 也不能绕过。说明文档可以描述这些文件名；不能把文件本身放入允许目录后导出。合成回归在运行时拼接测试 Token、URL，并在临时目录创建负例。

这些检查只覆盖已列明的形态，不能识别所有远端认证 URL、任意编码的秘密或改名后的真实会话；图片仍需逐张审核。目录白名单也不等于逐文件已经审核，`.gitignore` 和模式扫描通过均不能代替源码/包清单与素材审查。新增凭据形态或导出目录时，应补相应门禁与合成负向测试，不得据此宣称没有隐私信息。

## 新插件首次迁移与注册

以下仅适用于尚未拥有独立公开仓库的新插件。先确定公开包名、仓库、许可、宿主契约和分发渠道，从研究目录的审核白名单建立独立历史。GitHub 登录/SSH 权限、Git 提交署名和 npm 账号分别管理，不把公司全局 Git 或 npm 配置切换为个人配置。

需要 npm 时，使用个人账号并在注册前知悉维护者邮箱会出现在公共包元数据中；由本人完成密码、邮箱验证、服务条款与 2FA。密码、验证码、恢复码和 Token 不进入源码、聊天、截图或公开日志。已有可用账号和独立认证配置时，日常发行只核对身份；按 npm 要求重新认证，无须重复注册。

从插件目录向空的独立目录复制已审查文件，首次公开源码使用新的 Git 历史；后续版本保留这个历史。cache-helper 当前源码白名单为：

```text
.gitignore
.github/
package.json
package-lock.json
cordis.patch.yml
README.md
LICENSE
CHANGELOG.md
screenshots.json
src/
scripts/
tests/
docs/
```

目录条目仍须逐文件审核，`.github/` 中只保留已审核的独立 CI 配置，`screenshots.json` 只列出经复核的公开素材；真实素材另须有所有者授权和脱敏记录。后续新增目录或公开素材时，先更新白名单和隐私检查，再加入导出。保留 `package-lock.json`，不要用忽略全部 JSON 或锁文件的方式避免泄露。

研究目录的 Git 历史、`.git`、宿主源码镜像、实验、原始会话、profile、缓存、`node_modules`、构建结果和本地测试输出均不进入公开源码导出。预构建 `lib` 进入 tgz，生成的 tgz 与检查报告留在本地发布输出目录。

复制前后分别扫描文件内容与文件名。检查个人路径、邮箱、会话标识、认证 URL、凭据格式和截图；对仓库地址、安装命令和相对链接做独立目录检查。不要复用现有研究仓库的 commit 历史作为公开仓库历史。

## 公开提交身份门禁

当前公开署名为 `ghang`，许可证年份为 2026。公开包的作者信息使用公开 handle，不写个人 Gmail 或公司邮箱。

精确 noreply 邮箱需要本人从 GitHub 的 **Settings → Emails** 复制。账号名称不足以推导该地址，不能猜用户 ID 或邮箱格式。该值尚未确认时，可以继续本地构建和验包，公开提交门禁保持未完成。

新独立仓库首次提交前，仅在该仓库设置本地身份；已有仓库先核对既有局部配置，不重新建仓或更改全局配置。下例的 `PUBLIC_NOREPLY_EMAIL` 必须先设为已核对的精确值：

```bash
git config --local user.name ghang
git config --local user.email "$PUBLIC_NOREPLY_EMAIL"
git config --local user.useConfigOnly true
```

在该独立仓库根目录运行只读身份门禁；必须显式传入同一个已确认的值：

```bash
PUBLIC_GIT_EMAIL="$PUBLIC_NOREPLY_EMAIL" npm run check:identity -- --all
```

`--all` 检查所有本地引用与 HEAD 可达的提交，并检查可达的附注 tag 和提交中的邮箱 trailer；不覆盖不可达对象或仅存在于 reflog 的历史。检查拒绝浅克隆，首次公开前应使用完整、独立的新历史。缺少精确身份会阻断该门禁，不阻断纯本地构建。

不改全局或公司的 Git 配置。首次提交和后续每次公开提交前，同时核对：

- 当前仓库确实是白名单导出的独立目录，暂存区没有研究仓库或私人文件。
- 仓库本地配置已写入准确 noreply 值，实际 author 与 committer 均匹配预期。
- `GIT_AUTHOR_EMAIL`、`GIT_COMMITTER_EMAIL` 等环境覆盖没有换回其他身份；只设置 `user.useConfigOnly` 不能代替实际身份核对。
- 身份检查日志仅输出通过/失败，不把不匹配的邮箱打印到公开 CI、issue 或发布日志。
- 远端 URL 是本人确认的公开目标，未继承研究仓库或公司的 remote。

通过这些检查之后，才进入后续获授权的 commit、tag、push 或发布操作。对已有历史的身份审查应覆盖 author 和 committer；修改最新提交不能消除更早历史中的身份信息。

## GitHub Release 与原包冻结

使用已验证的预构建 tgz 作为 GitHub Release 附件。稳定资产名为 `dsh-cache-helper.tgz`，同时提供 `SHA256SUMS`，以保持已有 `latest/download` 地址可用。旧 tag 的资产保留；公开安装说明指向实际存在且校验过的产物，仓库 URL、tag 和版本号按最终事实填写。

上传前对最终候选再核对一次文件清单、许可证、版本、SHA-256、身份门禁与 web 验收结果。发布说明注明已验证的 DSH 版本、功能和边界、升级方式与回滚方法。发布后再验证公开安装地址；只有取得公开地址并通过安装验证，才更新 README 的发行状态。

优先使用已认证个人账号的 GitHub CLI，凭据有效时不重复网页登录。先查 `gh api user --jq .login`；Git SSH 登录与 Release API 权限分别核对。使用既有个人附注 tag 和 `gh release create <tag> --verify-tag --draft --notes-file <说明文件>` 创建草稿，再用 `gh release upload` 上传冻结 tgz 与 SHA256SUMS，下载验包后以 `gh release edit <tag> --draft=false --latest` 发布，最后匿名下载复验。所有命令显式指定 `--repo ghang/dsh-cache-helper`，不使用覆盖参数。

使用外部发行工具时也必须验证准确 source commit、候选报告与包摘要、远端个人 tag 对象，以及该 SHA 的成功分支 CI 和两个 Node job。分支 push/PR 执行完整门禁；tag push 不再重复跑同一候选，tag 身份由发行步骤独立复核。成功 job 额外保留实际 tgz 14 天；该 workflow 调整尚需下一次推送后观察。

中断后先读准确 tag 的真实 Release/资产状态；草稿只补缺失且未冲突的附件，已正式发行只核验。401/403/限流不能当成不存在，结果不确定不能直接重发；同名不同摘要保留现场并停止，不删除或覆盖旧包。[CLI 官方说明](https://cli.github.com/manual/gh_release_create)，核查日期 2026-10-26。

每次公开提交前核对精确 noreply、实际仓库/远端和本次发布授权。新建榜单条目时复核届时指南中的仓库年龄、topic、分类、描述和 tarball 字段；只改本插件条目，检查通过、维护者合并与市场实际可见分别验收。

## npm 官方公共源发行

以下为手动终端流程，不是已经实现的统一发行命令。使用独立个人 userconfig、空 globalconfig、空工作目录、明确的 `https://registry.npmjs.org/` 和独立 cache；保留公司 npmrc 与认证。执行前后只在本机核对原配置和默认源是否一致，公开报告不输出私有源或凭据。

独立配置第一次创建时，目录权限设为 `0700`、文件为 `0600`；已有配置不清空、不复制进仓库。下例的 cache 与工作目录留在仓库外：

```bash
PUBLIC_NPMRC="$HOME/.config/dsh-plugin-release/npmrc"
PUBLIC_NPM_CACHE="$HOME/.cache/dsh-plugin-release/npm"
PUBLIC_NPM_WORK="$(mktemp -d)"

mkdir -p "$HOME/.config/dsh-plugin-release"
chmod 700 "$HOME/.config/dsh-plugin-release"
touch "$PUBLIC_NPMRC"
chmod 600 "$PUBLIC_NPMRC"
cd "$PUBLIC_NPM_WORK"
```

每次 npm 子进程都过滤 `npm_config_*` 环境覆盖和常见认证环境变量，不打印这些值。下例用于 macOS/POSIX 交互终端，不作为 Windows 支持承诺。可以在当前终端定义临时函数；过滤只作用于子进程，它保留 stdin/stdout 的终端连接，不改写父 shell 的认证环境或公司配置：

```bash
public_npm() {
  node --input-type=module -e '
    import { spawnSync } from "node:child_process";
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^npm_config_/i.test(key) &&
      !["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_AUTH_TOKEN"].includes(key)));
    const result = spawnSync("npm", process.argv.slice(1), { env, stdio: "inherit" });
    if (result.error) console.error("npm process could not start");
    process.exitCode = result.status ?? 1;
  ' -- "$@" \
    --registry=https://registry.npmjs.org/ \
    --userconfig="$PUBLIC_NPMRC" --globalconfig=/dev/null \
    --cache="$PUBLIC_NPM_CACHE" --update-notifier=false
}
```

1. 需要登录时执行 `public_npm login --auth-type=web`，随后执行 `public_npm whoami` 核对本次授权的个人账号。浏览器登录成功不替代 CLI 身份检查；不对公司 registry 执行 whoami。
2. 发布前核对包名归属、版本、仓库字段、SHA-256 和冻结的候选清单。`publish --dry-run` 只能预演，不能证明权限、包名预留或实际发行。上一请求结果不确定时，先查询准确版本；同版本已存在且字节一致就做下载复验，内容不同则停止排查，不能覆盖或擅自改版本重发。
3. 在真实交互终端执行下例，并按 npm 提示完成本次 2FA。不要把 publish 的 stdin/stdout 改为管道，也不要使用 heredoc 给承载交互认证的 Node 进程传脚本；这会失去 TTY。认证链接和验证码不放入公开日志。只读查询可以使用 JSON 输出。

```bash
ARTIFACT="/absolute/path/dsh-cache-helper.tgz"
EXPECTED_VERSION="<本次已核对的版本>"
public_npm publish "$ARTIFACT" --access=public --ignore-scripts
public_npm view "dsh-cache-helper@$EXPECTED_VERSION" \
  version dist.tarball dist.integrity dist.shasum --json
```

4. 命令退出 0 后，等待准确版本实际公开，再从公共元数据返回的 tarball 地址下载原包；核对包名/版本、SHA-256、`dist.integrity`、`dist.shasum` 及与已验证候选的字节一致性，保存脱敏回执。已有同一 tgz 的安装证据可以复用；更改或重建过产物则重新验证。
5. npm 存在发布后安全扫描等待，短暂 404 或占位版本不能直接判为上传失败或需要人工审批。先查准确版本和真实 staged 记录，按间隔重试只读查询；等待超出本轮观察窗口时记录“已上传、公开可用待验证”，不要重复上传、更改版本或标记完成。扫描耗时不构成可用性承诺。[官方说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)，核查日期 2026-10-22。

当前候选 manifest 已加入公共 registry 的 `publishConfig`，作为发布目标的第二层约束；它不代替 userconfig、环境过滤和真实身份核对。已发行 `0.1.2` 原包保持冻结：

```json
"publishConfig": {
  "registry": "https://registry.npmjs.org/",
  "access": "public"
}
```

可信发布者/OIDC、staged publishing 或新增发布权限属于另外的设置，不是现有自动化能力，也不能因为遇到认证问题就自动开启或降低 2FA。

## 现有自动化与后续缺口

| 能力 | 当前状态 |
|---|---|
| 审核白名单导出 | `prepare:release` 已实现；只导出，不安装或公开发布 |
| 本地完整候选检查 | `check:release` 已实现；包含完整源码和实际解包产物回归，输出内容摘要及报告 |
| 真实 Git 身份检查 | `check:identity` 已实现；本地发行者提供已核对的精确 noreply，CI 定义显式使用同一个公开身份 |
| 远端 CI | Node 22.19.0 / 24.18.1 分支 push/PR 检查实际提交身份与完整候选，并留存报告/校验值和成功 tgz；tag 改为复用准确 SHA 的成功分支 run，由发行者独立查 tag。workflow 调整尚未推送；没有自动公开发行步骤 |
| GitHub 发行 | 可由外部参数化工具串起账号、来源/报告/包、tag、CI、草稿、缺失附件、下载验包与回执；本仓不内置 Lab 工具，也不自动创建仓库、tag 或 push |
| 跨渠道统一发行 | 尚未实现：npm 仍按独立配置和真实 TTY/2FA 执行，扫描/公开核验、市场与安装分别验收；GitHub 工具不能标记这些渠道完成 |
| 其他插件复用 | 当前是流程和契约复用；专用包名、入口、宿主兼容测试和隐私模式不能假定通用 |

现有自动化输出是本地候选状态；GitHub Release、npm、榜单合并、市场可见和本机升级由各自证据确认。新会话先核对源码/版本/运行来源与对应回执，再处理未完成阶段。
