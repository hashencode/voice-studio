import '../../../data/sqlite/app_database.dart';
import '../../transcription/model/transcript_segment_entity.dart';
import '../model/meeting_time_range.dart';

class MeetingTranscriptQuery {
  const MeetingTranscriptQuery({
    this.text = '',
    this.timeRange,
    this.reviewState,
  });

  final String text;
  final MeetingTimeRange? timeRange;
  final TranscriptReviewState? reviewState;

  String get normalizedText => text.trim();
  bool get isEmpty =>
      normalizedText.isEmpty && timeRange == null && reviewState == null;

  @override
  bool operator ==(Object other) {
    return other is MeetingTranscriptQuery &&
        other.normalizedText == normalizedText &&
        other.timeRange == timeRange &&
        other.reviewState == reviewState;
  }

  @override
  int get hashCode => Object.hash(normalizedText, timeRange, reviewState);
}

class MeetingSearchService {
  MeetingSearchService({AppDatabase? database})
    : _database = database ?? AppDatabase.instance;

  final AppDatabase _database;

  Future<List<TranscriptSegmentEntity>> search({
    required int recordingId,
    required MeetingTranscriptQuery query,
    int limit = 200,
  }) async {
    if (query.isEmpty) return const <TranscriptSegmentEntity>[];
    if (limit <= 0) {
      throw ArgumentError.value(limit, 'limit', '搜索结果上限必须大于 0');
    }
    final db = await _database.database;
    final conditions = <String>['recording.id = ?'];
    final arguments = <Object>[recordingId];
    final normalizedText = query.normalizedText.toLowerCase();
    if (normalizedText.isNotEmpty) {
      final escaped = normalizedText
          .replaceAll(r'\', r'\\')
          .replaceAll('%', r'\%')
          .replaceAll('_', r'\_');
      conditions.add("lower(segment.text) LIKE ? ESCAPE '\\'");
      arguments.add('%$escaped%');
    }
    final timeRange = query.timeRange;
    if (timeRange != null) {
      conditions
        ..add('segment.start_ms < ?')
        ..add('segment.end_ms > ?');
      arguments
        ..add(timeRange.endMs)
        ..add(timeRange.startMs);
    }
    final reviewState = query.reviewState;
    if (reviewState != null) {
      conditions.add('segment.review_state = ?');
      arguments.add(reviewState.storageValue);
    }
    arguments.add(limit);
    final rows = await db.rawQuery('''
      SELECT segment.*
      FROM recordings AS recording
      JOIN transcript_segments AS segment
        ON segment.generation_id = recording.active_generation_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY segment.sequence_id ASC, segment.start_ms ASC, segment.id ASC
      LIMIT ?
      ''', arguments);
    return rows.map(TranscriptSegmentEntity.fromMap).toList(growable: false);
  }
}
