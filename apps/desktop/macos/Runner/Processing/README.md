# Native processing boundary

The desktop processing adapter uses the `sherpa_onnx` Dart FFI package, which
loads Sherpa's C API dylib inside the signed macOS app process. The adapter must
remain behind `ProcessingEnginePort`; widgets and persistence code may not call
Sherpa directly.

Benchmark tools live outside the product UI and bind every result to the exact
macOS target, runtime, model, and fixture hashes. Production model installation
continues to use the app-private, hash-verified asset manifest boundary.
