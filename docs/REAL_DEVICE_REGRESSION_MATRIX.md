# Real Device Regression Matrix (Android)

目标：覆盖“是否算重构完成”最关键链路，优先验证端到端稳定性与可回归性。

> 2026-07-24 说明：下方 2026-05-07 的 R1-R6 是历史基线证据，不代表当前
> U1-U8 变更已全部验收。当前发布判定以本节的会议产品闭环矩阵为准；未填
> PASS 的项不得由历史 PASS 替代。

> 2026-07-25 范围决策 `S2-MOBILE-CORE-2026-07-25`：M16、M20、M21
> 保留原始 PENDING/BLOCKED/FAIL 证据，但改列为 `DEFERRED_NOT_PASSED`，
> 不再阻塞 S2 Mobile Core。`ASR-005-TIMESTAMP-INDEPENDENT`（M18）仍是
> 唯一未通过的 Mobile Core 功能门禁。Mobile Core BLOCKED 与整体
> NOT RELEASE-READY 是独立结论。

## 当前会议产品闭环矩阵（2026-07-25）

- 设备：Xiaomi M2102J2SC（thyme，Android 13，物理设备 `a186e452`）
- 设备层级：Xiaomi 10S 为中端参考机；HUAWEI EVA-AL10（Android 8/API 26，
  3,805,444 KB RAM，物理设备 `KWG5T16A21000917`）为低端参考机；两档已
  完成历史主链门禁，但新增 GTCRN 成对门禁只有 Xiaomi 中端结果
- 分级口径：按当前验收日期的目标用户设备群、设备年代和实测资源/RTF
  划分，不沿用手机发布时的营销定位。旧旗舰可以作为当前中端参考机；
  实测性能用于判断是否通过门禁，不反向决定设备档位
- 包名：`com.voice2text.app`
- 当前留存长录音 session：`7edb7c06-5aa9-42ad-9a35-b61e39e9d5e9`

