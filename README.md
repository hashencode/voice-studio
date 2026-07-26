# voice2text_flutter

Flutter 版本重构工程（Android 优先）。

## 设计与开发指导

当前项目 UI 设计与 Flutter 组件开发以相邻组件库文档为准：

- 设计规范：`../flutter-components/DESIGN.md`
- 开发指导：`../flutter-components/DOC.md`

涉及 UI、页面结构、交互状态或组件选型的改动，应优先使用 `package:flutter_components/flutter_components.dart` 导出的 `Goo*` 组件，并遵循根目录 `AGENTS.md` 的项目级说明。

## 常用命令

在本目录执行：

```bash
# 构建缓存容量检查（默认 20 GiB，可用 --dry-run 只查看）
python3 tool/build_cache_guard.py

# 轻量自检：契约 + analyze + test
./tool/dev_check.sh

# 全量自检：含 debug APK 构建
./tool/dev_check.sh --with-build

# 真机会议闭环：时间戳播放/编辑/搜索/导出 + 队列恢复/删除重试
./tool/run_meeting_flow_smoke.sh <android-device-id>

# 单独构建
flutter build apk --debug

# UI 真机开发：启动后监听文件，安静 60 秒后自动 hot reload / rebuild
./tool/watch_ui_device.sh 8PXCGQZPEQJNP7U8

# UI watcher 幂等检查：有真机且 watcher 未运行时后台启动，否则跳过
./tool/ensure_ui_watcher.sh

# Android 冒烟（安装+启动+抓日志）
./tool/run_android_smoke.sh

# 转写日志判定（检查最新 smoke 日志）
./tool/check_transcribe_log.sh

# ASR 模型 benchmark
# 详见 benchmark/README.md；音频 fixture 已提交，模型下载到 build/asr_benchmark，不提交到 Git。
MODEL_IDS="paraformer-zh-2025-10-07 paraformer-en-2024-03-09" PROFILE_IDS="standard_vad_silero_warm_t2" ./benchmark/run_asr_benchmark.sh

# 清理真机转码临时 wav（默认保留最近 10 个）
./tool/clean_transcoded_audio.sh 8PXCGQZPEQJNP7U8 10

# 版本号更新
./tool/bump_version.sh --set 1.0.1+2

# 发布前检查（会给出 warning/error）
./tool/preflight_release.sh
```

## 目录说明（当前阶段）

- `lib/features/recording/`：录音流程与状态机
- `lib/features/transcription/`：转写任务列表与重试
- `lib/features/meetings/`：会议播放、时间轴、编辑、搜索与导出工作区
- `lib/features/meeting_intelligence/`：证据、审核、持久任务与 DeepSeek 云端直连
- `lib/features/records/`：录音记录列表、详情、删除
- `lib/features/settings/`：模型选择与自动转写配置
- `lib/data/sqlite/`：本地数据库
- `lib/app/contracts/`：Dart 侧音频/通道契约
- `android/app/src/main/kotlin/.../contracts/`：Android 侧契约
- `tool/check_audio_contract.sh`：契约一致性校验
- `tool/check_privacy_contract.sh`：备份、分享、日志和 AI 网络边界检查
- `tool/dev_check.sh`：开发自检入口

## 当前状态

- Android 录音已接入 `MediaRecorder` 实现
- Android 只有一个无 Flavor 的正式运行基线；开发、冒烟和发布构建均使用真实本地 ASR
- 转写链路：`m4a` 录音 -> 原生转码 `wav(16k mono)` -> Silero VAD 切片 -> Sherpa JNI 离线识别
- 数据闭环：录音/导入 -> 持久转写队列 -> 结构化时间戳 -> 播放复核、编辑、搜索与 TXT/Markdown/JSON/SRT 导出
- 转写结果按 generation 保存；用户编辑或证据关联的当前版本不会被重试结果静默覆盖
- AI 默认仍关闭且不隐式上传；用户可配置自己的 DeepSeek 密钥，逐场同意后使用
  `cloudDirect` 生成可追溯纪要
