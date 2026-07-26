# S3 端侧说话人分离候选复核

## 结论

量表已关闭为 `DEFERRED_NO_ADMISSIBLE_CANDIDATE`。当前 FP32 Sherpa 有界候选
在固定 Xiaomi 筛选中以功能语义和 projected RTF 失败；量表随后只推进官方
Pyannote INT8 segmentation + 3D-Speaker embedding 这一项 fallback，它也以
相同两项硬失败被淘汰。按计划不自动推进第三个候选。

| 候选 | 完整度 | Android/端侧成熟度 | 许可与资源风险 | 本轮判断 |
| --- | --- | --- | --- | --- |
| Sherpa + Pyannote FP32 + 3D-Speaker | 完整分割、embedding、聚类与有界会议级 reconciliation | 当前项目已安装多 ABI AAR；固定 Xiaomi 完整处理 12 个窗口 | 许可/工件固定；coverage 92.235%、DER 13.689%，但 overlap/静音语义失败，projected RTF 2.3348 | 真机筛选淘汰 |
| Sherpa + Pyannote INT8 + 3D-Speaker | 与当前候选同一完整链路，只替换官方 INT8 segmentation | 复用当前 AAR/Kotlin surface，无共享 runtime 变化 | 许可/工件固定；coverage 93.645%、DER 12.192%，静音语义失败，projected RTF 2.4020 | 唯一 fallback，真机筛选淘汰 |
| 直接 pyannote.audio/ONNX | 上游提供分割/重叠建模，但移动端还需 embedding、聚类、模型转换和运行时封装 | 没有本项目已验证的 Android 产品绑定 | 转换工件、运行时、包体和长音频内存均需重新验证 | 不作为无成本替换 |
| 3D-Speaker 完整 recipe | 官方 recipe 包含 VAD、分割、embedding、聚类，可选重叠检测 | 官方主流程以 Python/ModelScope 为主；本项目没有 Android binding | 代码 Apache-2.0 不自动解决每个权重/训练数据的分发复核；移植成本高 | 另立候选计划后再评估 |
| WeSpeaker | 提供 speaker verification/recognition/diarization toolkit 和 ONNX 能力 | 本项目没有已固定的 Android diarization pipeline | 需要选择并核对 VAD/分割/embedding/聚类组合和每个模型许可 | 暂不替换 |
| NVIDIA NeMo TitaNet embedding + Sherpa | Sherpa 官方支持该 embedding，但仍需独立 segmentation 和 clustering | 可复用 Sherpa AAR | NVIDIA 模型条款、模型大小和中文会议泛化需专项复核 | 仅作为 embedding 备选 |

## 为什么不是 Paraformer 自带能力

Paraformer 输出的是 ASR 文本与时间信息，不负责说话人分割或聚类。端侧 speaker
diarization 需要独立的声学分割、speaker embedding 和 clustering pipeline，
因此不能通过改变 Paraformer 参数直接得到可靠的“谁在说话”。

## 量表关闭依据

- Reverb segmentation 虽有 Sherpa Android 路径，但官方模型许可限制非商业用途。
- 3D-Speaker 与 WeSpeaker 的完整 diarization recipe 以 Python 为主，本项目没有
  固定的完整 Android binding；embedding 能导出 ONNX 不等于完整移动端 pipeline。
- NeMo TitaNet 在当前表中只是 embedding 替换，不独立提供 segmentation 与
  clustering，且中文会议风险未闭合。
- 唯一实现的 INT8 fallback 已产生原始证据和确定性 evaluation；候选矩阵由
  `validate_speaker_diarization_candidates.py` 保证只筛选一个 fallback。

固定 contract 始终复用同一 fixture 和阈值，没有通过换样本或降标准制造通过。
最终产品状态为 `DEFERRED_NO_ADMISSIBLE_CANDIDATE`。

## 参考

- Sherpa diarization：
  <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html>
- Sherpa Android model matrix：
  <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/apk.html>
- 3D-Speaker：
  <https://github.com/modelscope/3D-Speaker>
- WeSpeaker：
  <https://github.com/wenet-e2e/wespeaker>
- NVIDIA NeMo：
  <https://github.com/NVIDIA/NeMo>
