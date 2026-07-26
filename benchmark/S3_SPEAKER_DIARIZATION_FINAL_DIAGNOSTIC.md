# S3 移动端说话人分离最终诊断

日期：2026-07-26

## 终态

`MOBILE_DIARIZATION_CLOSED_NO_ADMISSIBLE_CANDIDATE`。

这是移动端自动说话人路线唯一一次最终诊断。四个固定 arm 均完成，均为
`FAIL`；`nextCandidate=null`。本次失败后不运行第三候选、不打包模型、不新增
产品入口，也不保存 voiceprint。未来若重新启动该路线，必须另立产品化计划。

## 固定实验

- 设备：Xiaomi M2102J2SC，Android 13 / API 33，
  build `V816.0.4.0.TGACNXM`。
- Fixture：300 秒、16 kHz、4,800,000 样本，WAV SHA-256
  `7e2757eb30176edc36a2c14a6511bbf297caa5dbfa9541e119cd94fd23a6d4ec`。
- RTTM SHA-256
  `a00bfae7495bf3e0aa4b3236f6225db936e61b1e4e213dd60ccd290791c5bb9d`。
- 所有 parity arm 都直接调用 Sherpa 完整 fixture `process`，不经过窗口、
  外部 embedding 或 reconciliation。
- Segmentation、fast clustering、speaker 数、阈值、min-duration 和门禁保持
  不变。t1/t2/t4 只改变线程数；TitaNet t2 只替换 embedding。
- 生产默认线程仍为 2；完整 fixture 与线程覆盖只暴露给显式 benchmark 探针。

## 结果

| Arm | Coverage | DER | RTF | 增量峰值 PSS | 失败门禁 |
| --- | ---: | ---: | ---: | ---: | --- |
| `official-3dspeaker-t1` | 92.525% | 15.746% | 1.9272 | 244,951 KiB | overlap、silence、RTF |
| `official-3dspeaker-t2` | 92.525% | 15.746% | 1.7472 | 249,241 KiB | overlap、silence、RTF |
| `official-3dspeaker-t4` | 92.525% | 15.746% | 1.2733 | 230,620 KiB | overlap、silence、RTF |
| `official-titanet-t2` | 92.525% | 44.356% | 0.9411 | 233,974 KiB | DER、overlap、silence、RTF |

四臂都完整消费 4,800,000 个样本，运行前后 fixture 哈希和转写快照哈希一致，
最大 thermal 状态为 `none`。四线程改善性能但仍为 RTF 门限 0.5 的 2.55 倍；
TitaNet 继续超出 RTF 门限，并把 DER 提高到 44.356%。两种 embedding 都没有
表示预注册 overlap，且都在预注册静默区间生成 speaker。

## 工件和许可

- Sherpa runtime `1.13.3`：
  SHA-256 `243ad797a3b6e75ebbeaf7a2ab4aec0777e7d71b730685abb762a120940b07b6`。
- Pyannote segmentation 3.0 FP32：
  SHA-256 `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`，
  5,992,913 bytes，下载包内 MIT LICENSE 已复核。
- 3D-Speaker embedding：
  SHA-256 `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b`，
  39,593,761 bytes，Apache-2.0。
- NeMo TitaNet embedding：
  SHA-256 `ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e`，
  40,257,283 bytes，Apache-2.0。

Sherpa 的 runtime 许可不替代模型许可复核。官方资料：

- <https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html>
- <https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_large>

## 可复验证据

权威合同：
`benchmark/speaker_diarization_final_diagnostic_contract.json`。

终态汇总：
`benchmark/evidence/speaker_diarization/final-diagnostic/summary.json`，
SHA-256
`8553e80aee8fb3f221c94e76ce47ac77c2ec89a6d0ed8bbbc635bf120156ec6b`。

同目录保留每个 arm 的原始 JSON 和独立 evaluation JSON；合同逐项绑定相对路径
和 SHA-256。`benchmark/test_validate_speaker_diarization_final_diagnostic.py`
会重新验证合同终态、设备/config、完整输入、证据哈希、评估绑定和 summary
一致性。
