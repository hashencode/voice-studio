import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';

import 'desktop_companion_repository.dart';

class DesktopCompanionTransferStore implements CompanionTransferStore {
  DesktopCompanionTransferStore({
    required FileCompanionTransferStore fileStore,
    required DesktopCompanionRepository repository,
    required String Function() activePeerDeviceId,
  }) : _fileStore = fileStore,
       _repository = repository,
       _activePeerDeviceId = activePeerDeviceId;

  final FileCompanionTransferStore _fileStore;
  final DesktopCompanionRepository _repository;
  final String Function() _activePeerDeviceId;

  @override
  Future<void> begin(CompanionTransferManifest manifest) async {
    await _fileStore.begin(manifest);
    await _repository.beginTransfer(manifest, _activePeerDeviceId());
  }

  @override
  Future<void> cancel(CompanionTransferManifest manifest) =>
      _fileStore.cancel(manifest);

  @override
  Future<CompanionCheckpoint> checkpoint(CompanionTransferManifest manifest) =>
      _fileStore.checkpoint(manifest);

  @override
  Future<CompanionCheckpoint?> checkpointFor(
    CompanionTransferManifest manifest,
  ) => _fileStore.checkpointFor(manifest);

  @override
  Future<CompanionReceipt?> receiptFor(CompanionTransferManifest manifest) =>
      _repository.receiptFor(manifest);

  @override
  Future<void> recordReceipt(
    CompanionTransferManifest manifest,
    CompanionReceipt receipt,
  ) async {
    await _fileStore.recordReceipt(manifest, receipt);
    await _repository.recordReceipt(manifest, receipt);
  }

  @override
  Future<String> verifyAndStage(CompanionTransferManifest manifest) =>
      _fileStore.verifyAndStage(manifest);

  @override
  Future<void> writeChunk(
    CompanionTransferManifest manifest,
    CompanionChunk chunk,
    List<int> bytes,
  ) async {
    await _fileStore.writeChunk(manifest, chunk, bytes);
    await _repository.recordChunk(manifest, chunk);
  }
}

class MacosCompanionCapacityProbe {
  const MacosCompanionCapacityProbe(this.path);

  final String path;

  Future<int> availableBytes() async {
    final result = await Process.run('/bin/df', <String>['-Pk', path]);
    if (result.exitCode != 0) {
      throw const CompanionProtocolException(
        'CAPACITY_PROBE_FAILED',
        'Desktop free space could not be measured.',
      );
    }
    final lines = (result.stdout as String)
        .trim()
        .split('\n')
        .where((line) => line.trim().isNotEmpty)
        .toList(growable: false);
    if (lines.length < 2) {
      throw const CompanionProtocolException(
        'CAPACITY_PROBE_FAILED',
        'Desktop free space output is invalid.',
      );
    }
    final fields = lines.last.trim().split(RegExp(r'\s+'));
    if (fields.length < 4) {
      throw const CompanionProtocolException(
        'CAPACITY_PROBE_FAILED',
        'Desktop free space output is invalid.',
      );
    }
    final kilobytes = int.tryParse(fields[3]);
    if (kilobytes == null || kilobytes < 0) {
      throw const CompanionProtocolException(
        'CAPACITY_PROBE_FAILED',
        'Desktop free space output is invalid.',
      );
    }
    return kilobytes * 1024;
  }
}
