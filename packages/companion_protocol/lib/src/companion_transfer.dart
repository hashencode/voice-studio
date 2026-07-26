import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'companion_models.dart';

abstract interface class CompanionTransferStore {
  Future<CompanionCheckpoint?> checkpointFor(
    CompanionTransferManifest manifest,
  );

  Future<CompanionReceipt?> receiptFor(CompanionTransferManifest manifest);

  Future<void> begin(CompanionTransferManifest manifest);

  Future<void> writeChunk(
    CompanionTransferManifest manifest,
    CompanionChunk chunk,
    List<int> bytes,
  );

  Future<CompanionCheckpoint> checkpoint(CompanionTransferManifest manifest);

  Future<String> verifyAndStage(CompanionTransferManifest manifest);

  Future<void> recordReceipt(
    CompanionTransferManifest manifest,
    CompanionReceipt receipt,
  );

  Future<void> cancel(CompanionTransferManifest manifest);
}

typedef CompanionImportCommit =
    Future<({int recordingId, String committedSha256})> Function(
      String stagedPath,
      CompanionTransferManifest manifest,
    );
typedef CompanionReceiptSigner =
    Future<String> Function(Map<String, Object> unsignedReceipt);

class CompanionTransferReceiver {
  CompanionTransferReceiver({
    required CompanionTransferStore store,
    required CompanionImportCommit commitImport,
    required CompanionReceiptSigner signReceipt,
    required this.desktopDeviceId,
    required this.desktopDeviceName,
    int Function()? clockMs,
  }) : _store = store,
       _commitImport = commitImport,
       _signReceipt = signReceipt,
       _clockMs = clockMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final CompanionTransferStore _store;
  final CompanionImportCommit _commitImport;
  final CompanionReceiptSigner _signReceipt;
  final String desktopDeviceId;
  final String desktopDeviceName;
  final int Function() _clockMs;

  Future<CompanionCheckpoint> acceptManifest(
    CompanionTransferManifest manifest,
  ) async {
    final receipt = await _store.receiptFor(manifest);
    if (receipt != null) {
      return CompanionCheckpoint(
        transferId: manifest.transferId,
        wholeFileSha256: manifest.wholeFileSha256,
        missingChunks: const <int>[],
        updatedAtMs: _clockMs(),
      );
    }
    await _store.begin(manifest);
    return _store.checkpoint(manifest);
  }

  Future<CompanionCheckpoint> acceptChunk(
    CompanionTransferManifest manifest,
    CompanionChunk chunk,
    List<int> bytes,
  ) async {
    if (chunk.transferId != manifest.transferId ||
        chunk.offset != chunk.index * manifest.chunkBytes ||
        chunk.plaintextBytes != bytes.length ||
        bytes.length != manifest.expectedChunkLength(chunk.index) ||
        sha256.convert(bytes).toString() != chunk.sha256) {
      throw const CompanionProtocolException(
        'CHUNK_HASH_OR_BOUNDS_MISMATCH',
        'Chunk does not match the transfer manifest.',
      );
    }
    await _store.writeChunk(manifest, chunk, bytes);
    return _store.checkpoint(manifest);
  }

  Future<CompanionReceipt> commit(CompanionTransferManifest manifest) async {
    final prior = await _store.receiptFor(manifest);
    if (prior != null) return prior;
    final checkpoint = await _store.checkpoint(manifest);
    if (checkpoint.missingChunks.isNotEmpty) {
      throw const CompanionProtocolException(
        'TRANSFER_INCOMPLETE',
        'Cannot commit a transfer with missing chunks.',
      );
    }
    final staged = await _store.verifyAndStage(manifest);
    final committed = await _commitImport(staged, manifest);
    if (committed.committedSha256 != manifest.wholeFileSha256) {
      throw const CompanionProtocolException(
        'COMMITTED_HASH_MISMATCH',
        'Committed desktop bytes do not match the manifest.',
      );
    }
    final now = _clockMs();
    final unsigned = <String, Object>{
      'schema': companionMediaTransferSchema,
      'receiptId': 'receipt-${manifest.transferId}',
      'transferId': manifest.transferId,
      'wholeFileSha256': manifest.wholeFileSha256,
      'sizeBytes': manifest.sizeBytes,
      'desktopDeviceId': desktopDeviceId,
      'desktopDeviceName': desktopDeviceName,
      'desktopRecordingId': committed.recordingId,
      'committedAtMs': now,
    };
    final receipt = CompanionReceipt(
      receiptId: unsigned['receiptId']! as String,
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      sizeBytes: manifest.sizeBytes,
      desktopDeviceId: desktopDeviceId,
      desktopDeviceName: desktopDeviceName,
      desktopRecordingId: committed.recordingId,
      committedAtMs: now,
      signature: await _signReceipt(unsigned),
    );
    await _store.recordReceipt(manifest, receipt);
    return receipt;
  }

