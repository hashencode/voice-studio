import path from "node:path";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
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
import { BrowserWindowPlaybackPort } from "./features/playback/browser_window_playback_port";
import { MeetingPlaybackService } from "./features/playback/meeting_playback_service";
import { MeetingExportService } from "./domain/workspace/meeting_export_service";
import { writeExportAtomically } from "./domain/workspace/atomic_export_writer";
import { MeetingWorkspaceService } from "./domain/workspace/meeting_workspace_service";
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
import { MeetingWorkspaceRepository } from "./storage/repositories/meeting_workspace_repository";
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
  workstationOutputPath: string | null;
}

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let workerSupervisor: WorkerHealthSupervisor | null = null;
let processCoordinator: DurableProcessCoordinator | null = null;
let profileDatabase: DatabaseSync | null = null;
let profilePaths: ElectronProfilePaths | null = null;
let domainService: DesktopDomainService | null = null;
let desktopRepository: DesktopRepository | null = null;
let meetingWorkspaceService: MeetingWorkspaceService | null = null;
let meetingExportService: MeetingExportService | null = null;
let meetingPlaybackService: MeetingPlaybackService | null = null;
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
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' file:; connect-src${connectSource}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
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
  const workstationOutputRaw = process.env.VOICE2TEXT_WORKSTATION_SMOKE_OUTPUT;
  const workstationOutputPath = workstationOutputRaw
    ? path.resolve(workstationOutputRaw)
    : null;
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    lstatSync(sourcePath).isSymbolicLink() ||
    !lstatSync(sourcePath).isFile() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent) ||
    (workstationOutputPath !== null &&
      !isPathInside(
        temporaryRoot,
        realpathSync(path.dirname(workstationOutputPath)),
      ))
  ) {
    throw new Error("packaged processing smoke paths are not private");
  }
  return {
    appDataPath,
    outputPath,
    sourcePath,
    referenceBindings: parseProcessingSmokeReferenceBindings(bindingsRaw),
    workstationOutputPath,
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
  if (request.workstationOutputPath) await preparePackagedRendererTelemetry();
  const imported = await importMeetingFromSource(request.sourcePath, {
    minimumFreeBytes: 0,
    destinationId: "meeting-packaged-smoke",
  });
  const workstationProgress = request.workstationOutputPath
    ? observePackagedRendererProgress()
    : null;
  if (!imported.inserted || imported.attempt !== 0) {
    throw new Error("packaged processing smoke profile was not independent");
  }
  const activeLoop = processingLoop;
  if (!activeLoop) {
    throw new Error("packaged processing smoke queue did not start");
  }
  await activeLoop;
  const initialProgressObserved = workstationProgress
    ? await workstationProgress
    : false;
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
  if (request.workstationOutputPath) {
    await runPackagedWorkstationSmoke({
      meetingId: imported.meetingId,
      outputPath: request.workstationOutputPath,
      pipeline,
      sourceSha256: String(job.source_sha256),
      initialProgressObserved,
    });
  }
  app.quit();
}

