import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/audio_intelligence/service/audio_api_secret_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('voice2text/test-audio-secret');
  const store = AudioApiSecretStore(channel: channel);
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
          calls.add(call);
          return switch (call.method) {
            'getAudioApiSecret' => 'stored-secret',
            'hasAudioApiSecret' => true,
            _ => null,
          };
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'delegates lifecycle operations without persisting plaintext in Dart',
    () async {
      await store.save(providerId: 'deepseek', secret: '  transient-secret  ');
      expect(await store.hasSecret('deepseek'), isTrue);
      expect(await store.read('deepseek'), 'stored-secret');
      await store.delete('deepseek');

      expect(calls.map((MethodCall call) => call.method), <String>[
        'setAudioApiSecret',
        'hasAudioApiSecret',
        'getAudioApiSecret',
        'deleteAudioApiSecret',
      ]);
      expect(calls.first.arguments, <String, Object?>{
        'providerId': 'deepseek',
        'secret': 'transient-secret',
      });
    },
  );

  test(
    'rejects empty and oversized values before crossing platform channel',
    () async {
      await expectLater(
        store.save(providerId: 'deepseek', secret: '  '),
        throwsArgumentError,
      );
      await expectLater(
        store.save(providerId: 'deepseek', secret: 'x' * 4097),
        throwsArgumentError,
      );
      expect(calls, isEmpty);
    },
  );
}
