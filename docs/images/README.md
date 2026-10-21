# 演示图片来源

## 真实会话示例

采样日期：2026-10-21。会话所有者明确授权用“DeepSeek Harness 插件依赖修复与回滚”展示实际效果。只通过浏览器读取已有会话，不发送新模型请求、不改写读数，也不导出原始 Session。

- [独立缓存看板](real-cache-dashboard.png)：主展示图。顶部统计覆盖已扫描的 25 个会话，右侧展示所选真实会话的 4 次异常；两处会话标识和一处目录已用不透明色块遮挡。仅处理图片，未修改产品界面。
- [末次缓存与 WARN](real-turn-cache.jpg)：第 16 轮末次调用为 636.4k tok、99.69%，保留此前 4 次缓存失效的 WARN。
- [实际异常步骤](real-cache-misses.jpg)：展示第 3、7、15、16 轮首步的实际回执与工具变化线索，其中第 15、16 轮命中率约为 0.4%、1.4%。

截图由浏览器按功能区域截取。独立看板使用 imagegen 作局部遮挡并放大，逐项核对实际调用时间、用量与原因提示；另两张保留原始截图像素。公开范围已逐张复核，不含账号联系方式、账户余额、认证链接、可读的个人绝对路径或会话 UUID。README 和 `screenshots.json` 使用这三张真实示例；原始 Session 和未打码的看板截图不进入公开仓库。

## 合成回归示例

生成日期：2026-10-21。以下三张图片由 `tests/client.test.mjs` 的临时 localhost 夹具生成，使用固定的演示会话、工具名和用量；不读取真实 Session、个人账户、凭据或运行中的 profile，也不连接模型服务。

- [逐轮读数与 WARN](turn-footer.png)：缓存读数位于原生用量后、时间前；WARN 位于模拟输入框上方。
- [快捷缓存看板](cache-dashboard.png)：演示异常步骤、工具变化线索和后续恢复状态。
- [设置页入口](settings-dashboard.png)：在模拟原生设置中显示内嵌缓存看板。

这些图片展示测试夹具中的真实插件组件。宿主布局使用带来源与 MIT 许可的最小样式快照，不能将图片当作对所有 DSH 版本界面的兼容证明。

重新生成时，在已装锁定开发依赖和 Playwright Chromium 的独立候选目录运行：

```bash
DSH_CLIENT_TEST_SCREENSHOT_VIEWPORT=1280x900 \
DSH_CLIENT_TEST_FOOTER_SCREENSHOT=docs/images/turn-footer.png \
DSH_CLIENT_TEST_SCREENSHOT=docs/images/cache-dashboard.png \
DSH_CLIENT_TEST_SETTINGS_SCREENSHOT=docs/images/settings-dashboard.png \
node --test tests/client.test.mjs
```

生成后复核整个画面，再更新源码中的图片。发布校验不生成或改写这些图片，以便源码摘要对应已审核文件。
