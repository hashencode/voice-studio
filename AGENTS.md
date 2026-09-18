# Project Agent Instructions

## Rule discovery before repository changes

- The root rules in this file always apply. Before changing repository files,
  identify the planned paths and run `python3 tool/rules_for_change.py <paths>`
  from the repository root. Add `--tag <task-type>` when the task has a relevant
  tag in `docs/standards/rules-index.json`.
- Read every document printed by the router before editing. Do not treat a
  printed path or a link as if its contents had been loaded. If routing fails,
  a referenced document is unavailable, or applicable rules conflict, resolve
  that before changing code; never assume that no rule applies.
- Before finishing, route every changed path again and read any newly matched
  document. For cross-module changes, use the union of all matched rules. The
  index is the only route map; do not maintain a second hand-written table.
- Current code and importing package APIs establish implementation facts.
  Historical plans, tests, review comments, and solution records provide
  context; they do not independently create current product requirements.

## Worktree creation requires explicit confirmation

- Before invoking any command, tool, API, or UI action that could start creating
  or opening a new Git worktree, ask the user for explicit confirmation and wait
  for their reply. This applies to `git worktree add`, Codex task creation or
  forks with a worktree environment, and handoffs into a new worktree.
- Before asking, run a read-only check that this repository has a valid `HEAD`.
  If it has no valid commit, report that a worktree cannot be created and do
  not attempt creation.
- State the proposed repository, base branch or commit, new branch (if any),
  worktree path, and reason in the confirmation request. General permission to
  implement, fix, parallelize, delegate, or create a task is not worktree
  permission.
- Use the current checkout or same-directory task environment by default.
  Confirmation applies only to the exact single worktree proposed; ask again
  for another worktree.

## Project knowledge

- `docs/solutions/` contains documented solutions to past bugs, architecture decisions, best practices, and workflow issues. Entries are organized by category and may use YAML frontmatter such as `module`, `tags`, and `problem_type`; they are relevant when implementing or debugging in a documented area.
- `CONCEPTS.md` defines shared domain vocabulary for entities, named processes, and status concepts; it is relevant when orienting to the codebase or discussing domain behavior.

## Visual validation permission

- Never perform visual validation unless the user has explicitly authorized it in the current task.
- Visual validation includes launching, relaunching, closing, or controlling an app, browser, simulator, emulator, or physical device; taking or updating screenshots or goldens; running visual or browser-driven test suites; and starting UI device watchers.
- A request to implement or change UI is not permission to perform visual validation. Ask first, and treat permission as limited to the scope granted for that task.
- Without permission, use only non-visual static checks and tests that do not launch or control UI processes. Report visual validation as skipped by user policy; do not substitute another UI-launching command.

## Verification and build entry

- Read `docs/standards/verification.md` for the verification lane that matches
  the changed files. Run the lightest required lane and all bounded reverse
  consumers. Do not run the repository-wide gate for routine changes.
- Read `docs/standards/build-resources.md` before builds, resource acquisition,
  code generation, or device watcher work. The visual-validation permission
  above still controls every UI process and visual test.
