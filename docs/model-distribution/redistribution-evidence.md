# Model Redistribution Evidence

This record separates verified upstream facts from the maintainer's legal-risk decision. It is not legal advice. On 2026-09-20 the maintainer confirmed that all five frozen resources may be publicly redistributed. The two remote model archives include their applicable license and conversion-provenance files; auxiliary-model notices remain part of the later application-artifact work.

## Evidence table

| Resource                               | Frozen input                                                                                                                             | Upstream terms found                                                                                                                                                                                                                                        | Notice / attribution                                              | Current disposition                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-ASR 0.6B int8 ONNX bundle        | `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`, SHA-256 `393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96`         | The official Qwen3-ASR repository and model card identify Apache-2.0 for the original model. The frozen conversion README names its ModelScope source and export-script repository.                                                                            | The normalized archive includes the conversion README and the Apache-2.0 text pinned at Qwen3-ASR commit `9567667698f195fa807b1581de5c03184e63d2b0`. | `eligible` by maintainer decision; exact source, conversion provenance, member hashes and notice files are frozen. |
| SenseVoice 2024-07-17 int8 ONNX bundle | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`, SHA-256 `f6b2a72ebcb1ac7a764d4cfccd886e6bcb2a95c4657c2199d0ba95ed4b9ea71a` | The selected archive identifies the conversion source as FunAudioLLM/SenseVoice. SenseVoiceSmall weights use the FunASR Model Open Source License Agreement v1.1.                                                                                                | The normalized archive includes the conversion README/LICENSE and the model agreement pinned at FunASR commit `58830eca4012644aac0c3218c3ccc7d98f003fda`; the SenseVoice model name is retained. | `eligible` by maintainer decision; exact source, member hashes, attribution and model terms are frozen. |
| Silero VAD ONNX                        | `silero_vad.onnx`, SHA-256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`                                            | The official Silero VAD repository carries the MIT license.                                                                                                                                                                                                 | Include the Silero copyright and MIT license text in the application notices. | `eligible` by maintainer decision for later application bundling. |
| Pyannote segmentation 3.0 ONNX         | `sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, SHA-256 `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`              | The official `pyannote/segmentation-3.0` model card identifies MIT and requires acceptance of its access conditions. The selected archive contains a MIT license file with SHA-256 `14d7016ad68e7394d6e6b78d96cc2ae431c905287b89674cfdf021e79e62b8ba`.      | Bundle the archive's MIT license and upstream attribution with the application. | `eligible` by maintainer decision for later application bundling. |
| 3D-Speaker ERes2Net embedding ONNX     | `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, SHA-256 `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b` | The official 3D-Speaker repository carries Apache-2.0 for the project.                                                                                                                                                                                      | Include Apache-2.0 and 3D-Speaker attribution in the application notices. | `eligible` by maintainer decision for later application bundling. |

## Fixed upstream references

- Qwen3-ASR repository and license: <https://github.com/QwenLM/Qwen3-ASR>
- Qwen3-ASR 0.6B model card: <https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf>
- SenseVoice license explanation and official-weight distinction: <https://github.com/QwenAudio/SenseVoice/blob/main/README.md#license>
- FunASR Model Open Source License Agreement v1.1: <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>
- Silero VAD license: <https://github.com/snakers4/silero-vad/blob/master/LICENSE>
- Pyannote segmentation 3.0 model card: <https://huggingface.co/pyannote/segmentation-3.0>
- 3D-Speaker license: <https://github.com/modelscope/3D-Speaker/blob/main/LICENSE>
- sherpa-onnx source license: <https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE>

## Published remote-model evidence

- Immutable release: <https://github.com/hashencode/voice-studio-models/releases/tag/models-v1>
- Repository provenance commit: `d780d9a`
- Release ID: `392128722`; published at `2026-09-19T16:07:50Z`; GitHub API reported `immutable: true`.
- Qwen3-ASR archive: 849,404,180 bytes, SHA-256 `674908c4b847caabd25a011aa457c280ed1e872b88c8234aa2dc7cbcab64404b`.
- SenseVoice archive: 164,107,250 bytes, SHA-256 `2cb16bb88adee12e4aaf54c76359a3a3e6c0e1fd0a59eb52caa38b9007ece912`.
- Anonymous full downloads matched both sizes and SHA-256 values.
- Anonymous range probes returned exact `206 Content-Range`, strong ETags and `Accept-Ranges: bytes` through `https://release-assets.githubusercontent.com`, so safe resume is available.
- The public receipt JSON files attached to the release contain the normalized member inventories without local filesystem paths.
- A development lifecycle run paused the real SenseVoice download at 8,434,922 bytes, resumed and installed it, deleted it, then downloaded and installed it again; both installs passed the real Worker probe.
- A real 15-second Qwen3-ASR transcription completed successfully, and the real SenseVoice caption Worker initialized successfully from the normalized archives.

The maintainer's authorization resolves the distribution decision for these frozen identities. Any future source, model version, conversion, hash or license change requires a new evidence decision and a new immutable release tag.
