# App 端架构

适用范围：`apps/mobile-flutter`。根 [AGENTS](../../../AGENTS.md) 的授权、规则发现和工作区约束继续生效。

本目录是当前 Android Flutter 应用。移动端 UI、平台组合和持久化按本端职责维护，Electron 桌面进程及其原生 worker 不作为移动端实现模板。

## 模块与职责

| 入口 | 职责 |
| --- | --- |
| [App 组合与路由](../lib/app) | 应用装配、路由、平台接口与主题 |
| [功能模块](../lib/features) | 录音、导入、音频工作区、转写、Companion、智能处理等现有功能 |
| [本地持久化](../lib/data/sqlite) | 本端数据访问，按现有数据库和业务合同维护 |
| [音频领域](../../../packages/audio_core) | 共享领域值；不承载 Electron UI |
| [音频工作流](../../../packages/audio_workflows) | 平台独立的音频工作流边界 |
| [音频存储](../../../packages/audio_storage) | 音频 SQLite schema 与数据库工厂 |
| [处理合同](../../../packages/processing_contracts) | 版本化的处理任务和结果合同 |
| [跨设备协议](../../../packages/companion_protocol) | 安全媒体传输协议 |

## 平台、接口与设计

跨设备与供应方消息见 [根协议导航](../../../docs/api/README.md)；移动能力与已有布局记录见 [能力矩阵](../../../docs/product/mobile-capability-matrix.md)、[布局记录](../../../docs/product/mobile-flutter-layout.json)，保留原日期与证据范围。具体实现以当前源码和明确产品决定交叉核对。

Flutter 界面按根 [Flutter 规范](../../../docs/standards/flutter-ui.md) 和使用方实际可导入的 Goo API 核对；不套用 Electron 的组件和布局规范。共享协议和原验收记录继续集中维护，本页不复制 schema 或建立新的状态机。
