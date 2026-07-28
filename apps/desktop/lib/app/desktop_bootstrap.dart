import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:crypto/crypto.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:processing_contracts/processing_contracts.dart';

import '../features/companion/desktop_companion_credential_store.dart';
import '../features/companion/desktop_companion_platform.dart';
import '../features/companion/desktop_companion_repository.dart';
import '../features/companion/desktop_companion_service.dart';
import '../features/captions/desktop_live_caption_service.dart';
import '../features/captions/live_caption_repository.dart';
import '../features/captions/live_caption_worker_client.dart';
import '../features/capture/desktop_capture_controller.dart';
import '../features/capture/desktop_capture_port.dart';
import '../features/capture/desktop_capture_recovery.dart';
import '../features/capture/desktop_capture_service.dart';
import '../features/capture/desktop_capture_workspace.dart';
import '../features/importing/desktop_import_service.dart';
import '../features/importing/macos_native_import_transfer_port.dart';
import '../features/lifecycle/desktop_data_lifecycle_manager.dart';
import '../features/meeting_intelligence/desktop_ai_provider_registry.dart';
import '../features/meeting_intelligence/desktop_meeting_ai_repository.dart';
import '../features/meetings/data/desktop_meeting_workspace_repository.dart';
import '../features/meetings/playback/desktop_meeting_playback.dart';
import '../features/processing/desktop_processing_engine.dart';
import '../features/processing/desktop_processing_repository.dart';
import '../features/processing/frozen_sherpa_model_manager.dart';
import '../features/processing/native_sherpa_worker_engine.dart';
import '../features/platform/macos_runtime_capabilities.dart';
import '../features/security/desktop_disk_encryption.dart';
import '../features/secrets/desktop_secret_store.dart';
import '../features/settings/desktop_ai_provider_settings_repository.dart';
import 'desktop_home_controller.dart';

class DesktopBootstrap {
  const DesktopBootstrap._();