  Future<void> cancel(CompanionTransferManifest manifest) =>
      _store.cancel(manifest);
}

class FileCompanionTransferStore implements CompanionTransferStore {
  FileCompanionTransferStore({
    required Directory root,
    Future<int> Function()? availableBytes,
    this.minimumFreeBytes = 512 * 1024 * 1024,
  }) : _root = root,
       _availableBytes = availableBytes;

  final Directory _root;
  final Future<int> Function()? _availableBytes;
  final int minimumFreeBytes;
  final Map<String, CompanionReceipt> _receipts = <String, CompanionReceipt>{};
  final Random _random = Random.secure();

  String _key(CompanionTransferManifest manifest) => manifest.idempotencyKey;

  Directory _directory(CompanionTransferManifest manifest) {
    final safe = sha256.convert(utf8.encode(_key(manifest))).toString();
    return Directory('${_root.path}/$safe');
  }

  File _manifestFile(CompanionTransferManifest manifest) =>
      File('${_directory(manifest).path}/manifest.json');

  File _transferIndexFile(CompanionTransferManifest manifest) => File(
    '${_root.path}/transfer-${sha256.convert(utf8.encode(manifest.transferId))}.binding',
  );

  File _chunkFile(CompanionTransferManifest manifest, int index) =>
      File('${_directory(manifest).path}/chunk-$index.part');

  File _temporaryFile(String targetPath) => File(
    '$targetPath.tmp-${List<int>.generate(16, (_) => _random.nextInt(256)).map((value) => value.toRadixString(16).padLeft(2, '0')).join()}',
  );

  Future<void> _requireSafeRegularFile(
    File file, {
    required int expectedBytes,
  }) async {
    final type = await FileSystemEntity.type(file.path, followLinks: false);
    final stat = await file.stat();
    if (type != FileSystemEntityType.file ||
        stat.type != FileSystemEntityType.file ||
        stat.size != expectedBytes) {
      throw const CompanionProtocolException(
        'UNSAFE_CHUNK_FILE',
        'Transfer staging file is not a bounded regular file.',
      );
    }
    if (Platform.isMacOS || Platform.isLinux) {
      final arguments = Platform.isMacOS
          ? <String>['-f', '%l', file.path]
          : <String>['-c', '%h', file.path];
      final result = await Process.run('/usr/bin/stat', arguments);
      if (result.exitCode != 0 || result.stdout.toString().trim() != '1') {
        throw const CompanionProtocolException(
          'UNSAFE_CHUNK_FILE',
          'Transfer staging file has multiple hard links.',
        );
      }
    }
  }

