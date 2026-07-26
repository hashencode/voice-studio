# S3 第一产品化增量状态

决策：`S3-PRODUCTIZATION-2026-07-25`

## 结论

第一增量状态为 `PARTIAL_PASS`，完整 S3 为 `BLOCKED`，整体仍为
`NOT RELEASE-READY`。

这不是“只完成基础结构”：用户已经可以选择 `cloudDirect`、使用自己的
DeepSeek 账户、把密钥保存在 Android Keystore 边界内，并在每场会议明确同意后
生成可编辑、可复核、可追溯的结构化纪要。自动标题建议、三层摘要、议题、决策、
行动项、风险、未决项、六种场景模板加通用模板、证据回跳、审核/驳回/发布和修订
均已进入产品闭环。

后续平台方向已由 `DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26` 重新定基线：
桌面端是会议处理主工作站，手机继续作为可靠采集端和可独立使用的移动核心。
macOS 严格先行；Windows 在 macOS closure 前保持
`PLANNED`，且不能继承 macOS 的模型 PASS。

## 分项状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 云端直连 AI | `PASS` | DeepSeek adapter、Android Keystore 密钥、单场明确同意、批次预算、持久任务、取消和恢复已实现；live smoke 为可选且本轮未使用任何用户密钥 |
| 结构化会议纪要 | `PASS` | `meeting_intelligence_output/v1`、严格验证、证据约束、模板、编辑、审核和发布闭环已实现 |
| 端侧匿名说话人分离 | `DEFERRED_NO_ADMISSIBLE_CANDIDATE` | FP32 有界候选与唯一 INT8 fallback 均完成固定 Xiaomi 真机筛选并被淘汰；无产品入口 |
| PC 配对 provider | `DEFERRED_PC_RUNTIME_MISSING` | 安全协议 v1 已冻结；没有 PC runtime、移动 adapter、二维码扫描权限或入口 |
| 多语言/中英混说 | `DEFERRED_NOT_IMPLEMENTED` | 不在第一产品化增量中 |
| 完整 S3 | `BLOCKED` | 不能用云端直连和纪要闭环的 PASS 覆盖说话人、PC 和多语言缺口 |

## 说话人门禁

Paraformer 本身不返回说话人。再准入在 Xiaomi M2102J2SC
（Android 13/debug）上对同一固定 fixture、阈值和有界 30 秒窗口完成了两次
5 分钟筛选：

- FP32 Pyannote 候选完整处理 12 个窗口，覆盖率 92.235%、DER 13.689%，但
  overlap 与预注册静音诚实性失败；projected 120 分钟 RTF 为 2.3348。
- 量表唯一选中的 INT8 Pyannote fallback 完整处理 12 个窗口，覆盖率
  93.645%、DER 12.192%，并表达 overlap，但仍在预注册静音区间伪造归属；
  projected RTF 为 2.4020。
- 两者转写快照前后哈希一致，thermal 均为 none；INT8 没有达到 0.5 RTF，
  因此按计划不启动 120 分钟长探针，也不推进第三个候选。30 分钟探针继续
  `SKIPPED_BY_PLAN`。

状态因此为 `DEFERRED_NO_ADMISSIBLE_CANDIDATE`，同时保留
`failedGates=["FUNCTIONAL","RESOURCE","NO_ADMISSIBLE_CANDIDATE"]`。产品
service、路由、设置入口、人工修正 UI 和模型打包保持关闭，也不保存 voiceprint。

## paired-PC provider 与桌面主工作站边界

协议规定了短时 QR offer、公钥指纹、一次性 challenge、120 秒过期、能力协商、
job/idempotency/input hash、进度、取消、显式重试、严格结构化结果、加密认证传输
和 replay 拒绝。二维码永远不得承载 API key 或长期凭据。

协议存在不代表运行时存在。该 v1 协议继续只描述“转写片段到结构化纪要”，
保持 `DEFERRED_PC_RUNTIME_MISSING`；不得不兼容地扩展为原始音频传输或桌面
ASR。新的桌面主工作站 app、目标独立模型处理和局域网媒体交接由
`desktop-workstation-scope.json` 承接，不再把“PC runtime 缺失”等同于
桌面产品方向 deferred。

## 发布边界

ASR-005 仅保留为 `USER_PRE_RELEASE_ACCEPTANCE_ONLY`，由用户在发布前执行，
不进入开发任务、自动状态报告或阻塞列表。完整 S3、发布高端兼容性、EXP-005
正式包和发布交付仍未闭合，所以 preflight 必须继续返回
`NOT RELEASE-READY`。

机器可验证的权威状态位于
[`s3-productization-scope.json`](s3-productization-scope.json)。
