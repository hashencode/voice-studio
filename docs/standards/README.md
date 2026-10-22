# Current standards

核心开发规范入口现统一为 [development-rules.md](../ai/development-rules.md)；本目录继续维护专项标准及其权威说明，原规则路由与详细政策保持不变。

`AGENTS.md` is the mandatory entry point. Run `python3 tool/rules_for_change.py`
with the files you intend to change, then read every returned document. The
machine-readable `rules-index.json` is the only path and task-tag route map.
This page records current authority for each rule area; it does not add routes.

| Rule area | Current authority |
| --- | --- |
| Worktree creation requires explicit confirmation | Root `AGENTS.md` |
| Flutter Goo component guidance | `flutter-ui.md` |
| Electron renderer component guidance | `electron-renderer.md` |
| Electron accessibility guidance | `electron-renderer.md` |
| Visual styling guidance | `visual-style.md` |
| Project knowledge | Root `AGENTS.md` |
| Visual validation permission | Root `AGENTS.md` |
| Verification lanes | `verification.md` |
| Frozen resource download cache | `build-resources.md` |
| Build cache budget | `build-resources.md` |
| UI device watcher | `build-resources.md` |

When a current rule changes, update its authority document and any affected
route tests together. Keep architecture and [documented cases](../README.md#专题经验) as supporting
context, not as a competing source of current instructions.
