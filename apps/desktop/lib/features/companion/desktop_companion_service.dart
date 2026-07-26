import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:companion_protocol/companion_protocol.dart';

import '../importing/desktop_import_service.dart';
import '../processing/desktop_processing_repository.dart';
import 'desktop_companion_platform.dart';
import 'desktop_companion_repository.dart';
import 'desktop_companion_transfer_store.dart';

class DesktopCompanionPairingInvite {
  const DesktopCompanionPairingInvite({
    required this.pairingId,
    required this.shortCode,
    required this.encodedPayload,
    required this.expiresAtMs,
  });

  final String pairingId;
  final String shortCode;
  final String encodedPayload;
  final int expiresAtMs;
}

class _PendingDesktopInvite {
  const _PendingDesktopInvite({
    required this.credential,
    required this.expiresAtMs,
  });

  final List<int> credential;
  final int expiresAtMs;
}

class DesktopCompanionService {
  DesktopCompanionService({
    required DesktopCompanionRepository repository,
    required DesktopImportService importService,
    required DesktopProcessingRepository processingRepository,
    required Directory transferRoot,
    required DesktopCompanionDiscoveryPort discovery,
    this.deviceName = 'Voice2Text Mac',
  }) : _repository = repository,
       _importService = importService,
       _processingRepository = processingRepository,
       _transferRoot = transferRoot,
       _discovery = discovery;

  final DesktopCompanionRepository _repository;
  final DesktopImportService _importService;
  final DesktopProcessingRepository _processingRepository;
  final Directory _transferRoot;
  final DesktopCompanionDiscoveryPort _discovery;
  final String deviceName;
  CompanionSocketServer? _server;
  CompanionIdentity? _identity;
  String? _activePeerDeviceId;
  final Map<String, _PendingDesktopInvite> _pendingInvites =
      <String, _PendingDesktopInvite>{};

  int? get port => _server?.port;

  String? get fingerprint => _identity?.fingerprint;

  String? get deviceId => _identity == null
      ? null
      : 'desktop-${_identity!.fingerprint.toLowerCase().substring(0, 20)}';

  Future<void> start() async {
    if (_server != null) return;
    await _transferRoot.create(recursive: true);
    final identity = await _repository.identity();
    _identity = identity;
    final capacity = MacosCompanionCapacityProbe(_transferRoot.path);
    final fileStore = FileCompanionTransferStore(
      root: _transferRoot,
      availableBytes: capacity.availableBytes,
    );
    final store = DesktopCompanionTransferStore(
      fileStore: fileStore,
      repository: _repository,
      activePeerDeviceId: () => _activePeerDeviceId ?? '',
    );
    final receiver = CompanionTransferReceiver(
      store: store,
      desktopDeviceId: deviceId!,
      desktopDeviceName: deviceName,
      signReceipt: (unsigned) async {
        final signature = await identity.sign(
          utf8.encode(jsonEncode(unsigned)),
        );
        return base64Encode(signature.bytes);
      },
      commitImport: (stagedPath, manifest) async {
        final outcome = await _importService.importSelectedPath(
          sourcePath: stagedPath,
          displayName: manifest.displayName,
        );
        final committedHash = await _processingRepository.recordingHash(
          outcome.recordingId,
        );
        if (committedHash == null) {
          throw const CompanionProtocolException(
            'IMPORT_COMMIT_MISSING',
            'Desktop import commit could not be verified.',
          );
        }
        return (
          recordingId: outcome.recordingId,
          committedSha256: committedHash,
        );
      },
    );
    final server = CompanionSocketServer(
      identity: CompanionServerIdentity(
        deviceId: deviceId!,
        deviceName: deviceName,
        fingerprint: identity.fingerprint,
      ),
      lookupPeer: (peerDeviceId) async {
        final trust = await _repository.lookupTrust(peerDeviceId);
        if (trust != null) _activePeerDeviceId = peerDeviceId;
        return trust;
      },
      resolveInvitedPeer:
          ({
            required pairingId,
            required deviceId,
            required deviceName,
            required fingerprint,
          }) async {
            final invite = _pendingInvites[pairingId];
            if (invite == null ||
                DateTime.now().millisecondsSinceEpoch > invite.expiresAtMs) {
              _pendingInvites.remove(pairingId);
              return null;
            }
            _activePeerDeviceId = deviceId;
            return CompanionPeerTrust(
              peerDeviceId: deviceId,
              peerFingerprint: fingerprint,
              sharedCredential: invite.credential,
              pairedAtMs: DateTime.now().millisecondsSinceEpoch,
            );
          },
      confirmInvitedPeer:
          ({
            required pairingId,
            required deviceId,
            required deviceName,
            required fingerprint,
            required trust,
          }) async {
            await _repository.pairPeer(
              deviceId: deviceId,
              displayName: deviceName,
              fingerprint: fingerprint,
              sharedCredential: trust.sharedCredential,
            );
            _pendingInvites.remove(pairingId);
          },
      receiver: receiver,
    );
    final port = await server.start();
    try {
      await _discovery.register(
        port: port,
        deviceId: deviceId!,
        deviceName: deviceName,
        fingerprint: identity.fingerprint,
      );
    } catch (_) {
      await server.stop();
      rethrow;
    }
    _server = server;
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    _activePeerDeviceId = null;
    await _discovery.unregister();
    await server?.stop();
  }

