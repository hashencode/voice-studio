---
title: S2 ASR Model and Quality Gates Resolution - Plan
type: feat
date: 2026-07-25
origin: docs/product/meeting-voice-recognition-prd-v1.0.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-requirements
execution: code
---

# S2 ASR Model and Quality Gates Resolution - Plan

## Goal Capsule

| Field | Contract |
| --- | --- |
| Objective | 基于当前 PRD 与已完成的 S2 U1–U11 收口结果，制定并执行可审计的 ASR 模型与质量门禁方案，尽最大可执行范围关闭 ASR-004/005/006/007/008，并补齐当前可获得的基准、模拟器和真机证据。 |
| Authority | PRD 定义 S2 强制结果；实际安装的 Sherpa AAR API、许可证据、模型输出、生产路径、可复现基准和独立/真机证据定义是否通过。 |
| Execution profile | 先锁定模型能力和许可证决策，再修复生产分段与评估参考契约，随后扩展统一候选基准、执行 ITN/置信度/热词/增强门禁，最后更新产品真相并跑完整开发门禁。 |
| Stop conditions | 不伪造 ITN、confidence、热词、AEC、独立 reviewer、低端真机或外部麦克风证据；实验候选、许可不清资产和未通过成对门禁的增强不得进入生产默认。 |
| Tail ownership | 本 Goal 负责所有当前可执行实现、自动化、基准、真机证据和文档结论；发布、签名、提交、推送、PR、部署、商店交付不在范围内。 |

---

## Product Contract

### Summary

上一轮 S2 U1–U11 已完成可执行产品收口，但模型相关强制项仍未关闭。本计划不把“Goal 执行完成”等同于“S2 阶段完成”，而是建立一条可重复、默认关闭、证据优先的 ASR 能力升级路径。

现有 Paraformer 继续作为生产基线，直到替代候选同时通过许可证、准确率、时间戳、置信度校准、解码热词、ITN、性能和设备门禁。候选模型必须用一个真实的解码架构同时解决 ASR-006 与 ASR-007，避免在不支持这些能力的模型上分别堆入口。ASR-004 和 ASR-008 继续 fail-closed；ASR-005 先修复生产分段与参考边界的契约问题，但独立听审只能由独立 reviewer 完成。

### Problem Frame

- 当前 Paraformer 的离线结果有文本、token 与时间戳，但没有生产可用的真实 confidence；其热词配置不受支持。
- 已安装 Sherpa AAR 的在线转导器结果暴露 `ysProbs`，并支持 `createStream(hotwords)` 与 `modified_beam_search`，因此可作为统一的 confidence/热词候选架构；任何概率解释仍须校准。
- 官方流式中文转导器候选的模型卡缺少清晰再分发许可，不能直接打包或开放生产能力。
- Vosk small-cn 是许可清晰的移动端比较候选，但动态词表不自动等同于自由文本解码热词，且需要验证准确率与额外运行时成本。
- 当前 Xiaomi 生产时间戳预测每条仅一个 VAD 段，参考分别为 5/4 段；必须先区分声学边界、文本分段和人工参考的契约，再谈 P95。
- GTCRN 不是 AEC；目前只完成资产、处理器和 Xiaomi API/ABI smoke，缺少成对质量、低端设备、热/电和完整性能门禁。

### Actors

- A1. 会议用户依赖真实可解释的离线转写、人工复核和时间轴联动。
- A2. ASR 运行时执行生产基线或通过门禁的统一候选模型。
- A3. 质量执行者运行固定数据集、设备和指标合同。
- A4. 独立 reviewer 听审并批准时间戳参考；实现代理不得担任此角色。
- A5. 维护者审核模型许可证、候选能力、证据来源和 S2 阶段结论。

### Requirements

