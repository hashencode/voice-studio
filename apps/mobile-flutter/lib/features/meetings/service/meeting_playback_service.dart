import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:video_player/video_player.dart';

class MeetingPlaybackSnapshot {
  const MeetingPlaybackSnapshot({
    required this.initialized,
    required this.playing,
    required this.position,
    required this.duration,
    required this.speed,
    this.error,
  });

  const MeetingPlaybackSnapshot.idle()
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

abstract interface class MeetingPlaybackBackend {
  MeetingPlaybackSnapshot get snapshot;
  void addListener(VoidCallback listener);
  void removeListener(VoidCallback listener);
  Future<void> initialize(String path);
  Future<void> play();
  Future<void> pause();
  Future<void> seekTo(Duration position);
  Future<void> setSpeed(double speed);
  Future<void> dispose();
}

class VideoPlayerMeetingPlaybackBackend implements MeetingPlaybackBackend {
  VideoPlayerController? _controller;
  String? _error;

  @override
  MeetingPlaybackSnapshot get snapshot {
    final controller = _controller;
    if (controller == null) {
      return MeetingPlaybackSnapshot(
        initialized: false,
        playing: false,
        position: Duration.zero,
        duration: Duration.zero,
        speed: 1,
        error: _error,
      );
    }
    final value = controller.value;
    return MeetingPlaybackSnapshot(
      initialized: value.isInitialized,
      playing: value.isPlaying,
      position: value.position,
      duration: value.duration,
      speed: value.playbackSpeed,
      error: value.hasError ? value.errorDescription : _error,
    );
  }

  @override
  void addListener(VoidCallback listener) => _controller?.addListener(listener);

  @override
  Future<void> initialize(String path) async {
    final file = File(path);
    if (!await file.exists()) {
      throw StateError('音频文件不存在');
    }
    final controller = VideoPlayerController.file(file);
    _controller = controller;
    try {
      await controller.initialize();
    } catch (error) {
      _error = '无法加载音频';
      rethrow;
    }
  }

  @override
  Future<void> pause() async => _controller?.pause();

  @override
  Future<void> play() async => _controller?.play();

  @override
  void removeListener(VoidCallback listener) {
    _controller?.removeListener(listener);
  }

  @override
  Future<void> seekTo(Duration position) async {
    final controller = _controller;
    if (controller == null) return;
    final bounded = position < Duration.zero
        ? Duration.zero
        : position > controller.value.duration
        ? controller.value.duration
        : position;
    await controller.seekTo(bounded);
  }

  @override
  Future<void> setSpeed(double speed) async {
    await _controller?.setPlaybackSpeed(speed.clamp(0.5, 2));
  }

  @override
  Future<void> dispose() async {
    await _controller?.dispose();
    _controller = null;
  }
}

class MeetingPlaybackService extends ChangeNotifier {
  MeetingPlaybackService({MeetingPlaybackBackend? backend})
    : _backend = backend ?? VideoPlayerMeetingPlaybackBackend();

  final MeetingPlaybackBackend _backend;
  MeetingPlaybackSnapshot _snapshot = const MeetingPlaybackSnapshot.idle();
  bool _disposed = false;

  MeetingPlaybackSnapshot get snapshot => _snapshot;

  Future<void> load(String path) async {
    try {
      await _backend.initialize(path);
      _backend.addListener(_sync);
      _sync();
    } catch (_) {
      _snapshot = const MeetingPlaybackSnapshot(
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

  Future<void> toggle() =>
      _snapshot.playing ? _backend.pause() : _backend.play();

  Future<void> seekTo(Duration position) => _backend.seekTo(position);

  Future<void> skip(Duration delta) => seekTo(_snapshot.position + delta);

  Future<void> setSpeed(double speed) => _backend.setSpeed(speed);

  void _sync() {
    if (_disposed) return;
    _snapshot = _backend.snapshot;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _backend.removeListener(_sync);
    unawaited(_backend.dispose());
    super.dispose();
  }
}
