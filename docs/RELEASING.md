# 发布准备

本文件定义独立源码、提交身份、安装验证和公开发行的流程。构建与本地准备命令不自动创建 Git 仓库、提交、tag、Release、npm 发布或插件榜投稿；公开动作按当前任务的明确授权执行。

## 交付状态

| 状态 | 完成条件 |
|---|---|
| 本地候选 | 版本一致，干净构建、测试和包检查完成，生成可核对的 tgz |
| web 验证 | 候选安装到 web，确认读数、门禁、WARN、看板、停用、卸载与回滚 |
| 公开源码 | 通过隐私与提交身份门禁后，从独立白名单创建新的公开源码历史 |
| GitHub Release | 获授权后，上传已校验的预构建 tgz、校验值与对应版本说明，并下载验包 |
| npm | 可选渠道；另行核对账户、包名、授权与公开元数据 |
| 插件榜 | 公开源码与可安装产物就绪后，按届时指南提交并等待收录 |

本地安装成功、测试通过或产物生成，都不能标记为已经公开发布。

## 本地候选流程

在源码目录先导出到一个尚不存在的新目录，再在该候选目录使用锁文件运行：

```bash
npm run prepare:release -- --out /absolute/path/cache-helper-candidate
cd /absolute/path/cache-helper-candidate
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npx --no-install playwright install chromium
npm test
npm run check:release
```

`prepare:release` 仅白名单导出，不安装依赖、不运行测试或创建 Git 仓库。源目录中若存在指向宿主 profile 的 `node_modules` 软链，不能在源目录执行 `npm ci`。候选目录单独安装锁定依赖与 Chromium，不改变运行中的 profile。

`check:release` 自动运行完整测试、构建、打包、解包及产物的原生/浏览器二次验证；拒绝 `node_modules` 软链和旧的宿主模块路径环境覆盖。检查失败、浏览器未准备好或用例跳过时，不能标记完整通过。它不会安装到实际 web profile、创建提交或执行公开发布；web 试装仍按 README 单独验收。

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
| 隐私 | 包内没有个人路径、私人会话标题/标识/正文、凭据、真实运行截图或公司内部资料 |
| 内容清单 | 逐项核对 `npm pack --dry-run --ignore-scripts`；包含的每个文件都有用途 |
| 可安装性 | 从独立临时目录检查候选；安装验证只进 web，不修改日常桌面 profile |

测试截图使用合成会话和合成标题。公开证据只展示必要的行为与指标，发布前复核整个画面；不能把真实会话截图裁一角就默认视为脱敏。

## 独立源码白名单

从插件目录向一个空的独立目录复制已审查文件，公开源码使用新的 Git 历史。当前源码白名单为：

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

目录条目仍须逐文件审核，`.github/` 中只保留已审核的独立 CI 配置，`screenshots.json` 只列出经过复核的合成素材。后续新增目录或公开素材时，先更新白名单和隐私检查，再加入导出。保留 `package-lock.json`，不要用忽略全部 JSON 或锁文件的方式避免泄露。

研究目录的 Git 历史、`.git`、宿主源码镜像、实验、原始会话、profile、缓存、`node_modules`、构建结果和本地测试输出均不进入公开源码导出。预构建 `lib` 进入 tgz，生成的 tgz 与检查报告留在本地发布输出目录。

复制前后分别扫描文件内容与文件名。检查个人路径、邮箱、会话标识、认证 URL、凭据格式和截图；对仓库地址、安装命令和相对链接做独立目录检查。不要复用现有研究仓库的 commit 历史作为公开仓库历史。

## 公开提交身份门禁

当前公开署名为 `ghang`，许可证年份为 2026。公开包的作者信息使用公开 handle，不写个人 Gmail 或公司邮箱。

精确 noreply 邮箱需要本人从 GitHub 的 **Settings → Emails** 复制。账号名称不足以推导该地址，不能猜用户 ID 或邮箱格式。该值尚未确认时，可以继续本地构建和验包，公开提交门禁保持未完成。

后续获准创建独立 Git 仓库后，仅在该仓库设置本地身份。下例的 `PUBLIC_NOREPLY_EMAIL` 必须先设为已核对的精确值：

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

## 后续公开发布

优先使用已验证的预构建 tgz 作为 GitHub Release 附件；npm 为可选渠道。公开安装说明要指向实际存在且校验过的产物，仓库 URL、tag 和版本号都按最终事实填写，不预写尚未创建的地址。

上传前对最终候选再核对一次文件清单、许可证、版本、SHA-256、身份门禁与 web 验收结果。发布说明注明已验证的 DSH 版本、功能和边界、升级方式与回滚方法。发布后再验证公开安装地址；只有取得公开地址并通过安装验证，才更新 README 的发行状态。

每次公开提交前核对精确 noreply、实际仓库/远端和本次发布授权。npm 是可选渠道，需要单独核对目标账号与包名；本地准备脚本不猜测身份或自动创建远端。
