# 接口与协议导航

本项目包含跨设备、处理工作流和桌面接口；本目录不假设存在统一业务 HTTP 后端，也不另写协议副本。

| 范围 | 原合同与实现入口 |
| --- | --- |
| 音频智能供应方 | [供应方协议](../architecture/audio-intelligence-provider-protocol.md)、[schema](../contracts/audio-intelligence-provider-v1.schema.json) |
| Companion 音频传输 | [协议 v2](../architecture/companion-audio-transfer-v2.md)、[schema](../contracts/companion-audio-transfer-v2.schema.json)、[协议包](../../packages/companion_protocol) |
| Companion 媒体传输 | [协议 v1](../architecture/companion-media-transfer-v1.md)、[schema](../contracts/companion-media-transfer-v1.schema.json) |
| 桌面运行时边界 | [Runtime boundaries](../architecture/desktop-runtime-boundaries.md)、[Preload](../../apps/desktop-electron/src/preload)、[共享接口](../../apps/desktop-electron/src/shared) |
| 处理合同 | [processing_contracts](../../packages/processing_contracts)、[audio_workflows](../../packages/audio_workflows) |

接口改动读取对应合同、当前调用方与测试，并使用现有规则路由找到适用规范。架构说明与 schema 不替代实际代码、当前产品决定或目标设备证据；历史产品状态和验收记录保留原位。视觉验证仍须根 AGENTS 要求的本次明确授权。
