import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('feature code does not reintroduce Material visual fallbacks', () {
    final files = Directory('lib/src')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'));
    final forbidden = <RegExp, String>{
      RegExp(r'\bIcons\.'): 'Material feature icon',
      RegExp(r'(?<!Codex)\bshowDialog(?:\s*<[^>]+>)?\s*\('):
          'Material dialog entry point',
      RegExp(r'\b(?:AlertDialog|SimpleDialog|Dialog)\s*\('):
          'Material Dialog widget',
      RegExp(r'\bPopupMenu(?:Button|Item)(?:\s*<[^>]+>)?\s*\('):
          'Material popup menu',
      RegExp(r'(?<!Codex)\bshowMenu(?:\s*<[^>]+>)?\s*\('):
          'Material menu entry point',
      RegExp(r'(?<!Codex)\bTooltip\s*\('): 'default Material tooltip',
      RegExp(r'\bInkWell\s*\('): 'Material ink response',
      RegExp(r'\bInkResponse\s*\('): 'Material ink response',
      RegExp(r'\bMenuAnchor\s*\('): 'Material menu anchor',
      RegExp(r'\bDropdown(?:Menu|Button)(?:\s*<[^>]+>)?\s*\('):
          'Material dropdown',
      RegExp(r'\bMenuItemButton\s*\('): 'Material menu item',
    };

    for (final file in files) {
      final source = file.readAsStringSync();
      for (final entry in forbidden.entries) {
        expect(
          entry.key.hasMatch(source),
          isFalse,
          reason: '${entry.value} found in ${file.path}',
        );
      }
    }
  });
}
