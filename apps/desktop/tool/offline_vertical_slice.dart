import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:processing_contracts/processing_contracts.dart';
import 'package:voice2text_desktop/features/processing/sherpa_desktop_processing_engine.dart';

Future<void> main(List<String> arguments) async {
  final options = _parse(arguments);
  final source = File(_required(options, 'source'));
  final outputRoot = Directory(_required(options, 'output-root'));
  await outputRoot.create(recursive: true);
  final sourceSha = (await sha256.bind(source.openRead()).first).toString();
  final engine = SherpaDesktopProcessingEngine(
    runtimeRoot: _required(options, 'runtime-root'),
    models: SherpaDesktopModelSet(
      convFrontendPath: _required(options, 'conv-frontend'),
      encoderPath: _required(options, 'encoder'),
      decoderPath: _required(options, 'decoder'),
      tokenizerPath: _required(options, 'tokenizer'),
      segmentationPath: _required(options, 'segmentation'),
      embeddingPath: _required(options, 'embedding'),
    ),
  );
  final progress = <Map<String, Object?>>[];
  final result = await engine.process(
    ProcessingRequest(
      sourcePath: source.path,
      sourceSha256: sourceSha,
      durationSeconds: double.parse(_required(options, 'duration-seconds')),
    ),
    cancellationToken: ProcessingCancellationToken(),
    onProgress: (value) {
      if (progress.isEmpty ||
          value.phase != progress.last['phase'] ||
          value.fraction - (progress.last['fraction'] as double) >= 0.1) {
        progress.add(<String, Object?>{
          'phase': value.phase,
          'fraction': value.fraction,
        });
      }
    },
  );
  final review = ReviewableMeetingTranscript(result.segments);
  final vtt = NonAiMeetingExport.toWebVtt(review.segments);
  final vttFile = File('${outputRoot.path}/offline-vertical-slice.vtt');
  await vttFile.writeAsString(vtt, flush: true);
  final evidence = <String, Object?>{
    'schemaVersion': 1,
    'source': 'local_private_file',
    'sourceSha256': sourceSha,
    'engineId': result.engineId,
    'cloudProvidersInvoked': <Object?>[],
    'aiFeaturesInvoked': <Object?>[],
    'reviewState': 'manual_correction_available',
    'reviewRevisionCount': review.revisionCount,
    'exportFormat': 'webvtt',
    'exportSha256': (await sha256.bind(vttFile.openRead()).first).toString(),
    'elapsedMilliseconds': result.elapsedMilliseconds,
    'residentBytesAfterProbe': result.peakResidentBytes,
    'segmentCount': result.segments.length,
    'speakerAssignments':
        result.segments
            .map((segment) => segment.speakerAssignment.name)
            .toSet()
            .toList()
          ..sort(),
    'progress': progress,
    'complete': result.segments.isNotEmpty,
  };
  await File(
    '${outputRoot.path}/offline-vertical-slice.json',
  ).writeAsString('${const JsonEncoder.withIndent('  ').convert(evidence)}\n');
}

Map<String, String> _parse(List<String> arguments) {
  final result = <String, String>{};
  for (var index = 0; index < arguments.length; index += 2) {
    if (index + 1 >= arguments.length || !arguments[index].startsWith('--')) {
      throw ArgumentError('expected --key value arguments');
    }
    result[arguments[index].substring(2)] = arguments[index + 1];
  }
  return result;
}

String _required(Map<String, String> options, String key) {
  final value = options[key];
  if (value == null || value.isEmpty) throw ArgumentError('missing --$key');
  return value;
}
