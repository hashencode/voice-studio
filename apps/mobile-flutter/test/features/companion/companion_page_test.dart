import 'package:companion_protocol/companion_protocol.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:voice2text_flutter/features/companion/companion_page.dart';
import 'package:voice2text_flutter/features/companion/repository/mobile_companion_repository.dart';
import 'package:voice2text_flutter/features/companion/service/android_companion_platform.dart';
import 'package:voice2text_flutter/features/records/model/recording_entity.dart';

void main() {
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('flutter.baseflow.com/permissions/methods'),
          (call) async => <int, int>{
            for (final id in call.arguments as List<dynamic>) id as int: 1,
          },
        );
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('flutter.baseflow.com/permissions/methods'),
          null,
        );
  });

  testWidgets(
    'history translates transfer and source states including unknown values',
    (tester) async {
      final transfers = <String, String>{
        'pending': '等待发送',
        'transferring': '发送中',
        'paused': '已暂停',
        'verifying': '正在校验',
        'committed': 'Mac 已接收',
        'failed': '发送失败',
        'canceled': '已取消',
        'future_state': '状态暂不可用',
      };
      final cleanup = <String, String>{
        'retained': '手机原件保留',
        'deferred': '稍后清理',
        'deleted': '手机原件已删除',
        'not_applicable': '',
        'future_cleanup': '原件状态暂不可用',
      };
      for (final transfer in transfers.entries) {
        for (final source in cleanup.entries) {
          await _pumpPage(
            tester,
            _Repository(<MobileCompanionHistory>[
              _history(transfer.key, source.key),
            ]),
          );
          expect(
            find.text(
              <String>[
                transfer.value,
                if (source.value.isNotEmpty) source.value,
              ].join(' · '),
            ),
            findsOneWidget,
          );
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
        }
      }
    },
  );

  testWidgets(
    'receipt details remain readable on a narrow screen with large text and canceling deletion preserves source',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = _Repository(<MobileCompanionHistory>[
        _history('committed', 'retained', receipt: _receipt),
      ]);
      await _pumpPage(
        tester,
        repository,
        textScaler: const TextScaler.linear(2),
      );
      await tester.tap(find.text('录音样本'));
      await tester.pumpAndSettle();
      expect(find.text(_receipt.desktopDeviceName), findsOneWidget);
      expect(find.textContaining('1.0 MB'), findsOneWidget);
      expect(find.textContaining('接收时间：'), findsOneWidget);
      expect(find.textContaining(_receipt.wholeFileSha256), findsNothing);
      expect(find.text('Mac 录音编号：42'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.text('核验详情'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('核验详情'));
      await tester.pumpAndSettle();
      expect(find.textContaining(_receipt.wholeFileSha256), findsOneWidget);
      expect(find.text('Mac 录音编号：42'), findsOneWidget);
      await tester.ensureVisible(find.textContaining(_receipt.wholeFileSha256));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Mac 录音编号：42'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('从手机永久删除'));
      await tester.pumpAndSettle();
      expect(repository.deleted, isEmpty);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(repository.deleted, isEmpty);
      await tester.tap(find.text('录音样本'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('从手机永久删除'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('永久删除'));
      await tester.pumpAndSettle();
      expect(repository.deleted, <String>['transfer-1']);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    },
  );
}

Future<void> _pumpPage(
  WidgetTester tester,
  _Repository repository, {
  TextScaler? textScaler,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      builder: textScaler == null
          ? null
          : (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: textScaler),
              child: child!,
            ),
      home: GooToastScope(
        child: CompanionPage(
          key: UniqueKey(),
          repository: repository,
          platform: _Platform(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

MobileCompanionHistory _history(
  String state,
  String cleanup, {
  CompanionReceipt? receipt,
}) => MobileCompanionHistory(
  transferId: 'transfer-1',
  recordingId: 1,
  displayName: '录音样本',
  hash: '0' * 64,
  sizeBytes: 1048576,
  state: state,
  cleanupState: cleanup,
  createdAtMs: 1750000000000,
  receipt: receipt,
);

final _receipt = CompanionReceipt(
  receiptId: 'receipt-1',
  transferId: 'transfer-1',
  wholeFileSha256: 'a' * 64,
  sizeBytes: 1048576,
  desktopDeviceId: 'desktop-1',
  desktopDeviceName: 'Studio Mac',
  desktopRecordingId: 42,
  committedAtMs: 1750000000000,
  signature: 'signature',
);

class _Repository extends MobileCompanionRepository {
  _Repository(this.history);
  final List<MobileCompanionHistory> history;
  final List<String> deleted = <String>[];
  @override
  Future<List<MobileCompanionPeer>> listPeers() async =>
      <MobileCompanionPeer>[];
  @override
  Future<List<RecordingEntity>> listRecordings() async => <RecordingEntity>[];
  @override
  Future<List<MobileCompanionHistory>> listHistory() async => history;
  @override
  Future<void> deleteSourceAfterReceipt(MobileCompanionHistory history) async {
    deleted.add(history.transferId);
  }
}

class _Platform implements CompanionPlatformPort {
  @override
  Future<void> startDiscovery() async {}
  @override
  Future<void> stopDiscovery() async {}
  @override
  Future<List<DiscoveredCompanionDesktop>> listDiscoveredDesktops() async =>
      <DiscoveredCompanionDesktop>[];
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
