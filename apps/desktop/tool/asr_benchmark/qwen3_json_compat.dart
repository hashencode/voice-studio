import 'dart:convert';

/// Decodes sherpa-onnx Qwen3 result JSON while repairing only unescaped JSON
/// control characters inside string values.
///
/// sherpa-onnx 1.13.4 can return literal newlines from generated Qwen3 text
/// without JSON escaping them. Structural JSON, escapes, and all printable text
/// remain unchanged.
Map<String, Object?> decodeQwen3ResultJson(String source) {
  final repaired = StringBuffer();
  var insideString = false;
  var escaped = false;
  for (final codeUnit in source.codeUnits) {
    if (!insideString) {
      repaired.writeCharCode(codeUnit);
      if (codeUnit == 0x22) insideString = true;
      continue;
    }
    if (escaped) {
      repaired.writeCharCode(codeUnit);
      escaped = false;
      continue;
    }
    if (codeUnit == 0x5c) {
      repaired.writeCharCode(codeUnit);
      escaped = true;
      continue;
    }
    if (codeUnit == 0x22) {
      repaired.writeCharCode(codeUnit);
      insideString = false;
      continue;
    }
    if (codeUnit < 0x20) {
      switch (codeUnit) {
        case 0x08:
          repaired.write(r'\b');
          break;
        case 0x09:
          repaired.write(r'\t');
          break;
        case 0x0a:
          repaired.write(r'\n');
          break;
        case 0x0c:
          repaired.write(r'\f');
          break;
        case 0x0d:
          repaired.write(r'\r');
          break;
        default:
          repaired.write('\\u${codeUnit.toRadixString(16).padLeft(4, '0')}');
      }
      continue;
    }
    repaired.writeCharCode(codeUnit);
  }
  final decoded = jsonDecode(repaired.toString());
  if (decoded is! Map<String, Object?>) {
    throw const FormatException('Qwen3 result must be a JSON object');
  }
  return decoded;
}