| ID | 门禁 | 当前证据 | 状态 | 剩余动作 |
| --- | --- | --- | --- | --- |
| M1 | 单一无 Flavor 真实运行时 | runtime contract、analyzer、当前 183 个 Flutter 测试与应用 Kotlin 单测通过；完整 Gradle 单测（Java 21）、androidTest 构建及 debug APK 在 2026-07-24 的当前源码上通过 | PASS | 当前轮 `dev_check`、Kotlin 编译/单测和 androidTest 构建已完成；release preflight 按当前安排延后 |
| M2 | 后台/锁屏前台服务录音 | Xiaomi 已验证后台、锁屏、通知停止与 Flutter 进程重建；EVA-AL10 session `c4a92b3f-e39f-47c6-a166-f0e9b83b3fc4` 在桌面/锁屏保持前台服务，由系统通知“停止并保存”完成 `124,992 ms` finalize，session=`completed`/`notification_stop`，只生成一条 recording/session/job，job 一次完成并生成 6 个片段，服务与活动通知消失 | PASS | 中/低端物理设备均通过；低端证据：`build/device-evidence/2026-07-24-low-eva-al10-scenarios/summary.md` |
| M3 | 两小时连续录音 | session `7edb7c06-5aa9-42ad-9a35-b61e39e9d5e9` 于 2026-07-24 02:17 启动，锁屏/后台运行后于 04:18 由应用内停止键单次结束；journal=`completed`/`user_stop`，原生时长 7,266,560 ms；canonical M4A 为 58,590,545 bytes，SHA-256=`98b86cbc60791c5bd6ab1000c18b47abbdd77f63169841f5cdb70d19683f0d24`，设备端与本地副本一致；staging 和录音通知均消失；SQLite recording/session/job 唯一且时长一致；重启后应用播放器实际播放至 01:20 并成功暂停 | PASS | 原件仍保留在 app-private canonical；本地留档为 `build/device-evidence/2026-07-24-m3-7edb7c06/`。旧 session `06caccc0-8e50-4d23-9a2c-3fa1be2228fc` 的未留存运行仅作为历史补充 |
| M4 | 十次连续短会话 | 2026-07-24 在当前 v15 APK 完成 10 个唯一 session；10/10 journal=`completed`/`user_stop`，时长 2,880–48,256 ms；10 个非空 canonical M4A；SQLite 为 10 条唯一录音、10 条 completed session 和 10 条终态任务 | PASS | 1 条转写完成，9 条现场静音由 VAD 明确失败；无卡死、重复 session 或残留前台服务 |
| M5 | 中断 finalize 与启动恢复 | 通知停止、进程重建和 sidecar 恢复已在本机通过 | PASS | 最终矩阵附日志路径 |
| M6 | 文档导入、去重和系统向外分享 | Xiaomi 与 EVA-AL10 均通过系统 picker、SHA-256 去重和厂商分享面板真实读取。EVA-AL10 重选 `9345f8…a562` 的 5 分钟 WAV 后仍只有 1 条 recording/1 条 completed job；外部只读接收器从 Huawei 分享面板读取 `9,621,036` bytes，哈希与私有副本一致 | PASS | 路径未暴露给接收器；该证据验证 Voice2Text 向外分享，不替代 REC-008 分享导入；权限撤销、大文件取消仍为扩展兼容性覆盖 |
| M7 | 持久队列进程重启/重新附着 | v10→v15 迁移、Xiaomi 处理中重启及短会话均通过；EVA-AL10 在唯一 job `4` 的 `processing/decode`、attempt=1、progress=0.617 时强停 PID `15147`，重启为 PID `27477` 后同一 job 被重新 claim，attempt=2 单次进入 completed，最终仍为 1 个 recording/job/active generation 和 10 个片段 | PASS | 中/低端物理设备重启恢复均通过且无重复任务；长音频资源门禁归 M9 |
| M8 | 时间戳播放、编辑、搜索、导出 | 3000 片段、边界跳转、修订、四种导出、布局/主题/字体/语义自动化与两条 Android 集成流通过；Xiaomi 真实 5 分钟工作区通过。EVA-AL10 进一步验证真实播放、编辑、正向搜索与撤销，TXT/Markdown/JSON/SRT 经 Huawei 分享面板被接收器读取 `1,919/2,104/2,566/2,183` bytes，各自保留 SHA-256 回执 | PASS | 中/低端功能同步通过；独立听审的时间戳 P95 准确率仍是单独发布门禁 |
| M9 | 两小时有界转写 | WAV 分块/取消与流式转码原生单测通过；上述 7,266.56 s M4A 在中端 Xiaomi 10S 上一次完成，job 13 从 04:18:36.030 到 04:21:30.385，共 174,355 ms，RTF≈0.024、attempt=1、5 个持久片段；decode 后半段采样总 RSS 峰值 655,024 KB，无任务重启基线 599,648 KB，差值约 55,376 KB，满足中端 RTF≤1.0、增量 RSS≤512 MB。2026-07-24 同一 M4A 通过低端 EVA-AL10 系统选择器导入后一次完成，耗时 434,035 ms、RTF=0.060、attempt=1、3 个持久片段；30 秒采样峰值 RSS/PSS 为 787,200/737,648 KB，pre-run PSS 为 447,902 KB，温度 38.0-39.0°C，PID 全程不变，无 OOM/LMK/重试/重复任务，处理期间 UI 可导航；移除 picker 源后私有文件哈希仍一致且播放推进至 00:05。长录音以安静段为主，仍完整覆盖两小时流式转码、VAD、识别、持久化和缓冲释放 | PASS | 中端性能门槛与低端无 OOM 门槛均通过。证据：`build/device-evidence/2026-07-24-m3-7edb7c06/summary.md`、`build/device-evidence/2026-07-24-low-eva-al10-2h/summary.md` |
| M10 | 删除失败可重试且无残留 | Xiaomi session 删除失败/重试已通过；EVA-AL10 对 recording/job `4` 将 import canonical 目录从 `0700` 改为 `0500`，首次彻底删除明确保留 recording=`pending`、`9,747,436`-byte WAV、job、1 generation 与 10 segments；恢复 `0700` 后从生产 UI 重试，最近删除变空，recording/job/generation/segment/revision/asset/note/insight/note revision/evidence link 均为 0，canonical 不存在 | PASS | 中/低端幂等删除重试与全图零残留均通过 |
| M11 | AI 证据审核基础且无生产提供商 | fixture 证据回跳、审核/驳回/发布、同意与位置门禁自动化通过 | PASS (FOUNDATION) | 不得描述为生产 AI 生成功能 |
| M12 | 中/低端设备覆盖 | 中端 Xiaomi 10S 已通过两小时锁屏录音、10 次连续会话、导入/去重/分享、队列强停恢复、真实播放/编辑/搜索/四格式导出、删除失败重试及两小时 RTF/RSS；低端 EVA-AL10 已通过 API 26 安装/启动、两条 Android 集成流、旧 toybox 数据恢复、系统 picker、生产模型短探针、7,266.56 s 两小时无 OOM、源移除后播放，以及 M2、M6-M10 完整物理场景 | PASS | 中/低端参考设备覆盖完成。证据：`build/device-evidence/2026-07-24-m3-7edb7c06/summary.md`、`build/device-evidence/2026-07-24-low-eva-al10/summary.md`、`build/device-evidence/2026-07-24-low-eva-al10-2h/summary.md`、`build/device-evidence/2026-07-24-low-eva-al10-scenarios/summary.md` |
| M13 | 标点、人工复核、redo、组合搜索、VTT/范围导出与无障碍增量 | Xiaomi M2102J2SC 真实加载 75,519,198-byte CT-Transformer，对 272.398 秒仓库 WAV 完成关闭/开启标点对照；19 个片段序号、时间戳和正文字符不变量一致。TalkBack 实际绑定且 touch exploration 开启时，200% 字体、深色横屏通过编辑、undo/redo、三态复核、组合搜索、五格式/范围 VTT 集成流；3000 片段远跳、状态更新、搜索和 VTT 导出同机完成；独立接收器按 `text/vtt` 读取范围 VTT 75 bytes，SHA-256=`ba19dc6ce30c0364bac99cb2a8718c74a1546033b112e3b3d5d86e7ed819fe6f` | PASS | 增量门禁只要求至少一台物理 Android；热词、ITN、自动低置信度和 title/speaker 搜索保持未实现。发布继续暂停 |
| M14 | S1 非发布质量收口 | Xiaomi M2102J2SC 上 `LowStorageGateSmokeTest` 2/2 通过：真实 `MediaRecorder` 返回 0–32,767 有界幅度和已识别实际路由；注入 0 bytes 的启动场景返回 `LOW_STORAGE` 且无 staging/canonical/journal 产物；录音中将同一生产 guard 降为 0 bytes 后以 `low_storage` 完成非空 canonical 并清理测试产物。录音遥测/存储 JVM 测试、analyzer、当前 183 个 Flutter 测试、隐私与运行时契约通过；首页持久化生命周期、失败阶段/重试入口、核心 Goo 迁移和设置页 200% 字体均有 widget 覆盖 | PASS | 低存储证据是物理设备上的安全注入，不是真实填盘；本门禁的路由证据只覆盖 REC-003 只读观察，后续 REC-009 自动化不替代蓝牙/有线真机插拔证据；高端设备与发布均未覆盖 |
| M15 | 系统分享导入（REC-008） | 自动化基础闭环通过；2026-07-24 在 Xiaomi 上由独立 UID 的 `com.voice2text.app.test` 冷启动分享只读 `content://` WAV。源与 app-private 副本均为 `64,044` bytes，SHA-256 均为 `073091647e4f2f098c4051c149919e941d513150966d7c2271e30f1a83ed14aa`；落库为 `imported`/`2000 ms` 并创建唯一持久任务 | PASS | 已覆盖“其他 App 分享进 Voice2Text”的真实设备路径；文件管理器/相册和热启动仍可作为扩展兼容性覆盖。证据：`benchmark/S2_PHYSICAL_EVIDENCE.md` |
| M16 | 输入设备主动切换（REC-009） | Android 6/API 23+ 输入枚举、待机/录音/暂停选择、实际路由名、断开降级/停止和 Flutter 幂等重新附着已有自动化。2026-07-24 Xiaomi 未发现外接输入描述符 | DEFERRED_NOT_PASSED（历史 PENDING） | 转入移动高级硬件兼容，不阻塞 S2 Mobile Core。当前没有真实蓝牙/有线/USB 麦克风，不能用内置麦克风替代；后续仍须补连接、主动选择、实际路由和断开证据 |
| M17 | 会中重点与文字备注（REC-010） | 自动化基础闭环通过；2026-07-24 Xiaomi 真机完成 42,880 ms 录音，写入 12,006 ms 重点标记和 28,006 ms 备注；任务以 `VAD_FAILED` 结束后强停/冷启动，会议时间线仍显示两项。点击标记使播放器跳至 `00:12`，点击备注跳至 `00:28` | PASS | 写入、正常停止、失败保留、进程重启、重开和时间线回跳均已覆盖。证据：`benchmark/S2_PHYSICAL_EVIDENCE.md` |
| M18 | ASR-005 时间戳准确率（`ASR-005-TIMESTAMP-INDEPENDENT`） | Silero 参数 sweep 均为 1 段且 Paraformer token timestamps 为空后，生产链路增加自适应持续静音分段；Xiaomi 两条固定 clip 预测为 5/4 段，证据 SHA-256=`01b77e52dd6eadd048a6a2cd91952e7502ad9f6e856010b08d32923a4be1c0d7`；provisional 工程 P95=182 ms/18 边界，报告 SHA-256=`d94940888f4786e212c3b468a633af84241ad27bee34b3bda22b91e3109d9459` 且 `releaseEligible=false` | BLOCKED (ENGINEERING PASS) | 唯一 Mobile Core blocker。仍须由独立 reviewer 完成盲听 worksheet 和元数据，再用正常模式得到 release-eligible P95 ≤1.5 秒；实现代理不能充当 reviewer |
| M19 | S2 Mobile Core 自动化总回归 | 2026-07-25 当前源码通过 analyzer、183 个 Flutter tests、40 个既有 ASR/ITN/timestamp/enhancement Python gate tests、应用 Kotlin 单测、debug APK、AndroidTest 构建及各合同。模拟器会议闭环 4/4 通过 | PASS (AUTOMATED) | 自动化通过不替代 M18 独立听审。M16/M20/M21 作为 `DEFERRED_NOT_PASSED` 保留历史，不再阻塞 Mobile Core |
| M20 | ASR-006/007 在线候选能力筛选 | Xiaomi 隔离运行 Apache-2.0 14M Zipformer。固定集：无热词 CER 4.931%/RTF 0.078，热词 CER 4.734%/RTF 0.099；错误全为漏字，不能校准；目标词命中 52→52 | DEFERRED_NOT_PASSED（历史 BLOCKED / LAB ONLY） | 自动 confidence 与热词转入 PC ASR，不阻塞 S2 Mobile Core。原始报告 SHA-256=`7b6c9f0f723d90d37b5de0bf01a9c03e9e3332694f80c54e0fc272a912c7b0c9`；历史缺口继续作为 PC 准入条件 |
| M21 | ASR-008 GTCRN 固定噪声集成对门禁 | Xiaomi 完成五组各 300.655 秒 raw/enhanced 路径；安静 CER、噪声改善、增强 RTF、原生内存和边界门禁未达到阈值 | DEFERRED_NOT_PASSED（历史 FAIL） | 转入高级音频，不阻塞 S2 Mobile Core。原始报告 SHA-256=`05749363f647b30cf337bf61c0a843cd288937aa7f3ff416835120b231f23362`，评估 SHA-256=`b7ae589b0c8494a06c1b5952c462a2a20319a83859d845da9b42474dffa3a14a`；仍无 AEC |

