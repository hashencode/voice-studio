import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:meeting_storage/meeting_storage.dart';
import 'package:meeting_workflows/meeting_workflows.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:processing_contracts/processing_contracts.dart';

import '../features/companion/desktop_companion_credential_store.dart';
import '../features/companion/desktop_companion_platform.dart';
import '../features/companion/desktop_companion_repository.dart';
import '../features/companion/desktop_companion_service.dart';
import '../features/importing/desktop_import_service.dart';
import '../features/importing/macos_native_import_transfer_port.dart';
import '../features/lifecycle/desktop_data_lifecycle_manager.dart';
import '../features/meeting_intelligence/deepseek_desktop_provider.dart';
import '../features/meeting_intelligence/desktop_meeting_ai_repository.dart';
import '../features/meetings/data/desktop_meeting_workspace_repository.dart';
import '../features/meetings/playback/desktop_meeting_playback.dart';
import '../features/processing/desktop_processing_engine.dart';
import '../features/processing/desktop_processing_repository.dart';
import '../features/processing/frozen_sherpa_model_manager.dart';
import '../features/processing/native_sherpa_worker_engine.dart';
import '../features/security/desktop_disk_encryption.dart';
import '../features/secrets/desktop_secret_store.dart';
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
    );
    final installed = await modelManager.inspect(manifest);

    final contents = File(Platform.resolvedExecutable).parent.parent;
    final processingResources = Directory(
      p.join(contents.path, 'Resources', 'Processing'),
    );
    final runtimeRoot = p.join(contents.path, 'Frameworks');
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

    final installedEngine = installed == null
        ? null
        : engineForModels(installed.models);
    final engine = installedEngine?.isAvailable == true
        ? installedEngine!
        : UnavailableDesktopProcessingEngine(
            nativeRuntimeLoaded: File(
              p.join(runtimeRoot, 'libsherpa-onnx-c-api.dylib'),
            ).existsSync(),
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
    final provider = DeepSeekDesktopMeetingAiProvider(secretStore: secretStore);
    final aiRepository = DesktopMeetingAiRepository(
      database: database,
      workflow: MeetingAiWorkflow(provider: provider),
      provider: provider,
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
      secretStore: secretStore,
      companionService: companionService,
      playback: DesktopMeetingPlaybackController(
        port: MediaKitDesktopPlaybackPort(),
      ),
      initialModelStatus: installedEngine?.isAvailable == true
          ? ModelAssetInstallStatus.installed
          : ModelAssetInstallStatus.notInstalled,
      diskEncryptionStatus: diskEncryptionStatus,
    );
  }
}
