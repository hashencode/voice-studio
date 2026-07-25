import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../records/repository/recordings_repository.dart';
import '../../recording/model/recording_annotation_entity.dart';
import '../../recording/repository/recording_annotations_repository.dart';
import '../../transcription/model/transcript_revision_entity.dart';
import '../../transcription/model/transcript_segment_entity.dart';
import '../../transcription/repository/transcript_generations_repository.dart';
import '../../transcription/repository/transcript_revisions_repository.dart';
import '../../transcription/repository/transcript_segments_repository.dart';
import '../../transcription/repository/transcription_jobs_repository.dart';
import '../model/meeting_record.dart';
import '../service/meeting_playback_service.dart';
import '../service/meeting_search_service.dart';

class MeetingReviewController extends ChangeNotifier {
  MeetingReviewController({
    required this.recordingId,
    RecordingsRepository? recordingsRepository,
    TranscriptGenerationsRepository? generationsRepository,
    TranscriptSegmentsRepository? segmentsRepository,
    TranscriptionJobsRepository? jobsRepository,
    TranscriptRevisionsRepository? revisionsRepository,
    RecordingAnnotationsRepository? annotationsRepository,
    MeetingSearchService? searchService,
    MeetingPlaybackService? playbackService,
  }) : _recordingsRepository = recordingsRepository ?? RecordingsRepository(),
       _generationsRepository =
           generationsRepository ?? TranscriptGenerationsRepository(),
       _segmentsRepository =
           segmentsRepository ?? TranscriptSegmentsRepository(),
       _jobsRepository = jobsRepository ?? TranscriptionJobsRepository(),
       _revisionsRepository =
           revisionsRepository ?? TranscriptRevisionsRepository(),
       _annotationsRepository =
           annotationsRepository ?? RecordingAnnotationsRepository(),
       _searchService = searchService ?? MeetingSearchService(),
       playback = playbackService ?? MeetingPlaybackService();

  final int recordingId;
  final RecordingsRepository _recordingsRepository;
  final TranscriptGenerationsRepository _generationsRepository;
  final TranscriptSegmentsRepository _segmentsRepository;
  final TranscriptionJobsRepository _jobsRepository;
  final TranscriptRevisionsRepository _revisionsRepository;
  final RecordingAnnotationsRepository _annotationsRepository;
  final MeetingSearchService _searchService;
  final MeetingPlaybackService playback;

  MeetingRecord? _meeting;
  bool _loading = false;
  String? _error;
  int? _currentSegmentIndex;
  List<TranscriptSegmentEntity> _searchResults =
      const <TranscriptSegmentEntity>[];
  MeetingTranscriptQuery _searchQuery = const MeetingTranscriptQuery();
  bool _searching = false;
  int _searchEpoch = 0;
  bool _autoFollow = true;
  bool _canUndo = false;
  bool _canRedo = false;
  int _transcriptRefreshEpoch = 0;
  bool _playbackListenerAttached = false;

  MeetingRecord? get meeting => _meeting;
  bool get loading => _loading;
  String? get error => _error;
  int? get currentSegmentIndex => _currentSegmentIndex;
  List<TranscriptSegmentEntity> get searchResults => _searchResults;
  MeetingTranscriptQuery get searchQuery => _searchQuery;
  bool get searching => _searching;
  bool get autoFollow => _autoFollow;
  bool get canUndo => _canUndo;
  bool get canRedo => _canRedo;

