import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';

import 'companion_crypto.dart';
import 'companion_models.dart';
import 'companion_pairing.dart';
import 'companion_transfer.dart';

typedef CompanionPeerLookup =
    Future<CompanionPeerTrust?> Function(String deviceId);
typedef CompanionInvitedPeerResolver =
    Future<CompanionPeerTrust?> Function({
      required String pairingId,
      required String deviceId,
      required String deviceName,
      required String fingerprint,
    });
typedef CompanionInvitedPeerConfirmation =
    Future<void> Function({
      required String pairingId,
      required String deviceId,
      required String deviceName,
      required String fingerprint,
      required CompanionPeerTrust trust,
    });

class CompanionServerIdentity {
  const CompanionServerIdentity({
    required this.deviceId,
    required this.deviceName,
    required this.fingerprint,
  });

  final String deviceId;
  final String deviceName;
  final String fingerprint;
}

class CompanionTransferCancellation {
  bool _canceled = false;

  bool get canceled => _canceled;

  void cancel() => _canceled = true;
}

class CompanionSocketServer {
  CompanionSocketServer({
    required this.identity,
    required CompanionPeerLookup lookupPeer,
    required CompanionTransferReceiver receiver,
    CompanionInvitedPeerResolver? resolveInvitedPeer,
    CompanionInvitedPeerConfirmation? confirmInvitedPeer,
    void Function(List<int> frame)? observeInboundFrame,
    InternetAddress? address,
    Random? secureRandom,
    int Function()? clockMs,
  }) : _lookupPeer = lookupPeer,
       _receiver = receiver,
       _resolveInvitedPeer = resolveInvitedPeer,
       _confirmInvitedPeer = confirmInvitedPeer,
       _observeInboundFrame = observeInboundFrame,
       _address = address ?? InternetAddress.anyIPv4,
       _secureRandom = secureRandom ?? Random.secure(),
       _clockMs = clockMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final CompanionServerIdentity identity;
  final CompanionPeerLookup _lookupPeer;
  final CompanionTransferReceiver _receiver;
  final CompanionInvitedPeerResolver? _resolveInvitedPeer;
  final CompanionInvitedPeerConfirmation? _confirmInvitedPeer;
  final void Function(List<int> frame)? _observeInboundFrame;
  final InternetAddress _address;
  final Random _secureRandom;
  final int Function() _clockMs;
  ServerSocket? _server;
  final Set<Socket> _clients = <Socket>{};

  int? get port => _server?.port;

  Future<int> start({int port = 0}) async {
    if (_server != null) return _server!.port;
    final server = await ServerSocket.bind(
      _address,
      port,
      shared: false,
      v6Only: false,
    );
    _server = server;
    server.listen(_handleClient, onError: (_) {});
    return server.port;
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    await server?.close();
    final clients = _clients.toList(growable: false);
    _clients.clear();
    for (final client in clients) {
      await client.close();
    }
  }

