# 项目文档导航

音频与会议项目；规则路由、视觉验证授权、资源和处理合同继续按原规范执行。

## 常用入口

| 内容 | 入口 |
| --- | --- |
| 仓库规则与授权 | [../AGENTS.md](../AGENTS.md) |
| 按任务读取开发文档 | [ai/README.md](ai/README.md) |
| 核心开发规范 | [development-rules.md](ai/development-rules.md) |
| 接口、协议或资源契约 | [api/README.md](api/README.md) |
| 验证要求 | [standards/verification.md](standards/verification.md) |
| 启动与项目说明 | [../README.md](../README.md) |

## 文档目录

- [ai/](ai/README.md)：按任务选择开发规则，不保存第二份业务接口或验收结论。
- [api/](api/README.md)：原接口和协议的索引；详细合同保持原有权威。
- [architecture/](architecture/)：架构、协议与技术决定。
- [standards/](standards/)：现有规则路由及详细规范。
- [contracts/](contracts/)：既有协议 schema 或资源契约。
- [product/](product/)：产品范围、状态与原验收证据。
- [plans/](plans/)：保留原日期和范围的实施计划。
- [solutions/](solutions/)：已解决问题与适用范围。
- [brainstorms/](brainstorms/)：需求与方案探索。
- [ideation/](ideation/)：产品探索资料。
- [model-distribution/](model-distribution/)：模型分发及资源资料。

## 命名与维护

- `README.md` 用于入口；核心开发规范统一使用 `ai/development-rules.md`，需要独立维护的开发流程使用 `ai/development-workflow.md`，测试标准使用 `testing-standards.md`。已有专题或工具权威按下述例外保留，不为凑齐名称新增空文件或重复政策。
- 新增普通 Markdown 文件使用英文小写和短横线，以具体主题命名；计划、审计与验收记录按 `YYYY-MM-DD-主题.md` 命名。持续维护的规范不加日期，工具要求的文件名和既有历史记录不批量改名。
- 同一规则只维护一份正文，其他入口通过链接引用。文档中的相对链接以所在文件为基准；明确标注为仓库代码路径的内容以根目录为基准。改名或移动前检查正文职责、链接、脚本和规则路由消费者，同步修复有效引用。
- 当前规则、实施计划和验收证据分开维护；历史记录保留原日期、环境、来源、未验证项和结论。本次目录整理不代表重新验收，也不扩大组件库、工作树、设备或生产操作授权。

## 本项目保留的结构

- `ai/development-rules.md` 是统一核心入口；`standards/` 保留专项规则与验证政策，`rules-index.json` 和原工具仍是唯一路由，不迁移或复制。

## 应用与共享包

| 范围 | 本地文档入口 |
| --- | --- |
| PC 端 `apps/desktop-electron` | [应用文档](../apps/desktop-electron/docs/README.md) |
| App 端 `apps/mobile-flutter` | [应用文档](../apps/mobile-flutter/docs/README.md) |

本表只导航文档位置，不是第二份规则匹配表。适用规范继续由原规则路由选择；根文档维护共同约束、共享协议和跨端资料，应用 docs 维护端内架构和流程。`packages/`、原生实现与功能模块不逐个建立 docs，有必要时保留包 README 或链接现有根专题。历史记录和工具引用的原权威保持原位。