- R1. 模型能力与许可证必须以官方文档、官方仓库、模型卡、安装 API 和实际基准为证据；模型许可证不清时只能作为本地实验候选。
- R2. 生产默认保持当前 Paraformer，直到一个候选同时通过所有适用的 S2 强制门禁；不得以单项指标胜出替换生产模型。
- R3. ASR-005 的生产分段、声学边界参考和评估算法必须共享明确契约；预测必须由生产路径生成，不得手工改写。
- R4. 时间戳发布证据必须包含音频哈希、生产预测、独立 reviewer 审批和物理设备 P95 ≤ 1.5 秒；缺任一项保持 BLOCKED。
- R5. ASR-006 只接受模型返回的真实分数信号；自动阈值必须基于带标签数据做校准并报告覆盖率、错误率和可靠性，未校准时保持 `confidence = null`。
- R6. ASR-007 只接受解码阶段的可测改善；必须有无热词对照、非目标退化检查和固定基准，后处理文本替换不算通过。
- R7. ASR-004 的 ITN 只有在规则/模型资产许可清晰、黄金样例覆盖数字/日期/时间/金额/单位及歧义 fail-closed 时才能启用。
- R8. ASR-008 的 GTCRN 只能被称为语音增强，不能称为 AEC；必须同时通过固定噪声集的成对准确率、安静语音、时间戳、RTF、峰值内存、热/电和低/中端设备门禁后才能进入生产默认。
- R9. 基准合同必须可重复比较准确率、时间戳、热词改善、真实分数/校准、ITN、RTF、峰值内存、热/电、包体和低/中端设备。
- R10. 基准与提交证据不得持久化会议正文、完整私人路径或稳定设备标识；需要文本的本地计算结果必须经过净化后才能进入文档。
- R11. Xiaomi 10S 仅作为中端参考机；EVA-AL10 仅作为低端参考机。缺失低端设备时不得用 Xiaomi 替代。
- R12. REC-009 必须使用真实蓝牙、有线或 USB 麦克风；内置麦克风不能替代，硬件不可用时保留外部 blocker。
- R13. 单个外部 blocker 不得停止其他独立实施单元；每项结论必须精确标记 PASS、BLOCKED、FAIL 或 NOT RUN。
- R14. PRD、能力矩阵、真机矩阵和统一 S2 ASR closure status 必须一致区分“实现/自动化存在”“当前证据通过”“S2 release-ready”。

### Key Flows

- F1. 候选准入：登记模型来源、运行时 API、模型许可、包体与能力，许可证或必需能力失败即停在实验层。
- F2. 分段契约：用固定音频在生产路径与 VAD 诊断路径生成边界，先修复确定性契约问题，再由独立 reviewer 提供 release-eligible 参考。
- F3. 统一候选比较：对同一音频、设备、profile 运行生产基线和候选，分别记录无热词/有热词、分数信号、准确率与资源指标。
- F4. Fail-closed 能力：ITN、自动 confidence、热词和 GTCRN 只有完整门禁通过才改变生产能力注册表；否则保留自动化和 blocker。
- F5. 阶段收口：汇总自动化、模拟器、Xiaomi、EVA、独立 reviewer 与外设证据；任何强制项未通过时 S2 保持 BLOCKED / NOT RELEASE-READY。

### Acceptance Examples

- AE1. 候选模型能在本机运行但模型卡没有许可字段：基准可执行，生产注册和打包保持关闭，状态为 BLOCKED。
- AE2. 模型返回 token 概率但没有标签校准集：报告原始信号存在，`confidence` 仍为空，ASR-006 不通过。
- AE3. 热词只通过转写后替换提高命中：基准拒绝该结果，ASR-007 不通过。
- AE4. Xiaomi 预测边界能与 provisional 参考匹配，但无独立 reviewer：工程分段契约可 PASS，release-eligible ASR-005 仍 BLOCKED。
- AE5. GTCRN 在 Xiaomi API smoke 成功，但无低端真机和成对准确率：ASR-008 保持生产关闭，且不得称为 AEC。
- AE6. 所有自动化通过但 REC-009 外设、独立 reviewer 或 EVA 缺失：Goal 可按最大可执行范围完成，S2 仍 NOT RELEASE-READY。

### Success Criteria

- 有一份机器可校验的候选模型/许可证/能力注册表和一条统一比较基准路径。
- 生产分段与评估边界合同有自动化覆盖，当前可用设备生成的新证据可复现。
- confidence 与热词候选共享同一真实解码能力，不存在死入口、启发式伪信号或后处理伪热词。
- ITN 与 GTCRN 继续由显式门禁控制，文档不夸大。
- 所有相关单测、Flutter 门禁、Gradle 门禁、AndroidTest 构建、模拟器和可用真机门禁有观测结果。
- 最终统一状态逐项给出 PASS/BLOCKED 及缺失证据；只有全部 PRD S2 强制项通过才声明 S2 完成。

### Scope Boundaries

**In scope**

- 模型/API/许可证决策、候选注册表、分段契约、统一基准、当前可用 Xiaomi/模拟器证据、fail-closed 门禁和权威文档更新。
- 在许可证和设备允许时下载本地实验模型与运行基准；不把临时大模型或包含正文的原始报告纳入产品资产。