  Future<void> _handleClient(Socket socket) async {
    if (_clients.isNotEmpty) {
      socket.destroy();
      return;
    }
    _clients.add(socket);
    try {
      final reader = _CompanionFrameReader(
        socket,
        observeFrame: _observeInboundFrame,
      );
      final hello = _decodePlain(await reader.next());
      _requireExactKeys(hello, <String>{
        'schema',
        'type',
        'sessionId',
        'deviceId',
        'deviceName',
        'fingerprint',
        'pairingId',
        'initiatorNonce',
        'issuedAtMs',
      });
      if (hello['schema'] != companionMediaTransferSchema ||
          hello['type'] != 'sessionHello') {
        throw const CompanionProtocolException(
          'INVALID_SESSION_HELLO',
          'Session hello is invalid.',
        );
      }
      final sessionId = hello['sessionId'] as String? ?? '';
      final deviceId = hello['deviceId'] as String? ?? '';
      final deviceName = hello['deviceName'] as String? ?? '';
      final fingerprint = hello['fingerprint'] as String? ?? '';
      final pairingId = hello['pairingId'] as String?;
      final issuedAtMs = hello['issuedAtMs'] as int? ?? -1;
      final now = _clockMs();
      if (sessionId.isEmpty ||
          deviceId.isEmpty ||
          deviceName.isEmpty ||
          (issuedAtMs - now).abs() > 120000) {
        throw const CompanionProtocolException(
          'SESSION_HELLO_EXPIRED',
          'Session hello is invalid or expired.',
        );
      }
      var invited = false;
      var peer = await _lookupPeer(deviceId);
      if (peer == null && pairingId != null && _resolveInvitedPeer != null) {
        peer = await _resolveInvitedPeer(
          pairingId: pairingId,
          deviceId: deviceId,
          deviceName: deviceName,
          fingerprint: fingerprint,
        );
        invited = peer != null;
      }
      if (peer == null) {
        throw const CompanionProtocolException(
          'UNPAIRED_PEER',
          'Peer is not paired.',
        );
      }
      peer.requireUsable(
        presentedFingerprint: fingerprint,
        restoredFromBackup: false,
      );
      final initiatorNonce = _decodeFixedBase64(
        hello['initiatorNonce'],
        32,
        'initiatorNonce',
      );
      final responderNonce = List<int>.generate(
        32,
        (_) => _secureRandom.nextInt(256),
      );
      final expiresAtMs = now + 5 * 60 * 1000;
      _writePlain(socket, <String, Object?>{
        'schema': companionMediaTransferSchema,
        'type': 'sessionHelloAck',
        'sessionId': sessionId,
        'deviceId': identity.deviceId,
        'deviceName': identity.deviceName,
        'fingerprint': identity.fingerprint,
        'responderNonce': base64Encode(responderNonce),
        'expiresAtMs': expiresAtMs,
      });
      final sessions = await CompanionSession.establish(
        sessionId: sessionId,
        sharedCredential: peer.sharedCredential,
        initiatorNonce: initiatorNonce,
        responderNonce: responderNonce,
        expiresAtMs: expiresAtMs,
      );
      final session = sessions.$2;
      CompanionTransferManifest? manifest;
      CompanionChunk? pendingChunk;
      while (true) {
        final frame = await reader.next();
        if (frame.first == _binaryFrame) {
          final chunk = pendingChunk;
          final activeManifest = manifest;
          if (chunk == null || activeManifest == null) {
            throw const CompanionProtocolException(
              'UNEXPECTED_BINARY_PACKET',
              'Binary packet has no chunk header.',
            );
          }
          final bytes = await session.openBytes(
            packet: frame.sublist(1),
            nowMs: _clockMs(),
          );
          final checkpoint = await _receiver.acceptChunk(
            activeManifest,
            chunk,
            bytes,
          );
          pendingChunk = null;
          await _writeSealed(
            socket,
            session,
            CompanionMessageType.checkpoint,
            'checkpoint-${chunk.index}',
            checkpoint.toJson(),
            _clockMs(),
          );
          continue;
        }
        final envelope = await session.open(
          sealed: utf8.decode(frame.sublist(1)),
          nowMs: _clockMs(),
        );
        switch (envelope.type) {
          case CompanionMessageType.manifest:
            manifest = CompanionTransferManifest.fromJson(envelope.payload);
            if (invited) {
              await _confirmInvitedPeer?.call(
                pairingId: pairingId!,
                deviceId: deviceId,
                deviceName: deviceName,
                fingerprint: fingerprint,
                trust: peer,
              );
              invited = false;
            }
            final checkpoint = await _receiver.acceptManifest(manifest);
            await _writeSealed(
              socket,
              session,
              CompanionMessageType.checkpoint,
              'checkpoint-manifest',
              checkpoint.toJson(),
              _clockMs(),
            );
            break;
          case CompanionMessageType.chunk:
            final activeManifest = manifest;
            if (activeManifest == null) {
              throw const CompanionProtocolException(
                'MANIFEST_REQUIRED',
                'Chunk arrived before a transfer manifest.',
              );
            }
            pendingChunk = _chunkFromJson(envelope.payload);
            if (pendingChunk.transferId != activeManifest.transferId) {
              throw const CompanionProtocolException(
                'TRANSFER_ID_MISMATCH',
                'Chunk transfer ID does not match the manifest.',
              );
            }
            break;
          case CompanionMessageType.receipt:
            final activeManifest = manifest;
            if (activeManifest == null ||
                envelope.payload['request'] != true ||
                envelope.payload['transferId'] != activeManifest.transferId ||
                envelope.payload['wholeFileSha256'] !=
                    activeManifest.wholeFileSha256) {
              throw const CompanionProtocolException(
                'INVALID_RECEIPT_REQUEST',
                'Receipt request is invalid.',
              );
            }
            final receipt = await _receiver.commit(activeManifest);
            await _writeSealed(
              socket,
              session,
              CompanionMessageType.receipt,
              receipt.receiptId,
              receipt.toJson(),
              _clockMs(),
            );
            return;
          case CompanionMessageType.cancel:
            final activeManifest = manifest;
            if (activeManifest != null) {
              await _receiver.cancel(activeManifest);
            }
            return;
          default:
            throw const CompanionProtocolException(
              'UNEXPECTED_MESSAGE',
              'Message is not valid in the transfer stream.',
            );
        }
      }
    } on Object {
      socket.destroy();
    } finally {
      _clients.remove(socket);
      await socket.close();
    }
  }
}

