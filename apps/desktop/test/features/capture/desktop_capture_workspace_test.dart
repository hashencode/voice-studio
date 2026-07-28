import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_desktop/features/capture/desktop_capture_workspace.dart';

void main() {
  test('workspace only creates bounded private session directories', () async {
    final root = await Directory.systemTemp.createTemp('capture-workspace-');
    addTearDown(() => root.delete(recursive: true));
    final workspace = DesktopCaptureWorkspace(
      Directory('${root.path}/captures'),
    );

    final session = await workspace.createSession('session-123456789abc');
    expect(await session.exists(), isTrue);
    expect(
      (await workspace.sessionDirectories()).map((value) => value.path),
      <String>[session.path],
    );
    await expectLater(
      workspace.createSession('../outside'),
      throwsFormatException,
    );
  });

  test('discard is idempotent and cannot follow a symlink', () async {
    if (Platform.isWindows) {
      return;
    }
    final root = await Directory.systemTemp.createTemp('capture-discard-');
    final outside = await Directory.systemTemp.createTemp('capture-outside-');
    addTearDown(() async {
      if (await root.exists()) {
        await root.delete(recursive: true);
      }
      if (await outside.exists()) {
        await outside.delete(recursive: true);
      }
    });
    final captures = Directory('${root.path}/captures')..createSync();
    final link = Link('${captures.path}/session-123456789abc');
    await link.create(outside.path);
    final workspace = DesktopCaptureWorkspace(captures);

    await expectLater(
      workspace.discardSession('session-123456789abc'),
      throwsA(isA<FileSystemException>()),
    );
    expect(await outside.exists(), isTrue);
  });
}