  static Future<DesktopHomeController> createHomeController() async {
    final database = await const DesktopDatabaseFactory().create();
    final processingRepository = DesktopProcessingRepository(
      database: database,
    );
    await processingRepository.reconcileInterruptedJobs();

    final support = await getApplicationSupportDirectory();
    final importRoot = Directory(p.join(support.path, 'meetings', 'imports'));
    final modelRoot = Directory(p.join(support.path, 'processing', 'models'));
    final manifest = FrozenSherpaManifest.fromJson(
      (jsonDecode(
                await rootBundle.loadString(
                  'assets/processing/frozen_sherpa_macos_arm64.json',
                ),
              )
              as Map)
          .cast<String, Object?>(),
    );
    final modelManager = FrozenSherpaModelManager(
      root: modelRoot,
      fetcher: const HttpsFrozenSherpaFetcher(),
      capacityProbe: const MacosFrozenSherpaCapacityProbe(),
      allowDevelopmentAssets: !kReleaseMode,
    );
    final runtimeCapabilities = MacosRuntimeCapabilities.current();
    final installed = await modelManager.inspect(manifest);

    final contents = File(Platform.resolvedExecutable).parent.parent;
    final processingResources = Directory(
      p.join(contents.path, 'Resources', 'Processing'),
    );
    final runtimeRoot = p.join(contents.path, 'Frameworks');
    final senseVoiceManifest = FrozenSenseVoiceManifest.fromJson(
      (jsonDecode(
                await rootBundle.loadString(
                  'assets/processing/frozen_sensevoice_macos_arm64.json',
                ),
              )
              as Map)
          .cast<String, Object?>(),
    );
    final senseVoiceAssets = await _resolveSenseVoiceAssets(
      manifest: senseVoiceManifest,
      support: support,
      processingResources: processingResources,
      runtimeRoot: runtimeRoot,
    );
    final captureRepository = DesktopCaptureRepository(database);
    final captureWorkspace = DesktopCaptureWorkspace(
      Directory(p.join(support.path, 'meetings', 'capture-sessions')),
    );
    final captureRecovery = DesktopCaptureRecovery(
      repository: captureRepository,
      workspace: captureWorkspace,
    );
    final captureService = DesktopCaptureService(
      port: MacosDesktopCapturePort(),
      repository: captureRepository,
      workspace: captureWorkspace,
      recovery: captureRecovery,
    );
    final liveCaptions = senseVoiceAssets == null
        ? null
        : DesktopLiveCaptionService(
            repository: LiveCaptionRepository(database: database),
            workerFactory: senseVoiceAssets.worker,
          );
    final captureController = DesktopCaptureController(
      captureService: captureService,
      formalTranscription: processingRepository,
      liveCaptions: liveCaptions,
      captionModelSha256: senseVoiceAssets?.modelSha256,
    );
    NativeSherpaWorkerEngine engineForModels(models) =>
        NativeSherpaWorkerEngine(
          NativeSherpaWorkerConfiguration(
            launcherPath: p.join(
              processingResources.path,
              'native_process_group_launcher',
            ),
            workerPath: p.join(
              processingResources.path,
              'desktop_sherpa_worker',
            ),
            runtimeRoot: runtimeRoot,
            importRoot: importRoot.path,
            models: models,
          ),
        );

    final installedEngine =
        installed == null || !runtimeCapabilities.supportsLocalProcessing
        ? null
        : engineForModels(installed.models);
    final engine = installedEngine?.isAvailable == true
        ? installedEngine!
        : UnavailableDesktopProcessingEngine(
            nativeRuntimeLoaded: File(
              p.join(runtimeRoot, 'libsherpa-onnx-c-api.dylib'),
            ).existsSync(),
            minimumMacosVersionRequired:
                runtimeCapabilities.supportsLocalProcessing
                ? null
                : macosLocalProcessingMinimumVersion.toString(),
          );
    final coordinator = DesktopProcessingCoordinator(
      repository: processingRepository,
      engine: engine,
    );
    final importService = DesktopImportService(
      transferPort: const MacosNativeImportTransferPort(),
      repository: processingRepository,
      importRootProvider: () async => importRoot,
    );

    final workspaceService = MeetingWorkspaceService(
      port: DesktopMeetingWorkspaceRepository(database: database),
    );
    const secretStore = KeychainDesktopSecretStore();
    final aiSettingsRepository = DesktopAiProviderSettingsRepository(
      database: database,
    );
    final aiProviderRegistry = DesktopAiProviderRegistry(
      secretStore: secretStore,
    );
    final aiRepository = DesktopMeetingAiRepository.withProviderResolver(
      database: database,
      providerResolver: () async {
        return aiProviderRegistry.resolve(await aiSettingsRepository.load());
      },
    );
    await aiRepository.reconcileInterrupted();
    final companionRepository = DesktopCompanionRepository(
      database: database,
      credentialStore: const DesktopCompanionCredentialStore(),
    );
    final transferRoot = Directory(
      p.join(support.path, 'companion', 'incoming-transfers'),
    );
    await DesktopDataLifecycleManager(
      importStagingRoot: Directory(p.join(importRoot.path, 'staging')),
      sidecarWorkspaceRoot: Directory(
        p.join(support.path, 'processing', 'jobs'),
      ),
      ephemeralShareRoot: Directory(
        p.join(support.path, 'sharing', 'ephemeral'),
      ),
      companionTransferRoot: transferRoot,
      loadStaleCompanionTransfers: (cutoffMs) =>
          companionRepository.unfinishedTransfers(updatedBeforeMs: cutoffMs),
      expireCompanionTransfer: companionRepository.expireTransfer,
    ).cleanup();
    final companionService = DesktopCompanionService(
      repository: companionRepository,
      importService: importService,
      processingRepository: processingRepository,
      transferRoot: transferRoot,
      discovery: const MacosCompanionDiscoveryPort(),
    );
    final diskEncryptionStatus = await const MacosFileVaultStatusPort()
        .status();

    return DesktopHomeController(
      importService: importService,
      repository: processingRepository,
      processingCoordinator: coordinator,
      workspaceService: workspaceService,
      modelManager: modelManager,
      modelManifest: manifest,
      engineFactory: engineForModels,
      aiRepository: aiRepository,
      aiProviderRegistry: aiProviderRegistry,
      secretStore: secretStore,
      aiSettingsRepository: aiSettingsRepository,
      captureController: captureController,
      companionService: companionService,
      playback: DesktopMeetingPlaybackController(
        port: MediaKitDesktopPlaybackPort(),
      ),
      initialModelStatus: installedEngine?.isAvailable == true
          ? ModelAssetInstallStatus.installed
          : ModelAssetInstallStatus.notInstalled,
      diskEncryptionStatus: diskEncryptionStatus,
      runtimeCapabilities: runtimeCapabilities,
    );
  }