class CompanionSocketPairingClient {
  CompanionSocketPairingClient({
    required this.deviceId,
    required this.deviceName,
    required this.identity,
    required this.pairingId,
    required this.shortCode,
    required this.targetDeviceId,
    required this.targetFingerprint,
    required this.targetIdentityPublicKey,
    required this.targetEphemeralPublicKey,
    required this.expiresAtMs,
    required this.persistPendingTrust,
    this.finalAcknowledgementTimeout = const Duration(seconds: 30),
    Random? secureRandom,
    int Function()? clockMs,
  }) : _secureRandom = secureRandom ?? Random.secure(),
       _clockMs = clockMs ?? (() => DateTime.now().millisecondsSinceEpoch);

  final String deviceId;
  final String deviceName;
  final CompanionIdentity identity;
  final String pairingId;
  final String shortCode;
  final String targetDeviceId;
  final String targetFingerprint;
  final SimplePublicKey targetIdentityPublicKey;
  final SimplePublicKey targetEphemeralPublicKey;
  final int expiresAtMs;
  final Future<void> Function(CompanionPeerTrust trust) persistPendingTrust;
  final Duration finalAcknowledgementTimeout;
  final Random _secureRandom;
  final int Function() _clockMs;

  Future<CompanionPeerTrust> pair({
    required InternetAddress address,
    required int port,
  }) async {
    if (_clockMs() > expiresAtMs ||
        companionFingerprint(targetIdentityPublicKey.bytes) !=
            targetFingerprint ||
        targetIdentityPublicKey.type != KeyPairType.ed25519 ||
        targetEphemeralPublicKey.type != KeyPairType.x25519) {
      throw const CompanionProtocolException(
        'INVALID_PAIRING_INVITE',
        'Pairing invite identity or expiry is invalid.',
      );
    }
    final ephemeral = await CompanionPairingEphemeral.generate();
    final sharedSecret = await ephemeral.sharedSecret(targetEphemeralPublicKey);
    final temporaryCredential = await deriveCompanionPairingCredential(
      secret: sharedSecret,
      pairingId: pairingId,
      purpose: 'temporary-channel',
    );
    final socket = await Socket.connect(
      address,
      port,
      timeout: const Duration(seconds: 10),
    );
    final reader = _CompanionFrameReader(socket);
    try {
      final sessionId =
          'session-${_clockMs()}-${_secureRandom.nextInt(1 << 32)}';
      final initiatorNonce = List<int>.generate(
        32,
        (_) => _secureRandom.nextInt(256),
      );
      _writePlain(socket, <String, Object?>{
        'schema': companionMediaTransferSchema,
        'type': 'sessionHello',
        'sessionId': sessionId,
        'deviceId': deviceId,
        'deviceName': deviceName,
        'fingerprint': identity.fingerprint,
        'pairingId': pairingId,
        'initiatorEphemeralPublicKey': base64Encode(ephemeral.publicKey.bytes),
        'initiatorNonce': base64Encode(initiatorNonce),
        'issuedAtMs': _clockMs(),
      });
      final ack = _decodePlain(await reader.next());
      _requireExactKeys(ack, <String>{
        'schema',
        'type',
        'sessionId',
        'deviceId',
        'deviceName',
        'fingerprint',
        'responderNonce',
        'expiresAtMs',
      });
      if (ack['schema'] != companionMediaTransferSchema ||
          ack['type'] != 'sessionHelloAck' ||
          ack['sessionId'] != sessionId ||
          ack['deviceId'] != targetDeviceId ||
          ack['fingerprint'] != targetFingerprint) {
        throw const CompanionProtocolException(
          'TARGET_IDENTITY_MISMATCH',
          'Desktop identity does not match the pairing invite.',
        );
      }
      final responderNonce = _decodeFixedBase64(
        ack['responderNonce'],
        32,
        'responderNonce',
      );
      final sessionExpiresAtMs = ack['expiresAtMs'] as int? ?? -1;
      final sessions = await CompanionSession.establish(
        sessionId: sessionId,
        sharedCredential: temporaryCredential,
        initiatorNonce: initiatorNonce,
        responderNonce: responderNonce,
        expiresAtMs: sessionExpiresAtMs,
      );
      final session = sessions.$1;
      final transcript = CompanionPairingTranscript(
        pairingId: pairingId,
        initiatorDeviceId: deviceId,
        initiatorFingerprint: identity.fingerprint,
        initiatorEphemeralPublicKey: base64Encode(ephemeral.publicKey.bytes),
        responderDeviceId: targetDeviceId,
        responderFingerprint: targetFingerprint,
        responderEphemeralPublicKey: base64Encode(
          targetEphemeralPublicKey.bytes,
        ),
        shortCodeHash: CompanionPairingTranscript.hashShortCode(
          pairingId: pairingId,
          code: shortCode,
        ),
        expiresAtMs: expiresAtMs,
        capabilities: const <String>[companionMediaTransferCapability],
      );
      final initiatorSignature = await identity.sign(
        transcript.canonicalBytes(),
      );
      await _writeSealed(
        socket,
        session,
        CompanionMessageType.pairingTranscript,
        'pairing-$pairingId',
        <String, Object?>{
          'transcript': transcript.toJson(),
          'shortCode': shortCode,
          'initiatorIdentityPublicKey': base64Encode(identity.publicKey.bytes),
          'initiatorSignature': base64Encode(initiatorSignature.bytes),
        },
        _clockMs(),
      );
      final response = await _readSealed(reader, session, _clockMs());
      if (response.type != CompanionMessageType.pairingTranscript) {
        throw const CompanionProtocolException(
          'PAIRING_RESPONSE_INVALID',
          'Desktop pairing response is invalid.',
        );
      }
      _requireExactKeys(response.payload, <String>{
        'transcript',
        'responderIdentityPublicKey',
        'responderSignature',
        'verified',
      });
      if (response.payload['verified'] != true ||
          jsonEncode(response.payload['transcript']) !=
              jsonEncode(transcript.toJson())) {
        throw const CompanionProtocolException(
          'PAIRING_TRANSCRIPT_MISMATCH',
          'Desktop pairing transcript changed.',
        );
      }
      final responderIdentityBytes = _decodeFixedBase64(
        response.payload['responderIdentityPublicKey'],
        32,
        'responderIdentityPublicKey',
      );
      final responderSignatureBytes = _decodeFixedBase64(
        response.payload['responderSignature'],
        64,
        'responderSignature',
      );
      if (!_constantTimeBytes(
        responderIdentityBytes,
        targetIdentityPublicKey.bytes,
      )) {
        throw const CompanionProtocolException(
          'PAIRING_RESPONDER_IDENTITY_MISMATCH',
          'Desktop pairing identity changed.',
        );
      }
      final signed = CompanionSignedPairing(
        transcript: transcript,
        initiatorPublicKey: identity.publicKey,
        initiatorSignature: initiatorSignature,
        responderPublicKey: targetIdentityPublicKey,
        responderSignature: Signature(
          responderSignatureBytes,
          publicKey: targetIdentityPublicKey,
        ),
      );
      await signed.verify();
      final transcriptHash = sha256.convert(transcript.canonicalBytes()).bytes;
      final durable = await deriveCompanionPairingCredential(
        secret: sharedSecret,
        pairingId: pairingId,
        purpose: 'long-term-peer',
        transcriptHash: transcriptHash,
      );
      final trust = CompanionPeerTrust(
        peerDeviceId: targetDeviceId,
        peerFingerprint: targetFingerprint,
        sharedCredential: List<int>.unmodifiable(List<int>.from(durable)),
        pairedAtMs: _clockMs(),
      );
      durable.fillRange(0, durable.length, 0);
      await persistPendingTrust(trust);
      final transcriptHashHex = sha256
          .convert(transcript.canonicalBytes())
          .toString();
      await _writeSealed(
        socket,
        session,
        CompanionMessageType.pairingTranscript,
        'pairing-commit-$pairingId',
        <String, Object?>{'commit': true, 'transcriptHash': transcriptHashHex},
        _clockMs(),
      );
      try {
        final committed = await _readSealed(
          reader,
          session,
          _clockMs(),
        ).timeout(finalAcknowledgementTimeout);
        _requireExactKeys(committed.payload, <String>{
          'paired',
          'transcriptHash',
        });
        if (committed.type != CompanionMessageType.pairingTranscript ||
            committed.payload['paired'] != true ||
            committed.payload['transcriptHash'] != transcriptHashHex) {
          throw const CompanionProtocolException(
            'PAIRING_COMMIT_MISMATCH',
            'Desktop pairing commit is invalid.',
          );
        }
      } on Object {
        throw const CompanionProtocolException(
          'PAIRING_CONFIRMATION_UNKNOWN',
          'Pairing commit was sent but desktop confirmation was lost; probe the persisted pending credential.',
        );
      }
      return trust;
    } finally {
      sharedSecret.fillRange(0, sharedSecret.length, 0);
      temporaryCredential.fillRange(0, temporaryCredential.length, 0);
      ephemeral.destroy();
      socket.destroy();
      await socket.close();
    }
  }
}