### M13 转写质量增量证据

- 设备与窗口：Xiaomi M2102J2SC（thyme，Android 13/API 33），
  1080×2340、440 dpi；按当前目标用户群与设备年代作为中端参考机，不按
  首发营销定位归类。
- 标点媒体：`assets/sherpa/wav/test.wav`，272.398 秒。2026-07-24 真机
  instrumentation 结果为 known-text 389 ms、关闭标点转写 10,385 ms、
  开启标点转写 13,804 ms、19 个片段；去标点正文 SHA-256 为
  `15ef3d6aef35b238d68d0f4165d032732487607ad62dbbc7c73b34764495d63c`。
  外部 `dumpsys meminfo` 采样最高 TOTAL PSS/RSS 为 529,856/603,728 KB；
  无 JNI 崩溃、无片段数量/序号/时间戳变化。
- 最终源码在干净测试安装上再次跑通标点模型原子提取和完整 WAV：
  known-text 1,253 ms、关闭标点转写 73,411 ms、开启标点转写 47,944 ms，
  instrumentation 总计 124.399 秒；片段数和上述正文 SHA-256 保持一致。
- 无障碍与布局：TalkBack 服务处于 bound，`touchExplorationEnabled=true`；
  系统字体 2.0、night mode=yes、横屏 rotation=1 下两条 Android 集成用例
  通过。首轮发现 234 px 纵向溢出后改为短窗口可滚动复核工具区，新增
  932×430/200% widget 回归后同机复跑通过。普通 100% 字体、浅色竖屏路径
  也已通过；测试结束后 TalkBack、字体、主题和旋转均恢复原值。
