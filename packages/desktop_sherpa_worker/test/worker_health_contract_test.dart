import 'package:desktop_sherpa_worker/desktop_sherpa_worker.dart';
import 'package:test/test.dart';

void main() {
  test('accepts the current worker health protocol', () {
    expect(
      () => validateDesktopWorkerHealthRequest(<String, Object?>{
        'schemaVersion': 1,
        'operation': 'health',
        'expectedProtocolVersion': 1,
      }),
      returnsNormally,
    );
  });

  test('rejects an incompatible worker health protocol', () {
    expect(
      () => validateDesktopWorkerHealthRequest(<String, Object?>{
        'schemaVersion': 1,
        'operation': 'health',
        'expectedProtocolVersion': 2,
      }),
      throwsA(isA<FormatException>()),
    );
  });
}
