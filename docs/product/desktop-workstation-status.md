# Desktop-first meeting workstation status

决策：`DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26`

## 开发阶段执行策略

当前移动端与 PC 端统一为 `DEVELOPMENT_ONLY`。生产签名、公证、商店提交、
正式升级、发布候选包/设备矩阵与其他生产发布任务均暂停；日常验证上限为
30 分钟，使用 5–30 秒 smoke、2–5 分钟质量样本和按需 15–30 分钟稳定性/
故障注入。既有一小时/两小时和历史 dogfood 数据只作基线引用，不主动重跑。
恢复生产发布或数小时门禁必须有新的明确产品决策。

## 当前结论

桌面端是会议处理主工作站，手机是可靠采集端和可独立使用的移动核心。macOS
现已将产品 ASR 收敛为唯一的 Qwen3-ASR 0.6B int8 配置，状态回到
`PRODUCT_IN_PROGRESS`，旧 Zipformer closure 不继承给新模型；Windows 在
Qwen3 产品门禁完成前保持 `BLOCKED_BY_MACOS_CLOSURE`。两个平台仍不得跨目标
继承 PASS。此前的 Windows `PLANNED` 状态属于 Zipformer closure 后的历史状态。

本状态页描述当前执行方向，不改写已经完成的 S2/S3 历史证据。paired-PC
provider v1 继续只表示“转写片段到结构化纪要”；桌面 ASR、原始音频传输和
本地任务使用新的 capability 与 schema。

## 平台状态

| 目标 | 状态 | 当前边界 |
| --- | --- | --- |
| Android | `MOBILE_CORE_AVAILABLE` | 保持录音、导入、离线转写、复核、AI 纪要和导出回归；一次性最终移动说话人诊断已以 `FAIL_NO_ADMISSIBLE_CANDIDATE` 终态关闭，不继续候选循环 |
| macOS | `PRODUCT_IN_PROGRESS` | ASR 只保留 Qwen3-ASR 0.6B int8；当前只重跑不超过 30 分钟的质量、生命周期、取消、恢复和资源开发门禁，旧 U9 长时与 dogfood PASS 仅作历史证据 |
| Windows | `BLOCKED_BY_MACOS_CLOSURE` | 等待 Qwen3 macOS closure；之后只移植同一 finalist 与产品流，并在 Windows 参考目标重新生成独立证据 |

## 2026-07-28 macOS 扩展能力

扩展仅作用于桌面端；根移动 app、Android 原生录音、移动导航和移动 AI provider
均不新增功能或 UI。Windows 对下列能力统一为
`BLOCKED_BY_EXPANDED_MACOS_CLOSURE`：

