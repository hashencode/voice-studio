import 'package:flutter/material.dart';
import 'package:flutter_ui_mobile/flutter_ui_mobile.dart';

import 'desktop_capture_controller.dart';
import 'desktop_capture_models.dart';
import 'desktop_capture_view_model.dart';
import 'widgets/capture_status_row.dart';

class DesktopCapturePreflightPage extends StatelessWidget {
  const DesktopCapturePreflightPage({
    super.key,
    required this.controller,
    required this.model,
  });

  final DesktopCaptureUiController controller;
  final DesktopCaptureViewModel model;

  @override
  Widget build(BuildContext context) {
    final preflight = model.preflight;
    final microphoneOnly =
        preflight?.captureMode == DesktopCaptureMode.microphoneOnly;
    return Column(
      children: <Widget>[
        GooAppBar.primary(
          title: '开始电脑会议',
          subtitle: microphoneOnly
              ? '兼容模式只录制所选麦克风；不录制屏幕画面'
              : '录制系统音频与所选麦克风；不录制屏幕画面',
          pageLoadingMode: model.phase == DesktopCapturePhase.checking
              ? GooPageLoadingMode.recycle
              : null,
          pageLoadingAnimated:
              model.phase == DesktopCapturePhase.checking &&
              !MediaQuery.disableAnimationsOf(context),
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 840),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 48),
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      GooButton.text(
                        iconName: GooIcons.arrowBack,
                        onPressed: controller.reset,
                        child: const GooText('返回会议资料库'),
                      ),
                      const Spacer(),
                      GooButton.text(
                        iconName: GooIcons.refresh,
                        onPressed: () => controller.preflight(),
                        child: const GooText('重新检查'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  if (preflight == null)
                    const GooCard(
                      fillWidth: true,
                      child: Center(child: GooInlineLoader()),
                    )
                  else ...[
                    if (microphoneOnly) ...[
                      const GooCard(
                        fillWidth: true,
                        variant: GooCardVariant.filled,
                        child: GooText(
                          '兼容模式：当前 macOS 可继续录制麦克风，但不会录到电脑播放的声音。'
                          '升级到 macOS 14.2 或更高版本可启用系统音频双轨录制。',
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],
                    const GooText('录音条件', variant: GooTextVariant.heading),
                    const SizedBox(height: 10),
                    GooList(
                      children: <Widget>[
                        CaptureStatusRow(
                          title: '系统音频',
                          description: microphoneOnly
                              ? '当前系统不支持；本次不会录制电脑播放声音。'
                                    '最低需要 macOS ${preflight.systemAudioMinimumMacosVersion}'
                              : '使用 Core Audio 私有进程 tap；权限在开始时由系统校验',
                          available: !microphoneOnly,
                          iconName: GooIcons.audio,
                          trailing: microphoneOnly
                              ? const GooTag(
                                  label: '未启用',
                                  accent: GooTagAccent.neutral,
                                  variant: GooTagVariant.capsule,
                                )
                              : null,
                        ),
                        CaptureStatusRow(
                          title: '麦克风权限',
                          description: _permissionLabel(
                            preflight.microphonePermission,
                          ),
                          available:
                              preflight.microphonePermission ==
                              DesktopCapturePermissionState.granted,
                          iconName: GooIcons.microphone,
                        ),
                        CaptureStatusRow(
                          title: '可用磁盘',
                          description:
                              '${_gib(preflight.availableBytes)} GiB 可用，'
                              '至少需要 ${_gib(preflight.requiredBytes)} GiB',
                          available:
                              preflight.availableBytes >=
                              preflight.requiredBytes,
                          iconName: GooIcons.folder,
                        ),
                        CaptureStatusRow(
                          title: '实时草稿',
                          description: model.captionAvailable
                              ? '使用 U18 保留的 SenseVoice control；草稿始终标记为可能变化'
                              : '模型未安装或系统版本不支持；只禁用实时草稿，录音仍可使用',
                          available: model.captionAvailable,
                          iconName: GooIcons.audioFiles,
                          trailing: GooSwitch(
                            value:
                                model.captionEnabled && model.captionAvailable,
                            onChanged: model.captionAvailable
                                ? controller.setCaptionEnabled
                                : null,
                            semanticLabel: '启用实时草稿',
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),
                    const GooText('选择麦克风', variant: GooTextVariant.heading),
                    const SizedBox(height: 10),
                    GooList(
                      children: preflight.microphones
                          .map(
                            (device) => GooListItem(
                              title: device.name,
                              subtitle: device.isDefault
                                  ? '当前系统默认输入'
                                  : '可用于本次会议',
                              leadingIconName: GooIcons.microphone,
                              trailing: model.selectedMicrophoneId == device.id
                                  ? const GooTag(
                                      label: '已选择',
                                      accent: GooTagAccent.green,
                                      variant: GooTagVariant.capsule,
                                    )
                                  : null,
                              onTap: () =>
                                  controller.selectMicrophone(device.id),
                            ),
                          )
                          .toList(growable: false),
                    ),
                    if (model.error != null) ...[
                      const SizedBox(height: 16),
                      GooCard(
                        fillWidth: true,
                        variant: GooCardVariant.filled,
                        child: GooText(model.error!),
                      ),
                    ],
                    const SizedBox(height: 24),
                    Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 12,
                      runSpacing: 12,
                      children: <Widget>[
                        GooButton(
                          variant: GooButtonVariant.secondary,
                          onPressed: () =>
                              controller.preflight(requestPermissions: true),
                          child: const GooText('检查并请求权限'),
                        ),
                        GooButton(
                          key: const ValueKey('capture_start_button'),
                          iconName: GooIcons.phoneRecord,
                          onPressed: model.canStart ? controller.start : null,
                          autofocus: model.canStart,
                          semanticLabel: microphoneOnly
                              ? '开始仅麦克风电脑会议录音'
                              : '开始电脑会议双轨录音',
                          child: GooText(microphoneOnly ? '开始仅麦克风录音' : '开始录音'),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  static String _permissionLabel(DesktopCapturePermissionState state) {
    return switch (state) {
      DesktopCapturePermissionState.granted => '已允许使用所选麦克风',
      DesktopCapturePermissionState.notDetermined => '尚未请求；点击下方按钮授权',
      DesktopCapturePermissionState.denied => '已拒绝；请在系统设置的隐私与安全性中允许',
      DesktopCapturePermissionState.restricted => '此 Mac 的策略限制了麦克风',
      DesktopCapturePermissionState.revoked => '权限已撤销；录音前需要重新允许',
      DesktopCapturePermissionState.unavailable => '当前系统不可用',
    };
  }

  static String _gib(int bytes) => (bytes / (1024 * 1024 * 1024))
      .toStringAsFixed(bytes < 10 * 1024 * 1024 * 1024 ? 1 : 0);
}