  Future<List<DesktopCompanionPeer>> listPeers() => _repository.listPeers();

  Future<List<DesktopCompanionTransferHistory>> listHistory() =>
      _repository.listHistory();

  Future<void> pairPeer({
    required String deviceId,
    required String displayName,
    required String fingerprint,
    required List<int> sharedCredential,
  }) => _repository.pairPeer(
    deviceId: deviceId,
    displayName: displayName,
    fingerprint: fingerprint,
    sharedCredential: sharedCredential,
  );

  Future<void> unpair(String deviceId) async {
    final unfinished = await _repository.unfinishedTransfers(
      peerDeviceId: deviceId,
    );
    final fileStore = FileCompanionTransferStore(root: _transferRoot);
    for (final manifest in unfinished) {
      await fileStore.cancel(manifest);
    }
    await _repository.revokePeer(deviceId);
  }

  Future<DesktopCompanionPairingInvite> createPairingInvite() async {
    if (_server == null || _identity == null) {
      throw StateError('Companion receiver is not running');
    }
    final random = Random.secure();
    final pairingId =
        'pair-${DateTime.now().millisecondsSinceEpoch}-'
        '${random.nextInt(1 << 32)}';
    final shortCode = random.nextInt(1000000).toString().padLeft(6, '0');
    final credential = List<int>.generate(32, (_) => random.nextInt(256));
    final expiresAtMs =
        DateTime.now().millisecondsSinceEpoch +
        const Duration(minutes: 2).inMilliseconds;
    _pendingInvites
      ..removeWhere(
        (_, invite) =>
            DateTime.now().millisecondsSinceEpoch > invite.expiresAtMs,
      )
      ..[pairingId] = _PendingDesktopInvite(
        credential: credential,
        expiresAtMs: expiresAtMs,
      );
    final payload = <String, Object>{
      'schema': companionMediaTransferSchema,
      'type': 'pairingInvite',
      'pairingId': pairingId,
      'shortCode': shortCode,
      'desktopDeviceId': deviceId!,
      'desktopDeviceName': deviceName,
      'desktopFingerprint': _identity!.fingerprint,
      'sharedCredential': base64Encode(credential),
      'expiresAtMs': expiresAtMs,
    };
    return DesktopCompanionPairingInvite(
      pairingId: pairingId,
      shortCode: shortCode,
      encodedPayload: base64UrlEncode(utf8.encode(jsonEncode(payload))),
      expiresAtMs: expiresAtMs,
    );
  }
}
