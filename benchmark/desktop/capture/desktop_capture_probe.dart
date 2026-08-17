import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

Future<void> main(List<String> arguments) async {
  if (arguments.length != 1) {
    stderr.writeln(
      'usage: dart run benchmark/desktop/capture/desktop_capture_probe.dart '
      '<evidence.json>',
    );
    exitCode = 64;
    return;
  }
  final file = File(arguments.single);
  final document = (jsonDecode(await file.readAsString()) as Map)
      .cast<String, Object?>();
  final limits = (document['probeLimits'] as Map).cast<String, Object?>();
  final observations = document['observations'];
  final decision = (document['decision'] as Map).cast<String, Object?>();
  final maximumMinutes = (limits['maximumDurationMinutes'] as num).toInt();
  final minimumMinutes = (limits['minimumDurationMinutes'] as num).toInt();
  if (minimumMinutes < 20 || minimumMinutes > maximumMinutes) {
    throw StateError('Capture probe duration bounds are invalid');
  }
  if (maximumMinutes > 30) {
    throw StateError('Capture probe exceeds the 30-minute development limit');
  }
  if (observations is! List) {
    throw const FormatException('observations must be a list');
  }
  if (decision['captureContractFrozen'] == true &&
      (decision['u12Allowed'] != true || observations.isEmpty)) {
    throw StateError('Frozen capture contract requires physical observations');
  }
  if (decision['captureContractFrozen'] == true) {
    if (document['status'] != 'PASS' || observations.length != 1) {
      throw StateError('Frozen capture contract requires one PASS observation');
    }
    final observation = (observations.single as Map).cast<String, Object?>();
    final evidencePath = observation['path'];
    final expectedHash = observation['sha256'];
    if (evidencePath is! String ||
        evidencePath.startsWith('/') ||
        evidencePath.contains('..') ||
        expectedHash is! String ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(expectedHash)) {
      throw const FormatException('Capture observation binding is invalid');
    }
    final evidenceFile = File(evidencePath);
    final actualHash = await sha256.bind(evidenceFile.openRead()).first;
    if (actualHash.toString() != expectedHash) {
      throw StateError('Capture observation hash mismatch');
    }
    final evidence = (jsonDecode(await evidenceFile.readAsString()) as Map)
        .cast<String, Object?>();
    final target = (evidence['target'] as Map).cast<String, Object?>();
    final build = (evidence['build'] as Map).cast<String, Object?>();
    final probe = (evidence['probe'] as Map).cast<String, Object?>();
    final recovery = (evidence['recovery'] as Map).cast<String, Object?>();
    final evidenceDecision = (evidence['decision'] as Map)
        .cast<String, Object?>();
    final duration = (probe['requestedDurationSeconds'] as num).toInt();
    final faults = recovery['faultInjection'];
    if (evidence['status'] != 'PASS' ||
        evidence['admissibleForDeclaredClosureTarget'] != true ||
        target['cpu'] != 'Apple M4' ||
        target['architecture'] != 'arm64' ||
        target['memoryBytes'] != 17179869184 ||
        duration < minimumMinutes * 60 ||
        duration > maximumMinutes * 60 ||
        observation['durationSeconds'] != duration ||
        recovery['invalidFinalizedChunks'] != 0 ||
        (recovery['maximumRecoveryMs'] as num).toInt() > 30000 ||
        (recovery['maximumTailChunksQuarantinedPerTrack'] as num).toInt() > 1 ||
        evidenceDecision['chunksValid'] != true ||
        evidenceDecision['recoveryValid'] != true ||
        evidenceDecision['captureContractFrozen'] != true ||
        evidenceDecision['u12Allowed'] != true ||
        faults is! List ||
        faults.length != 3 ||
        faults.any((value) {
          final fault = value as Map;
          return fault['status'] != 'PASS' || fault['idempotent'] != true;
        }) ||
        !RegExp(r'^[0-9a-f]{40}$').hasMatch(build['cdHash'] as String? ?? '') ||
        !RegExp(
          r'^[0-9a-f]{64}$',
        ).hasMatch(build['executableSha256'] as String? ?? '')) {
      throw StateError('Capture physical evidence failed its frozen gates');
    }
    final faultStages = faults.map((value) => (value as Map)['stage']).toSet();
    if (!faultStages.containsAll(<String>{
      'during_write',
      'during_finalize',
      'after_journal',
    })) {
      throw StateError('Capture fault-injection stages are incomplete');
    }
  }
  stdout.writeln(
    'PASS: capture probe contract is bounded; status=${document['status']}',
  );
}