- 直接采集：`PASS`。工作站应用启动与仅麦克风录制下限为 macOS 13.0；
  macOS 13.0–14.1 在 preflight 明确提示不会录到电脑播放声音，并允许用户以
  `microphone_only` 模式继续；Core Audio process tap 双轨录制要求 macOS
  14.2，本地离线转写在
  用户安装或运行模型时要求 macOS 15.5。Sherpa/ONNX 已隔离到 worker，不再
  进入主进程启动依赖。曾按扩大覆盖面的要求实测将壳配置降为 macOS 12.0，
  但 Flutter 3.41.9 的 native-assets pipeline 当前把 macOS target 固定为
  13，实际生成的 `App.framework` 仍为 `minos 13.0`；因此该配置会产生
  不能在 12.x 启动的自相矛盾产物，已撤回。当前 Debug 产物的主 executable、
  `App.framework`、原生 launcher 与 Info.plist 已重新验证全部为 13.0；
  不采用 Mach-O 篡改或未验证的旧 Flutter 工具链。仍缺 macOS 13.x/14.x
  实机 smoke；当前 M4 只能通过 DEBUG 强制模式验证单轨代码路径，不能替代
  低系统 target-specific evidence。系统音频和麦克风
  分轨保存，不录屏，不采集本应用输出。契约为
  `desktop-capture-session/v1`。Apple M4 主机上的真实短 smoke 已完成
  start/pause/resume/stop，并分别观察到非零系统音频和外置耳机麦克风帧；
  当前 U11-U18 与扩展 closure 的参考目标已调整为这台 Mac mini `Mac16,10`、
  Apple M4（10 核）、16 GiB、macOS 15.7.5（24G624），因此该短 smoke 是
  同目标 API 证据。随后同一 M4 构建完成 20 分钟双轨 probe：两轨各 240 个
  五秒 CAF/LPCM 分块、480 个已确认 hash 均有效、总占用 704,747,557 bytes，
  完成恢复 326 ms；写入中、finalize 中和 journal 落盘后三个预注册故障点均
  幂等，每轨最多隔离一个尾块。U12 的 schema v22、durable chunk/journal、
  stable command receipt、partial capture、受限单会话丢弃和启动恢复已通过
  storage/service/recovery 测试；正常停止、麦克风断开、运行时低磁盘和双轨
  故障的真实 integration matrix 通过。另一次真实进程终止探针在写入中、
  finalize 中和 journal 落盘后分别以预注册退出码 86/87/88 终止，首次恢复
  最慢 2 ms，二次恢复幂等，零损坏成品。U11 证据位于
  `benchmark/desktop/capture/evidence/macos_m4_20m_chunk_recovery_probe.json`，
  U12 证据位于
  `benchmark/desktop/capture/evidence/macos_m4_u12_fault_matrix.json`。
- 实时草稿：`U18_CONTROL_RETAINED_PASS`。当前 M4 的固定
  SenseVoice control 已通过独立 live contract：15 分钟回放的
  speech-end-to-Flutter-visible P50/P95 为 900.901/1492.201 ms，最大 backlog
  0.528 秒，15 秒强制切分、无 crash/OOM；两分钟 App Sandbox 集成 probe 中
  control 与并发字幕录音的系统/麦克风 callback 帧均与持久化帧完全相等，
  额外丢帧为 0，保守总 RSS 1,318,420,480 bytes，UI 长帧率为 0。只实现
  Silero VAD 端点后的 SenseVoice 句级 `VAD_SIMULATED_STREAMING`，不宣称
  token streaming，不覆盖人工修订。U18 的 control + 13 个单变量 screening
  已完成；`vad-threshold-0.4` 在开发集筛入，但在 held-out + 15 分钟实时回放
  中总错误率由可比 control `0.300542` 回退至 `0.305828`，非目标错误率由
  `0.305309` 回退至 `0.312142`，超过 `+0.003` 门限，故保留 U13 control。
  2025 模型因许可未解决、non-speech 幻觉和质量回退不得晋级；ORT 1.24.4
  因 RSS 回退不得晋级。最终 machine decision 位于
  `benchmark/desktop/live_caption/evidence/sensevoice-optimization/macos/u18-decision.json`。
  U14 已把该 control 接入 schema v23 的独立 draft generation 和长驻
  spool worker；sequence 重放幂等，generation/model/timestamp/offset 漂移
  fail closed。停止顺序固定为双轨 finalize/commit、草稿 flush/关闭、再排入
  U17 Qwen3 正式任务；不完整正式输出不切换 active，人工修订进入显式且可撤销
  reconcile。Apple M4 的 10 秒有界真机 smoke 生成 3 个系统音频和 2 个麦克风
  CAF chunk，并写出 97 个 100 ms 对齐 spool frame；worker 产出 2 个连续
  utterance，最终 offset 310400 bytes、backlog 0。该短 smoke 不替代历史
  长时证据，记录于
  `benchmark/desktop/live_caption/evidence/handoff/macos/u14-handoff-smoke.json`。
