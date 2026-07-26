import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

class SherpaRuntimeProbe {
  SherpaRuntimeProbe._();

  static bool _attempted = false;
  static bool _loaded = false;

  static bool loadNativeRuntime([String? runtimeRoot]) {
    if (_attempted) return _loaded;
    _attempted = true;
    try {
      sherpa.initBindings(runtimeRoot);
      _loaded = true;
    } catch (_) {
      _loaded = false;
    }
    return _loaded;
  }
}
