# Shared UI styling and copy standard

Applies to user-facing Flutter and Electron UI. Read this alongside the
platform-specific standard before changing visual styling or interface copy.
Platform component authorities remain in `flutter-ui.md` and
`electron-renderer.md`; the root `AGENTS.md` controls visual-validation
permission.

## Visual styling guidance

- Default to shadowless UI. Do not add shadows unless the user explicitly requests them or an existing platform contract requires them.
- Establish hierarchy with spacing, borders, surface color differences, and typography before considering elevation.
- Keep keyboard focus visible but lightweight. Inputs, buttons, and other form controls should use a thin focus indicator rather than a thick ring or glow.
- Keep interface copy concise, natural, and considerate. Include only information that affects the user's next action or decision; do not repeat visible controls, states, or capabilities. For instructions, prefer brief and polite wording when it adds warmth without adding explanation.
- When a Modal conveys one brief system message and has no distinct task name, use the title to identify the message type or semantic category, state the complete fact once in the body, and keep only actions required for a decision or continuation in the footer. Do not repeat the same content across the title, body, and actions; keep a task-specific title when the Modal has a distinct named task.
- Use declarative copy in confirmation dialogs. Name the confirmation task directly in the title, such as “重置本机数据确认”; do not use question marks or interrogative wording in the title or body. State the consequence in the body and present the available decisions as footer actions.
