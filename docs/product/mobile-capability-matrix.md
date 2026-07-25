# 移动端能力矩阵

更新时间：2026-07-25

本表描述当前仓库能够运行和验证的移动端能力，不把设计入口、历史实验或未来规划视为已交付。状态变更必须同时具备代码、自动化检查和相应真机证据。

范围决策 `S2-MOBILE-CORE-2026-07-25`：移动端保持 Paraformer 基础闭环。
自动 confidence、解码热词、高级 ITN、GTCRN/AEC 与外接麦克风真机验收
均为 `DEFERRED_NOT_PASSED`，不再作为 S2 Mobile Core 强制门禁，也不得
描述为已交付。Mobile Core 当前仅因 ASR-005 独立听审保持 BLOCKED；整体
仍为 NOT RELEASE-READY。

| 能力 | 当前状态 | 目标阶段 | 当前证据 | 明确边界 |
| --- | --- | --- | --- | --- |
| 单一正式运行基线 | 已实现，自动化验证通过 | S0 | 无 Flutter/Android Flavor；`dev_check --with-build`、runtime contract、应用 Kotlin 单测和 release preflight 通过；普通 debug APK 包含真实 Sherpa JNI 与模型资产 | 不存在 `ui`、stub 或运行时引擎选择；真机冒烟仍按设备门禁执行 |
| Android 本地录音 | 已实现，中/低端参考机通过 | S1 | 前台服务拥有录音状态与 sidecar journal；分阶段 finalize、启动恢复、通知停止和 SQLite 幂等提交均有自动化；中端 Xiaomi 10S 真机后台/锁屏、通知停止、进程重建、10 次连续会话及留存的 7,266,560 ms 连续录音均通过；低端 EVA-AL10 进一步完成 124,992 ms 后台/锁屏录音并从系统通知 finalize，session/job 唯一且一次完成 | 当前中/低端设备门禁已完成 |
| 录音输入设备与主动切换 | `DEFERRED_NOT_PASSED`；自动化基础闭环保留 | 移动高级硬件兼容 | Android 6/API 23+ 枚举并显示连接的内置、蓝牙、有线和 USB 输入，可在待机、录音或暂停时主动选择，并显示实际路由；断开降级与停止路径已有 JVM/Dart/Widget/桥接契约测试。2026-07-24 Xiaomi 没有外接输入 | 不阻塞 S2 Mobile Core；当前没有真实蓝牙/有线/USB 麦克风，不能用内置麦克风替代连接、选择、实际路由和断开证据，REC-009 历史 blocker 保留 |
| 本地离线中文转写 | 已实现，中/低端两小时门禁通过 | S1 | `m4a -> wav 16k mono -> Silero VAD -> Paraformer` 真实 JNI 链路在专用单线程执行器运行；录音停止和导入只提交持久任务，不等待识别；中端 Xiaomi 10S 完成 7,266.56 s 录音一次转写，RTF≈0.024、总 RSS 相对无任务基线约 +55,376 KB；低端 Android 8 EVA-AL10 完成同一 M4A，RTF=0.060、峰值 RSS/PSS 787,200/737,648 KB、无 OOM/LMK且 UI 可导航 | 中端 RTF/RSS 与低端无 OOM 门禁已通过；低端两小时录音以安静段为主 |
| 本地模型就绪检查 | 已实现 | S0 | `ModelAssetManager`、`ModelReadinessChecker` 和唯一 `paraformer-zh` 注册项 | 缺失资产明确失败，不返回占位文本 |
| ASR 模型准入与候选实验 | 已实现可审计实验边界，候选未准入生产 | PC ASR 输入 | `benchmark/asr_model_candidates.json` 分离 runtime/model 许可证并固定 archive/必需文件哈希；Apache-2.0 14M Zipformer 已在 Xiaomi 隔离运行：基线 CER 4.931%/RTF 0.078，热词 CER 4.734%/RTF 0.099，模型文件 25,354,625 bytes | 自动 confidence 和热词为 `DEFERRED_NOT_PASSED`；候选仅 `lab_only`，目标词命中 52→52 未改善，raw score 未完成独立校准；移动端不替换唯一生产 Paraformer，不新增入口 |
| 转写任务状态与重试 | 已实现，中/低端参考机通过 | S1 | SQLite v12 持久单消费者队列；幂等入队、FIFO claim、阶段进度、待处理/处理中取消、失败重试、原生任务重新附着与中断任务重排均有自动化；真机 v10→v15、Xiaomi/EVA-AL10 处理中强停恢复、十次短会话及两台设备的 7,266.56 s 任务均已验证；EVA-AL10 的唯一 job 在 attempt 1 强停后以 attempt 2 完成且没有重复 generation | 当前中/低端队列与两小时资源证据已完成 |
| 本地文件导入 | 已实现，中/低端参考机通过 | S1 | Android 文档选择器、真实音轨/时长/容量校验、app-private 分阶段复制、SHA-256 去重、取消与残留清理；录音记录和待转写任务在同一事务中提交；Xiaomi 与 EVA-AL10 均已通过系统选择器导入 9,621,036-byte WAV、完成转写并证明重复选择仅保留一个文件/recording/job | 权限撤销与大文件取消保留为扩展兼容性覆盖 |
| 系统分享导入 | 已实现，Xiaomi 真机通过 | S2 | Android 单文件 `ACTION_SEND` 支持 `audio/*` 与 `video/*`；冷/热启动共享有界 URI 队列，Flutter 自动消费并复用本地文件导入的校验、私有复制、SHA-256 去重、记录提交和持久转写入队。自动化通过；2026-07-24 Xiaomi 由不同 UID 的外部测试 App 以只读 `content://` 冷启动分享 64,044-byte WAV，源与 app-private 副本 SHA-256 均为 `073091647e4f2f098c4051c149919e941d513150966d7c2271e30f1a83ed14aa`，并创建唯一 recording/job | 已满足“其他 App 分享进 Voice2Text”的 REC-008 物理证据；文件管理器/相册和热启动为扩展兼容性覆盖。旧 M6 仍只代表向外分享 |
| 完整本地删除与系统向外分享 | 已实现，中/低端参考机通过 | S1-S2 | `deletion_pending` 幂等重试会清理主文件、staging/canonical、sidecar journal、导出及关联行；Xiaomi 与 EVA-AL10 均已通过只读目录失败注入、pending 保留、恢复后重试和全图零残留；两台设备的外部系统分享接收器均实际读取 9,621,036-byte 音频且 SHA-256 与源文件一致，EVA-AL10 还完整读取四种转写导出 | 当前中/低端物理设备覆盖已完成；该证据属于向外分享，不代表 REC-008 分享导入 |
| 后台/锁屏可靠录音 | 中/低端参考机通过 | S1 | 前台服务在真机后台和锁屏期间持续写入，通知停止可在 Flutter 进程重建后提交完成记录；中端 Xiaomi 10S 已留存 7,266,560 ms/58,590,545-byte canonical 并完成播放，10 次连续短会话通过；低端 EVA-AL10 在锁屏状态由系统通知停止并保存 124,992 ms canonical，session/job 唯一且完成 | 当前中/低端设备门禁已完成 |
| 会中重点与文字备注 | 已实现，Xiaomi 真机通过 | S2 | SQLite v17 `recording_annotations` 以稳定 session ID 保存多个时间点标记和单条备注；录音完成后通过 recording/session 关系进入统一会议时间线并可回跳音频。自动化通过；2026-07-24 Xiaomi 42,880 ms 录音写入 12,006 ms 标记和 28,006 ms 备注，`VAD_FAILED` 后强停/冷启动仍保留，点击时间线分别跳到 `00:12` 与 `00:28` | REC-010 的写入、保存、重开、失败保留和时间线回跳物理证据已完成；证据见 `benchmark/S2_PHYSICAL_EVIDENCE.md` |
| 时间戳转写片段 | 结构化能力与生产分段契约已实现，独立准确率门禁阻塞 | S2 Mobile Core | 生产 ASR 返回并事务持久化有序 start/end 片段；2026-07-25 Xiaomi 固定 clip 预测为 5/4 段，证据 SHA-256=`01b77e52dd6eadd048a6a2cd91952e7502ad9f6e856010b08d32923a4be1c0d7`；provisional 工程 P95=182 ms/18 边界 | `ASR-005-TIMESTAMP-INDEPENDENT` 仍 BLOCKED：参考为 provisional 且无独立 reviewer，`releaseEligible=false`。它是唯一未通过的 Mobile Core 功能门禁 |
| 离线标点与人工复核 | Mobile Core PASS，Xiaomi 参考机通过 | S2 Mobile Core | 自动标点设置按 attempt 传入真实 native 请求；72 MB CT-Transformer 按需加载。Xiaomi 完成关闭/开启标点对照；人工未复核/待复核/已复核三态、逐项确认和筛选可持久化 | 高级 ITN 与自动 confidence 为 `DEFERRED_NOT_PASSED`；生产 `confidence == null` 始终显示未知。Zipformer raw-score/热词实验不能转成移动产品能力 |
| 播放、定位、编辑、搜索与导出 | 已实现，中端增量门禁通过 | S2 | Goo 会议工作区支持播放/暂停、拖动、±10 秒、倍速、二分高亮、片段跳转、手动滚动暂停跟随、稳定片段编辑、事务化多步 undo/redo、三态复核、文本/时间/状态组合搜索，以及 TXT/Markdown/JSON/SRT/VTT 全量或范围流式导出；3000 片段、Unicode、明暗主题、200% 字体和语义有自动化。Xiaomi M2102J2SC 在 TalkBack 绑定、200% 字体、深色横屏下通过复核集成流和 3000 片段远跳/状态更新/搜索/VTT 导出，范围 VTT 由独立系统接收器按 `text/vtt` 读取 75 bytes 并校验 SHA-256；EVA-AL10 的历史四格式证据仍有效 | 独立听审时间戳 P95 仍待发布门禁；当前会议搜索不含标题或说话人 |
| 标题搜索与批量管理 | 已实现 | S2 | 首页支持当前分组内标题搜索；批量服务和 Goo UI 支持移动分组、软删除、永久删除、转写重试及 TXT/Markdown/JSON/SRT/VTT 导出，逐项保留 succeeded/skipped/failed 结果，危险删除二次确认，临时 ZIP/清单可安全分享并清理；混合状态、部分失败和恢复路径有自动化 | 说话人搜索依赖 S3 数据；当前批量“移动”是本地分组，不是云端文件夹或跨设备移动 |
| 最近删除自动保留 | 已实现，默认关闭 | S2 | SQLite v18 持久化关闭/7/30/90 天策略和最后成功扫描时间；应用启动时最多处理 25 条到期最近删除记录，复用完整删除协调器，失败保持 pending 并在后续启动重试；边界、并发、分页和数据库图/文件清理有自动化 | 只清理已经进入最近删除且达到期限的记录；不会自动删除活跃会议 |
| 本地数据保护、备份与日志治理 | 已实现可验证平台基线 | S2 | 数据库和受管媒体使用 app-private 路径，分享仅暴露受控只读 URI；Android backup/data-extraction 规则排除数据库、录音、导入、导出、诊断和临时内容；日志只允许记录状态、计数、时长、阶段、错误码、大小和哈希等字段，静态契约及 Xiaomi 运行日志通过 | 不宣称 SQLCipher、应用层文件加密、自管密钥或企业远程擦除；设备静态/锁屏保护强度由 Android 与用户设备策略决定 |
| 离线帮助与安全诊断分享 | 部分实现 | S2 | 本地帮助无需网络，覆盖录音合规、故障恢复、模型限制和数据边界；诊断包在用户预览后生成，只含允许列表 JSON 和 manifest，通过系统分享只读发送，不包含正文、标题、完整路径、URI、原始日志或稳定设备标识；24 小时/下次启动清理有自动化 | 没有服务端反馈上传；Android chooser 放弃没有可靠结果回调，因此无法即时获知未分享，临时包依赖 TTL/下次启动清理 |
| 离线语音增强候选 | `DEFERRED_NOT_PASSED`，中端成对门禁失败 | 高级音频 | 官方 MIT GTCRN 资产、原子提取、处理器、Xiaomi API/ABI smoke 和 5 组各 300.655 秒 raw/enhanced 真机采集已完成。成对报告 SHA-256=`05749363f647b30cf337bf61c0a843cd288937aa7f3ff416835120b231f23362` | 不阻塞 S2 Mobile Core；`denoiseReady=false`，生产链路不调用。安静 CER、噪声改善、增强 RTF、原生内存和边界门禁均失败；还缺独立绝对时间戳和低端真机；GTCRN 不是 AEC |
| AI 证据模型与审核流程 | 已实现基础边界 | S3 基础 | SQLite v15 结构化摘要/决策/行动/风险、稳定片段证据、未支持标记、草稿/审核/驳回/发布、修订记录、显式同意与处理位置门禁均有自动化；会议页可复核 fixture 证据 | 生产未配置任何提供商、凭据、端点或上传路径；不宣称已具备自动 AI 生成 |
| 移动端 Live VAD / 实时转写 | 不在产品范围 | — | 产品运行时、设置和默认 benchmark 均不包含该路线 | 历史 debug profile 仅作未来 PC 独立计划输入 |
| 云同步、协作、跨会议知识库 | 后续独立计划 | S4 | 本轮不建设 | 默认不启用云备份或同步 |
| 企业治理与私有化 | 后续独立计划 | S5 | 本轮不建设 | SSO、审计、保留、驻留和私有部署另立计划 |

## 状态判定规则

- “已实现”表示代码路径存在且有自动化契约；涉及真机可靠性的能力还必须补充设备证据后才可对外宣称完成。
- “部分实现”表示基础数据或入口存在，但用户闭环或可靠性门槛尚未完成。
- “`DEFERRED_NOT_PASSED`”表示能力已从当前 Mobile Core 强制范围迁移，
  但历史失败或缺证结论仍有效；它不等于 PASS。
- benchmark 中的显式 Live VAD profile 不构成移动端产品能力，也不得进入默认 smoke 或 release 矩阵。
- S4 与 S5 只保留方向说明，不属于当前移动端基础计划的交付范围。
