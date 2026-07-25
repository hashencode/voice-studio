# S2 Closure Status

更新时间：2026-07-25

## 结论

决策 `S2-MOBILE-CORE-2026-07-25` 已将移动端 S2 重定为 **S2 Mobile
Core**。机器范围契约中的 18 个强制门禁目前 17 PASS、1 BLOCKED；
唯一未通过的 Mobile Core 功能门禁是
`ASR-005-TIMESTAMP-INDEPENDENT`。因此 **S2 Mobile Core 仍为 BLOCKED**。

原 S2 范围没有被追溯改写为通过。自动 confidence、热词、高级 ITN、
GTCRN/AEC 和 REC-009 外接麦克风真机验收保留历史 BLOCKED/FAIL，
状态为 `DEFERRED_NOT_PASSED`，分别进入 PC 或高级能力阶段。

整体产品继续 **NOT RELEASE-READY**：除了 Mobile Core 尚缺独立听审，
S1 高端参考设备、EXP-005 Android 生产发布和正式发布交付也仍未完成。
本结论不包含发布、签名、提交、推送、PR、部署或商店交付。

## S2 Mobile Core gate summary

| 范围 | 当前结论 | 依据 |
| --- | --- | --- |
| Mobile Core 已通过门禁 | 17 PASS | 可靠录音/导入、Paraformer 离线转写、真实标点/分段、人工三态复核、播放器、编辑、搜索、五格式导出、删除/保留、平台数据保护、帮助和无障碍 |
| ASR-005 独立时间戳 | **BLOCKED** | 工程分段 5/4 和 provisional P95=182 ms 已有；独立 reviewer 缺失，`releaseEligible=false` |
| Mobile Core 总体 | **BLOCKED** | 总体状态由机器契约计算；任一 mandatory gate 非 PASS 即 BLOCKED |
| 原 S2 高级能力 | `DEFERRED_NOT_PASSED` | 历史 blocker/失败值保留，迁移不等于 PASS |
| 整体产品 | **NOT RELEASE-READY** | Mobile Core、S1 高端设备、EXP-005 和发布交付未全部完成 |

机器权威：`docs/product/s2-mobile-core-scope.json`；校验入口：
`python3 tool/validate_s2_mobile_core_scope.py`。

## 历史实施单元

| 单元 | 结果 | 证据或边界 |
| --- | --- | --- |
| U1 ASR 能力盘点 | PASS | runtime/model 许可证和能力分开审计；当前生产模型许可证未知。候选 registry、哈希固定和准入 validator 已建立；`benchmark/S2_ASR_CAPABILITY_REVIEW.md` |
| U2 ITN | PASS（fail-closed） | manifest/validator 固定许可证、来源、文件哈希、backend 与黄金样例要求；当前缺合法资产，返回 `itn_asset_missing`，不改写数字语义；`benchmark/S2_ITN_BLOCKER.md` |
| U3 置信度 | PASS（诚实降级），自动门禁 BLOCKED | 生产 Paraformer 不提供可校准 confidence；未知值和人工三态复核保持可用。Zipformer 取得 raw scores，但固定集错误全为漏字，无法校准；`benchmark/S2_CONFIDENCE_REVIEW.md` |
| U4 热词 | BLOCKED | 当前 Paraformer API 无解码偏置接口；Zipformer 解码 A/B 虽使 CER 4.931%→4.734%，预注册目标词命中仍为 52→52，候选保持 `lab_only`；`benchmark/S2_HOTWORD_BLOCKER.md` |
| U5 语音增强 | 实验基础 PASS，生产门禁 BLOCKED | GTCRN API/ABI smoke 和五组固定 300.655 秒 raw/enhanced Xiaomi instrumentation 已完成；安静 CER、噪声改善、增强 RTF、原生内存和成对边界门禁实测失败，仍缺独立时间戳、低端真机且无 AEC；生产默认关闭；`benchmark/S2_ENHANCEMENT_REVIEW.md` |
| U6 标题搜索与批量管理 | PASS | 标题搜索、批量移动/删除/重试/五格式导出、逐项结果与恢复路径有自动化 |
| U7 自动保留 | PASS | SQLite v18；默认关闭，7/30/90 天，仅到期最近删除，25 条有界批次，失败可重试 |
| U8 数据保护与日志 | PASS（平台基线） | app-private、备份排除、只读分享和日志允许列表通过静态/运行时检查；不宣称应用层加密；`benchmark/S2_PRIVACY_LOG_EVIDENCE.md` |
| U9 帮助与反馈 | PASS（本地分享），服务端上传未实现 | 离线帮助、分享前字段预览、只读诊断 ZIP 和 TTL 清理有自动化；无后台上传 |
| U10 独立/物理证据 | PARTIAL | REC-008、REC-010 Xiaomi 真机 PASS；ASR-005 工程分段与 ASR-006/007/008 中端实验已补；独立 reviewer、低端增强和 REC-009 外设仍缺；`benchmark/S2_PHYSICAL_EVIDENCE.md` |
| U11 总回归与产品事实 | PASS（自动化），阶段门禁 BLOCKED | analyzer clean、183 个 Flutter tests、40 个 ASR/ITN/timestamp/enhancement Python tests、Kotlin 单测、debug/AndroidTest 构建及模拟器会议闭环 4/4 通过；不覆盖独立/外部/低端缺口 |

