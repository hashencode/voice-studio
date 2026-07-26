import 'package:processing_contracts/processing_contracts.dart';
import 'package:test/test.dart';

void main() {
  test('new persistent processing jobs start queued', () {
    const reference = ProcessingJobReference(
      id: 7,
      state: ProcessingJobState.queued,
      inputSha256: 'fixture-hash',
    );

    expect(reference.state, ProcessingJobState.queued);
  });
}
