class CodexTaskFixture {
  const CodexTaskFixture({
    required this.title,
    required this.prompt,
    required this.response,
  });

  final String title;
  final String prompt;
  final String response;
}

const codexTaskFixtures = <CodexTaskFixture>[
  CodexTaskFixture(
    title: 'Rebuild the Codex desktop UI',
    prompt:
        'Rebuild the Codex desktop UI from the renderer assets. Focus on layout, menus, icons, and dialogs.',
    response:
        'I inspected the packaged renderer and rebuilt the visual system from its compiled tokens and assets.',
  ),
  CodexTaskFixture(
    title: 'Review the latest implementation',
    prompt:
        'Review the current implementation for visual regressions and missing interaction states.',
    response:
        'I checked the shell, overlays, responsive layout, and presentation-only interactions.',
  ),
  CodexTaskFixture(
    title: 'Polish empty and loading states',
    prompt:
        'Polish the empty and loading states without changing product logic.',
    response:
        'I aligned the empty-state hierarchy and progress treatment with the renderer tokens.',
  ),
  CodexTaskFixture(
    title: 'Create a responsive sidebar',
    prompt: 'Create a sidebar that remains usable at the minimum window width.',
    response:
        'I implemented the renderer width clamp and a compact navigation rail.',
  ),
  CodexTaskFixture(
    title: 'Audit desktop interaction details',
    prompt: 'Audit menus, focus, shortcuts, and desktop pointer states.',
    response:
        'I verified the shared action, menu, dialog, and tooltip interaction contracts.',
  ),
];