class CompanionSocketClient {
  CompanionSocketClient({
    required this.deviceId,
    required this.deviceName,
    required this.deviceFingerprint,
    required this.targetDeviceId,
    required this.targetFingerprint,
    required this.sharedCredential,
    this.targetIdentityPublicKey,
    this.pairingId,
    Random? secureRandom,
    int Function()? clockMs,
  }) : _secureRandom = secureRandom ?? Random.secure(),
       _clockMs = clockMs ?? (() => DateTime.now().millisecondsSinceEpoch) {
    if (sharedCredential.length != 32) {
      throw ArgumentError.value(sharedCredential, 'sharedCredential');
    }
  }

  final String deviceId;
  final String deviceName;
  final String deviceFingerprint;
  final String targetDeviceId;
  final String targetFingerprint;
  final List<int> sharedCredential;
  final SimplePublicKey? targetIdentityPublicKey;
  final String? pairingId;
  final Random _secureRandom;
  final int Function() _clockMs;

  Future<CompanionReceipt> sendFile({
    required InternetAddress address,
    required int port,
    required File source,
    required CompanionTransferManifest manifest,
    CompanionTransferCancellation? cancellation,
    void Function(int sentBytes, int totalBytes)? onProgress,
    int? maximumChunksThisConnection,
  }) async {
    final stat = await source.stat();
    if (stat.type != FileSystemEntityType.file ||
        stat.size != manifest.sizeBytes) {
      throw const CompanionProtocolException(
        'SOURCE_CHANGED',
        'Source is not a regular file matching the manifest.',
      );
    }
    final socket = await Socket.connect(
      address,
      port,
      timeout: const Duration(seconds: 10),
    );
    final reader = _CompanionFrameReader(socket);
    try {
      final sessionId =
          'session-${_clockMs()}-${_secureRandom.nextInt(1 << 32)}';
      final initiatorNonce = List<int>.generate(
        32,
        (_) => _secureRandom.nextInt(256),
      );
      _writePlain(socket, <String, Object?>{
        'schema': companionMediaTransferSchema,
        'type': 'sessionHello',
        'sessionId': sessionId,
        'deviceId': deviceId,
        'deviceName': deviceName,
        'fingerprint': deviceFingerprint,
        'pairingId': pairingId,
        'initiatorNonce': base64Encode(initiatorNonce),
        'issuedAtMs': _clockMs(),
      });
      final ack = _decodePlain(await reader.next());
      _requireExactKeys(ack, <String>{
        'schema',
        'type',
        'sessionId',
        'deviceId',
        'deviceName',
        'fingerprint',
        'responderNonce',
        'expiresAtMs',
      });
      if (ack['schema'] != companionMediaTransferSchema ||
          ack['type'] != 'sessionHelloAck' ||
          ack['sessionId'] != sessionId ||
          ack['deviceId'] != targetDeviceId ||
          ack['fingerprint'] != targetFingerprint) {
        throw const CompanionProtocolException(
          'TARGET_IDENTITY_MISMATCH',
          'Desktop identity does not match the paired peer.',
        );
      }
      final responderNonce = _decodeFixedBase64(
        ack['responderNonce'],
        32,
        'responderNonce',
      );
      final expiresAtMs = ack['expiresAtMs'] as int? ?? -1;
      if (expiresAtMs <= _clockMs() ||
          expiresAtMs - _clockMs() > 5 * 60 * 1000 + 5000) {
        throw const CompanionProtocolException(
          'INVALID_SESSION_EXPIRY',
          'Desktop session expiry is invalid.',
        );
      }
      final sessions = await CompanionSession.establish(
        sessionId: sessionId,
        sharedCredential: sharedCredential,
        initiatorNonce: initiatorNonce,
        responderNonce: responderNonce,
        expiresAtMs: expiresAtMs,
      );
      final session = sessions.$1;
      await _writeSealed(
        socket,
        session,
        CompanionMessageType.manifest,
        'manifest-${manifest.transferId}',
        manifest.toJson(),
        _clockMs(),
      );
      var checkpoint = _checkpointFromJson(
        (await _readSealed(reader, session, _clockMs())).payload,
        manifest,
      );
      var sent = 0;
      var sentChunks = 0;
      for (final index in checkpoint.missingChunks) {
        if (cancellation?.canceled == true) {
          await _writeSealed(
            socket,
            session,
            CompanionMessageType.cancel,
            'cancel-${manifest.transferId}',
            <String, Object?>{
              'transferId': manifest.transferId,
              'reason': 'user',
            },
            _clockMs(),
          );
          throw const CompanionProtocolException(
            'TRANSFER_CANCELED',
            'Transfer was canceled by the user.',
          );
        }
        if (maximumChunksThisConnection != null &&
            sentChunks >= maximumChunksThisConnection) {
          throw const CompanionProtocolException(
            'SIMULATED_CONNECTION_LOSS',
            'Connection ended before all chunks were sent.',
          );
        }
        final offset = index * manifest.chunkBytes;
        final length = manifest.expectedChunkLength(index);
        final bytes = await source
            .openRead(offset, offset + length)
            .fold(<int>[], (buffer, data) => buffer..addAll(data));
        final chunk = CompanionChunk(
          transferId: manifest.transferId,
          index: index,
          offset: offset,
          plaintextBytes: bytes.length,
          sha256: sha256.convert(bytes).toString(),
        );
        await _writeSealed(
          socket,
          session,
          CompanionMessageType.chunk,
          'chunk-${manifest.transferId}-$index',
          chunk.toJson(),
          _clockMs(),
        );
        final encrypted = await session.sealBytes(
          plaintext: bytes,
          nowMs: _clockMs(),
        );
        _writeFrame(socket, _binaryFrame, encrypted);
        checkpoint = _checkpointFromJson(
          (await _readSealed(reader, session, _clockMs())).payload,
          manifest,
        );
        sent += bytes.length;
        sentChunks++;
        onProgress?.call(sent, manifest.sizeBytes);
      }
      if (checkpoint.missingChunks.isNotEmpty) {
        throw const CompanionProtocolException(
          'TRANSFER_INCOMPLETE',
          'Desktop still reports missing chunks.',
        );
      }
      await _writeSealed(
        socket,
        session,
        CompanionMessageType.receipt,
        'receipt-request-${manifest.transferId}',
        <String, Object?>{
          'request': true,
          'transferId': manifest.transferId,
          'wholeFileSha256': manifest.wholeFileSha256,
        },
        _clockMs(),
      );
      final receiptEnvelope = await _readSealed(reader, session, _clockMs());
      if (receiptEnvelope.type != CompanionMessageType.receipt) {
        throw const CompanionProtocolException(
          'RECEIPT_REQUIRED',
          'Desktop did not return a receipt.',
        );
      }
      final receipt = _receiptFromJson(receiptEnvelope.payload);
      await _verifyReceipt(receipt, manifest);
      return receipt;
    } finally {
      await socket.close();
    }
  }

