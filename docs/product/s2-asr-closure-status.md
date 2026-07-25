# S2 ASR Model and Quality-Gate Closure Status

更新时间：2026-07-25

## 审计结论

本轮模型决策、实现、自动化、Xiaomi 中端真机实验和文档收口均以
fail-closed 方式执行。随后产品决策 `S2-MOBILE-CORE-2026-07-25` 将移动端
S2 收敛为 **S2 Mobile Core**：保留 Paraformer 基础离线转写、真实标点、
结构化时间戳和人工复核；自动 confidence、热词和高级 ITN 标记为
`DEFERRED_TO_PC`，GTCRN/AEC 标记为 `DEFERRED_NOT_PASSED` 到高级音频。

这不是把旧门禁改写为 PASS。原 S2 历史仍为 BLOCKED / NOT
RELEASE-READY，所有原始失败指标都保留。当前 18 个 Mobile Core
mandatory gates 为 17 PASS、1 BLOCKED；唯一 blocker 是
`ASR-005-TIMESTAMP-INDEPENDENT`，所以 **S2 Mobile Core 仍为 BLOCKED**。
整体还受 S1 高端参考设备、EXP-005 和发布交付约束，继续 **NOT
RELEASE-READY**。没有执行发布、签名、提交、推送、PR、部署或商店交付。

## S2 Mobile Core ASR gate

| 能力 | Mobile Core 结论 | 高级部分 |
| --- | --- | --- |
| ASR-004 | PASS：真实 CT-Transformer 标点和确定性分段 | ITN `DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED`，许可证与黄金样例门禁不变 |
| ASR-005 | **BLOCKED**：工程分段 5/4、provisional P95=182 ms；独立 reviewer 缺失，`releaseEligible=false` | 无；独立听审是 Core 强制门禁 |
| ASR-006 | PASS：人工未复核/待复核/已复核三态 | 自动 confidence `DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED` |
| ASR-007 | 不属于 Mobile Core | 热词 `DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED` |
| ASR-008 | 不属于 Mobile Core | GTCRN/AEC `DEFERRED_NOT_PASSED` 到高级音频，历史 FAIL 不变 |

## 模型与架构决策

- 唯一生产模型仍为离线 Paraformer。它继续承担现有转写，但当前打包模型
  缺少可核验的模型再分发许可证，且没有可校准 confidence 或可验证解码
  热词接口，因此移动端不为 ASR-006/007 更换模型或增加 UI/设置入口。
- Apache-2.0 Sherpa 运行时与 Apache-2.0 14M streaming Zipformer 候选被
  固定到 archive、README 和四个必需文件的 SHA-256。候选只在隔离
  AndroidTest 中运行，状态为 `lab_only`，不进入产品 registry、请求、
  设置、持久化或默认链路。
- 模型准入验证器要求 runtime/model 许可证分离、资产和证据哈希固定、
  capability gate 真实通过、低/中端真机均有证据，才能标记
  `production_eligible`。当前没有候选满足这些条件。
- ITN 只有在规则资产许可证、来源证据、文件哈希、backend 和黄金样例全部
  齐备时才允许启用；当前 validator 返回 `itn_asset_missing`，运行时保持
  fail-closed。
- GTCRN 只作为离线噪声抑制候选评估，绝不描述为 AEC；生产
  `denoiseReady=false`，请求默认关闭，生产引擎不调用它。
- 未来 PC 热词必须使用 Transducer + `modified_beam_search`。离线批处理
  优先评估 Offline Zipformer Transducer，实时路径优先评估 Online
  Zipformer Transducer；具体权重仍须经过许可证、准确率、热词、校准、
  RTF、内存和设备 benchmark，当前没有选定生产 PC 模型。

## 原 S2 强制门禁历史

| PRD | 当前结论 | 已完成证据 | 仍缺少的真实 PASS 条件 |
| --- | --- | --- | --- |
| ASR-004 标点、ITN、分段 | **BLOCKED** | 真实 CT-Transformer 离线标点已通过 Xiaomi；ITN manifest、validator 和黄金样例哈希契约已自动化；缺资产时不改写数字语义 | 取得许可与来源清晰的 ITN 规则/模型资产，固定哈希和 backend，并使完整黄金样例回归通过 |
| ASR-005 时间戳片段 | **BLOCKED（工程分段 PASS）** | 生产链路在 Silero 外层区域内增加自适应持续静音分段；Xiaomi 固定 clip 为 5/4 段；预测 SHA-256=`01b77e52dd6eadd048a6a2cd91952e7502ad9f6e856010b08d32923a4be1c0d7`；provisional 工程 P95=182 ms/18 边界，报告 SHA-256=`d94940888f4786e212c3b468a633af84241ad27bee34b3bda22b91e3109d9459` 且 `releaseEligible=false` | 由独立 reviewer 完成盲听 worksheet 与 reviewer 元数据，再由正常物理评估模式取得 P95 ≤1.5 秒；实现代理不能充当 reviewer |
| ASR-006 低置信度 | **BLOCKED（人工三态 PASS）** | 人工未复核/待复核/已复核三态保持可用；生产 Paraformer 继续返回 unknown；Zipformer 固定集输出逐 token `ysProbs` | 独立标注的 calibration/held-out 数据必须同时包含正确与错误输出 token，并通过预注册校准指标后才能设置阈值；当前错误全为漏字，无法建立阈值 |
| ASR-007 热词 | **BLOCKED** | Zipformer `modified_beam_search` A/B 证明解码输出会变化；Xiaomi 基线 CER 4.931%/RTF 0.078，热词 CER 4.734%/RTF 0.099 | 预注册目标词命中需真实改善；当前为 52→52，未通过。还缺低端、完整回归和生产准入 |
| ASR-008 增强/AEC | **BLOCKED** | 官方 MIT GTCRN 资产、原子提取、处理器、Xiaomi API/ABI smoke 和五组固定 300.655 秒成对 raw/enhanced instrumentation 均已完成。安静 CER 回退 +0.8876pp、噪声均值改善 0.2301pp、增强 RTF 0.3273、原生内存增量 349,676,096 bytes、成对边界仅 3/5 可比且最大 P95 616 ms | 上述中端指标均未通过对应强制阈值；还缺独立绝对时间戳、低端 EVA-AL10；无 AEC |