- 3000 片段：同一 TalkBack/200%/深色横屏环境中，惰性时间轴未构建首尾
  全部子树，完成第 3000 段远距离跟随、人工复核状态更新、组合搜索和完整
  VTT 流式导出；两条用例总测试时间 57 秒，无 OOM 或布局异常。
- 分享字节证据：范围 VTT MIME 为 `text/vtt`，接收器通过 FileProvider
  URI 实际读取 75 bytes，SHA-256 为
  `ba19dc6ce30c0364bac99cb2a8718c74a1546033b112e3b3d5d86e7ed819fe6f`。
- 隐私检查：设备证据日志仅包含模型大小、耗时、片段数、内存、MIME、
  字节数和哈希，不包含转写正文、会议标题或完整私有路径。

当前历史中/低端主链设备门禁仍为 **PASS**，REC-008 与 REC-010 物理交互
也已通过。按 `S2-MOBILE-CORE-2026-07-25`，S2 Mobile Core 的设备矩阵
仅因 M18 独立听审保持 **BLOCKED**。M16/M20/M21 的原始 PENDING/BLOCKED/
FAIL 证据继续有效，但已迁移到后续阶段，不能用 `DEFERRED_NOT_PASSED`
替代阈值 PASS，也不再阻塞 Mobile Core。

