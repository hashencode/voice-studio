import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:media_kit/media_kit.dart';

class DesktopPlaybackSnapshot {
  const DesktopPlaybackSnapshot({
    required this.initialized,
    required this.playing,
    required this.position,
    required this.duration,
    required this.speed,
    this.error,
  });

  const DesktopPlaybackSnapshot.idle()
    : initialized = false,
      playing = false,
      position = Duration.zero,
      duration = Duration.zero,
      speed = 1,
      error = null;

  final bool initialized;
  final bool playing;
  final Duration position;
  final Duration duration;
  final double speed;
  final String? error;
}

abstract interface class DesktopPlaybackPort {
  Stream<DesktopPlaybackSnapshot> get snapshots;

  Future<void> open(String path);

  Future<void> play();

  Future<void> pause();

  Future<void> seek(Duration position);

  Future<void> setRate(double rate);

  Future<void> close();
}

class MediaKitDesktopPlaybackPort implements DesktopPlaybackPort {
  MediaKitDesktopPlaybackPort({Player? player}) : _player = player ?? Player() {
    _subscriptions.addAll(<StreamSubscription<Object?>>[
      _player.stream.position.listen((_) => _emit()),
      _player.stream.duration.listen((_) => _emit()),
      _player.stream.playing.listen((_) => _emit()),
      _player.stream.rate.listen((_) => _emit()),
      _player.stream.error.listen((message) {
        _error = message;
        _emit();
      }),
    ]);
  }

  final Player _player;
  final _controller = StreamController<DesktopPlaybackSnapshot>.broadcast();
  final _subscriptions = <StreamSubscription<Object?>>[];
  bool _initialized = false;
  String? _error;

  @override
  Stream<DesktopPlaybackSnapshot> get snapshots => _controller.stream;

  @override
  Future<void> open(String path) async {
    final file = File(path);
    if (!await file.exists()) throw StateError('会议音频不存在');
    _error = null;
    await _player.open(Media(file.path), play: false);
    _initialized = true;
    _emit();
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) {
    final bounded = position < Duration.zero
        ? Duration.zero
        : position > _player.state.duration
        ? _player.state.duration
        : position;
    return _player.seek(bounded);
  }

  @override
  Future<void> setRate(double rate) => _player.setRate(rate.clamp(0.5, 2));

  void _emit() {
    if (_controller.isClosed) return;
    _controller.add(
      DesktopPlaybackSnapshot(
        initialized: _initialized,
        playing: _player.state.playing,
        position: _player.state.position,
        duration: _player.state.duration,
        speed: _player.state.rate,
        error: _error,
      ),
    );
  }

  @override
  Future<void> close() async {
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    await _player.dispose();
    await _controller.close();
  }
}

class DesktopMeetingPlaybackController extends ChangeNotifier {
  DesktopMeetingPlaybackController({required DesktopPlaybackPort port})
    : _port = port {
    _subscription = _port.snapshots.listen((snapshot) {
      _snapshot = snapshot;
      notifyListeners();
    });
  }

  final DesktopPlaybackPort _port;
  late final StreamSubscription<DesktopPlaybackSnapshot> _subscription;
  DesktopPlaybackSnapshot _snapshot = const DesktopPlaybackSnapshot.idle();

  DesktopPlaybackSnapshot get snapshot => _snapshot;

  Future<void> open(String path) async {
    try {
      await _port.open(path);
    } on Object {
      _snapshot = const DesktopPlaybackSnapshot(
        initialized: false,
        playing: false,
        position: Duration.zero,
        duration: Duration.zero,
        speed: 1,
        error: '无法加载会议音频',
      );
      notifyListeners();
    }
  }

  Future<void> toggle() => _snapshot.playing ? _port.pause() : _port.play();

  Future<void> seek(Duration position) => _port.seek(position);

  Future<void> skip(Duration delta) => seek(_snapshot.position + delta);

  Future<void> setRate(double rate) => _port.setRate(rate);

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    unawaited(_port.close());
    super.dispose();
  }
}
