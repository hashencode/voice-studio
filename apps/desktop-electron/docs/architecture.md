# PC 端架构

适用范围：`apps/desktop-electron`。根 [AGENTS](../../../AGENTS.md) 的授权、规则发现和工作区约束继续生效。

当前 macOS PC 应用采用 Electron、React / TypeScript 与独立 Main / Preload / Renderer 边界；移动端 Flutter 的布局和运行规则不用于本端。

## 进程与职责

| 位置 | 职责 |
| --- | --- |
| [Main](../src/main) | 桌面业务与平台编排、权限、资源或文件入口 |
| [Preload](../src/preload) | 提供受控桥接，保留现有请求与返回合同 |
| [Shared](../src/shared) | 可序列化跨进程接口与共享类型 |
| [Renderer](../src/renderer) | React / TypeScript 展示与交互，特权能力经原桥接调用 |

## 音频与原生边界

- [desktop_sherpa_worker](../../../packages/desktop_sherpa_worker) 承担隔离的桌面原生处理实现，处理消息与终态核对 [processing_contracts](../../../packages/processing_contracts)；不能从 UI 状态推断原生任务已完成。
- 桌面运行边界、采集和音频上下文分别见 [运行边界](../../../docs/architecture/desktop-runtime-boundaries.md)、[会议采集](../../../docs/architecture/desktop-live-meeting-capture.md)、[音频上下文](../../../docs/architecture/electron-audio-context-shell.md)。原详细合同保留原位，不在此复制字段或状态机。
- 跨设备与供应方协议仍由 [根协议导航](../../../docs/api/README.md) 索引；不能将桌面 worker、移动端存储或历史 Flutter Desktop 当作可互换运行时。

## 设计与证据

界面来源、可用组件和状态行为按 [Electron 规范](../../../docs/standards/electron-renderer.md) 及原 [桌面指南](../README.md) 阅读；具体产品与视觉记录按其原日期和适用范围解释，不从本页建立新的几何值或通过结论。