## 原 S2 blocker 与新阶段去向

- ASR-004：Mobile Core 的真实标点与确定性分段 PASS；高级 ITN 为
  `DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED`。没有许可清晰且可回归的
  ITN 规则资产；已有黄金样例和 validator 只证明 fail-closed 契约。
- ASR-005：生产分段数量已在 Xiaomi 修复为 5/4，provisional 工程
  P95=182 ms/18 边界；参考仍为 provisional 且没有独立 reviewer，
  `releaseEligible=false`。它继续作为 Mobile Core 唯一 blocker。
- ASR-006：Mobile Core 人工三态复核 PASS；自动 confidence 为
  `DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED`。生产模型没有真实、可校准
  信号；Zipformer raw-score 固定集没有错误输出 token。
- ASR-007：`DEFERRED_TO_PC` / `DEFERRED_NOT_PASSED`。当前 Paraformer
  没有解码阶段热词接口；Zipformer A/B 的预注册目标词命中 52→52。
- ASR-008：`DEFERRED_NOT_PASSED` 到高级音频。GTCRN 的五组成对中端
  真机门禁中，安静 CER 回退 +0.8876pp、
  噪声均值仅改善 0.2301pp、增强 RTF 0.3273、原生内存增量
  349,676,096 bytes、成对边界仅 3/5 可比且最大 P95 616 ms，均未通过；
  还缺独立绝对时间戳和低端真机，且没有 AEC。
- REC-009：`DEFERRED_NOT_PASSED` 到移动高级硬件兼容。当前没有真实
  蓝牙、有线或 USB 麦克风，不能以内置麦克风替代。

## 验证记录

- `./tool/dev_check.sh --with-build`：PASS；analyzer clean，183 个 Flutter
  tests，40 个 ASR/ITN/timestamp/enhancement Python tests，runtime/privacy/
  audio 合同及 debug APK 构建均通过。
- `./gradlew :app:testDebugUnitTest :app:assembleDebug
  :app:assembleDebugAndroidTest`：PASS。
- `./tool/run_meeting_flow_smoke.sh emulator-5554` 对应四条拆分执行为 4/4
  PASS：普通离线会议流、3000 片段惰性时间线、恢复/删除重试、真实标点和
  范围 VTT。中途一次模拟器 offline 和一次 DDS 建连失败均发生在测试体
  启动前，恢复基础设施后未执行条目全部通过。
- U10 Xiaomi 物理证据：REC-008、REC-010 PASS；ASR-005 已生成生产预测但
  发布门禁仍 blocked；ASR-006/007 在线候选和 ASR-008 GTCRN 成对实验均
  只属于中端实验。详见 `benchmark/S2_PHYSICAL_EVIDENCE.md` 和
  `docs/product/s2-asr-closure-status.md`。

统一 ASR 模型、证据身份、逐项 PASS/BLOCKED 和外部依赖见
`docs/product/s2-asr-closure-status.md`。本文件保留 U1-U11 和原 S2
失败历史，并明确区分范围决策执行、S2 Mobile Core 验收、原 S2 历史结论
与整体 release readiness。
