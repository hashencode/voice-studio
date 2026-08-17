import 'dart:async';

import 'package:companion_protocol/companion_protocol.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';
import 'package:permission_handler/permission_handler.dart';

import '../records/model/recording_entity.dart';
import 'repository/mobile_companion_repository.dart';
import 'service/android_companion_platform.dart';

class CompanionPage extends StatefulWidget {
  const CompanionPage({super.key, this.repository, this.platform});

  final MobileCompanionRepository? repository;
  final CompanionPlatformPort? platform;

  @override
  State<CompanionPage> createState() => _CompanionPageState();
}

class _CompanionPageState extends State<CompanionPage> {
  late final CompanionPlatformPort _platform;
  late final MobileCompanionRepository _repository;
  CompanionTransferCancellation? _cancellation;
  Timer? _discoveryTimer;
  bool _loading = true;
  bool _sending = false;
  double _progress = 0;
  String? _networkMessage;
  List<MobileCompanionPeer> _peers = const <MobileCompanionPeer>[];
  List<DiscoveredCompanionDesktop> _desktops =
      const <DiscoveredCompanionDesktop>[];
  List<RecordingEntity> _recordings = const <RecordingEntity>[];
  List<MobileCompanionHistory> _history = const <MobileCompanionHistory>[];

  @override
  void initState() {
    super.initState();
    _platform = widget.platform ?? const AndroidCompanionPlatform();
    _repository =
        widget.repository ?? MobileCompanionRepository(platform: _platform);
    unawaited(_load(requestPermission: true));
  }

  @override
  void dispose() {
    _discoveryTimer?.cancel();
    unawaited(_platform.stopDiscovery().catchError((_) {}));
    super.dispose();
  }

