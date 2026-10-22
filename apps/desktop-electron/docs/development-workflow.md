# PC 端开发流程

适用范围：`apps/desktop-electron`。根 [AGENTS](../../../AGENTS.md) 的授权、规则发现和工作区约束继续生效。

## 开始任务

1. 在仓库根按拟改路径执行 `python3 tool/rules_for_change.py <paths>`，读取全部返回规范，再读本端 [架构](architecture.md) 和直接相关合同。
2. 先明确涉及 Renderer、Main / Preload、处理协议、worker 还是资源，按原规则选择影响范围；不要把局部任务默认扩大为全仓自检。
3. 在本端目录按当前 `package.json` 使用 Bun 脚本；已有运行方式见 [桌面指南](../README.md)。资源准备按当前资源合同选择，不因普通任务默认下载或重新打包。

## 运行与调试

- 根 AGENTS 要求本次任务明确授权后才可进行视觉验证；启动、控制应用和运行视觉测试均受该要求约束。
- 从当前 checkout 的项目脚本启动，按配置的 `electronDev.appId` 或准确 `.app` 路径选择应用，核对可执行文件归属；不启动裸 Electron。只清理本次启动的进程。
- Main / Preload / Renderer 各自按实际职责调试，保留原权限、生命周期和测试数据隔离。详细行为与身份以 [本端指南](../README.md)、[当前脚本](../package.json) 为准。

## 验证与交付

按 [本端验证入口](testing-standards.md) 选择检查，根 [验证政策](../../../docs/standards/verification.md) 仍是唯一详细政策。完成后按实际改动路径再次运行规则路由，保留历史证据，分别报告代码、视觉、原生、打包和发布范围。纯文档只检查差异与引用。