## 可复现入口与证据身份

- 权威实施计划：
  `docs/plans/2026-07-25-001-feat-s2-asr-model-quality-gates-plan.md`
- 候选注册表与准入：
  `benchmark/asr_model_candidates.json`、
  `benchmark/validate_asr_model_candidates.py`、
  `benchmark/prepare_asr_candidate.py`
- 当前生产 benchmark 模型 manifest：
  `benchmark/asr_benchmark_manifest.json`
- 时间戳：
  `benchmark/audio/timestamp_manifest.json`、
  `benchmark/prepare_timestamp_review.py`、
  `benchmark/evaluate_transcript_timestamps.py`
- 在线候选：
  `benchmark/audio/online_transducer_candidate_manifest.json`、
  `benchmark/evaluate_online_transducer_candidate.py`
- ITN：
  `benchmark/itn_asset_manifest.json`、
  `benchmark/validate_itn_assets.py`
- GTCRN：
  `benchmark/audio/s2_noise_manifest.json`、
  `benchmark/prepare_s2_noise_audio.py`、
  `benchmark/evaluate_s2_enhancement.py`
- 候选模型必需文件总大小：25,354,625 bytes；Xiaomi 在线候选原始报告
  SHA-256=`7b6c9f0f723d90d37b5de0bf01a9c03e9e3332694f80c54e0fc272a912c7b0c9`，
  evaluator 报告
  SHA-256=`8170f11f4d6708b9c5ec50579326eee80e05d07b90866bda938b29076c5d216e`。
- 当前 debug APK 为 430,784,408 bytes，SHA-256=
  `9b6414fdc78ddaa5926fa163b04e356f6831ac0c85ff2fee3aa51ff02a4db2e1`。
  这是包含调试符号/多 ABI/现有全部资产的开发构建，不是 release 包体或
  候选增量包体，不能用于发布准入。
- GTCRN 成对真机报告与 evaluator 报告仅保存在忽略的 `build/`，文档记录
  其哈希和非敏感聚合指标；设备报告中的转写正文不进入仓库。原始报告
  SHA-256=`05749363f647b30cf337bf61c0a843cd288937aa7f3ff416835120b231f23362`，
  物理模型身份报告
  SHA-256=`2fec9d260f8bedf82edb32b9933442a6a0073e61922eb6823e89d48a197e5bb3`，
  evaluator 报告
  SHA-256=`b7ae589b0c8494a06c1b5952c462a2a20319a83859d845da9b42474dffa3a14a`。

## 外部依赖与后续阶段

- ASR-005 是 Mobile Core 唯一 blocker：需要独立 reviewer，当前实现代理
  不能代签。
- REC-009 转入移动高级硬件兼容：需要真实蓝牙、有线或 USB 麦克风执行
  连接、主动选择、实际路由和录音中断开；内置麦克风不能替代。
- ASR-004 ITN 转入 PC 文本质量：需要合法可分发资产与规则来源。
- ASR-006 自动 confidence 转入 PC ASR：需要独立标注的
  calibration/held-out 语料。
- ASR-007 热词转入 PC ASR：需要 Transducer 解码 A/B 的目标词真实改善。
- ASR-008 转入高级音频：需要低端 EVA-AL10 和独立时间戳参考；AEC 还
  需要独立的真实回声控制方案。

迁移项不再阻止 S2 Mobile Core，但也没有成为 PASS。机器分类和计算结果见
`docs/product/s2-mobile-core-scope.json`。

## 最终开发门禁

- `./tool/dev_check.sh --with-build`：PASS；analyzer clean、183 个 Flutter
  tests、40 个 ASR/ITN/timestamp/enhancement Python gate tests、合同检查和
  debug APK 构建通过。
- `./gradlew :app:testDebugUnitTest :app:assembleDebug
  :app:assembleDebugAndroidTest`：PASS。
- 模拟器会议闭环拆分执行：4/4 PASS。一次 ADB offline 和一次 DDS 建连
  失败均发生在测试体启动前；恢复后所有待执行条目通过。
- Xiaomi：ASR-005 生产预测、在线候选 A/B、GTCRN 5/5 成对门禁和模型身份
  绑定 instrumentation 均完成；各自的 release 结论仍按上表 BLOCKED/FAIL。