  Future<void> _load({bool requestPermission = false}) async {
    try {
      if (requestPermission) {
        final permission = await Permission.nearbyWifiDevices.request();
        if (!permission.isGranted) {
          throw PlatformException(code: 'LOCAL_NETWORK_PERMISSION_DENIED');
        }
      }
      await _platform.startDiscovery();
      _networkMessage = null;
      _discoveryTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => unawaited(_refreshDiscovery()),
      );
      await _refreshDiscovery();
    } on PlatformException catch (error) {
      _networkMessage = error.code == 'LOCAL_NETWORK_PERMISSION_DENIED'
          ? '未获准访问本地网络。录音、本机转写、复核、导出和普通文件导入仍可使用。'
          : '暂时无法发现桌面；可稍后重试，现有移动功能不受影响。';
    } catch (_) {
      _networkMessage = '当前网络无法发现桌面；现有移动功能不受影响。';
    }
    await _refreshData();
    if (!mounted) return;
    setState(() => _loading = false);
  }

  Future<void> _refreshDiscovery() async {
    try {
      final desktops = await _platform.listDiscoveredDesktops();
      if (!mounted) return;
      setState(() => _desktops = desktops);
    } catch (_) {
      // Discovery is auxiliary. Local recording and review remain available.
    }
  }

  Future<void> _refreshData() async {
    final values = await Future.wait<Object>(<Future<Object>>[
      _repository.listPeers(),
      _repository.listRecordings(),
      _repository.listHistory(),
    ]);
    if (!mounted) return;
    setState(() {
      _peers = values[0] as List<MobileCompanionPeer>;
      _recordings = values[1] as List<RecordingEntity>;
      _history = values[2] as List<MobileCompanionHistory>;
    });
  }

  Future<void> _pair() async {
    final payloadController = TextEditingController();
    final codeController = TextEditingController();
    try {
      await showGooDialog<void>(
        context: context,
        builder: (_) => GooDialog.custom(
          title: '配对 Mac',
          description: '在 Mac 生成两分钟有效的邀请，扫描二维码后核对双方显示的六位短码。',
          actions: <GooDialogAction>[
            const GooDialogAction(label: '取消'),
            GooDialogAction(
              label: '确认配对',
              style: GooDialogActionStyle.primary,
              onPressed: () async {
                await _repository.acceptPairingInvite(
                  encodedPayload: payloadController.text.trim(),
                  confirmedShortCode: codeController.text.trim(),
                );
                await _refreshData();
              },
            ),
          ],
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              GooInput(
                controller: payloadController,
                label: '二维码内容',
                placeholder: '扫描或粘贴 Mac 上的配对邀请',
                autocorrect: false,
                enableSuggestions: false,
              ),
              const SizedBox(height: 12),
              GooInput(
                controller: codeController,
                label: '六位短码',
                placeholder: '确认两端显示一致',
                keyboardType: TextInputType.number,
                maxLength: 6,
                autocorrect: false,
                enableSuggestions: false,
              ),
            ],
          ),
        ),
      );
    } on CompanionProtocolException catch (error) {
      if (mounted) GooToastScope.of(context).error(_message(error.code));
    } finally {
      payloadController.dispose();
      codeController.dispose();
    }
  }

  Future<void> _send(RecordingEntity recording) async {
    final available =
        <({MobileCompanionPeer peer, DiscoveredCompanionDesktop desktop})>[];
    for (final peer in _peers) {
      for (final desktop in _desktops) {
        if (desktop.deviceId == peer.deviceId &&
            desktop.fingerprint == peer.fingerprint) {
          available.add((peer: peer, desktop: desktop));
        }
      }
    }
    if (available.isEmpty) {
      GooToastScope.of(context).error('没有在线且身份匹配的已配对 Mac');
      return;
    }
    final selected = await showGooDialog<int>(
      context: context,
      builder: (_) => GooDialog.confirmation(
        title: '发送到已配对 Mac',
        description: '原始录音会加密分块传输；桌面完整校验并签发 receipt 后，手机仍默认保留原件。',
        actions: <GooDialogAction>[
          const GooDialogAction(label: '取消'),
          for (var index = 0; index < available.length; index++)
            GooDialogAction(
              label: available[index].peer.displayName,
              result: index,
              style: GooDialogActionStyle.primary,
            ),
        ],
      ),
    );
    if (selected == null || !mounted) return;
    setState(() {
      _sending = true;
      _progress = 0;
      _cancellation = CompanionTransferCancellation();
    });
    try {
      final choice = available[selected];
      final receipt = await _repository.sendRecording(
        recordingId: recording.id,
        peer: choice.peer,
        desktop: choice.desktop,
        cancellation: _cancellation,
        onProgress: (sent, total) {
          if (!mounted) return;
          setState(() => _progress = sent / total);
        },
      );
      await _refreshData();
      if (!mounted) return;
      GooToastScope.of(
        context,
      ).success('已由 ${receipt.desktopDeviceName} 接收并确认，手机原件仍保留');
    } on CompanionProtocolException catch (error) {
      if (mounted) GooToastScope.of(context).error(_message(error.code));
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
          _progress = 0;
          _cancellation = null;
        });
      }
    }
  }

  Future<void> _reviewReceipt(MobileCompanionHistory history) async {
    final receipt = history.receipt;
    if (receipt == null) return;
    final action = await showGooDialog<String>(
      context: context,
      builder: (_) => GooDialog.custom(
        title: '桌面接收凭证',
        description:
            '${receipt.desktopDeviceName}\n'
            'SHA-256 ${receipt.wholeFileSha256}\n'
            '${receipt.sizeBytes} bytes · desktop recording ${receipt.desktopRecordingId}',
        actions: const <GooDialogAction>[
          GooDialogAction(label: '继续保留', result: 'retain'),
          GooDialogAction(label: '稍后清理', result: 'defer'),
          GooDialogAction(
            label: '从手机永久删除',
            result: 'delete',
            tone: GooDialogActionTone.destructive,
          ),
        ],
        child: const GooText(
          '永久删除只在 receipt 已验证后可用，会删除手机上的音频原件和本地派生数据。',
          variant: GooTextVariant.body,
        ),
      ),
    );
    if (action == 'defer') {
      await _repository.deferCleanup(history.transferId);
    } else if (action == 'delete' && mounted) {
      final confirmed = await showGooDialog<bool>(
        context: context,
        builder: (_) => GooDialog.confirmation(
          title: '永久删除手机原件？',
          description: '此操作不可撤销；桌面 receipt 和桌面音频不受影响。',
          actions: const <GooDialogAction>[
            GooDialogAction(label: '取消', result: false),
            GooDialogAction(
              label: '永久删除',
              result: true,
              tone: GooDialogActionTone.destructive,
            ),
          ],
        ),
      );
      if (confirmed == true) {
        await _repository.deleteSourceAfterReceipt(history);
      }
    }
    await _refreshData();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const GooAppBar.secondary(title: '发送到 Mac'),
      body: _loading
          ? const Center(child: GooSpinner(semanticLabel: '正在读取配对与传输状态'))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
              children: <Widget>[
                if (_networkMessage != null)
                  GooResult(
                    title: '局域网暂不可用',
                    description: _networkMessage!,
                    buttonLabel: '重新发现',
                    onButtonPressed: () => _load(requestPermission: true),
                  ),
                Row(
                  children: <Widget>[
                    const Expanded(
                      child: GooText('已配对桌面', variant: GooTextVariant.subtitle),
                    ),
                    GooButton(
                      variant: GooButtonVariant.secondary,
                      onPressed: _pair,
                      child: const Text('配对新 Mac'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                if (_peers.isEmpty)
                  const GooList(
                    style: GooListStyle.grouped,
                    children: <Widget>[
                      GooListItem(
                        title: '尚未配对',
                        subtitle: '在 Mac 上生成邀请，核对身份与六位短码后配对',
                      ),
                    ],
                  )
                else
                  GooList(
                    style: GooListStyle.grouped,
                    children: _peers
                        .map(
                          (peer) => GooListItem(
                            title: peer.displayName,
                            subtitle:
                                '${_desktops.any((item) => item.deviceId == peer.deviceId) ? '在线' : '离线'}'
                                ' · ${peer.fingerprint}',
                          ),
                        )
                        .toList(growable: false),
                  ),
                const SizedBox(height: 20),
                const GooText('手机音频', variant: GooTextVariant.subtitle),
                const SizedBox(height: 8),
                if (_sending) ...<Widget>[
                  LinearProgressIndicator(value: _progress),
                  const SizedBox(height: 8),
                  GooButton(
                    variant: GooButtonVariant.secondary,
                    onPressed: _cancellation?.cancel,
                    child: const Text('取消传输'),
                  ),
                  const SizedBox(height: 8),
                ],
                GooList(
                  style: GooListStyle.grouped,
                  children: _recordings.isEmpty
                      ? const <Widget>[
                          GooListItem(
                            title: '没有可发送的音频',
                            subtitle: '录音和本地导入仍可照常使用',
                          ),
                        ]
                      : _recordings
                            .map(
                              (recording) => GooListItem(
                                title: recording.displayName ?? '未命名音频',
                                subtitle:
                                    '${Duration(milliseconds: recording.durationMs).inMinutes} 分钟'
                                    ' · 点击选择已配对桌面',
                                showGuide: true,
                                disabled: _sending,
                                onTap: _sending ? null : () => _send(recording),
                              ),
                            )
                            .toList(growable: false),
                ),
                const SizedBox(height: 20),
                const GooText(
                  '传输历史与 receipt',
                  variant: GooTextVariant.subtitle,
                ),
                const SizedBox(height: 8),
                GooList(
                  style: GooListStyle.grouped,
                  children: _history.isEmpty
                      ? const <Widget>[
                          GooListItem(
                            title: '暂无传输历史',
                            subtitle: '完成后可在这里复核哈希、桌面 recording ID 和原件状态',
                          ),
                        ]
                      : _history
                            .map(
                              (item) => GooListItem(
                                title: item.displayName,
                                subtitle:
                                    '${item.state} · ${item.cleanupState}'
                                    '${item.receipt == null ? '' : ' · ${item.receipt!.desktopDeviceName}'}',
                                showGuide: item.receipt != null,
                                onTap: item.receipt == null
                                    ? null
                                    : () => _reviewReceipt(item),
                              ),
                            )
                            .toList(growable: false),
                ),
              ],
            ),
    );
  }
}

String _message(String code) => switch (code) {
  'PAIRING_EXPIRED' => '配对邀请已过期，请在 Mac 上重新生成',
  'PAIRING_CODE_MISMATCH' => '六位短码不一致，未建立配对',
  'PEER_KEY_CHANGED' => '桌面身份密钥已变化，必须重新配对',
  'PAIRING_REPAIR_REQUIRED' => '配对凭据不可用，请解除后重新配对',
  'INSUFFICIENT_DISK_SPACE' => 'Mac 空间不足，未提交音频，手机原件仍保留',
  'TRANSFER_CANCELED' => '传输已取消，手机原件仍保留',
  'CONNECTION_CLOSED' => '网络中断；下次只会续传缺失分块',
  _ => '传输未完成（$code），手机原件仍保留',
};