**Out of scope**

- 代理冒充独立 reviewer、购买/伪造 EVA 或外部麦克风、把 GTCRN 描述为 AEC。
- 发布、签名、提交、推送、PR、部署、商店交付。
- 未经门禁替换生产模型、引入远程 ASR、S3 说话人识别。

### Sources

- `docs/product/meeting-voice-recognition-prd-v1.0.md`
- `docs/product/s2-closure-status.md`
- `docs/product/mobile-capability-matrix.md`
- `docs/REAL_DEVICE_REGRESSION_MATRIX.md`
- `docs/plans/2026-07-24-003-feat-s2-remaining-scope-closure-plan.md`
- `benchmark/S2_ASR_CAPABILITY_REVIEW.md`
- `benchmark/S2_ITN_BLOCKER.md`
- `benchmark/S2_CONFIDENCE_REVIEW.md`
- `benchmark/S2_HOTWORD_BLOCKER.md`
- `benchmark/S2_ENHANCEMENT_REVIEW.md`
- `benchmark/TIMESTAMP_REVIEW.md`
- `benchmark/S2_PHYSICAL_EVIDENCE.md`
- Sherpa hotwords: <https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html>
- Sherpa offline transducers: <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html>
- Sherpa online transducers: <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html>
- Sherpa runtime license: <https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE>
- Vosk models and adaptation: <https://alphacephei.com/vosk/models>, <https://alphacephei.com/vosk/adaptation>

---

## Planning Contract

### Key Technical Decisions

- KTD1. 保持 Paraformer 为生产基线；模型切换是总门禁决策，不是 ASR-006 或 ASR-007 的局部 UI 变更。
- KTD2. 首选统一候选是已安装 Sherpa AAR 支持的在线转导器：`modified_beam_search` 提供解码热词，`ysProbs` 仅作为待校准原始信号。候选模型许可不清时保持 lab-only。
- KTD3. Vosk small-cn 仅作为许可证清晰的比较/回退候选；动态词表需验证是否满足自由文本热词合同，不能直接视为通过。
- KTD4. ASR-005 同时保留两个结论：工程分段合同与 release-eligible 独立听审 P95。前者可由本 Goal 修复，后者必须等待独立 reviewer。
- KTD5. 所有能力默认 fail-closed；模型注册表是生产真相，benchmark registry 是实验真相，两者不可混用。
- KTD6. 原始 benchmark 可在 `build/` 内含本地转写用于指标计算；持久化文档只记录哈希、聚合指标和净化证据。
- KTD7. GTCRN 继续独立于 AEC，且未通过完整成对门禁前不改变生产默认。

### Assumptions

- 当前可用物理设备为 Xiaomi 10S 中端参考机；EVA-AL10 和外部麦克风可能不可用。
- 独立 reviewer 在本 Goal 执行窗口内可能不可用，因此相关门禁可形成完整 review packet 但不能由代理批准。
- 官方模型发布包可用于本地研究不代表应用可再分发；许可证缺失时不纳入产品资产。
- 本次不改 UI；如实施中确需 UI，必须先读取 sibling `flutter-ui-mobile/DESIGN.md` 与 `DOC.md` 并使用真实 Goo API。

### High-Level Technical Design

1. 在 benchmark 层新增模型来源、许可证、能力与准入状态的机器可读注册表，并以验证脚本阻止缺证候选被标记为 production-eligible。
2. 把生产 VAD 参数和时间戳诊断的边界数据结构收敛到共享契约；用固定音频运行 profile sweep，选择规则必须预先声明并由单测覆盖。
3. 扩展 debug-only benchmark 以支持在线转导器候选、可选 decoder hotwords、`ysProbs` 聚合和资源数据，不把实验 API接入生产 UI。
4. 对 ITN、confidence、hotword、GTCRN 分别生成机器判定的 gate report；生产 capability registry 只消费全部通过且许可证允许的结果。
5. 在 Xiaomi 和模拟器运行可用门禁；对 EVA、独立 reviewer、REC-009 产生明确外部依赖记录。
6. 更新统一 closure 文档及 PRD/矩阵，使实现、证据与阶段状态一一对应。

### Repository Patterns to Preserve

- 生产 ASR 位于 `android/app/src/main/kotlin/com/voice2text/app/transcription/`，实验 runner 位于 `benchmark/android/src/debug/`。
- 临时模型、音频、原始结果留在 `build/`，不写入生产 assets。
- Python evaluator 使用 manifest/hash 驱动并 fail-closed；Kotlin/Flutter 结果保持明确 nullable capability。
- 所有修改通过现有 `./tool/dev_check.sh`，代码变更后执行 `./tool/ensure_ui_watcher.sh`。