- Qwen3 优化：`OPTIMIZATION_ADMITTED`。Apple M4 上八个预注册单变量 arm
  已全部完成，machine decision 冻结 `vad-max-speech-12`：保持 Qwen3-ASR
  0.6B int8、Sherpa 1.13.4 / ORT 1.27、CPU 2 threads、concurrency 1、
  空 hotwords 和 512 token，改用官方 Silero VAD
  `threshold=0.2/minSpeech=0.2/maxSpeech=12`。总错误率从 `0.225381`
  降到 `0.200605`，非目标错误率从 `0.267542` 降到 `0.240118`，target-term
  recall 从 `0.75` 升到 `1.0`；取消、RSS、临时目录、截断和幻觉门禁通过。
  ORT 1.24.4 速度显著更快但未取得最低准入错误率，故未替换 runtime；
  128-token arm 因截断明确淘汰。raw/summary/decision SHA-256 互引，决策位于
  `benchmark/desktop/asr_comparison/evidence/qwen3-optimization/macos/u17-decision.json`。
  最终产品 worker 已编译并在 51.5 秒 frozen fixture 上按该 profile 真机
  smoke 通过，生成 4 个单调时间戳片段；证据位于同目录
  `u17-product-worker-smoke.json`。
- 录音交互：`PASS`。
  会议库主操作、preflight、共享 window/menu controller、单次 finalize、
  双轨电平、caption 降级/重启、partial capture 与逐 session recovery
  已实现；所选 microphone UID 会绑定到 Core Audio device，关闭主窗口保持
  app/菜单栏录音，系统睡眠前安全暂停并在唤醒后显式要求继续，reduced motion
  禁用页面 loading 动画；睡眠期间 UI 计时和实时草稿轮询也同步暂停。定向
  desktop tests、macOS interaction integration test、runtime-floor contract、
  21-stage `dev_check` 和 Debug build 通过。Apple M4 真机已完成中断恢复、最终
  bounded dual-track stop/finalize 与 DEBUG-forced microphone-only smoke，
  系统默认输入识别为 `外置麦克风`。forced path 不作为 macOS 13.x/14.1
  真机兼容证据；该低版本物理证据仍待具备相应系统的主机补充。证据位于
  `docs/product/desktop-workstation-u15-evidence.json`。
- 开放 AI：`PASS_REMOTE_PROVIDER_SCOPE`。用户明确决定不把本地生成式大模型
  作为产品能力或验收门禁；设置和共享 registry 仅暴露 DeepSeek 预设与远程
  OpenAI-compatible 自定义接口。两者均要求远程 HTTPS、Keychain 密钥和逐场
  明确同意，并通过无自动回退、schema/evidence、3xx、大小、超时、每 provider
  单并发和 live HTTP 取消门禁；“检查配置”在逐场同意前不发起网络。不安装、
  启动或下载 Ollama。机器证据位于
  `docs/product/desktop-workstation-u16-evidence.json`。完整 21 步
  `./tool/dev_check.sh` 已通过；历史长时真实门禁未重跑。

上述能力均受 `DEVELOPMENT_ONLY` 和单次 probe 不超过 30 分钟约束。缺少当前
Mac mini `Mac16,10` / Apple M4 / 16 GiB / macOS 15.7.5（24G624）的
target-specific evidence 时，UI 不得宣称可用。U4-U9 的 Apple M2 证据保留
为历史基线，不自动继承到当前扩展 closure。

## 模型与证据

所有结果均遵循 `TARGET_SPECIFIC`：Android、macOS、Windows 分别记录 OS、
CPU、内存、runtime/model/fixture SHA-256、线程、质量、性能和资源结果。
任何平台的 PASS 都不能作为另一个平台的唯一证据。

macOS 第一轮固定比较：

- ASR：Sherpa、FunASR。
- 说话人分离：Sherpa、pyannote.audio。
- Whisper、faster-whisper 和 whisper.cpp 不进入第一轮。

