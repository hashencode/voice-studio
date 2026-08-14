import path from "node:path";
import { writeFile, rename, rm } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { app, BrowserWindow, dialog, session } from "electron";

import {
  desktopProtocolVersion,
  type BootstrapAction,
  type ImportMeetingResponse,
  type OperationEvent,
} from "../shared/contracts";
import { DesktopApplicationState } from "./application/application_state";
import {
  buildProcessingSmokeEvidence,
  parseProcessingSmokeReferenceBindings,
  type ProcessingSmokeReferenceBindings,
} from "./application/processing_smoke_evidence";
import { runPrimaryInstance } from "./application/single_instance";
import { registerDesktopIpc } from "./ipc";
import { canceledResponse, queuedResponse } from "./ipc/desktop_ipc";
import { DesktopDomainService } from "./domain/desktop_domain_service";
import { SecureImportDomainService } from "./domain/importing/secure_import_domain_service";
import {
  cleanupExpiredOrphanedImportedMedia,
  cleanupExpiredTemporaryWorkspaces,
} from "./domain/processing/temporary_workspace_cleanup";
import { resolveMacOSNativeHelper } from "./features/importing/helper_locator";
import { MacOSNativeHelperClient } from "./features/importing/macos_native_helper_client";
import {
  DurableProcessCoordinator,
  ProcessCanceledError,
} from "./processes/durable_process_coordinator";
import {
  adaptExistingAsrWorkerFrame,
  finalizeExistingSherpaResult,
} from "./processes/existing_asr_worker_adapter";
import {
  OwnedProcessSupervisor,
  ProcessDeadlineError,
  WorkerReportedError,
} from "./processes/owned_process_supervisor";
import { prepareProcessingAttempt } from "./processes/processing_attempt";
import { initializeElectronProfile } from "./profile/electron_profile";
import type { ElectronProfilePaths } from "./profile/electron_profile";
import {
  ResourceCatalog,
  requireProcessingPipelineIdentities,
  resolveResourceRoot,
} from "./resources/resource_catalog";
import { secureWebPreferences } from "./security";
import { sha256File } from "./security/sha256_file";
import { DesktopRepository } from "./storage/desktop_repository";
import { WorkerHealthSupervisor } from "./worker_health";

const processingSmokeRequest = readProcessingSmokeRequest();
if (processingSmokeRequest) {
  const smokeUserData = path.join(
    processingSmokeRequest.appDataPath,
    "electron-user-data",
  );
  mkdirSync(smokeUserData, { recursive: true, mode: 0o700 });
  app.setPath("appData", processingSmokeRequest.appDataPath);
  app.setPath("userData", smokeUserData);
}
const isPrimaryInstance = runPrimaryInstance(app, () => app.enableSandbox());

interface ProcessingSmokeRequest {
  appDataPath: string;
  outputPath: string;
  sourcePath: string;
  referenceBindings: ProcessingSmokeReferenceBindings;
}

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let workerSupervisor: WorkerHealthSupervisor | null = null;
let processCoordinator: DurableProcessCoordinator | null = null;
let profileDatabase: DatabaseSync | null = null;
let profilePaths: ElectronProfilePaths | null = null;
let domainService: DesktopDomainService | null = null;
let desktopRepository: DesktopRepository | null = null;
let resourceCatalog: ResourceCatalog | null = null;
let teardownPromise: Promise<void> | null = null;
let teardownComplete = false;
let bootstrapPromise: Promise<void> | null = null;
let processingLoop: Promise<void> | null = null;
const applicationState = new DesktopApplicationState();
const operationListeners = new Set<(event: OperationEvent) => void>();

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: "Voice2Text",
    webPreferences: secureWebPreferences(path.join(__dirname, "preload.js")),
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && !isTrustedNavigation(currentUrl, targetUrl)) {
      event.preventDefault();
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  return window;
}

function isTrustedNavigation(current: string, target: string): boolean {
  const currentUrl = new URL(current);
  const targetUrl = new URL(target);
  if (currentUrl.protocol === "file:" || targetUrl.protocol === "file:") {
    return currentUrl.href === targetUrl.href;
  }
  return currentUrl.origin === targetUrl.origin;
}