  Future<void> _verifyReceipt(
    CompanionReceipt receipt,
    CompanionTransferManifest manifest,
  ) async {
    final publicKey = targetIdentityPublicKey;
    if (publicKey == null ||
        publicKey.type != KeyPairType.ed25519 ||
        companionFingerprint(publicKey.bytes) != targetFingerprint) {
      throw const CompanionProtocolException(
        'RECEIPT_IDENTITY_UNAVAILABLE',
        'Paired desktop public identity is required to verify receipts.',
      );
    }
    await verifyCompanionReceipt(
      receipt: receipt,
      manifest: manifest,
      expectedDesktopDeviceId: targetDeviceId,
      expectedDesktopFingerprint: targetFingerprint,
      desktopIdentityPublicKey: publicKey,
    );
  }
}

const int _controlFrame = 0;
const int _binaryFrame = 1;
const int _maximumFrameBytes = companionMaximumChunkBytes + 4096;

Future<void> _writeSealed(
  Socket socket,
  CompanionSession session,
  CompanionMessageType type,
  String messageId,
  Map<String, Object?> payload,
  int nowMs,
) async {
  final sealed = await session.seal(
    type: type,
    messageId: messageId,
    payload: payload,
    nowMs: nowMs,
  );
  _writeFrame(socket, _controlFrame, utf8.encode(sealed));
}