2026-07-28 的产品收敛只保留一个 ASR profile：
`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`，CPU provider、2 threads、
concurrency 1、官方 Silero VAD `threshold=0.2/minSpeech=0.2/maxSpeech=12`、
`maxTotalLen=512`、`maxNewTokens=512`、`temperature=1e-6`、`topP=0.8`、
`seed=42`、空 hotwords。说话人分离保持独立能力，不作为第二个 ASR 候选。
冻结测量、模型 hash、报告 hash 与 U17 machine decision 位于
`benchmark/desktop/asr_comparison/pc_qwen3_optimization_baseline.json`。
当前产品 runtime 保持 sherpa-onnx 1.13.4 / ORT 1.27；ORT 1.24.4 已通过
本轮单变量速度/质量门禁，但固定 evaluator 以最低准入错误率选择
`vad-max-speech-12`，因此不组合两个变量，也不替换产品 runtime。当前 sherpa
归档中的第三方 ONNX 转换仍缺少独立
许可证声明，因此只允许 Debug/Profile 本地产品验证；外部分发与 Release
相关工作在当前开发阶段统一暂停，未来恢复时再完成来源许可审查。

U4 在 Apple M2 / 16 GiB / macOS 15.7.5 上完成单 lockfile falsification 和
Debug 构建。真实 `assets/sherpa/wav/test.wav` 已通过系统文件选择器导入，
私有副本 SHA-256 与源文件一致，重启后持久 `pending` 任务仍可见；未安装
准入模型时 UI 明确显示不可用，未生成模拟转写。证据位于
`docs/product/desktop-workstation-u4-evidence.json`。

U5 在同一目标上完成真实 Sherpa 1.13.4 基线。Zipformer 14M 的固定中文
夹具 CER 为 `0.035503`、RTF 为 `0.020462`；五分钟说话人夹具在保留重叠并
抑制检测到的静音后 RTF 为 `0.257393`；完整 7,200 秒资源门禁 RTF 为
`0.274567`、增量峰值 RSS 为 `216252416` 字节，未超时或 OOM。离线本地文件
到 ASR、匿名说话人、人工复核契约和非 AI WebVTT 导出的纵切通过。

Sherpa 1.13.4 的离线分离进度回调返回值不会中止原生计算，因此取消门禁使用
独立 worker 进程：到达原生 diarizer checkpoint 后终止进程组，不发布部分
结果并清理临时目录。U5 证据位于
`docs/product/desktop-workstation-u5-evidence.json`。当前仍是 benchmark
阶段。

U6 在同一 Apple M2 目标与固定中文夹具上完成首轮比较并冻结 finalist。
FunASR 1.3.22 的 Paraformer、VAD、标点、ITN 请求和 941 个时间戳均实际运行，
绝对 CER/RTF 门禁通过，但 CER `0.116371`、含冷启动 RTF `0.202825`、增量峰值
RSS `3130687488` 字节，且模型权重 `1209984868` 字节；相对 Sherpa 的质量、
速度、内存和交付体积均无收益，因此不选入产品。pyannote Community-1 固定到
commit `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`，但未接受用户条件、未下载
模型，保持 `LAB_ONLY_USER_CONDITIONS_NOT_ACCEPTED`。

U6 当时冻结的组合为 Sherpa Zipformer 14M ASR 与 Sherpa pyannote 3.0 segmentation +
3D-Speaker ERes2Net diarization，共用 `sherpa-onnx-c-api@1.13.4`。segmentation
归档包含固定 MIT 许可证，embedding 模型固定 Apache-2.0 disposition；产品
交付必须保留 notice，只输出匿名 speaker，不持久化 voiceprint。机器决策与
选择说明分别位于 `benchmark/desktop/desktop_model_candidates.json` 和
`benchmark/desktop/MACOS_ENGINE_SELECTION.md`，U6 汇总证据位于
`docs/product/desktop-workstation-u6-evidence.json`。

U7 将当时冻结的组合产品化为独立 macOS 会议工作站。默认会议库、持久任务区、本机
播放、虚拟化转写、搜索/定位、编辑与 undo/redo、匿名说话人重命名/合并/
人工指派、证据链接、五格式导出和会议笔记审核均使用共享 v19 SQLite 与
`meeting_workflows`，desktop app 不导入根移动 package。处理任务和 AI 任务
独立持久化；partial success、取消、重启未知状态和可重试失败均有明确 UI，
模型重跑不会静默覆盖人工 transcript 或 speaker revision。