- App 底部显示当前安装包信息（包名/版本/安装时间），便于确认是否为最新构建
- 移动端不提供 Live VAD、实时转写或 stub 降级；缺少模型资产时会明确失败
- 时间戳 benchmark 的独立听审当前标记为
  `SKIPPED_PENDING_USER_TEST`；`releaseEligible=false` 的自测报告不是发布证据
- 范围决策 `S2-MOBILE-CORE-2026-07-25` 将移动端 S2 收敛为 **S2 Mobile Core**：保留 Paraformer 会后离线转写、真实标点、结构化时间戳、人工
  三态复核、播放编辑搜索导出、隐私和设备可靠性；移动端不因自动
  confidence 或热词更换模型
- Mobile Core 的 18 个强制门禁目前 17 PASS、1 BLOCKED；唯一 blocker 是
  ASR-005 独立听审。当前工程分段 5/4、provisional P95=182 ms，但
  `releaseEligible=false`；该人工门禁暂时跳过，等待用户后续测试
- 自动 confidence、热词、高级 ITN、GTCRN/AEC 和 REC-009 外接麦克风验收
  均为 `DEFERRED_NOT_PASSED`，历史 BLOCKED/FAIL 证据保留，不等于通过
- S1 非发布功能闭环已在低端和中端参考机通过；高端参考设备作为最终候选包
  的发布兼容性门禁，不回退已通过的功能状态
- 整体仍为 **NOT RELEASE-READY**：除 Mobile Core 外，发布高端兼容性、
  EXP-005 与正式发布交付也须单独完成。机器范围契约见
  `docs/product/s2-mobile-core-scope.json`，统一结论见
  `docs/product/s2-closure-status.md`

### S3 第一产品化增量

决策 `S3-PRODUCTIZATION-2026-07-25` 当前为 `PARTIAL_PASS`：

- DeepSeek `cloudDirect` 和结构化纪要闭环已实现。用户自己的密钥保存在
  Android Keystore 边界内；只有逐场确认后，所显示范围的会议文本才会离开
  设备。纪要可编辑、复核、发布并回到原文/音频证据。
- 端侧说话人分离为 `DEFERRED_NO_ADMISSIBLE_CANDIDATE`：FP32 有界候选和
  唯一 INT8 fallback 已完成 Xiaomi 固定 5 分钟筛选，但语义均失败，projected
  RTF 分别为 2.3348 与 2.4020；因此不启动 120 分钟、不推进第三候选，也没有
  产品入口。
- PC provider 安全协议 v1 已冻结，但没有 PC runtime、移动 adapter、相机权限
  或扫码入口，保持 `DEFERRED_PC_RUNTIME_MISSING`。
- 完整 S3 仍为 BLOCKED；产品继续 **NOT RELEASE-READY**。

机器权威状态见 `docs/product/s3-productization-scope.json`，说明见
`docs/product/s3-productization-status.md`。


## Release 配置

1. 生成本地配置：`./tool/init_key_properties.sh`
2. 交互式快速填写：`./tool/fix_key_properties.sh`
3. 安全写入签名密码：`./tool/set_signing_passwords.sh`
4. 或手动填写 `applicationId` 与 keystore 四项：`storeFile/storePassword/keyAlias/keyPassword`
5. 执行：`./tool/preflight_release.sh`
6. 构建 release：`flutter build apk --release`


## Beta 发布

- 参考清单：`docs/BETA_RELEASE_CHECKLIST.md`


## Sherpa 接入状态

- 普通构建直接接入真实 JNI 推理调用，不存在运行时引擎选择。
- 自动转写链路：`m4a` 录音 -> 原生转码 `wav(16k mono)` -> Silero VAD 切片 -> Sherpa 离线识别（真机实测通过，已出现 `transcribe ok` 日志）。
- 已支持转码缓存清理与识别链路日志（tag: `Voice2TextNative`）。

## ASR 模型 benchmark

benchmark 工具集中放在 `benchmark/` 下；固定音频 fixture 放在 `benchmark/audio/` 并提交，模型和运行缓存放在 `build/asr_benchmark/`，不提交到 Git。当前标准只评估标准 VAD 单路线；根目录示例命令是 smoke，focused/coarse/full 参数矩阵使用方式见 `benchmark/README.md`。