Future<CompanionEnvelope> _readSealed(
  _CompanionFrameReader reader,
  CompanionSession session,
  int nowMs,
) async {
  final frame = await reader.next();
  if (frame.first != _controlFrame) {
    throw const CompanionProtocolException(
      'CONTROL_FRAME_REQUIRED',
      'Expected an encrypted control frame.',
    );
  }
  return session.open(sealed: utf8.decode(frame.sublist(1)), nowMs: nowMs);
}

void _writePlain(Socket socket, Map<String, Object?> value) {
  final encoded = utf8.encode(jsonEncode(value));
  if (encoded.length > 4096) {
    throw const CompanionProtocolException(
      'PLAIN_FRAME_TOO_LARGE',
      'Session handshake exceeds its limit.',
    );
  }
  _writeFrame(socket, _controlFrame, encoded);
}

Map<String, Object?> _decodePlain(Uint8List frame) {
  if (frame.first != _controlFrame || frame.length > 4097) {
    throw const CompanionProtocolException(
      'INVALID_PLAIN_FRAME',
      'Session handshake frame is invalid.',
    );
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(utf8.decode(frame.sublist(1)));
  } on FormatException {
    throw const CompanionProtocolException(
      'INVALID_PLAIN_FRAME',
      'Session handshake JSON is invalid.',
    );
  }
  if (decoded is! Map || decoded.keys.any((key) => key is! String)) {
    throw const CompanionProtocolException(
      'INVALID_PLAIN_FRAME',
      'Session handshake object is invalid.',
    );
  }
  return decoded.cast<String, Object?>();
}

