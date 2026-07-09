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
# 轻量自检：契约 + analyze + test
./tool/dev_check.sh

# 全量自检：含 debug APK 构建
./tool/dev_check.sh --with-build

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
- `lib/features/records/`：录音记录列表、详情、删除
- `lib/features/settings/`：模型选择与自动转写配置
- `lib/data/sqlite/`：本地数据库
- `lib/app/contracts/`：Dart 侧音频/通道契约
- `android/app/src/main/kotlin/.../contracts/`：Android 侧契约
- `tool/check_audio_contract.sh`：契约一致性校验
- `tool/dev_check.sh`：开发自检入口

## 当前状态

- Android 录音已接入 `MediaRecorder` 实现
- Real 转写链路可用：`m4a` 录音 -> 原生转码 `wav(16k mono)` -> Silero VAD 切片 -> Sherpa JNI 离线识别
- 数据闭环：录音保存 -> 转写入队/执行 -> 任务列表可重试
- App 底部显示当前安装包信息（包名/版本/安装时间），便于确认是否为最新构建


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

- `engineMode=auto` 当前已默认走 Android `real` 引擎路径。
- Real 引擎已接入真实 JNI 推理调用。
- 自动转写链路：`m4a` 录音 -> 原生转码 `wav(16k mono)` -> Silero VAD 切片 -> Sherpa 离线识别（真机实测通过，已出现 `transcribe ok` 日志）。
- 已支持转码缓存清理与识别链路日志（tag: `Voice2TextNative`）。

## ASR 模型 benchmark

benchmark 工具集中放在 `benchmark/` 下；固定音频 fixture 放在 `benchmark/audio/` 并提交，模型和运行缓存放在 `build/asr_benchmark/`，不提交到 Git。当前标准只评估标准 VAD 单路线；根目录示例命令是 smoke，focused/coarse/full 参数矩阵使用方式见 `benchmark/README.md`。
