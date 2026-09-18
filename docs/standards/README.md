# Current standards

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
route tests together. Keep architecture and `docs/solutions/` as supporting
context, not as a competing source of current instructions.