  Future<void> load() async {
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final recording = await _recordingsRepository.findById(recordingId);
      if (recording == null || recording.deletedAtMs != null) {
        _error = '会议记录不存在或已删除';
        return;
      }
      final generation = await _generationsRepository.findActiveForRecording(
        recordingId,
      );
      final segments = generation == null
          ? const <TranscriptSegmentEntity>[]
          : await _segmentsRepository.listForGeneration(generation.id);
      await _refreshHistoryState(generation?.id);
      final job = await _jobsRepository.findLatestByRecordingPath(
        recording.filePath,
      );
      final annotations = await _annotationsRepository.listForRecording(
        recordingId,
      );
      _meeting = MeetingRecord(
        recording: recording,
        generation: generation,
        segments: segments,
        latestJob: job,
        annotations: annotations,
      );
      if (!_playbackListenerAttached) {
        playback.addListener(_handlePlaybackChanged);
        _playbackListenerAttached = true;
      }
      await playback.load(recording.filePath);
    } catch (_) {
      _error = '会议工作区加载失败';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> reloadTranscript() async {
    final current = _meeting;
    if (current == null) return;
    final refreshEpoch = ++_transcriptRefreshEpoch;
    final generation = await _generationsRepository.findActiveForRecording(
      recordingId,
    );
    final segments = generation == null
        ? const <TranscriptSegmentEntity>[]
        : await _segmentsRepository.listForGeneration(generation.id);
    final canUndo = generation == null
        ? false
        : await _revisionsRepository.canUndo(generation.id);
    final canRedo = generation == null
        ? false
        : await _revisionsRepository.canRedo(generation.id);
    if (refreshEpoch != _transcriptRefreshEpoch) return;
    _canUndo = canUndo;
    _canRedo = canRedo;
    _meeting = MeetingRecord(
      recording: current.recording,
      generation: generation,
      segments: segments,
      latestJob: current.latestJob,
      annotations: current.annotations,
    );
    _updateCurrentSegment();
    notifyListeners();
    if (!_searchQuery.isEmpty) {
      unawaited(search(_searchQuery));
    }
  }

  Future<TranscriptRevisionEntity?> saveSegment({
    required int segmentId,
    required String text,
    bool markReviewed = false,
  }) async {
    final revision = await _revisionsRepository.saveEdit(
      segmentId: segmentId,
      text: text,
      markReviewed: markReviewed,
    );
    if (revision != null || markReviewed) await reloadTranscript();
    return revision;
  }

  Future<bool> undoLastEdit() async {
    final generation = _meeting?.generation;
    if (generation == null) return false;
    final revision = await _revisionsRepository.undoLastForGeneration(
      generation.id,
    );
    if (revision == null) return false;
    await reloadTranscript();
    return true;
  }

  Future<bool> redoLastEdit() async {
    final generation = _meeting?.generation;
    if (generation == null) return false;
    final revision = await _revisionsRepository.redoLastForGeneration(
      generation.id,
    );
    if (revision == null) return false;
    await reloadTranscript();
    return true;
  }

  Future<bool> updateReviewState({
    required int segmentId,
    int? generationId,
    required TranscriptReviewState state,
  }) async {
    final activeGenerationId = _meeting?.generation?.id;
    final targetGenerationId = generationId ?? activeGenerationId;
    if (activeGenerationId == null ||
        targetGenerationId != activeGenerationId) {
      return false;
    }
    final updated = await _segmentsRepository.updateReviewState(
      segmentId: segmentId,
      generationId: targetGenerationId,
      state: state,
    );
    if (!updated) return false;
    await reloadTranscript();
    return true;
  }

  Future<void> search(MeetingTranscriptQuery query) async {
    if (query.isEmpty) {
      clearSearch();
      return;
    }
    final searchEpoch = ++_searchEpoch;
    _searchQuery = query;
    _searching = true;
    notifyListeners();
    try {
      final results = await _searchService.search(
        recordingId: recordingId,
        query: query,
      );
      if (searchEpoch != _searchEpoch) return;
      _searchResults = results;
      _searching = false;
      notifyListeners();
    } catch (_) {
      if (searchEpoch != _searchEpoch) return;
      _searchResults = const <TranscriptSegmentEntity>[];
      _searching = false;
      notifyListeners();
    }
  }

  void clearSearch() {
    _searchEpoch += 1;
    _searchQuery = const MeetingTranscriptQuery();
    _searchResults = const <TranscriptSegmentEntity>[];
    _searching = false;
    notifyListeners();
  }

  Future<void> seekToSegment(TranscriptSegmentEntity segment) async {
    await playback.seekTo(Duration(milliseconds: segment.startMs));
    _autoFollow = true;
    _updateCurrentSegment();
    notifyListeners();
  }

  Future<void> seekToAnnotation(RecordingAnnotationEntity annotation) async {
    await playback.seekTo(Duration(milliseconds: annotation.positionMs));
    _autoFollow = true;
    _updateCurrentSegment();
    notifyListeners();
  }

  void suspendAutoFollow() {
    if (!_autoFollow) return;
    _autoFollow = false;
    notifyListeners();
  }

  void resumeAutoFollow() {
    if (_autoFollow) return;
    _autoFollow = true;
    notifyListeners();
  }

  void _handlePlaybackChanged() {
    _updateCurrentSegment();
    notifyListeners();
  }

  void _updateCurrentSegment() {
    _currentSegmentIndex = indexForPosition(
      _meeting?.segments ?? const <TranscriptSegmentEntity>[],
      playback.snapshot.position.inMilliseconds,
    );
  }

  Future<void> _refreshHistoryState(int? generationId) async {
    if (generationId == null) {
      _canUndo = false;
      _canRedo = false;
      return;
    }
    _canUndo = await _revisionsRepository.canUndo(generationId);
    _canRedo = await _revisionsRepository.canRedo(generationId);
  }

  @visibleForTesting
  static int? indexForPosition(
    List<TranscriptSegmentEntity> segments,
    int positionMs,
  ) {
    var low = 0;
    var high = segments.length - 1;
    while (low <= high) {
      final middle = low + ((high - low) >> 1);
      final segment = segments[middle];
      if (positionMs < segment.startMs) {
        high = middle - 1;
      } else if (positionMs >= segment.endMs) {
        low = middle + 1;
      } else {
        return middle;
      }
    }
    return null;
  }

  @override
  void dispose() {
    if (_playbackListenerAttached) {
      playback.removeListener(_handlePlaybackChanged);
    }
    playback.dispose();
    super.dispose();
  }
}
