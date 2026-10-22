# AI 开发文档导航

- 仓库规则与授权以根 [AGENTS.md](../../AGENTS.md) 为入口；本页提供统一的文档位置，不替代原规则发现流程。
- 修改前用拟改路径执行 `python3 tool/rules_for_change.py <paths>`，读取它返回的每份文档；完成前按实际改动路径再次执行。需要任务标签时按原规则使用，不在本页维护第二份路径或标签匹配表。
- [规则总览](../standards/README.md) 解释当前权威；[验证政策](../standards/verification.md) 决定检查范围和证据边界。文档变更只检查差异与引用，不运行产品测试、构建或 GUI。
- 接口资料见 [API / 契约导航](../api/README.md)，其他资料见 [文档总导航](../README.md)。当前代码、原业务合同与用户明确决定仍按原职责负责，不由历史计划或来源项目推导新需求。

## 保留的目录与命名

`docs/standards/`、`rules-index.json` 及路由工具保留原位。持续规则和验证政策继续在该目录单点维护，不另建同内容的 `development-rules.md` 或 `testing-standards.md`。架构、产品、解决方案、计划和验收资料保持原路径、来源与状态。

## 先选择应用范围

- [PC 端文档](../../apps/desktop-electron/docs/README.md)：本端架构、开发与验证入口。
- [App 端文档](../../apps/mobile-flutter/docs/README.md)：本端架构、开发与验证入口。

在原规则路由返回的规范之外，读取目标应用的本地文档；涉及共享包、原生或跨端协议时，再读对应根合同。局部文档不覆盖根授权，根验证政策与机器路由仍单点维护，不向其他端推广某一端的组件、存储或启动规则。