### Risks & Dependencies

- 模型许可缺失会阻止生产集成，但不阻止本地能力基准。
- 在线转导器的 `ysProbs` 可能无法形成可靠的段级 confidence；若校准失败应记录为失败并保持 null。
- 用少量 timestamp fixture 调 VAD 有过拟合风险；选择标准必须同时检查已有长音频和不退化约束。
- Xiaomi 不能代表低端热/电/内存；缺 EVA 时 ASR-008 和模型总门禁不能完成。
- 原始基准含转写正文，任何文档化脚本都必须净化。

### Delivery Sequence

1. U1 建立候选/许可证/能力准入合同。
2. U2 修复 ASR-005 分段与评估契约并生成可用真机证据。
3. U3 扩展统一候选 benchmark，评估 confidence 与 decoder hotwords。
4. U4 执行 ITN 与 GTCRN fail-closed 质量门禁。
5. U5 跑完整自动化、模拟器、可用真机并更新统一产品真相。

---

## Implementation Units

### U1. Establish the auditable model admission contract

**Goal:** 用机器可读注册表区分生产基线、实验候选、官方来源、许可和必需能力。

**Files:**

- Create `benchmark/asr_model_candidates.json`
- Create `benchmark/validate_asr_model_candidates.py`
- Create `benchmark/test_validate_asr_model_candidates.py`
- Modify `benchmark/asr_benchmark_manifest.json`
- Modify `benchmark/S2_ASR_CAPABILITY_REVIEW.md`

**Approach:**

- 记录 Paraformer、Sherpa 在线转导器和 Vosk 比较候选的 runtime/model 来源与许可证状态。
- 定义 `lab_only`、`blocked`、`production_eligible` 状态；只有来源、许可证据和所需能力字段齐全才允许 `production_eligible`。
- 记录模型包体、归档 SHA-256、语言、时间戳、热词、分数信号、ITN 与设备范围；未知必须显式为 unknown/blocked。
- 下载器必须在解压前校验注册表固定的 SHA-256；运行时 Apache-2.0 许可证与模型权重许可证分别记录。

**Test scenarios:**

- 缺少模型许可的候选不能标记 production-eligible。
- Paraformer 不能声明 decoder hotwords 或 confidence。
- 运行时 Apache-2.0 不能被错误传播为模型许可。

**Verification:**

- `python3 -m unittest benchmark/test_validate_asr_model_candidates.py`
- `python3 benchmark/validate_asr_model_candidates.py`

### U2. Repair the ASR-005 segmentation and evidence contract

**Goal:** 让生产预测、声学边界和 evaluator 使用同一确定性合同，并把工程通过与独立听审发布通过分开。

**Files:**

- Modify `android/app/src/main/kotlin/com/voice2text/app/transcription/RealSherpaTranscriptionEngine.kt`
- Modify/Create tests under `android/app/src/test/kotlin/com/voice2text/app/transcription/`
- Modify `android/app/src/androidTest/kotlin/com/voice2text/app/transcription/TimestampPredictionSmokeTest.kt`
- Modify `benchmark/evaluate_transcript_timestamps.py`
- Create `benchmark/test_evaluate_transcript_timestamps.py`
- Modify `benchmark/prepare_timestamp_review.py`
- Modify `benchmark/TIMESTAMP_REVIEW.md`

**Approach:**

- 先用 debug-only VAD/profile sweep 诊断当前 1 段结果；不得先把 provisional 边界硬编码进生产。
- 把声学 segment 的最小时长、静音切分和最大时长含义写成共享参数/测试，修复可证明的 native VAD 配置或 flush 契约问题。
- 生产 smoke 输出 schema、音频哈希、边界来源和 segment 数；evaluator 对 schema/哈希/顺序/边界严格校验。
- provisional 参考只能形成工程诊断；只有 independent/approved reference 才能 release-eligible。

**Test scenarios:**

- 预测与参考 schema/哈希不一致时 fail。
- 一段生产预测对 5/4 段参考继续 fail，不通过 evaluator 放宽掩盖。
- 代理生成的 reference 不能标记 independent/approved。
- 分段变更不破坏片段顺序、非重叠时间戳或长音频 smoke。

**Verification:**