void _writeFrame(Socket socket, int kind, List<int> payload) {
  final length = payload.length + 1;
  if (length < 2 || length > _maximumFrameBytes) {
    throw const CompanionProtocolException(
      'FRAME_SIZE_INVALID',
      'Transport frame is outside the size limit.',
    );
  }
  final header = ByteData(4)..setUint32(0, length, Endian.big);
  socket.add(header.buffer.asUint8List());
  socket.add(<int>[kind]);
  socket.add(payload);
}

class _CompanionFrameReader {
  _CompanionFrameReader(
    this._socket, {
    void Function(List<int> frame)? observeFrame,
  }) : _observeFrame = observeFrame {
    _subscription = _socket.listen(
      (data) {
        _buffer.addAll(data);
        _drain();
        if (_buffer.length > (_maximumFrameBytes + 4) * 2) {
          _failTransport(
            const CompanionProtocolException(
              'FRAME_SIZE_INVALID',
              'Incoming frame buffer exceeds its hard limit.',
            ),
            StackTrace.current,
          );
        }
      },
      onError: (Object error, StackTrace stackTrace) {
        _failTransport(error, stackTrace);
      },
      onDone: () {
        _failTransport(
          const CompanionProtocolException(
            'CONNECTION_CLOSED',
            'Connection closed before the next frame.',
          ),
          StackTrace.current,
        );
      },
      cancelOnError: true,
    );
  }

  final List<int> _buffer = <int>[];
  final Socket _socket;
  final void Function(List<int> frame)? _observeFrame;
  final List<Completer<Uint8List>> _pending = <Completer<Uint8List>>[];
  late final StreamSubscription<List<int>> _subscription;