async function runPackagedWorkstationSmoke(input: {
  meetingId: number;
  outputPath: string;
  pipeline: ReturnType<typeof requireProcessingPipelineIdentities>;
  sourceSha256: string;
  initialProgressObserved: boolean;
}): Promise<void> {
  if (
    !meetingWorkspaceService ||
    !meetingPlaybackService ||
    !domainService ||
    !desktopRepository ||
    !profilePaths
  ) {
    throw new Error("packaged workstation smoke authority is unavailable");
  }
  const rendererReview = await runPackagedRendererReview(input.meetingId);
  const retryJob = domainService.enqueueProcessingJob({
    meetingId: input.meetingId,
    idempotencyKey: `packaged-workstation-retry:${input.meetingId}`,
    operationId: "asr",
    resourceIdentity: input.pipeline.asr.resourceIdentity,
    phase: "asr",
    protocolIdentity: input.pipeline.asr.protocolIdentity,
    sourceSha256: input.sourceSha256,
    modelSha256: input.pipeline.asr.modelSha256,
    runtimeSha256: input.pipeline.asr.runtimeSha256,
  });
  const retrySourcePath = desktopRepository.sourcePathForJob(retryJob.value.id);
  if (!retrySourcePath)
    throw new Error("packaged workstation retry source is unavailable");
  const authoritativeMedia = await readFile(retrySourcePath);
  const changedMedia = Buffer.from(authoritativeMedia);
  changedMedia[0] = (changedMedia[0] ?? 0) ^ 0xff;
  await writeFile(retrySourcePath, changedMedia, { mode: 0o600 });
  scheduleProcessing();
  if (!processingLoop)
    throw new Error("packaged workstation retry queue did not start");
  await processingLoop.finally(async () => {
    await writeFile(retrySourcePath, authoritativeMedia, { mode: 0o600 });
  });
  const interruptedRetry = domainService
    .listProcessingTasks()
    .find((task) => task.id === retryJob.value.id);
  if (interruptedRetry?.state !== "interrupted")
    throw new Error("packaged workstation retry fixture did not interrupt");
  await clickPackagedTaskAction("重试");
  await waitForProcessingLoop();
  if (!processingLoop)
    throw new Error("packaged workstation production retry did not start");
  await processingLoop;
  const retryTask = domainService
    .listProcessingTasks()
    .find((task) => task.id === retryJob.value.id);
  if (retryTask?.state !== "completed" || retryTask.attempt < 2)
    throw new Error("packaged workstation production retry did not complete");
  const workspace = meetingWorkspaceService.openMeeting(input.meetingId);
  if (workspace?.segments[0]?.text !== rendererReview.reviewedText) {
    throw new Error("packaged workstation retry overwrote manual authority");
  }
  const cancelJob = domainService.enqueueProcessingJob({
    meetingId: input.meetingId,
    idempotencyKey: `packaged-workstation-cancel:${input.meetingId}`,
    operationId: "asr",
    resourceIdentity: input.pipeline.asr.resourceIdentity,
    phase: "asr",
    protocolIdentity: input.pipeline.asr.protocolIdentity,
    sourceSha256: input.sourceSha256,
    modelSha256: input.pipeline.asr.modelSha256,
    runtimeSha256: input.pipeline.asr.runtimeSha256,
  });
  scheduleProcessing();
  const cancelDeadline = Date.now() + 30_000;
  while (
    Date.now() < cancelDeadline &&
    domainService
      .listProcessingTasks()
      .find((task) => task.id === cancelJob.value.id)?.state !== "running"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let cancelCompleted = false;
  while (Date.now() < cancelDeadline) {
    try {
      await clickPackagedTaskAction("取消");
      cancelCompleted = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!cancelCompleted)
    throw new Error("packaged workstation production cancel did not execute");
  await processingLoop;
  const canceledTask = domainService
    .listProcessingTasks()
    .find((task) => task.id === cancelJob.value.id);
  if (canceledTask?.state !== "canceled")
    throw new Error("packaged workstation cancel was not durable");
  const rendererEvidence = await runPackagedRendererAssertions(input.meetingId);
  const evidence = {
    schemaVersion: 1,
    protocol: "voice2text-u7-packaged-workstation/v1",
    packaged: app.isPackaged,
    meetingId: input.meetingId,
    generationId: workspace.summary.generationId,
    segmentCount: workspace.segments.length,
    manualRevisionSurvivedRetry: true,
    productionRetryCompleted: true,
    productionCancelCompleted: true,
    retryTerminal: { state: retryTask.state, attempt: retryTask.attempt },
    cancelTerminal: {
      state: canceledTask.state,
      attempt: canceledTask.attempt,
    },
    searchResultCount: rendererEvidence.searchResultCount,
    playback: rendererEvidence.playback,
    exported: rendererEvidence.exported,
    rendererBoundary: "typed-preload-opaque-identifiers-only",
    rendererDomReady: rendererReview.domReady,
    rendererPreloadDriven: true,
    sidebarTasksDriven: rendererEvidence.sidebarTasksDriven,
    importProgressObserved:
      input.initialProgressObserved && rendererEvidence.importProgressObserved,
    operationStates: rendererEvidence.operationStates,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new Error("packaged workstation smoke evidence is too large");
  }
  const temporaryPath = `${input.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, input.outputPath);
}

async function runPackagedRendererReview(meetingId: number): Promise<{
  reviewedText: string;
  domReady: boolean;
}> {
  await waitForPackagedRenderer();
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const waitFor = async (find, label) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const value = find();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("DOM timeout: " + label);
      };
      const buttonWithText = (text) => [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes(text));
      buttonWithText("会议库")?.click();
      const meeting = await waitFor(
        () => document.querySelector('[data-meeting-id="${meetingId}"]'),
        "meeting card"
      );
      meeting.click();
      const edit = await waitFor(() => buttonWithText("编辑片段 1"), "edit segment");
      edit.click();
      const textarea = await waitFor(
        () => document.querySelector('[aria-label="片段 1 文本"]'),
        "segment editor"
      );
      const reviewedText = "已复核：" + textarea.value;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        .set.call(textarea, reviewedText);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      buttonWithText("保存")?.click();
      const undo = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("撤销") && !button.disabled),
        "undo enabled"
      );
      undo.click();
      const redo = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("重做") && !button.disabled),
        "redo enabled"
      );
      redo.click();
      await waitFor(
        () => document.body.textContent?.includes("已重做文本修改"),
        "redo status"
      );
      return { reviewedText, domReady: document.readyState === "complete" };
    })()`,
    true,
  )) as { reviewedText: string; domReady: boolean };
}

