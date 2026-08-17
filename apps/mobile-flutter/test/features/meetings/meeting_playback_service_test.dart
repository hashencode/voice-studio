import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voice2text_flutter/features/meetings/service/meeting_playback_service.dart';

void main() {
  test('load, play, seek, skip and speed are delegated', () async {
    final backend = _FakePlaybackBackend();
    final service = MeetingPlaybackService(backend: backend);

    await service.load('/meeting.m4a');
    expect(service.snapshot.initialized, isTrue);

    await service.toggle();
    expect(backend.playCalls, 1);
    await service.seekTo(const Duration(seconds: 20));
    await service.skip(const Duration(seconds: -10));
    await service.setSpeed(1.5);

    expect(backend.seeks, <Duration>[
      const Duration(seconds: 20),
      const Duration(seconds: -10),
    ]);
    expect(backend.speed, 1.5);
    service.dispose();
  });

  test('load failure is exposed as safe UI state', () async {
    final service = MeetingPlaybackService(
      backend: _FakePlaybackBackend(failLoad: true),
    );
    await service.load('/missing.m4a');
    expect(service.snapshot.initialized, isFalse);
    expect(service.snapshot.error, isNotEmpty);
    service.dispose();
  });
}

class _FakePlaybackBackend implements MeetingPlaybackBackend {
  _FakePlaybackBackend({this.failLoad = false});

  final bool failLoad;
  final List<VoidCallback> _listeners = <VoidCallback>[];
  int playCalls = 0;
  double speed = 1;
  final List<Duration> seeks = <Duration>[];
  MeetingPlaybackSnapshot _snapshot = const MeetingPlaybackSnapshot.idle();

  @override
  MeetingPlaybackSnapshot get snapshot => _snapshot;

  @override
  void addListener(VoidCallback listener) => _listeners.add(listener);

  @override
  Future<void> initialize(String path) async {
    if (failLoad) throw StateError('failed');
    _snapshot = const MeetingPlaybackSnapshot(
      initialized: true,
      playing: false,
      position: Duration.zero,
      duration: Duration(minutes: 2),
      speed: 1,
    );
  }

  @override
  Future<void> pause() async {}

  @override
  Future<void> play() async {
    playCalls++;
  }

  @override
  void removeListener(VoidCallback listener) => _listeners.remove(listener);

  @override
  Future<void> seekTo(Duration position) async => seeks.add(position);

  @override
  Future<void> setSpeed(double value) async => speed = value;

  @override
  Future<void> dispose() async {}
}