function configureSessionSecurity(): void {
  const currentSession = session.defaultSession;
  currentSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSource = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? ` 'self' ${new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin} ws://localhost:*`
      : " 'self'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src${connectSource}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });
}

async function runBootstrapSmokeIfRequested(): Promise<void> {
  const outputPath = process.env.VOICE2TEXT_BOOTSTRAP_SMOKE_OUTPUT;
  if (!outputPath || !workerSupervisor) return;
  const worker = await workerSupervisor.check();
  const receipt = {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    worker,
  };
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, outputPath);
  app.quit();
}

function readProcessingSmokeRequest(): ProcessingSmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_PROCESSING_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_OUTPUT,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_SOURCE,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_REFERENCE_BINDINGS,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged processing smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw, sourceRaw, bindingsRaw] = values as [
    string,
    string,
    string,
    string,
  ];
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  const sourcePath = realpathSync(path.resolve(sourceRaw));
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    lstatSync(sourcePath).isSymbolicLink() ||
    !lstatSync(sourcePath).isFile() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent)
  ) {
    throw new Error("packaged processing smoke paths are not private");
  }
  return {
    appDataPath,
    outputPath,
    sourcePath,
    referenceBindings: parseProcessingSmokeReferenceBindings(bindingsRaw),
  };
}

