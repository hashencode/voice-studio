import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/app/platform_composition.dart';
import 'package:voice2text_flutter/features/importing/service/meeting_import_service.dart';
import 'package:voice2text_flutter/features/recording/engine/recorder_port.dart';
import 'package:voice2text_flutter/features/recording/engine/unavailable_recorder_engine.dart';
import 'package:voice2text_flutter/features/transcription/service/transcription_port.dart';
import 'package:voice2text_flutter/features/transcription/service/unavailable_transcription_service.dart';

void main() {
  test(
    'non-Android composition fails closed instead of installing fakes',
    () async {
      final composition = AppPlatformComposition.forTarget(
        TargetPlatform.macOS,
      );
      final importService = MeetingImportService(
        mediaImportPort: composition.mediaImportPort,
      );
      addTearDown(importService.dispose);

      expect(
        composition.transcriptionPort,
        isA<UnavailableTranscriptionService>(),
      );
      expect(composition.recorderPort, isA<UnavailableRecorderEngine>());
      expect(
        composition.transcriptionPort.runtimeType.toString(),
        isNot(contains('Fake')),
      );
      expect(
        composition.recorderPort.runtimeType.toString(),
        isNot(contains('Fake')),
      );
      expect(composition.mediaImportPort.isAvailable, isFalse);
      expect(composition.recordingRecoveryEnabled, isFalse);
      expect(composition.notificationPermissionEnabled, isFalse);

      await expectLater(
        composition.transcriptionPort.transcribe(
          TranscriptionRequest(
            recordingPath: '/private/meeting.wav',
            durationMs: 1000,
            modelId: 'test',
          ),
        ),
        throwsA(
          isA<TranscriptionFailure>().having(
            (failure) => failure.code,
            'code',
            'PLATFORM_CAPABILITY_UNAVAILABLE',
          ),
        ),
      );
      await expectLater(
        composition.recorderPort.start(),
        throwsA(isA<RecorderException>()),
      );
      await expectLater(
        importService.pickAndImport(),
        throwsA(
          isA<MeetingImportException>().having(
            (failure) => failure.code,
            'code',
            'IMPORT_CAPABILITY_UNAVAILABLE',
          ),
        ),
      );
    },
  );
}
