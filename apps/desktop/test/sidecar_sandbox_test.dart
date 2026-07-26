import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sidecar/sidecar_sandbox.dart';

void main() {
  late Directory temporary;

  setUp(() async {
    temporary = await Directory.systemTemp.createTemp('sidecar-roots-');
  });

  tearDown(() async {
    await temporary.delete(recursive: true);
  });

  test('source containment rejects paths outside the job root', () async {
    final roots = await _roots(temporary);
    final outside = File('${temporary.path}/outside.wav')
      ..writeAsBytesSync(<int>[1]);
    await expectLater(
      roots.requireContainedSource(outside),
      throwsA(
        isA<SidecarProtocolException>().having(
          (error) => error.code,
          'code',
          'SIDECAR_PATH_ESCAPE',
        ),
      ),
    );
  });

  test('sandbox profile denies network and writes outside job root', () async {
    final profile = SidecarSandboxProfile.macos(await _roots(temporary));
    expect(profile, contains('(deny network*)'));
    expect(profile, contains('(allow file-read-metadata'));
    expect(profile, contains('(deny file-read*'));
    expect(profile, contains('(deny file-write*'));
  });
}

Future<SidecarRoots> _roots(Directory temporary) async {
  final job = await Directory('${temporary.path}/job').create();
  final runtime = await Directory('${temporary.path}/runtime').create();
  final model = await Directory('${temporary.path}/model').create();
  final tools = await Directory('${temporary.path}/tools').create();
  return SidecarRoots.resolve(
    jobRoot: job,
    runtimeRoot: runtime,
    modelRoot: model,
    toolRoot: tools,
  );
}