async function runProcessingSmokeIfRequested(): Promise<void> {
  const request = processingSmokeRequest;
  if (!request) return;
  if (!profileDatabase || !desktopRepository || !resourceCatalog) {
    throw new Error("packaged processing smoke authority is unavailable");
  }
  const sourceSha256 = await sha256File(request.sourcePath);
  if (sourceSha256 !== request.referenceBindings.fixtureSha256) {
    throw new Error("packaged processing smoke fixture hash mismatch");
  }
  const imported = await importMeetingFromSource(request.sourcePath, {
    minimumFreeBytes: 0,
    destinationId: "meeting-packaged-smoke",
  });
  if (!imported.inserted || imported.attempt !== 0) {
    throw new Error("packaged processing smoke profile was not independent");
  }
  const activeLoop = processingLoop;
  if (!activeLoop) {
    throw new Error("packaged processing smoke queue did not start");
  }
  await activeLoop;
  const task = desktopRepository
    .listProcessingTasks()
    .find((candidate) => candidate.id === imported.jobId);
  if (!task || task.state !== "completed") {
    throw new Error(
      `packaged processing smoke did not complete: ${task?.state ?? "missing"}`,
    );
  }
  const meeting = profileDatabase
    .prepare(
      `SELECT meetings.display_name, meetings.duration_ms,
        media_authorities.normalized_path, media_authorities.source_sha256,
        media_authorities.content_sha256, media_authorities.size_bytes
      FROM meetings
      JOIN media_authorities ON media_authorities.id = meetings.media_authority_id
      WHERE meetings.id = ?`,
    )
    .get(imported.meetingId);
  const job = profileDatabase
    .prepare(
      `SELECT operation_id, resource_identity, state, attempt, error_code,
        phase, protocol_identity, source_sha256, model_sha256, runtime_sha256,
        progress_fraction
      FROM processing_jobs WHERE id = ?`,
    )
    .get(imported.jobId);
  const publication = profileDatabase
    .prepare(
      `SELECT operation_id, attempt, payload_json, phase, protocol_identity,
        source_sha256, model_sha256, runtime_sha256
      FROM result_publications WHERE job_id = ?`,
    )
    .get(imported.jobId);
  if (!meeting || !job || !publication) {
    throw new Error("packaged processing smoke durable projection is missing");
  }
  const resultPayload = JSON.parse(String(publication.payload_json)) as unknown;
  if (!resultPayload || typeof resultPayload !== "object") {
    throw new Error("packaged processing smoke result payload is invalid");
  }
  const pipeline = requireProcessingPipelineIdentities(resourceCatalog);
  const normalizedSha256 = await sha256File(String(meeting.normalized_path));
  if (normalizedSha256 !== String(meeting.content_sha256)) {
    throw new Error("packaged processing smoke normalized media changed");
  }
  const evidence = buildProcessingSmokeEvidence({
    referenceBindings: request.referenceBindings,
    resource: {
      manifestSha256: resourceCatalog.identity,
      modelSha256: pipeline.diarization.modelSha256,
      runtimeSha256: pipeline.diarization.runtimeSha256,
    },
    media: {
      sourceSha256: String(meeting.source_sha256),
      normalizedSha256,
      normalizedSizeBytes: Number(meeting.size_bytes),
      durationMs: Number(meeting.duration_ms),
    },
    databaseProjection: {
      meeting: {
        displayName: String(meeting.display_name),
        durationMs: Number(meeting.duration_ms),
      },
      job: {
        operationId: String(job.operation_id),
        resourceIdentity: String(job.resource_identity),
        state: String(job.state),
        attempt: Number(job.attempt),
        errorCode: job.error_code === null ? null : String(job.error_code),
        phase: String(job.phase),
        protocolIdentity: String(job.protocol_identity),
        sourceSha256: String(job.source_sha256),
        modelSha256: String(job.model_sha256),
        runtimeSha256: String(job.runtime_sha256),
        progressFraction: Number(job.progress_fraction),
      },
      publication: {
        operationId: String(publication.operation_id),
        attempt: Number(publication.attempt),
        phase: String(publication.phase),
        protocolIdentity: String(publication.protocol_identity),
        sourceSha256: String(publication.source_sha256),
        modelSha256: String(publication.model_sha256),
        runtimeSha256: String(publication.runtime_sha256),
      },
    },
    resultPayload: resultPayload as Record<string, unknown>,
    state: task.state,
    phase: task.phase,
    attempt: task.attempt,
    progressFraction: task.progressFraction,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new Error("packaged processing smoke evidence is too large");
  }
  const temporaryPath = `${request.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, request.outputPath);
  app.quit();
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function bindDesktopIpc(window: BrowserWindow): void {
  unregisterIpc?.();
  unregisterIpc = registerDesktopIpc(window, {
    applicationSnapshot: () => applicationState.snapshot(),
    navigate: (section) => applicationState.navigate(section),
    requestBootstrapAction: async (action) =>
      await requestBootstrapAction(action),
    onApplicationSnapshot: (listener) => applicationState.subscribe(listener),
    onOperationEvent: (listener) => {
      operationListeners.add(listener);
      return () => operationListeners.delete(listener);
    },
    workerHealth: async () => {
      if (!workerSupervisor)
        throw new Error("worker capability is unavailable");
      return await workerSupervisor.check();
    },
    cancelProcessing: async (jobId) => {
      if (!processCoordinator || !(await processCoordinator.cancel(jobId))) {
        throw new Error("processing job is not running or canceling");
      }
      const canceled = domainService
        ?.listProcessingTasks()
        .find((task) => task.id === jobId && task.state === "canceled");
      if (!canceled) {
        throw new Error("durable canceled processing state is unavailable");
      }
      emitOperation({ jobId, state: "canceled", attempt: canceled.attempt });
      return canceledResponse(jobId);
    },
    retryProcessing: async (jobId, expectedAttempt) => {
      const pipeline = resourceCatalog?.processingPipelineIdentities();
      if (
        !pipeline ||
        !domainService?.retryInterruptedJob(jobId, expectedAttempt, {
          operationId: "asr",
          phase: "asr",
          ...pipeline.asr,
        })
      ) {
        throw new Error(
          "processing resources are incomplete or the job is not interrupted at the expected attempt",
        );
      }
      const queued = domainService
        .listProcessingTasks()
        .find((task) => task.id === jobId && task.state === "queued");
      if (!queued) {
        throw new Error("durable queued processing state is unavailable");
      }
      emitOperation({ jobId, state: "queued", attempt: queued.attempt });
      scheduleProcessing();
      return queuedResponse(jobId);
    },
    listProcessingTasks: async () => domainService?.listProcessingTasks() ?? [],
    importMeeting: async () => await chooseAndImportMeeting(),
  });
}

async function chooseAndImportMeeting(): Promise<ImportMeetingResponse> {
  if (!mainWindow || !profilePaths || !domainService || !desktopRepository) {
    throw new Error("Electron profile is not ready for import");
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "安全导入会议",
    properties: ["openFile"],
    filters: [
      {
        name: "可归一化的会议音视频",
        extensions: [
          "wav",
          "aiff",
          "aif",
          "caf",
          "mp3",
          "aac",
          "m4a",
          "mov",
          "mp4",
        ],
      },
    ],
  });
  if (selection.canceled || selection.filePaths.length !== 1) {
    return { protocolVersion: desktopProtocolVersion, state: "canceled" };
  }
  const result = await importMeetingFromSource(selection.filePaths[0]!, {
    minimumFreeBytes: 2 * 1024 * 1024 * 1024,
  });
  return {
    protocolVersion: desktopProtocolVersion,
    state: result.state,
    meetingId: result.meetingId,
    jobId: result.jobId,
    mediaSha256: result.mediaSha256,
    inserted: result.inserted,
    progressFraction: result.progressFraction,
  };
}

async function importMeetingFromSource(
  sourcePath: string,
  options: { minimumFreeBytes: number; destinationId?: string },
) {
  if (!profilePaths || !domainService || !desktopRepository) {
    throw new Error("Electron profile is not ready for import");
  }
  const pipeline = requireProcessingPipelineIdentities(resourceCatalog);
  const destinationRoot = profilePaths.mediaDirectory;
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath)) {
    throw new Error("macOS 安全导入 helper 不可用");
  }
  const helper = new MacOSNativeHelperClient(helperPath);
  const nativeSession = await helper.openSession({
    exactSourcePaths: [sourcePath],
    destinationRoots: [destinationRoot],
  });
  try {
    const receipt = await nativeSession.secureImport({
      sourcePath,
      destinationRoot,
      destinationId:
        options.destinationId ??
        `meeting-${Date.now()}-${randomBytes(12).toString("hex")}`,
      maxSourceBytes: 4 * 1024 * 1024 * 1024,
      minimumFreeBytes: options.minimumFreeBytes,
      temporaryStorageMultiplier: 3,
      maxDurationMs: 4 * 60 * 60 * 1_000,
    });
    const importing = new SecureImportDomainService(domainService, {
      discard: async (committedPath) =>
        await nativeSession.discard(committedPath, destinationRoot),
    });
    const result = await importing.commitValidatedImport({
      displayName: path.basename(sourcePath),
      receipt,
      processing: { operationId: "asr", ...pipeline.asr },
    });
    applicationState.setLibraryCount(desktopRepository.countMeetings());
    emitOperation({
      jobId: result.jobId,
      state: result.state,
      attempt: result.attempt,
      phase: "asr",
      progressFraction: result.progressFraction,
    });
    if (result.state === "queued") scheduleProcessing();
    return result;
  } finally {
    await nativeSession.close();
  }
}

async function requestBootstrapAction(action: BootstrapAction) {
  if (action === "repair-guidance") return applicationState.snapshot();
  await bootstrapApplication();
  return applicationState.snapshot();
}

async function bootstrapApplication(): Promise<void> {
  if (bootstrapPromise) return await bootstrapPromise;
  if (profileDatabase) return;
  bootstrapPromise = initializeApplication();
  try {
    await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
}

async function initializeApplication(): Promise<void> {
  applicationState.beginBootstrap();
  const profile = initializeElectronProfile(
    processingSmokeRequest?.appDataPath ?? app.getPath("appData"),
  );
  applicationState.completeBootstrap(profile);
  if (profile.status === "blocked") {
    console.error(
      JSON.stringify({
        event: "electron-profile-initialization-blocked",
        code: profile.code,
        message: profile.message,
        repairable: profile.repairable,
      }),
    );
    return;
  }
  profileDatabase = profile.database;
  profilePaths = profile.profile;
  desktopRepository = new DesktopRepository(profile.database, profile.profile);
  domainService = new DesktopDomainService(desktopRepository);
  applicationState.setLibraryCount(desktopRepository.countMeetings());
  const attemptsRoot = path.join(
    profile.profile.workspaceDirectory,
    "attempts",
  );
  mkdirSync(attemptsRoot, { recursive: true, mode: 0o700 });
  cleanupExpiredTemporaryWorkspaces(attemptsRoot);
  const processSupervisor = new OwnedProcessSupervisor({
    workspaceRoot: profile.profile.workspaceDirectory,
  });
  processCoordinator = new DurableProcessCoordinator(processSupervisor, {
    requestCancellation: async (jobId) =>
      domainService!.requestProcessingCancellation(jobId),
    completeCancellation: async (intent) => {
      if (!domainService!.completeProcessingCancellation(intent)) {
        throw new Error(
          "durable cancellation completion lost its attempt fence",
        );
      }
    },
    publishResult: async (intent, payload) => {
      domainService!.publishProcessingResult({
        ...intent,
        complete: true,
        payload,
      });
    },
    recordProgress: async (intent, progress) => {
      domainService!.recordProcessingProgress(intent, {
        phase: progress.phase,
        fraction: progress.fraction,
      });
      emitOperation({
        jobId: intent.jobId,
        state: "running",
        attempt: intent.attempt,
        phase: progress.phase,
        progressFraction: progress.fraction,
      });
    },
  });
  try {
    resourceCatalog = await ResourceCatalog.load(
      resolveResourceRoot({
        appRoot: app.getAppPath(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    );
    workerSupervisor = new WorkerHealthSupervisor(
      resourceCatalog.command("worker-health"),
    );
    applicationState.setProcessingCapability(
      resourceCatalog.processingPipelineIdentities()
        ? undefined
        : "本地 ASR 模型资源尚未安装，无法创建处理任务",
    );
    await cleanupNativeImportArtifacts(profile.profile, desktopRepository);
    if (processingSmokeRequest) {
      await runProcessingSmokeIfRequested();
    } else {
      scheduleProcessing();
    }
  } catch (error) {
    applicationState.setProcessingCapability(
      error instanceof Error ? error.message : "本地处理运行时不可用",
    );
    if (processingSmokeRequest) throw error;
  }
  if (!processingSmokeRequest) await runBootstrapSmokeIfRequested();
}

if (isPrimaryInstance) {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  void app
    .whenReady()
    .then(async () => {
      configureSessionSecurity();
      mainWindow = createMainWindow();
      bindDesktopIpc(mainWindow);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await bootstrapApplication();
    })
    .catch(async (error: unknown) => {
      console.error("Voice2Text bootstrap failed", error);
      teardownPromise ??= teardownOwnedResources();
      await teardownPromise.catch(() => undefined);
      teardownComplete = true;
      app.exit(1);
    });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (teardownPromise) return;
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      bindDesktopIpc(mainWindow);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (teardownComplete) return;
    event.preventDefault();
    teardownPromise ??= teardownOwnedResources()
      .then(() => {
        teardownComplete = true;
        app.quit();
      })
      .catch((error: unknown) => {
        teardownPromise = null;
        console.error(
          "Voice2Text process teardown failed; quit was stopped",
          error,
        );
      });
  });
}

async function teardownOwnedResources(): Promise<void> {
  unregisterIpc?.();
  unregisterIpc = null;
  await processCoordinator?.shutdown();
  await processingLoop?.catch(() => undefined);
  processingLoop = null;
  processCoordinator = null;
  await workerSupervisor?.shutdown();
  workerSupervisor = null;
  profileDatabase?.close();
  profileDatabase = null;
  profilePaths = null;
  domainService = null;
  desktopRepository = null;
  resourceCatalog = null;
}

function emitOperation(event: Omit<OperationEvent, "protocolVersion">): void {
  const value: OperationEvent = {
    protocolVersion: desktopProtocolVersion,
    ...event,
  };
  for (const listener of operationListeners) listener(value);
}

function scheduleProcessing(): void {
  if (processingLoop) return;
  processingLoop = drainProcessingQueue()
    .catch((error: unknown) => {
      console.error("Voice2Text processing queue failed", error);
    })
    .finally(() => {
      processingLoop = null;
    });
}

async function drainProcessingQueue(): Promise<void> {
  while (
    !teardownPromise &&
    domainService &&
    desktopRepository &&
    profilePaths &&
    resourceCatalog &&
    processCoordinator &&
    resourceCatalog.processingPipelineIdentities()
  ) {
    const service = domainService;
    const repository = desktopRepository;
    const profile = profilePaths;
    const catalog = resourceCatalog;
    const coordinator = processCoordinator;
    const pipeline = catalog.processingPipelineIdentities();
    if (!pipeline) return;
    const intent = service.claimNextProcessingJob({
      sourceIdentity: `worker-${randomBytes(16).toString("hex")}`,
      deadlineAtMs: Date.now() + 29 * 60 * 1_000,
    });
    if (!intent) return;
    let activeIntent = intent;
    const sourcePath = repository.sourcePathForJob(intent.jobId);
    const attemptDirectory = path.join(
      profile.workspaceDirectory,
      "attempts",
      `${intent.jobId}-${intent.attempt}`,
    );
    if (
      !prepareProcessingAttempt({
        intent,
        attemptDirectory,
        interrupt: (claimedIntent, errorCode) =>
          service.interruptProcessingAttempt(claimedIntent, errorCode),
        emitInterrupted: () =>
          emitOperation({
            jobId: intent.jobId,
            state: "interrupted",
            attempt: intent.attempt,
            phase: intent.phase,
          }),
      })
    ) {
      continue;
    }
    emitOperation({
      jobId: intent.jobId,
      state: "running",
      attempt: intent.attempt,
      phase: intent.phase,
      progressFraction: 0,
    });
    try {
      if (!sourcePath)
        throw new Error("processing job has no authoritative media path");
      const startedAtMs = Date.now();
      const asrPayload = await coordinator.runPhase({
        intent,
        command: catalog.command("asr", {
          runtimeRoot: path.join(catalog.root, "runtime"),
          attemptOutput: attemptDirectory,
        }),
        attemptOutputDirectory: attemptDirectory,
        inputFrame: {
          schemaVersion: 1,
          sourcePath,
          sourceSha256: intent.sourceSha256,
        },
        frameAdapter: adaptExistingAsrWorkerFrame,
      });
      activeIntent = service.advanceProcessingPhase(intent, {
        operationId: "diarization",
        phase: "diarization",
        ...pipeline.diarization,
      });
      emitOperation({
        jobId: activeIntent.jobId,
        state: "running",
        attempt: activeIntent.attempt,
        phase: activeIntent.phase,
        progressFraction: 0.45,
      });
      let diarizationPayload: Record<string, unknown> | null = null;
      let diarizationErrorCode: "DIARIZATION_FAILED" | null = null;
      try {
        diarizationPayload = await coordinator.runPhase({
          intent: activeIntent,
          command: catalog.command("diarization", {
            runtimeRoot: path.join(catalog.root, "runtime"),
            attemptOutput: attemptDirectory,
          }),
          attemptOutputDirectory: attemptDirectory,
          inputFrame: {
            schemaVersion: 1,
            sourcePath,
            sourceSha256: activeIntent.sourceSha256,
          },
          frameAdapter: adaptExistingAsrWorkerFrame,
        });
      } catch (error) {
        if (error instanceof WorkerReportedError) {
          diarizationErrorCode = "DIARIZATION_FAILED";
        } else {
          throw error;
        }
      }
      service.publishProcessingResult({
        ...activeIntent,
        complete: true,
        payload: finalizeExistingSherpaResult(
          asrPayload,
          diarizationPayload,
          diarizationErrorCode,
          Date.now() - startedAtMs,
        ),
      });
      emitOperation({
        jobId: activeIntent.jobId,
        state: "completed",
        attempt: activeIntent.attempt,
        phase: activeIntent.phase,
        progressFraction: 1,
      });
    } catch (error) {
      if (!(error instanceof ProcessCanceledError)) {
        service.interruptProcessingAttempt(
          activeIntent,
          error instanceof ProcessDeadlineError
            ? "PROCESS_TIMEOUT"
            : "PROCESS_INTERRUPTED",
        );
        emitOperation({
          jobId: activeIntent.jobId,
          state: "interrupted",
          attempt: activeIntent.attempt,
          phase: activeIntent.phase,
        });
      }
    } finally {
      await rm(attemptDirectory, { force: true, recursive: true });
    }
  }
}

async function cleanupNativeImportArtifacts(
  profile: ElectronProfilePaths,
  repository: DesktopRepository,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath)) return;
  const helper = new MacOSNativeHelperClient(helperPath);
  const nativeSession = await helper.openSession({
    exactSourcePaths: [],
    destinationRoots: [profile.mediaDirectory],
  });
  try {
    await nativeSession.cleanup(profile.mediaDirectory);
    await cleanupExpiredOrphanedImportedMedia(
      profile.mediaDirectory,
      repository
        .listMediaAuthorities()
        .map((authority) => authority.normalizedPath),
      async (orphanPath) =>
        await nativeSession.discard(orphanPath, profile.mediaDirectory),
    );
  } finally {
    await nativeSession.close();
  }
}
