import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:crypto/crypto.dart';

Future<void> main(List<String> arguments) async {
  final port = arguments.isEmpty ? 45872 : int.parse(arguments.first);
  final root = await Directory.systemTemp.createTemp('voice2text-u8-lan-');
  final committed = Completer<Map<String, Object>>();
  final credential = List<int>.generate(32, (index) => index);
  var capturedFrames = 0;
  var capturedBytes = 0;
  var plaintextMeetingContentSeen = false;
  var reusableCredentialSeen = false;
  final marker = utf8.encode('VOICE2TEXT_U8_SECRET_MEETING_CONTENT_');
  final credentialBase64 = utf8.encode(base64Encode(credential));
  final receiver = CompanionTransferReceiver(
    store: FileCompanionTransferStore(root: Directory('${root.path}/staging')),
    desktopDeviceId: 'u8-desktop',
    desktopDeviceName: 'U8 Mac Receiver',
    signReceipt: (payload) async =>
        base64Encode(sha256.convert(utf8.encode(jsonEncode(payload))).bytes),
    commitImport: (stagedPath, manifest) async {
      final target = File('${root.path}/committed.media');
      await File(stagedPath).copy(target.path);
      final digest = await sha256.bind(target.openRead()).first;
      final evidence = <String, Object>{
        'recordingId': 7008,
        'sha256': digest.toString(),
        'bytes': await target.length(),
        'transferId': manifest.transferId,
        'sourceAssetId': manifest.sourceAssetId,
      };
      if (!committed.isCompleted) committed.complete(evidence);
      return (recordingId: 7008, committedSha256: digest.toString());
    },
  );
  final server = CompanionSocketServer(
    identity: CompanionServerIdentity(
      deviceId: 'u8-desktop',
      deviceName: 'U8 Mac Receiver',
      fingerprint: 'D'.padRight(32, 'D'),
    ),
    lookupPeer: (deviceId) async => deviceId == 'u8-android'
        ? CompanionPeerTrust(
            peerDeviceId: deviceId,
            peerFingerprint: 'A'.padRight(32, 'A'),
            sharedCredential: credential,
            pairedAtMs: 1,
          )
        : null,
    observeInboundFrame: (frame) {
      capturedFrames++;
      capturedBytes += frame.length;
      plaintextMeetingContentSeen |= _contains(frame, marker);
      reusableCredentialSeen |=
          _contains(frame, credential) || _contains(frame, credentialBase64);
    },
    receiver: receiver,
  );
  await server.start(port: port);
  stdout.writeln(
    jsonEncode(<String, Object>{
      'event': 'ready',
      'port': port,
      'root': root.path,
    }),
  );
  final evidence = await committed.future.timeout(const Duration(minutes: 5));
  stdout.writeln(
    jsonEncode(<String, Object>{'event': 'committed', ...evidence}),
  );
  await ProcessSignal.sigint.watch().first;
  stdout.writeln(
    jsonEncode(<String, Object>{
      'event': 'capture_summary',
      'frames': capturedFrames,
      'bytes': capturedBytes,
      'plaintextMeetingContentSeen': plaintextMeetingContentSeen,
      'reusableCredentialSeen': reusableCredentialSeen,
    }),
  );
  await server.stop();
  await root.delete(recursive: true);
}

bool _contains(List<int> haystack, List<int> needle) {
  if (needle.isEmpty || haystack.length < needle.length) return false;
  for (var start = 0; start <= haystack.length - needle.length; start++) {
    var matches = true;
    for (var index = 0; index < needle.length; index++) {
      if (haystack[start + index] != needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