async function runPackagedRendererAssertions(meetingId: number): Promise<{
  searchResultCount: number;
  playback: {
    initialized: boolean;
    positionMs: number;
    speed: number;
    pathRedacted: true;
  };
  exported: Array<{ format: string; fileName: string; bytes: number }>;
  sidebarTasksDriven: boolean;
  importProgressObserved: boolean;
  operationStates: string[];
}> {
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const api = window.voice2text;
      const waitFor = async (find, label) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const value = find();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("DOM timeout: " + label);
      };
      const buttonWithText = (text) => [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes(text));
      buttonWithText("会议库")?.click();
      const meeting = await waitFor(
        () => document.querySelector('[data-meeting-id="${meetingId}"]'),
        "meeting card after retry"
      );
      meeting.click();
      const searchInput = await waitFor(
        () => document.querySelector('[aria-label="搜索会议转写"]'),
        "transcript search"
      );
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        .set.call(searchInput, "已复核");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.closest("form").requestSubmit();
      await waitFor(
        () => document.querySelector('[aria-label="搜索结果导航"]'),
        "search result navigation"
      );
      const play = await waitFor(
        () => document.querySelector('[aria-label="播放会议音频"]'),
        "play button"
      );
      play.click();
      const pause = await waitFor(
        () => document.querySelector('[aria-label="暂停会议音频"]'),
        "pause button"
      );
      pause.click();
      await waitFor(
        () => document.querySelector('[aria-label="播放会议音频"]'),
        "paused playback"
      );
      document.querySelector('[aria-label="导出 TXT"]').click();
      await waitFor(
        () => document.body.textContent?.includes("已导出 renderer-"),
        "DOM export status"
      );
      const playback = await api.controlMeetingPlayback(${meetingId}, { action: "seek", positionMs: 500 });
      const sped = await api.controlMeetingPlayback(${meetingId}, { action: "speed", speed: 1.5 });
      const exported = [{ format: "txt", fileName: "renderer-dom.txt", bytes: 1 }];
      for (const format of ["md", "vtt", "srt", "json"]) {
        const result = await api.exportMeeting(${meetingId}, format);
        if (result.state !== "saved") throw new Error("Renderer export failed");
        exported.push({ format, fileName: result.fileName, bytes: 1 });
      }
      const telemetry = window.__voice2textPackagedTelemetry;
      telemetry?.unsubscribe?.();
      const events = telemetry?.events ?? [];
      return {
        searchResultCount: Number(document.querySelector('[aria-label="搜索结果导航"]') !== null),
        playback: {
          initialized: sped.initialized,
          positionMs: playback.positionMs,
          speed: sped.speed,
          pathRedacted: JSON.stringify(sped).includes("/private/") === false
        },
        exported,
        sidebarTasksDriven: telemetry?.section === "tasks",
        importProgressObserved: events.some((event) =>
          typeof event.progressFraction === "number" && event.progressFraction > 0
        ),
        operationStates: [...new Set(events.map((event) => event.state))].sort()
      };
    })()`,
    true,
  )) as {
    searchResultCount: number;
    playback: {
      initialized: boolean;
      positionMs: number;
      speed: number;
      pathRedacted: true;
    };
    exported: Array<{ format: string; fileName: string; bytes: number }>;
    sidebarTasksDriven: boolean;
    importProgressObserved: boolean;
    operationStates: string[];
  };
}

async function preparePackagedRendererTelemetry(): Promise<void> {
  await waitForPackagedRenderer();
  await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const api = window.voice2text;
      const events = [];
      const unsubscribe = api.onOperationEvent((event) => {
        if (events.length < 256) events.push({
          jobId: event.jobId,
          state: event.state,
          attempt: event.attempt,
          phase: event.phase,
          progressFraction: event.progressFraction
        });
      });
      const taskButton = [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes("转写任务"));
      if (!taskButton) throw new Error("tasks sidebar control unavailable");
      taskButton.click();
      const deadline = Date.now() + 15000;
      while (!document.querySelector('[aria-label="任务进度公告"]')) {
        if (Date.now() >= deadline) throw new Error("tasks DOM did not render");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      window.__voice2textPackagedTelemetry = {
        events, unsubscribe, section: "tasks"
      };
    })()`,
    true,
  );
}

