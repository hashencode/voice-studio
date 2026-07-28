import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/processing/frozen_sherpa_model_manager.dart';

void main() {
  Map<String, Object?> loadManifest() {
    final file = <File>[
      File('assets/processing/frozen_sensevoice_macos_arm64.json'),
      File('apps/desktop/assets/processing/frozen_sensevoice_macos_arm64.json'),
    ].firstWhere((candidate) => candidate.existsSync());
    return (jsonDecode(file.readAsStringSync()) as Map).cast<String, Object?>();
  }

  test('U13 PASS exposes only the target-bound development capability', () {
    final manifest = FrozenSenseVoiceManifest.fromJson(loadManifest());

    expect(manifest.status, 'PASS');
    expect(manifest.developmentPosture, 'DEVELOPMENT_ONLY');
    expect(manifest.distributionEligible, isFalse);
    expect(manifest.exposesDevelopmentCapability, isTrue);
  });

  test('PASS requires target-specific machine evidence', () {
    final json = loadManifest()
      ..['status'] = 'PASS'
      ..['machineDecision'] = <String, Object?>{
        'status': 'PASS',
        'evidenceSha256': 'a' * 64,
        'target': 'Mac16,10/Apple M4/macOS 15.7.5 (24G624)',
      };

    expect(
      FrozenSenseVoiceManifest.fromJson(json).exposesDevelopmentCapability,
      isTrue,
    );

    (json['machineDecision']! as Map<String, Object?>)['target'] = 'Apple M2';
    expect(
      () => FrozenSenseVoiceManifest.fromJson(json),
      throwsFormatException,
    );
  });

  test('control cannot silently enable ITN or token partials', () {
    for (final field in <String>[
      'useInverseTextNormalization',
      'publishesTokenPartials',
    ]) {
      final json = loadManifest();
      (json['control']! as Map<String, Object?>)[field] = true;
      expect(
        () => FrozenSenseVoiceManifest.fromJson(json),
        throwsFormatException,
      );
    }
  });
}