  Future<Uint8List> next() {
    final completer = Completer<Uint8List>();
    _pending.add(completer);
    _drain();
    return completer.future.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        const error = CompanionProtocolException(
          'FRAME_TIMEOUT',
          'Timed out waiting for the next transport frame.',
        );
        _failTransport(error, StackTrace.current);
        throw error;
      },
    );
  }

  void _drain() {
    while (_pending.isNotEmpty && _buffer.length >= 4) {
      final header = ByteData.sublistView(Uint8List.fromList(_buffer), 0, 4);
      final length = header.getUint32(0, Endian.big);
      if (length < 2 || length > _maximumFrameBytes) {
        final error = const CompanionProtocolException(
          'FRAME_SIZE_INVALID',
          'Incoming transport frame is outside the size limit.',
        );
        _failTransport(error, StackTrace.current);
        return;
      }
      if (_buffer.length < 4 + length) return;
      final frame = Uint8List.fromList(_buffer.sublist(4, 4 + length));
      _buffer.removeRange(0, 4 + length);
      _observeFrame?.call(frame);
      _pending.removeAt(0).complete(frame);
    }
  }

  void _failPending(Object error, StackTrace stackTrace) {
    for (final completer in _pending) {
      if (!completer.isCompleted) completer.completeError(error, stackTrace);
    }
    _pending.clear();
  }

  void _failTransport(Object error, StackTrace stackTrace) {
    _failPending(error, stackTrace);
    _buffer.clear();
    unawaited(_subscription.cancel());
    _socket.destroy();
  }
}

List<int> _decodeFixedBase64(Object? raw, int bytes, String field) {
  if (raw is! String) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  final List<int> decoded;
  try {
    decoded = base64Decode(raw);
  } on FormatException {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  if (decoded.length != bytes) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  if (base64Encode(decoded) != raw) {
    throw CompanionProtocolException('INVALID_FIELD', '$field is invalid.');
  }
  return decoded;
}

void _requireExactKeys(Map<String, Object?> map, Set<String> expected) {
  if (map.keys.toSet().difference(expected).isNotEmpty ||
      expected.difference(map.keys.toSet()).isNotEmpty) {
    throw const CompanionProtocolException(
      'INVALID_FIELDS',
      'Handshake contains missing or unknown fields.',
    );
  }
}

CompanionChunk _chunkFromJson(Map<String, Object?> map) {
  return CompanionChunk(
    transferId: map['transferId'] as String? ?? '',
    index: map['index'] as int? ?? -1,
    offset: map['offset'] as int? ?? -1,
    plaintextBytes: map['plaintextBytes'] as int? ?? -1,
    sha256: map['sha256'] as String? ?? '',
  );
}

CompanionCheckpoint _checkpointFromJson(
  Map<String, Object?> map,
  CompanionTransferManifest manifest,
) {
  _requireExactKeys(map, <String>{
    'transferId',
    'wholeFileSha256',
    'chunkCount',
    'missingChunkBitmap',
    'updatedAtMs',
  });
  final chunkCount = map['chunkCount'] as int? ?? -1;
  if (chunkCount != manifest.chunkCount) {
    throw const CompanionProtocolException(
      'INVALID_CHECKPOINT',
      'Checkpoint chunk count does not match the manifest.',
    );
  }
  return CompanionCheckpoint(
    transferId: map['transferId'] as String? ?? '',
    wholeFileSha256: map['wholeFileSha256'] as String? ?? '',
    chunkCount: chunkCount,
    missingChunks: decodeMissingChunkBitmap(
      chunkCount: chunkCount,
      encoded: map['missingChunkBitmap'],
    ),
    updatedAtMs: map['updatedAtMs'] as int? ?? -1,
  );
}

CompanionReceipt _receiptFromJson(Map<String, Object?> map) {
  _requireExactKeys(map, <String>{
    'schema',
    'receiptId',
    'transferId',
    'wholeFileSha256',
    'sizeBytes',
    'desktopDeviceId',
    'desktopDeviceName',
    'desktopRecordingId',
    'committedAtMs',
    'signature',
  });
  if (map['schema'] != companionMediaTransferSchema) {
    throw const CompanionProtocolException(
      'UNSUPPORTED_SCHEMA',
      'Receipt schema is invalid.',
    );
  }
  return CompanionReceipt(
    receiptId: map['receiptId'] as String? ?? '',
    transferId: map['transferId'] as String? ?? '',
    wholeFileSha256: map['wholeFileSha256'] as String? ?? '',
    sizeBytes: map['sizeBytes'] as int? ?? -1,
    desktopDeviceId: map['desktopDeviceId'] as String? ?? '',
    desktopDeviceName: map['desktopDeviceName'] as String? ?? '',
    desktopRecordingId: map['desktopRecordingId'] as int? ?? -1,
    committedAtMs: map['committedAtMs'] as int? ?? -1,
    signature: map['signature'] as String? ?? '',
  );
}

bool _constantTimeBytes(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}
