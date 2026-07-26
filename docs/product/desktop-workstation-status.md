# Desktop-first meeting workstation status

决策：`DESKTOP-FIRST-MEETING-WORKSTATION-2026-07-26`

## 当前结论

桌面端是会议处理主工作站，手机是可靠采集端和可独立使用的移动核心。macOS
已完成 closure，状态为 `PASS`；Windows 依赖已解除并进入 `PLANNED`。两个
平台仍不得跨目标继承 PASS。

本状态页描述当前执行方向，不改写已经完成的 S2/S3 历史证据。paired-PC
provider v1 继续只表示“转写片段到结构化纪要”；桌面 ASR、原始音频传输和
本地任务使用新的 capability 与 schema。

## 平台状态

| 目标 | 状态 | 当前边界 |
| --- | --- | --- |
| Android | `MOBILE_CORE_AVAILABLE` | 保持录音、导入、离线转写、复核、AI 纪要和导出回归；一次性最终移动说话人诊断已以 `FAIL_NO_ADMISSIBLE_CANDIDATE` 终态关闭，不继续候选循环 |
| macOS | `PASS` | U9 已通过长会议、dogfood、性能、生命周期、安全、可访问性、真实集成和构建门禁，closure disposition 为 `MACOS_CLOSED_FOR_WINDOWS_ENTRY` |
| Windows | `PLANNED` | 仅移植 macOS finalist 与产品流，并在 Windows 参考目标重新生成独立证据，不继承 macOS PASS |

## 模型与证据

所有结果均遵循 `TARGET_SPECIFIC`：Android、macOS、Windows 分别记录 OS、
CPU、内存、runtime/model/fixture SHA-256、线程、质量、性能和资源结果。
任何平台的 PASS 都不能作为另一个平台的唯一证据。

macOS 第一轮固定比较：

- ASR：Sherpa、FunASR。
- 说话人分离：Sherpa、pyannote.audio。
- Whisper、faster-whisper 和 whisper.cpp 不进入第一轮。

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

冻结组合为 Sherpa Zipformer 14M ASR 与 Sherpa pyannote 3.0 segmentation +
3D-Speaker ERes2Net diarization，共用 `sherpa-onnx-c-api@1.13.4`。segmentation
归档包含固定 MIT 许可证，embedding 模型固定 Apache-2.0 disposition；产品
交付必须保留 notice，只输出匿名 speaker，不持久化 voiceprint。机器决策与
选择说明分别位于 `benchmark/desktop/desktop_model_candidates.json` 和
`benchmark/desktop/MACOS_ENGINE_SELECTION.md`，U6 汇总证据位于
`docs/product/desktop-workstation-u6-evidence.json`。

U7 将冻结组合产品化为独立 macOS 会议工作站。默认会议库、持久任务区、本机
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

ASR-005 的唯一现行状态是 `USER_PRE_RELEASE_ACCEPTANCE_ONLY`，所有者为用户。
它不进入开发任务、自动状态报告或阻塞列表。

机器可验证的权威状态位于
[`desktop-workstation-scope.json`](desktop-workstation-scope.json)。
