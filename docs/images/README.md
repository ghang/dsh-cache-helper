# 合成演示图片

生成日期：2026-10-21。图片由 `tests/client.test.mjs` 的临时 localhost 夹具生成，使用固定的演示会话、工具名和用量；不读取真实 Session、个人账户、凭据或运行中的 profile，也不连接模型服务。

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