冻结模型通过版本化 manifest 完成真实下载、SHA-256/大小复核、受控解包和
原子激活。签名 Debug app 内嵌 arm64 AOT worker 与进程组 launcher；真实
`assets/sherpa/wav/test.wav` 在 47.8 秒内生成 496 个片段和匿名说话人，
编辑/撤销/重做、人工 speaker、搜索与五格式导出端到端通过。DeepSeek 密钥
只进入 macOS Keychain；未配置或未对本场明确同意时零网络，worker 不继承
父环境或密钥。

五个固定真实来源的一分钟 dogfood 窗口均完成复核和五格式导出，并记录失败
恢复文案；冻结阈值 `0.65` 下 speaker assignment 修正率为 `7.996%`
（`73/913`），通过 U9 质量门禁。3001 片段资料库的打开、搜索和 200% 字体
虚拟列表已通过操作门限。汇总证据位于
`docs/product/desktop-workstation-u7-evidence.json`。

U9 在 Apple M2 / 16 GiB / macOS 15.7.5 上用最终产品 worker 完成 120 分钟
完整 ASR 与说话人分离，耗时 `1787419 ms`、RTF `0.248253`，低于 30 分钟
门槛。长会议使用两个各 2 线程的重叠分片 worker，120 秒重叠区对齐匿名
speaker 后在中点无重复拼接；一个作业仍统一拥有取消与发布。3001 段打开
P95 `7.323 ms`、搜索 P95 `0.641 ms`、真实播放 seek P95 `0.266 ms`，固定
滚动 452 帧长帧率为 0%。FileVault 在证据采集时关闭，UI 明确披露整库/音频
没有应用层静态加密并给出启用提示；API 与配对秘密仍只进 Keychain。U9 证据
位于 `docs/product/desktop-workstation-u9-evidence.json`。

移动端说话人最终诊断的四个固定 arm 已全部在 Xiaomi M2102J2SC 完成。3D-Speaker
t1/t2/t4 和仅替换 embedding 的 TitaNet t2 都未同时通过质量、语义和 RTF
门禁；终态为 `MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE`，且
`nextCandidate=null`。原始证据、逐臂评估与汇总位于
`benchmark/evidence/speaker_diarization/final-diagnostic/`。

## 局域网与数据安全

U8 LAN 交接当前为 `PASS_MACOS_ANDROID_LAN`。`companion-media-transfer/v1`
与 paired-PC provider v1 分离；动态端口经 DNS-SD 发布，配对绑定双方身份，
会话使用 HKDF-SHA256 派生的定向 AES-256-GCM 密钥、认证单调计数器和过期
边界。Android Keystore 与 macOS Keychain 保存长期信任，SQLite 只保存
非秘密的 peer、transfer、chunk、receipt 和清理历史。

同一真实局域网内，Xiaomi M2102J2SC 向 Apple M2 Mac 发送 24 MiB、96 分块
固定文件：第 25 块后中断并重连，只补发剩余 18,612,224 字节；整文件 SHA-256
与桌面导入提交哈希一致，重复发送返回相同 receipt 和 recording ID。手机源
文件默认保留。服务端原始应用帧观察覆盖 403 帧、50,463,410 字节，未发现
固定明文会议内容、可复用凭据原始字节或其 Base64。汇总证据位于
`docs/product/desktop-workstation-u8-evidence.json`。

## 开发提醒边界

ASR-005 的兼容历史字段仍为 `USER_PRE_RELEASE_ACCEPTANCE_ONLY`，但当前产品
策略是 `RELEASE_SCOPE_PAUSED`。它不进入开发任务、自动状态报告或阻塞列表；
恢复发布规划后再重新定义所有者与执行方式。

机器可验证的权威状态位于
[`desktop-workstation-scope.json`](desktop-workstation-scope.json)。
