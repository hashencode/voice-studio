# S3 端侧说话人分离准入复核

## 结论

状态：`DEFERRED_NO_ADMISSIBLE_CANDIDATE`。

当前应用使用的 Paraformer 仅负责语音转文字；说话人分离必须作为独立 sidecar
执行。已安装的 `sherpa-onnx.aar` 具备离线 speaker diarization API，本轮也
固定了候选模型、许可、fixture 和真机证据；schema v2 最终记录
`failedGates=["FUNCTIONAL","RESOURCE","NO_ADMISSIBLE_CANDIDATE"]`。FP32
有界候选和量表唯一选中的 INT8 fallback 均已被固定筛选淘汰，所以没有把
说话人功能暴露给用户，也没有将候选模型加入应用资产。

## 已验证事实

- AAR 版本：`1.13.3`（从四个 ABI 的原生库字符串核对）。
- AAR SHA-256：
  `243ad797a3b6e75ebbeaf7a2ab4aec0777e7d71b730685abb762a120940b07b6`。
- AAR 大小：`57,044,841` bytes。
- AAR ABI：`arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64`。
- 固定 API：
  `OfflineSpeakerDiarization(AssetManager, OfflineSpeakerDiarizationConfig)`、
  `sampleRate()`、`process(float[])`、`release()`。
- 配置由 Pyannote 分割模型、speaker embedding 模型和 fast clustering 组成。
  这与 Sherpa 官方离线示例一致。

## 候选模型与许可边界

首选组合沿用 Sherpa 官方 Android 示例：

1. `sherpa-onnx-pyannote-segmentation-3-0`。上游 Pyannote 模型卡标记 MIT；
   Sherpa 转换包包含同一 MIT LICENSE。发布包 SHA-256 为
   `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`，
   FP32 ONNX SHA-256 为
   `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`；
   唯一 fallback 使用同包官方 INT8 工件，SHA-256 为
   `d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d`。
2. `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`。精确
   ModelScope 模型记录标注 Apache License 2.0；工件 SHA-256 为
   `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b`。

Sherpa 官方 Android 文档同样明确提醒：Sherpa 代码的 Apache-2.0 许可不代表其
支持的模型具有相同许可。本轮已对这两个具体工件完成许可复核；它只解除模型
前置门禁，不代表功能或资源门禁自动通过。

## 探针调度与结果

FP32 原候选的冻结输入保留在
`speaker_diarization_current_screening_contract.json`，SHA-256 为
`e3b8bbadb61a5a51620fde517f90510efbd174ec70bd4c421d56f2a67cbda2ac`；
canonical INT8 fallback 输入位于
`speaker_diarization_admission_contract.json`，SHA-256 为
`1e6d8f6ec965b68be724235db6c277677b29902aedf27f146c6281d17dbfdd4b`。
两份 contract 的 fixture、门禁阈值和设备约束相同；生成结果只写入
`speaker_diarization_manifest.json`：

- 5 分钟功能探针：标注语音 turn 覆盖率至少 80%，DER 不高于 30%，turn 有序且
  不越界，显式表达 overlap，使用会议级匿名 speaker key，在预注册静音区间
  不伪造 speaker，并由转写前后快照哈希证明没有改变转写。
- 120 分钟资源探针：无 OOM/ANR、RTF 不高于 0.5、增量峰值 RSS 不高于
  384 MiB、thermal 不进入 severe。
- 30 分钟探针按本轮计划明确跳过，留到发布稳定阶段。

在 Xiaomi M2102J2SC（Android 13/debug）上完成同一固定 5 分钟筛选：

- FP32 有界候选完整处理 12 个窗口，覆盖率 92.235%、DER 13.689%，但 overlap
  与预注册静音诚实性失败；projected 120 分钟 RTF 为 2.3348。
- INT8 fallback 完整处理 12 个窗口，覆盖率 93.645%、DER 12.192%，明确表达
  overlap，但仍在预注册静音区间产生 speaker 归属；projected RTF 为 2.4020。
- 两次转写快照前后 SHA-256 相同，thermal 均为 none。由于两者都超过 RTF
  0.5，按计划不启动 120 分钟探针、不推进第三个候选，也不伪造 RTF/RSS 结果。
- 30 分钟探针保持 `SKIPPED_BY_PLAN`。

提交证据位于 `benchmark/evidence/speaker_diarization/`；因此能力保持不可用，
状态为 `DEFERRED_NO_ADMISSIBLE_CANDIDATE`。

## 后续边界

1. 本候选不得加入 `pubspec.yaml`，最终准入也不创建产品入口或人工修正闭环。
2. 当前候选和唯一 fallback 均已留下可复现硬失败；本计划不继续自动集成第三个
   候选。后续若重启路线，必须另立计划并保持相同 fixture、RTTM 与阈值。
3. 新计划仍必须在命名设备/build 上重新生成原始证据。
4. evaluator 返回 `VERIFIED` 只表示
   `eligibleForProductization=true`；`productAvailable` 与产品入口仍保持
   `false`，后续产品化必须另立计划。

## 参考

- Sherpa speaker diarization：
  <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html>
- Sherpa C API pipeline：
  <https://k2-fsa.github.io/sherpa/onnx/c-api/html/speaker_diarization.html>
- Sherpa Android 模型许可提醒：
  <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/apk.html>
- Pyannote segmentation 3.0：
  <https://huggingface.co/pyannote/segmentation-3.0>
- 3D-Speaker：
  <https://github.com/modelscope/3D-Speaker>