  static Future<_SenseVoiceAssets?> _resolveSenseVoiceAssets({
    required FrozenSenseVoiceManifest manifest,
    required Directory support,
    required Directory processingResources,
    required String runtimeRoot,
  }) async {
    if (!manifest.exposesDevelopmentCapability) return null;
    final configuredRoot = !kReleaseMode
        ? Platform.environment['VOICE2TEXT_SENSEVOICE_MODEL_ROOT']
        : null;
    final modelRoot = Directory(
      configuredRoot ??
          p.join(support.path, 'processing', 'models', manifest.setId),
    );
    final model = File(
      p.join(modelRoot.path, manifest.model['modelRelativePath']! as String),
    );
    final tokens = File(
      p.join(modelRoot.path, manifest.model['tokensRelativePath']! as String),
    );
    final configuredVad = !kReleaseMode
        ? Platform.environment['VOICE2TEXT_SENSEVOICE_VAD']
        : null;
    final vad = File(
      configuredVad ?? p.join(modelRoot.path, 'silero_vad.onnx'),
    );
    final worker = File(
      p.join(processingResources.path, 'desktop_sensevoice_caption_worker'),
    );
    if (!await model.exists() ||
        !await tokens.exists() ||
        !await vad.exists() ||
        !await worker.exists() ||
        !await _hashMatches(model, manifest.model['modelSha256']! as String) ||
        !await _hashMatches(
          tokens,
          manifest.model['tokensSha256']! as String,
        ) ||
        !await _hashMatches(vad, manifest.vad['sha256']! as String)) {
      return null;
    }
    return _SenseVoiceAssets(
      executable: worker.path,
      runtimeRoot: runtimeRoot,
      modelRoot: modelRoot.path,
      modelPath: model.path,
      modelSha256: manifest.model['modelSha256']! as String,
      tokensPath: tokens.path,
      tokensSha256: manifest.model['tokensSha256']! as String,
      vadPath: vad.path,
      vadSha256: manifest.vad['sha256']! as String,
    );
  }

  static Future<bool> _hashMatches(File file, String expected) async {
    return (await sha256.bind(file.openRead()).first).toString() == expected;
  }
}

class _SenseVoiceAssets {
  const _SenseVoiceAssets({
    required this.executable,
    required this.runtimeRoot,
    required this.modelRoot,
    required this.modelPath,
    required this.modelSha256,
    required this.tokensPath,
    required this.tokensSha256,
    required this.vadPath,
    required this.vadSha256,
  });

  final String executable;
  final String runtimeRoot;
  final String modelRoot;
  final String modelPath;
  final String modelSha256;
  final String tokensPath;
  final String tokensSha256;
  final String vadPath;
  final String vadSha256;

  LiveCaptionWorkerPort worker(String sessionRoot) {
    final control = jsonEncode(<String, Object?>{
      'provider': 'cpu',
      'threads': 2,
      'concurrency': 1,
      'decodingMethod': 'greedy_search',
      'language': 'auto',
      'useInverseTextNormalization': false,
      'recognizerLifecycle': 'resident_preloaded',
      'vadThreshold': 0.5,
      'minimumSpeechSeconds': 0.25,
      'minimumSilenceSeconds': 0.5,
      'maximumUtteranceSeconds': 15.0,
      'publishesTokenPartials': false,
      'publishesCompletedUtterancesOnly': true,
    });
    return LiveCaptionWorkerClient(
      configuration: LiveCaptionWorkerConfiguration(
        executable: executable,
        sessionRoot: sessionRoot,
        modelSha256: modelSha256,
        arguments: <String>[
          '--control-json=$control',
          '--fixture-root=$sessionRoot',
          '--model=$modelPath',
          '--model-root=$modelRoot',
          '--tokens=$tokensPath',
          '--vad=$vadPath',
          '--asset-root=${p.dirname(vadPath)}',
          '--runtime-root=$runtimeRoot',
          '--model-sha256=$modelSha256',
          '--tokens-sha256=$tokensSha256',
          '--vad-sha256=$vadSha256',
        ],
      ),
    );
  }
}
