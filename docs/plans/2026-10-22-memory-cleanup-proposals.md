# 记忆与经验整理结项记录

完成日期：2026-10-22。项目：`voice-studio`。状态：**本轮已完成，无需安排下一批存量清理。**

范围按用户本次授权执行：沿用前三个项目的收尾方式，先补齐正式承接，再去除完整重复、修正过期适用说明；保留真实经验、设计来源、待决身份与验收证据。只修改文档，不提交推送。

## 本轮结果

已修订并保留 1 项；已复核保留 2 项。共核清旧清单 3 项；计数包含分类说明、约束及证据分组，不等于独立故障数。

修正 1 篇架构案例的当前适用说明，保留其历史推理和原资格验证条件；2 篇缺陷案例原文保留。不迁入候选目录，不新增规则或完整质量门禁。

保留项不再列入“下一批待清理”。后续只在用户发起复核、实际架构变化或相关任务出现新证据时按需处理；新候选、迁移或删除仍按 [核心规范](../ai/development-rules.md#经验与记忆维护) 确认。不设置定时复核。

## 逐项最终去向

### docs/desktop-first-workstation-boundaries.md

| 原 ID / 行号 | 最终处理 | 承接或保留位置 / 依据 |
| --- | --- | --- |
| `SOLUTION-001` L1–93 | 已修订并保留 | [docs/desktop-first-workstation-boundaries.md](../../docs/desktop-first-workstation-boundaries.md)：新增当前 workspace / audio_* 适用说明；原 meeting_*、平台资格与验收条件保持历史身份，不新增日常全量门禁。 |

### docs/latest-intent-wins-across-async-audio-actions.md

| 原 ID / 行号 | 最终处理 | 承接或保留位置 / 依据 |
| --- | --- | --- |
| `SOLUTION-002` L1–90 | 已复核保留 | [docs/latest-intent-wins-across-async-audio-actions.md](../../docs/latest-intent-wins-across-async-audio-actions.md)：保留故障原因、失败方案、适用边界和原测试范围，正文未改。 |

### docs/separate-empty-state-component-scope-from-shell-chrome.md

| 原 ID / 行号 | 最终处理 | 承接或保留位置 / 依据 |
| --- | --- | --- |
| `SOLUTION-003` L1–126 | 已复核保留 | [docs/separate-empty-state-component-scope-from-shell-chrome.md](../../docs/separate-empty-state-component-scope-from-shell-chrome.md)：保留故障原因、失败方案、适用边界和原测试范围，正文未改。 |

## 原文与去重凭据

以下内容仅用于保留原日期、条件与变更前证据，不是第二套现行规则或新的执行队列。

### docs/desktop-first-workstation-boundaries.md 修订前原文

````text
# Desktop-first meeting workstation boundaries

## Context

The repository keeps the Android mobile core at the root while adding a desktop
meeting workstation under `apps/desktop-electron`. Both products share data contracts and
workflows without making either application package depend on the other.

## Boundary pattern

Keep platform applications as composition roots and move only portable contracts
into workspace packages:

- `meeting_core` owns domain values.
- `meeting_storage` owns the shared SQLite schema and migrations.
- `processing_contracts` owns processing job/result contracts.
- `meeting_workflows` owns revision, export, and recovery behavior.
- The root app composes Android capture and mobile capabilities.
- `apps/desktop-electron` composes file import, native workers, desktop playback, review,
  LAN receive, Keychain, and macOS-specific security truth.

This prevents the desktop app from importing the mobile package and avoids
turning a shared package into a hidden platform service locator.

## Native work as a process boundary

Long-running native inference should not execute in the UI process. The desktop
app starts a versioned worker through a process-group launcher, supplies a
minimal fixed environment, and publishes results only after the whole logical
job succeeds. Cancellation terminates the process group and discards partial
output.

For a two-hour meeting, one Sherpa diarization worker exceeded the product time
budget even though the model was admissible. The product solution uses two
2-thread workers with a bounded overlap:

1. Split at a stable midpoint.
2. Include enough overlap on both sides to observe common speakers.
3. Align anonymous speaker labels using overlap evidence.
4. Cut both results at the midpoint to prevent duplicate turns.
5. Publish the joined result atomically under the original job.

Shard count, thread count, overlap, clustering threshold, runtime, and model
hashes are product configuration and evidence—not tuning knobs exposed in UI.

## Evidence is target-specific

A platform PASS is valid only for the target fingerprint and artifact set that
produced it. Store OS, architecture, CPU, memory, runtime/model/fixture hashes,
threading, quality, latency, resource use, and recovery outcomes together.
Windows may reuse the frozen finalist design, but it cannot inherit macOS PASS.

Make closure machine-verifiable. A validator should bind:

- upstream unit evidence hashes;
- packaged worker/runtime hashes;
- long-meeting and quality thresholds;
- interaction, lifecycle, security, accessibility, and LAN outcomes;
- the target-specific terminal disposition.

This keeps prose status pages descriptive while the manifest and validator
remain authoritative.

## Lifecycle and security truth

Separate committed meeting data from transient transport and processing data:

- staging, sidecar, and ephemeral share data have a 24-hour retention bound;
- interrupted LAN checkpoints have a 7-day retention bound;
- receipt deletes transfer payload immediately;
- unpair deletes trust and transfer metadata without deleting the committed
  meeting;
- cleanup never follows symlinks.

Do not imply encryption that the app does not provide. On macOS, probe FileVault
with the platform tool, disclose that database/audio files have no app-layer
whole-store encryption, and prompt when FileVault is disabled or unknown.
Keychain protection for API and pairing secrets is a separate guarantee.

## LAN handoff ownership

LAN media transfer is distinct from the structured-notes provider protocol.
Pairing binds both identities; each session derives directional authenticated
encryption keys; monotonic counters reject replay; resumable chunks are retained
only until receipt or expiry. Source deletion must never happen before a
verified receipt, and the default mobile behavior is to retain the source.

## Verification consequence

Routine checks can validate contracts and recorded hashes, but evidence-producing
physical gates remain explicit. A closure is complete only after the real target
integration suite, final long-meeting run, dogfood review, privacy checks, build,
and repository-wide tests all pass against the same frozen source and artifacts.
````

## 验证与边界

- 按文档范围核对逐项承接、引用、保留条目及来源；检查 `git diff --check`。Studio 项目按实际改动路径复核规则路由。
- 对照执行前快照核对非文档文件、原无关改动、分支、HEAD 和暂存区；本轮没有业务代码、组件源码、脚本或配置变更。
- 原验收文档、日期、设备结果与未验证条件保留。本轮未运行产品分析、测试、构建、GUI 或设备验证，不产生新的实现或验收通过声明。

## 历史提案快照（已由本轮结果结项）

以下完整保留原提案及当时的拟操作、待决身份、哈希和依据；其中“等待确认 / 未执行 / 拟删除 / 暂存待决”只描述提案阶段。执行状态以本文上方逐项最终去向为准，不能据下方旧表重新发起下一批。

````text
# 记忆与经验清理待审清单

整理日期：2026-10-22。状态：**仅建议，等待用户确认具体批次；本清单未执行迁移、合并或删除。**

项目：`voice-studio`；调查分支：`main`；调查 HEAD：`88e51f23836d4dad709731968bf7aeb977ef331d`。来源以本地实际文件为准，已有其他任务改动不在本轮清理授权内。

2026-10-22 路径复核：来源标签、章节标题和链接使用当前实际位置；专题经验直接位于 `docs/` 根目录，候选仍在 `.agents/memories/`。下表分别保留整理时 SHA-256 与本次路径复核 SHA-256，原调查 HEAD 和条目行号继续表示当时上下文；摘要变化不代表本轮修改了来源正文。各项拟操作、条目 ID、待决和保留状态不变，执行前仍须按内容重新核对，本轮未执行清理。

本项目采用与其余项目相同的按需复核和逐批确认规则。经验文档逐篇参与审查，不因位于 `docs/` 根目录就免于核对；`.agents/memories/` 与 `.agents/tmp/` 已补齐，本清单不将现有经验迁入候选目录。

## 批次与判断口径

- 可按条目 ID 或同一操作分组确认；批准本轮管理方式、其他项目的清理或旧批次，不等于批准本表任何删除。
- “拟迁移 / 合并后删副本”包含先核对并补齐指定正式承接，再于同批删除来源；不会先删后补。若执行前发现条件不符，保留源条目并报告差异。
- 来源定位是静态证据；只出现同名符号不能证明完整覆盖。本轮不运行测试、构建、GUI、网络或真实业务请求，不把旧结果写成当前通过。
- 待决项在确认前保留；设计节点与原验收证据独立保留。普通工具笔记的删除理由是缺少项目长期复用价值，不是仅凭日期或未核实认定错误。
- 当前统一规则见 [开发规范](../../docs/ai/development-rules.md) 的“经验与记忆维护”；存量有效约束继续按相关任务核对，旧自动提升/定时整理指令不执行。

拟操作统计：保留经验 2 项；拟修订适用说明 1 项。

## 来源快照

| 当前位置 | 整理时 SHA-256 | 路径复核 SHA-256 |
| --- | --- | --- |
| [docs/desktop-first-workstation-boundaries.md](../../docs/desktop-first-workstation-boundaries.md) | `018ed78b09071147e40d9f1c56116d1f519d7f68782ea252177ef0a7e3736954` | `018ed78b09071147e40d9f1c56116d1f519d7f68782ea252177ef0a7e3736954` |
| [docs/latest-intent-wins-across-async-audio-actions.md](../../docs/latest-intent-wins-across-async-audio-actions.md) | `068f8f2d69548890ecbe6b1537dd9e4108b7279a464cc0b32c401897e7d030d5` | `6097e19d5dec1d0f10a91bdbce74c87d4f5c652aa66b9e7d889d8b1f354aaf6c` |
| [docs/separate-empty-state-component-scope-from-shell-chrome.md](../../docs/separate-empty-state-component-scope-from-shell-chrome.md) | `32b643e97942107f727c679fab74dc60df42a6956229aef766f9d758813bc5dc` | `d32e73801246a54457c2c3fc1bd0b663711b6931786e1e597b6df9ef7c5b7557` |

确认后执行前须重新核对来源内容；本次行号仅用于定位本表快照，不能跨版本按行号直接删除。

## docs/desktop-first-workstation-boundaries.md

| ID / 来源位置 | 内容或主题 | 拟操作 | 承接 / 来源定位与具体依据 |
| --- | --- | --- | --- |
| `SOLUTION-001` L1–93 | 平台组合、状态权威与证据边界 | 拟修订适用说明 | [docs/desktop-first-workstation-boundaries.md](../../docs/desktop-first-workstation-boundaries.md)：保留平台与数据边界的推理；Context 仍写 Android 在仓库根，当前 pubspec workspace 已指定 apps/mobile-flutter / audio_*。meeting_* 目录仍存在但不在当前 workspace 清单，不能只凭目录存在当作现行依赖。将历史架构身份和真实目标资格门禁与日常验证分开，不新增全量门禁。 |

## docs/latest-intent-wins-across-async-audio-actions.md

| ID / 来源位置 | 内容或主题 | 拟操作 | 承接 / 来源定位与具体依据 |
| --- | --- | --- | --- |
| `SOLUTION-002` L1–90 | 异步操作的最新意图与目标归属 | 保留经验 | [docs/latest-intent-wins-across-async-audio-actions.md](../../docs/latest-intent-wins-across-async-audio-actions.md)：保留问题、失败方案、异步归属或 Shell 维度分离的具体推理和原测试范围；相关规范仅提供规则入口，不足以替代案例解释。无本轮运行或视觉验证结论。 |

## docs/separate-empty-state-component-scope-from-shell-chrome.md

| ID / 来源位置 | 内容或主题 | 拟操作 | 承接 / 来源定位与具体依据 |
| --- | --- | --- | --- |
| `SOLUTION-003` L1–126 | 局部空态与 Shell 布局独立决策 | 保留经验 | [docs/separate-empty-state-component-scope-from-shell-chrome.md](../../docs/separate-empty-state-component-scope-from-shell-chrome.md)：保留问题、失败方案、异步归属或 Shell 维度分离的具体推理和原测试范围；相关规范仅提供规则入口，不足以替代案例解释。无本轮运行或视觉验证结论。 |

## 本轮验证与边界

本轮按 L0 检查来源覆盖、证据与目标路径、文档差异和链接。全部原记忆、经验正文及设计证据保持原字节；不修改业务代码、组件、脚本、索引、自动化配置，不提交或推送。历史验收日期、范围和未验证项保持原记录。
````