整体版本仍为 **NOT RELEASE-READY**：S1 高端参考设备、EXP-005 和发布
交付仍是独立前置条件。不得把 Mobile Core 子能力或范围迁移表述为原 S2
历史整体通过。

验收总标准：
- 无闪退
- 任务状态流转正确（pending -> processing -> completed/failed）
- 结果可展示（成功文本/失败原因）
- 日志可见 `transcribe ok`

## 历史基线归档（2026-05-07）

以下内容只记录旧版 R1-R6，不参与当前版本发布判定。

### 0. 基础信息（历史回归）

- 日期：2026-05-07
- 执行人：
- 分支/提交：
- 设备型号：M2102J2SC（thyme）
- Android 版本：
- App 版本（包名/版本号/安装时间）：
- 模型配置：paraformer-zh
- 引擎模式（auto/stub/real）：

---

## 1. 核心场景矩阵

| ID | 场景 | 步骤 | 预期结果 | 日志证据 | 结果(PASS/FAIL) | 备注 |
|---|---|---|---|---|---|---|
| R1 | 短录音转写 | 录音 3-8 秒 -> 停止并保存 | 记录入库；任务完成；列表可见转写文本 | `transcribe ok` | PASS |  |
| R2 | 长录音转写 | 录音 60-180 秒 -> 停止并保存 | 无闪退；任务完成；UI可滚动展示结果 | `transcribe ok` + costMs | PASS |  |
| R3 | 多次连续录音 | 连续做 5 次短录音并保存 | 每次都生成记录和任务，状态无错乱 | 多条 `transcribe ok` | PASS |  |
| R4 | 任务失败后重试 | 制造失败任务后点“重试” | 状态 failed -> processing -> completed/failed；按钮防连点生效 | retry 前后日志 | PASS |  |
| R5 | 权限拒绝后重试 | 首次拒绝麦克风权限 -> 再次触发录音 | 给出明确提示；允许用户恢复后再次录音 | 权限相关日志 | PASS |  |
| R6 | 来电/系统中断恢复 | 1) 开始录音 2) 触发中断（按 Home/切后台/来电）3) 回到 App | 出现“录音因系统中断已自动停止并保存”；不崩溃；可继续下一次录音 | 中断后提示截图 + `transcribe ok`/失败日志 | PASS |  |

