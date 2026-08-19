# Voice2Text Electron desktop

This is the independent Electron desktop composition root. It uses Bun,
Electron Forge, Vite, React/TypeScript, Tailwind, and the pinned shadcn
`sidebar-09` composition. Flutter Desktop remains frozen reference source only;
this application does not open its profile, import its packages, or use it as a
runtime fallback.

## Development

```bash
bun ci
bun run resources:worker
bun run check
bun run test:visual
bun run start
```

`bun run resources:worker` is required on the first checkout and whenever the
frozen worker/model resources change. Later development runs can use
`bun run start` directly.

`bun run package` builds the existing Dart/native desktop worker and its dynamic
libraries into `resources/worker`, then packages them outside `app.asar`.
`bun run smoke:package` launches the packaged macOS app from the system temporary
directory and verifies the real worker health handshake.

`bun run test:visual` launches the repository-pinned Electron runtime through a
test-only Main/Preload harness, exercises the production Renderer entry, checks
sidebar geometry, and compares five deterministic screenshots. Canonical pixel
baselines are macOS arm64 only; every host still runs the semantic and 1 px
geometry assertions. Baseline updates require the environment recorded in
`tests/visual/goldens/README.md` and a side-by-side review against the pinned
official `sidebar-09` demo.

The Renderer is sandboxed and has no Node or Electron imports. Privileged work
is exposed through the fixed API in `src/preload`, validated in Main, and backed
by versioned serializable contracts in `src/shared`.
