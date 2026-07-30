import 'package:codex_ui_reproduction/src/icons/codex_icon.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('all scoped Codex icon assets are bundled', () async {
    for (final icon in CodexIconData.values) {
      final data = await rootBundle.load(icon.assetPath);
      expect(data.lengthInBytes, greaterThan(0), reason: icon.assetPath);
    }
  });
}
