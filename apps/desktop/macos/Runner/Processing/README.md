# Native processing boundary

The desktop app supervises separately compiled `desktop_sherpa_worker` and
`desktop_sensevoice_caption_worker` helpers.
Only that worker loads Sherpa's C API and ONNX Runtime dylibs. The main app
launch graph must not link those libraries, because the frozen ONNX Runtime has
a higher macOS minimum than the workstation shell. The adapter remains behind
`ProcessingEnginePort`; widgets and persistence code may not call Sherpa
directly.

Benchmark tools live outside the product UI and bind every result to the exact
macOS target, runtime, model, and fixture hashes. Production model installation
continues to use the app-private, hash-verified asset manifest boundary.
