# Voice2Text Electron desktop

This is the independent Electron desktop composition root. It uses Bun,
Electron Forge, Vite, React/TypeScript, Tailwind, and shadcn's `sidebar-07`
source. Flutter Desktop remains frozen reference source only; this application
does not open its profile, import its packages, or use it as a runtime fallback.

## Development

```bash
bun ci
bun run check
bun run start
```

`bun run package` builds the existing Dart/native desktop worker and its dynamic
libraries into `resources/worker`, then packages them outside `app.asar`.
`bun run smoke:package` launches the packaged macOS app from the system temporary
directory and verifies the real worker health handshake.

The Renderer is sandboxed and has no Node or Electron imports. Privileged work
is exposed through the fixed API in `src/preload`, validated in Main, and backed
by versioned serializable contracts in `src/shared`.