  @override
  Future<void> begin(CompanionTransferManifest manifest) async {
    if (_availableBytes != null) {
      final available = await _availableBytes();
      if (available < manifest.sizeBytes + minimumFreeBytes) {
        throw const CompanionProtocolException(
          'INSUFFICIENT_DISK_SPACE',
          'Desktop does not have enough free space for this transfer.',
        );
      }
    }
    await _root.create(recursive: true);
    final binding = _transferIndexFile(manifest);
    if (await binding.exists()) {
      final existingKey = (await binding.readAsString()).trim();
      if (existingKey != _key(manifest)) {
        throw const CompanionProtocolException(
          'TRANSFER_ID_CONFLICT',
          'Transfer ID is already bound to different content.',
        );
      }
    } else {
      final temporaryBinding = File('${binding.path}.tmp');
      await temporaryBinding.writeAsString(_key(manifest), flush: true);
      await temporaryBinding.rename(binding.path);
    }
    final directory = _directory(manifest);
    await directory.create(recursive: true);
    final current = _manifestFile(manifest);
    if (await current.exists()) {
      final decoded = jsonDecode(await current.readAsString());
      final existing = CompanionTransferManifest.fromJson(
        (decoded as Map).cast<String, Object?>(),
      );
      if (existing.idempotencyKey != manifest.idempotencyKey ||
          existing.sizeBytes != manifest.sizeBytes ||
          existing.chunkBytes != manifest.chunkBytes) {
        throw const CompanionProtocolException(
          'TRANSFER_ID_CONFLICT',
          'Transfer ID is already bound to different content.',
        );
      }
      return;
    }
    final temporary = File('${current.path}.tmp');
    await temporary.writeAsString(jsonEncode(manifest.toJson()), flush: true);
    await temporary.rename(current.path);
  }

  @override
  Future<CompanionCheckpoint?> checkpointFor(
    CompanionTransferManifest manifest,
  ) async {
    if (!await _manifestFile(manifest).exists()) return null;
    return checkpoint(manifest);
  }

  @override
  Future<CompanionReceipt?> receiptFor(
    CompanionTransferManifest manifest,
  ) async => _receipts[_key(manifest)];

  @override
  Future<void> writeChunk(
    CompanionTransferManifest manifest,
    CompanionChunk chunk,
    List<int> bytes,
  ) async {
    final directory = _directory(manifest);
    final canonicalRoot = await directory.resolveSymbolicLinks();
    final file = File('$canonicalRoot/chunk-${chunk.index}.part');
    final existingType = await FileSystemEntity.type(
      file.path,
      followLinks: false,
    );
    if (existingType != FileSystemEntityType.notFound) {
      if (existingType != FileSystemEntityType.file) {
        throw const CompanionProtocolException(
          'UNSAFE_CHUNK_FILE',
          'Existing chunk is not a regular file.',
        );
      }
      await _requireSafeRegularFile(file, expectedBytes: bytes.length);
      if (sha256.convert(await file.readAsBytes()).toString() != chunk.sha256) {
        throw const CompanionProtocolException(
          'CHUNK_CONFLICT',
          'Existing chunk does not match the incoming chunk.',
        );
      }
      return;
    }
    final temporary = _temporaryFile(file.path);
    if (!temporary.absolute.path.startsWith('$canonicalRoot/')) {
      throw const CompanionProtocolException(
        'PATH_ESCAPE_REJECTED',
        'Chunk path escapes the transfer root.',
      );
    }
    await temporary.writeAsBytes(bytes, flush: true);
    try {
      await _requireSafeRegularFile(temporary, expectedBytes: bytes.length);
      if (sha256.convert(await temporary.readAsBytes()).toString() !=
          chunk.sha256) {
        throw const CompanionProtocolException(
          'CHUNK_HASH_MISMATCH',
          'Staged chunk hash changed before promotion.',
        );
      }
      if (await FileSystemEntity.type(file.path, followLinks: false) !=
          FileSystemEntityType.notFound) {
        throw const CompanionProtocolException(
          'CHUNK_CONFLICT',
          'Chunk destination appeared during staging.',
        );
      }
      await temporary.rename(file.path);
      await _requireSafeRegularFile(file, expectedBytes: bytes.length);
    } on Object {
      try {
        if (await temporary.exists()) await temporary.delete();
      } on FileSystemException {
        // Best effort cleanup; the unsafe staging file is never promoted.
      }
      rethrow;
    }
  }