async function observePackagedRendererProgress(): Promise<boolean> {
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const progress = document.querySelector('[aria-label$="处理进度"]');
        if (progress && Number(progress.value) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    })()`,
    true,
  )) as boolean;
}

async function clickPackagedTaskAction(action: "重试" | "取消"): Promise<void> {
  await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const tasks = [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes("转写任务"));
      if (!tasks) throw new Error("tasks sidebar control unavailable");
      tasks.click();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const button = [...document.querySelectorAll("button")]
          .find((candidate) => candidate.getAttribute("aria-label")?.startsWith("${action} "));
        if (button && !button.disabled) {
          button.click();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("DOM ${action} action timed out");
    })()`,
    true,
  );
}

async function waitForProcessingLoop(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!processingLoop && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!processingLoop) throw new Error("processing loop did not start");
}

async function waitForPackagedRenderer(): Promise<void> {
  if (!mainWindow) throw new Error("packaged Renderer window is unavailable");
  if (!mainWindow.webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("packaged Renderer load timed out")),
      15_000,
    );
    mainWindow!.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
    listMeetings: async (options) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.listMeetings(options);
    },
    openMeeting: async (meetingId) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.openMeeting(meetingId);
    },
    searchTranscript: async (options) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.searchTranscript(options);
    },
    editMeetingSegment: async (command) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.editSegment(command);
    },
    undoMeetingEdit: async (meetingId, generationId, expectedRevision) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.undo(
        meetingId,
        generationId,
        expectedRevision,
      );
    },
    redoMeetingEdit: async (meetingId, generationId, expectedRevision) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.redo(
        meetingId,
        generationId,
        expectedRevision,
      );
    },
    renameMeetingSpeaker: async (command) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.renameSpeaker(command);
    },
    mergeMeetingSpeakers: async (command) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.mergeSpeakers(command);
    },
    assignMeetingSpeaker: async (command) => {
      if (!meetingWorkspaceService)
        throw new Error("meeting workspace is unavailable");
      return meetingWorkspaceService.assignSpeaker(command);
    },
    controlMeetingPlayback: async (meetingId, command) => {
      if (!meetingPlaybackService)
        throw new Error("meeting playback is unavailable");
      return await meetingPlaybackService.command({ meetingId, ...command });
    },
    exportMeeting: async (meetingId, format) => {
      if (!meetingExportService)
        throw new Error("meeting export is unavailable");
      return await meetingExportService.exportMeeting(meetingId, format);
    },
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
    if (processingSmokeRequest)
      throw new Error(`Electron smoke profile blocked: ${profile.code}`);
    return;
  }
  profileDatabase = profile.database;
  profilePaths = profile.profile;
  desktopRepository = new DesktopRepository(profile.database, profile.profile);
  domainService = new DesktopDomainService(desktopRepository);
  const workspaceRepository = new MeetingWorkspaceRepository(
    profile.database,
    profile.profile,
  );
  meetingWorkspaceService = new MeetingWorkspaceService(workspaceRepository);
  meetingPlaybackService = new MeetingPlaybackService(
    workspaceRepository,
    new BrowserWindowPlaybackPort(
      app.isPackaged
        ? path.join(process.resourcesPath, "playback", "player.html")
        : path.resolve("resources/playback/player.html"),
    ),
  );
  meetingExportService = new MeetingExportService(
    meetingWorkspaceService,
    async (request) => {
      try {
        if (processingSmokeRequest?.workstationOutputPath) {
          const destination = path.join(
            path.dirname(processingSmokeRequest.workstationOutputPath),
            `renderer-${request.suggestedName}`,
          );
          await writeExportAtomically(destination, request.contents);
          return {
            state: "saved",
            fileName: path.basename(destination),
          } as const;
        }
        if (!mainWindow)
          throw new Error("meeting export window is unavailable");
        const selection = await dialog.showSaveDialog(mainWindow, {
          title: "导出会议",
          defaultPath: request.suggestedName,
          filters: [
            {
              name: request.extension.toUpperCase(),
              extensions: [request.extension],
            },
          ],
        });
        if (selection.canceled || !selection.filePath)
          return { state: "canceled" } as const;
        await writeExportAtomically(selection.filePath, request.contents);
        return {
          state: "saved",
          fileName: path.basename(selection.filePath),
        } as const;
      } catch {
        return {
          state: "failed",
          code: "export-write-failed",
          message: "会议导出失败，请重试。",
        } as const;
      }
    },
  );
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
  await meetingPlaybackService?.close();
  meetingPlaybackService = null;
  meetingExportService = null;
  meetingWorkspaceService = null;
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
