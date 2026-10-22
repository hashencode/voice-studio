# AI 开发文档导航

核心开发规范统一在 [development-rules.md](development-rules.md) 维护。先遵守根 AGENTS 的授权边界，再读取该文件及本导航指定的适用资料；本导航不另维护第二份规则正文。

- 仓库规则与授权以根 [AGENTS.md](../../AGENTS.md) 为入口；本页提供统一的文档位置，不替代原规则发现流程。
- 修改前用拟改路径执行 `python3 tool/rules_for_change.py <paths>`，读取它返回的每份文档；完成前按实际改动路径再次执行。需要任务标签时按原规则使用，不在本页维护第二份路径或标签匹配表。
- [规则总览](../standards/README.md) 解释当前权威；[验证政策](../standards/verification.md) 决定检查范围和证据边界。文档变更只检查差异与引用，不运行产品测试、构建或 GUI。
- 接口资料见 [API / 契约导航](../api/README.md)，其他资料见 [文档总导航](../README.md)。当前代码、原业务合同与用户明确决定仍按原职责负责，不由历史计划或来源项目推导新需求。

## 保留的目录与命名

`docs/standards/`、`rules-index.json` 及路由工具保留原位。核心开发规范入口统一为 `development-rules.md`，专项规则和验证政策继续在原目录单点维护，不复制第二份正文或机器路由表。架构、产品、计划和验收资料保持原路径、来源与状态；专题经验直接保存在 `docs/` 根目录，入口见 [文档总导航](../README.md#专题经验)，来源与验收状态保留。

## 先选择应用范围

- [PC 端文档](../../apps/desktop-electron/docs/README.md)：本端架构、开发与验证入口。
- [App 端文档](../../apps/mobile-flutter/docs/README.md)：本端架构、开发与验证入口。

在原规则路由返回的规范之外，读取目标应用的本地文档；涉及共享包、原生或跨端协议时，再读对应根合同。局部文档不覆盖根授权，根验证政策与机器路由仍单点维护，不向其他端推广某一端的组件、存储或启动规则。

## 经验与记忆入口

正式案例见 [专题经验](../README.md#专题经验)，专题 Markdown 直接保存在 `docs/` 根目录；候选与历史记录按下文入口查阅。

[经验与记忆维护](development-rules.md#经验与记忆维护) 统一规定按需复核、候选确认、正式承接与去重；本项目不设置定时复核。

本轮存量整理已完成，逐项结果见 [结项记录](../plans/2026-10-22-memory-cleanup-proposals.md)。已保留的经验、设计来源与验收证据不再列为下一批；未来新候选或新清理范围仍须按核心规范确认。

目录位置见 [Agent 工作目录](../../.agents/README.md)；候选与存量入口见 [.agents/memories/README.md](../../.agents/memories/README.md)，临时材料放在 `.agents/tmp/`。