---

## 2. 状态流转核对

每个任务至少核对一次：

- [x] pending
- [x] processing
- [x] completed（有 result_text）
- [x] failed（有 error_message）

异常核对：

- [x] failed 任务可重试
- [x] 重试期间按钮禁用，避免重复触发
- [x] 重试完成后列表刷新正确

---

## 3. 日志与产物留档

建议命令：

```bash
./tool/run_android_smoke.sh
./tool/check_transcribe_log.sh
```

每轮回归至少留档：

- [x] 最新 smoke 日志路径
- [x] 至少一条 `transcribe ok` 日志截图/文本
- [x] 失败场景日志（如有）
- [x] 构建信息截图（包名/版本/安装时间）

本轮日志证据：

- `build/smoke/logcat-20260507-092723.txt`
- `05-07 09:28:31.869 I/Voice2TextNative(...): transcribe ok mode=auto model=paraformer-zh durationMs=17448 costMs=3481`
- `05-07 09:28:31.882 I/flutter(...): transcribe ok jobId=2 durationMs=17448`

---

## 4. 结论门槛（是否通过）

通过条件（全部满足才算 PASS）：

- [x] R1~R6 全部 PASS
- [x] 无闪退
- [x] 任务状态无异常卡死
- [x] 成功/失败结果都可展示
- [x] 至少一轮 real 模式日志包含 `transcribe ok`

最终结论：

- [x] 本轮回归通过，可作为“重构完成度”证据
- [ ] 本轮回归未通过，阻塞项见下

历史状态：PASS（仅说明 2026-05-07 的 R1-R6 基线通过）

阻塞项：无（矩阵维度）

---

## R6 专项留证（建议）

- [ ] 中断触发前录音状态截图（录音中）
- [ ] 回到 App 后提示截图（自动停止并保存/自动保存失败）
- [ ] 记录页新增记录截图
- [ ] 转写页任务状态截图（completed 或 failed）
- [ ] 对应日志文件路径（`build/smoke/logcat-*.txt`）

## 已知限制（当前版本）

- 无新增阻塞性已知限制（R6 已完成真机回归通过）。
