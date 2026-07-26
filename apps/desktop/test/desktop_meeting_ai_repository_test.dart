import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:meeting_core/meeting_core.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:processing_contracts/processing_contracts.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:voice2text_desktop/features/meeting_intelligence/desktop_meeting_ai_repository.dart';
import 'package:voice2text_desktop/features/meetings/data/desktop_meeting_workspace_repository.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_engine.dart';
import 'package:voice2text_desktop/features/processing/desktop_processing_repository.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  test(
    'unconsented generation creates no AI job and calls no provider',
    () async {
      final fixture = await _Fixture.open();
      addTearDown(fixture.dispose);
      final provider = _Provider();
      final repository = DesktopMeetingAiRepository(
        database: fixture.database,
        workflow: MeetingAiWorkflow(provider: provider),
        provider: provider,
      );

      await expectLater(
        repository.generate(fixture.request(MeetingAiConsent.denied)),
        throwsA(
          isA<MeetingAiFailure>().having(
            (failure) => failure.code,
            'code',
            MeetingAiFailureCode.consentRequired,
          ),
        ),
      );

      expect(provider.configurationReads, 0);
      expect(provider.generateCalls, 0);
      expect(
        await (await fixture.database.database).query(
          'meeting_intelligence_jobs',
        ),
        isEmpty,
      );
    },
  );

  test(
    'AI failure is persistent and never deletes audio or transcript',
    () async {
      final fixture = await _Fixture.open();
      addTearDown(fixture.dispose);
      final provider = _Provider(
        failure: const MeetingAiFailure(
          MeetingAiFailureCode.networkUnavailable,
          'offline',
        ),
      );
      final repository = DesktopMeetingAiRepository(
        database: fixture.database,
        workflow: MeetingAiWorkflow(provider: provider),
        provider: provider,
      );

      await expectLater(
        repository.generate(fixture.request(MeetingAiConsent.granted)),
        throwsA(isA<MeetingAiFailure>()),
      );

      final database = await fixture.database.database;
      final jobs = await database.query('meeting_intelligence_jobs');
      expect(jobs.single['status'], 'failed');
      expect(jobs.single['error_code'], 'networkUnavailable');
      expect(await database.query('recordings'), hasLength(1));
      expect(await database.query('transcript_segments'), hasLength(1));
      expect(await database.query('meeting_notes'), isEmpty);
    },
  );

  test(
    'successful AI note persists evidence and remains draft until review',
    () async {
      final fixture = await _Fixture.open();
      addTearDown(fixture.dispose);
      final segment = fixture.workspace.segments.single;
      final provider = _Provider(
        output: MeetingAiOutput(
          suggestedTitle: '发布会',
          meetingType: 'planning',
          insights: <MeetingAiInsight>[
            MeetingAiInsight(
              kind: 'decision',
              body: '下周发布',
              evidence: <MeetingAiEvidence>[
                MeetingAiEvidence(
                  segmentId: segment.id,
                  startMs: segment.startMs,
                  endMs: segment.endMs,
                ),
              ],
            ),
          ],
        ),
      );
      final repository = DesktopMeetingAiRepository(
        database: fixture.database,
        workflow: MeetingAiWorkflow(provider: provider),
        provider: provider,
      );

      final run = await repository.generate(
        fixture.request(MeetingAiConsent.granted),
      );
      final database = await fixture.database.database;
      final insights = await database.query('meeting_insights');
      expect(run.output.insights, hasLength(1));
      expect(insights.single['status'], 'draft');
      expect(await database.query('evidence_links'), hasLength(1));

      expect(
        await repository.reviewInsight(
          insightId: insights.single['id']! as int,
          body: '修订后发布',
          publish: true,
        ),
        isTrue,
      );
      expect(
        (await database.query('meeting_insights')).single['status'],
        'published',
      );
      expect(await database.query('meeting_note_revisions'), hasLength(1));
    },
  );
}

class _Fixture {
  const _Fixture({
    required this.root,
    required this.database,
    required this.workspace,
  });

  static Future<_Fixture> open() async {
    final root = await Directory.systemTemp.createTemp('meeting-ai-repo-test-');
    final databaseDirectory = Directory(p.join(root.path, 'database'));
    await databaseDirectory.create();
    final database = AppDatabase(
      factory: databaseFactoryFfi,
      databasePathProvider: () async => databaseDirectory.path,
      databaseName: 'ai-test.db',
    );
    final processing = DesktopProcessingRepository(database: database);
    await processing.commitImported(
      const MeetingMediaCandidate(
        path: '/private/imports/meeting.wav',
        displayName: '项目周会.wav',
        sizeBytes: 4096,
        durationMs: 2000,
        fingerprintSha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        duplicateAsset: false,
      ),
    );
    final job = (await processing.claimNext())!;
    await processing.completeWithResult(
      job,
      const DesktopProcessingResult(
        segments: <ProcessingTranscriptSegment>[
          ProcessingTranscriptSegment(
            startSeconds: 0,
            endSeconds: 2,
            text: '确认下周发布。',
            speakerAssignment: SpeakerAssignment.unknown,
          ),
        ],
        engineId: 'test',
        elapsedMilliseconds: 1,
        peakResidentBytes: 1,
        diarizationSucceeded: false,
        diarizationErrorCode: 'DIARIZATION_FAILED',
      ),
    );
    final workspace = (await DesktopMeetingWorkspaceRepository(
      database: database,
    ).openMeeting(job.recordingId))!;
    return _Fixture(root: root, database: database, workspace: workspace);
  }

  final Directory root;
  final AppDatabase database;
  final MeetingWorkspaceSnapshot workspace;

  MeetingAiRequest request(MeetingAiConsent consent) => MeetingAiRequest(
    recordingId: workspace.summary.recordingId,
    generationId: workspace.summary.generationId!,
    consent: consent,
    segments: workspace.segments,
    meetingTitle: workspace.summary.displayName,
  );

  Future<void> dispose() async {
    await (await database.database).close();
    await root.delete(recursive: true);
  }
}

class _Provider implements MeetingAiProviderPort {
  _Provider({
    this.output = const MeetingAiOutput(insights: <MeetingAiInsight>[]),
    this.failure,
  });

  final MeetingAiOutput output;
  final MeetingAiFailure? failure;
  int configurationReads = 0;
  int generateCalls = 0;

  @override
  String get modelId => 'test-model';
  @override
  String get providerId => 'deepseek';

  @override
  Future<bool> isConfigured() async {
    configurationReads += 1;
    return true;
  }

  @override
  Future<MeetingAiOutput> generate(MeetingAiRequest request) async {
    generateCalls += 1;
    if (failure case final failure?) throw failure;
    return output;
  }
}