  @override
  Future<CompanionCheckpoint> checkpoint(
    CompanionTransferManifest manifest,
  ) async {
    final missing = <int>[];
    for (var index = 0; index < manifest.chunkCount; index++) {
      final file = _chunkFile(manifest, index);
      if (!await file.exists()) {
        missing.add(index);
        continue;
      }
      final stat = await file.stat();
      if (stat.type != FileSystemEntityType.file ||
          stat.size != manifest.expectedChunkLength(index)) {
        missing.add(index);
      }
    }
    return CompanionCheckpoint(
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      missingChunks: missing,
      updatedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
  }

  @override
  Future<String> verifyAndStage(CompanionTransferManifest manifest) async {
    final checkpointValue = await checkpoint(manifest);
    if (checkpointValue.missingChunks.isNotEmpty) {
      throw const CompanionProtocolException(
        'TRANSFER_INCOMPLETE',
        'Transfer has missing chunks.',
      );
    }
    final staged = File('${_directory(manifest).path}/complete.media');
    final stagedType = await FileSystemEntity.type(
      staged.path,
      followLinks: false,
    );
    if (stagedType != FileSystemEntityType.notFound) {
      if (stagedType != FileSystemEntityType.file) {
        throw const CompanionProtocolException(
          'UNSAFE_STAGED_FILE',
          'Completed transfer destination is not a regular file.',
        );
      }
      await _requireSafeRegularFile(staged, expectedBytes: manifest.sizeBytes);
      final existingDigest = await sha256.bind(staged.openRead()).first;
      if (existingDigest.toString() != manifest.wholeFileSha256) {
        throw const CompanionProtocolException(
          'STAGED_FILE_CONFLICT',
          'Completed transfer destination has conflicting content.',
        );
      }
      return staged.path;
    }
    final output = _temporaryFile(staged.path);
    final sink = output.openWrite(mode: FileMode.writeOnly);
    try {
      for (var index = 0; index < manifest.chunkCount; index++) {
        await sink.addStream(_chunkFile(manifest, index).openRead());
      }
      await sink.flush();
    } finally {
      await sink.close();
    }
    await _requireSafeRegularFile(output, expectedBytes: manifest.sizeBytes);
    final digest = await sha256.bind(output.openRead()).first;
    if (digest.toString() != manifest.wholeFileSha256) {
      try {
        await output.delete();
      } on FileSystemException {
        // Best effort cleanup; a mismatched file is never committed.
      }
      throw const CompanionProtocolException(
        'WHOLE_FILE_HASH_MISMATCH',
        'Reassembled file does not match the transfer manifest.',
      );
    }
    if (await FileSystemEntity.type(staged.path, followLinks: false) !=
        FileSystemEntityType.notFound) {
      await output.delete();
      throw const CompanionProtocolException(
        'STAGED_FILE_CONFLICT',
        'Completed transfer destination appeared during staging.',
      );
    }
    await output.rename(staged.path);
    await _requireSafeRegularFile(staged, expectedBytes: manifest.sizeBytes);
    final stagedDigest = await sha256.bind(staged.openRead()).first;
    if (stagedDigest.toString() != manifest.wholeFileSha256) {
      throw const CompanionProtocolException(
        'WHOLE_FILE_HASH_MISMATCH',
        'Promoted transfer changed before import.',
      );
    }
    return staged.path;
  }

  @override
  Future<void> recordReceipt(
    CompanionTransferManifest manifest,
    CompanionReceipt receipt,
  ) async {
    _receipts[_key(manifest)] = receipt;
    final directory = _directory(manifest);
    final file = File('${directory.path}/receipt.json');
    await file.writeAsString(jsonEncode(receipt.toJson()), flush: true);
    await for (final entry in directory.list(followLinks: false)) {
      final name = entry.uri.pathSegments.last;
      if (name.startsWith('chunk-') && name.endsWith('.part') ||
          name == 'complete.media') {
        await entry.delete();
      }
    }
  }

  @override
  Future<void> cancel(CompanionTransferManifest manifest) async {
    final directory = _directory(manifest);
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
    final binding = _transferIndexFile(manifest);
    if (await binding.exists()) await binding.delete();
  }
}