- `(cd android && ./gradlew :app:testDebugUnitTest)`
- `python3 -m unittest benchmark/test_evaluate_transcript_timestamps.py`
- Xiaomi 生产 `TimestampPredictionSmokeTest` + evaluator。

### U3. Build the unified confidence and decoder-hotword candidate benchmark

**Goal:** 在 debug-only runner 中以同一转导器候选评估真实分数信号与解码热词，不创建生产死入口。

**Files:**

- Modify `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkTypes.kt`
- Modify `benchmark/android/src/debug/kotlin/com/voice2text/app/benchmark/AsrBenchmarkRunner.kt`
- Modify `benchmark/asr_benchmark_manifest.json`
- Modify `benchmark/asr_benchmark_profiles.json`
- Modify `benchmark/download_asr_benchmark_models.sh`
- Create/Modify benchmark evaluators and tests for hotword delta and confidence calibration.
- Modify `benchmark/S2_CONFIDENCE_REVIEW.md`
- Modify `benchmark/S2_HOTWORD_BLOCKER.md`

**Approach:**

- 支持 online transducer 所需 encoder/decoder/joiner/tokens，使用 `modified_beam_search`。
- 对同一音频运行无热词与有热词解码，记录目标命中变化、非目标错误变化、RTF、内存和包体。
- 只导出 `ysProbs` 的聚合/校准所需数值，不将其直接当作 `[0,1]` confidence。
- 若许可、准确率或校准失败，保留实验结果并不修改生产 `TranscriptionModelRegistry`。

**Test scenarios:**

- greedy search 配置不得宣称支持 hotwords。
- 后处理替换不能进入 hotword 改善指标。
- 空/非有限/长度不一致的分数信号不能产生 confidence。
- 无标签校准报告不能把能力标为通过。

**Verification:**

- `(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug)`
- Xiaomi 上运行选定基线/候选 profile；原始报告留在 `build/`，提交净化摘要。

### U4. Execute ITN and enhancement fail-closed gates

**Goal:** 补齐可自动验证的缺失项，并在资产/设备不足时保持精确 blocker。

**Files:**

- Create `benchmark/validate_itn_assets.py`
- Create `benchmark/test_validate_itn_assets.py`
- Modify GTCRN paired benchmark/evaluator scripts and tests under `benchmark/`.
- Modify `benchmark/S2_ITN_BLOCKER.md`
- Modify `benchmark/S2_ENHANCEMENT_REVIEW.md`

**Approach:**

- ITN validator 同时要求资产许可、来源、黄金样例和歧义 fail-closed；缺资产时返回 blocker 而非启用。
- GTCRN 对 noisy/clean/quiet fixture 建立 hash manifest 与成对评估；记录 accuracy/timestamp/RTF/memory/thermal/power/device tier。
- Xiaomi 只关闭中端可观测子门禁；EVA 未连接时低端保持 NOT RUN/BLOCKED；AEC 永远保持未实现。

**Test scenarios:**

- 无许可证或黄金样例的 ITN 资产不能通过。
- 缺 clean/noisy 对或哈希漂移时增强 evaluator fail。
- 只有 API smoke 时不能判定 ASR-008 PASS。

**Verification:**

- 相关 Python 单测与 validator。
- Xiaomi GTCRN 可用 smoke/paired 子门禁；低端缺失明确记录。

### U5. Run closure gates and synchronize product truth

**Goal:** 运行与风险相称的完整门禁，统一所有产品/设备/基准文档状态。

**Files:**

- Modify `docs/product/meeting-voice-recognition-prd-v1.0.md`
- Modify `docs/product/s2-closure-status.md`
- Modify `docs/product/mobile-capability-matrix.md`
- Modify `docs/REAL_DEVICE_REGRESSION_MATRIX.md`
- Modify `benchmark/S2_PHYSICAL_EVIDENCE.md`
- Create `docs/product/s2-asr-closure-status.md` as the unified S2 ASR closure
  status.

**Approach:**

- 逐项记录 ASR-004/005/006/007/008 的 implementation、automation、evidence、result 与 blocker。
- 记录 analyzer/test/Gradle/AndroidTest build/meeting smoke/真机 benchmark 的实际结果。
- REC-009、独立 reviewer、EVA 等外部依赖保持精确，不让 Goal 完成措辞改变 S2 状态。
- 清理未采用实验留下的死代码、临时资产和夸大声明。

**Verification:**

- `./tool/dev_check.sh`
- `(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest)`
- 模拟器 meeting smoke。
- `./tool/ensure_ui_watcher.sh`
- 可用 Xiaomi benchmark/production smoke。

---

## Verification Contract

### Per-Unit Gates

| Unit | Required observed result |
| --- | --- |
| U1 | registry validator 和负例测试通过，所有候选准入状态有官方来源/许可解释 |
| U2 | 分段合同测试通过；Xiaomi 生产预测重新生成；release P95 只在独立 approved reference 时通过 |
| U3 | debug candidate runner 构建/测试通过；有无热词与原始分数信号可重复；未过总门禁不接生产 |
| U4 | ITN/GTCRN validator fail-closed；Xiaomi 子证据与 EVA/AEC blocker 分开 |
| U5 | 全量开发门禁通过，四份权威产品文档与统一 ASR closure status 一致 |

### Cross-Cutting Automated Gates

- Flutter analyzer clean and all Flutter tests pass.
- Kotlin unit tests pass and AndroidTest APK builds.
- Python benchmark/evaluator suites pass.
- Meeting smoke passes on the emulator.
- Available physical-device tests use production code paths.
- No production capability is enabled from a lab-only or blocked candidate.

### Required Scenario Evidence

- 当前 Paraformer 基线的 accuracy/timestamp/RTF/memory/size。
- 统一候选的 model/runtime/license、hotword A/B、raw score/calibration eligibility。
- ASR-005 audio hash、production prediction、reference provenance、P95 eligibility。
- GTCRN noisy/clean/quiet paired gate table and device tier.
- REC-009/independent reviewer/EVA availability state.

### Stop-the-Line Failures

- 许可不清资产被放入生产或标记 production-eligible。
- 人造 confidence、后处理伪热词、GTCRN 被称为 AEC。
- 代理把自身参考标记为独立 reviewer。
- 通过放宽 evaluator 隐藏生产分段缺陷。
- 任何强制 S2 项未通过却声明 S2 complete/release-ready。

---

## Definition of Done

- 权威计划存在且所有可执行 U1–U5 单元有实现、自动化或有证据的 NOT RUN/BLOCKED 结论。
- 候选模型与许可证准入机器可校验；生产和实验状态分离。
- ASR-005 分段合同有自动化和当前可用真机生产预测，独立 reviewer 缺失时 release gate 保持 BLOCKED。
- ASR-006/007 使用统一真实候选能力进行基准；若许可/校准/改善未通过则生产入口保持关闭。
- ASR-004/008 的 fail-closed 规则和可执行子门禁完成，GTCRN 不冒充 AEC。
- PRD、S2 closure、能力矩阵、真机矩阵和统一 ASR closure status 对同一事实给出一致结论。
- 全量开发门禁和可用模拟器/真机门禁有实际结果；无临时产品资产、死入口、正文证据或夸大声明。
- 若任何 PRD S2 强制项仍失败，最终结论明确为 `BLOCKED / NOT RELEASE-READY`；只有全部强制门禁真实通过才声明 S2 完成。

---

## Execution Outcome — 2026-07-25

- U1–U5 的当前可执行实施、自动化、Xiaomi 真机采集、模拟器回归与产品事实
  同步均已完成；候选模型注册表没有任何 `production_eligible` 项。
- ASR-005 生产分段由固定 clip 的 1/1 段修复为 5/4 段，provisional
  工程 P95 为 182 ms；缺独立 reviewer，因此发布门禁仍 BLOCKED。
- 14M Zipformer 在线候选在 Xiaomi 的基线/热词 CER 为 4.931%/4.734%，
  但目标词命中 52→52，且 raw score 缺独立 calibration/held-out 证据；
  ASR-006/007 保持 BLOCKED / LAB ONLY。
- GTCRN 五组 300.655 秒成对门禁完成，但安静 CER、噪声改善、增强 RTF、
  原生内存与成对边界门禁失败；低端、独立绝对时间戳和 AEC 仍缺，
  ASR-008 生产门禁关闭。
- ITN 缺许可与来源清晰的资产，validator 保持 fail-closed；REC-009 仍缺真实
  蓝牙/有线/USB 麦克风。
- 最终开发门禁：analyzer clean、183 个 Flutter tests、40 个 Python gate
  tests、Kotlin 单测、debug APK 与 AndroidTest APK 构建通过；模拟器会议
  smoke 4/4 通过；Xiaomi ASR-005、在线候选和增强证据已固定哈希。
- Goal 的最大可执行范围已完成；PRD S2 结论严格保持
  **BLOCKED / NOT RELEASE-READY**。
