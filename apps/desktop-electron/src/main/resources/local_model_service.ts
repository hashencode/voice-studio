import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import {
  localModelIntentSchema,
  localModelSnapshotSchema,
  type LocalModelBundleId,
  type LocalModelCapabilityReason,
  type LocalModelIntent,
  type LocalModelSnapshot,
} from "../../shared/contracts";
import { sha256File } from "../security/sha256_file";
import {
  extractTrustedModelArchive,
  type ExpectedModelFile,
  type StreamingArchiveAdapter,
} from "./model_archive_extractor";
import {
  ModelDownloadCoordinator,
  type TrustedModelDownload,
} from "./model_download_coordinator";
import { ModelLeaseCoordinator } from "./model_lease_coordinator";
import { ModelMigrationCoordinator } from "./model_migration_coordinator";
import { ModelStore, type ManagedModelStore } from "./model_store";
import type { ModelResourceAuthority } from "./resource_catalog";
import { writeJsonAtomically } from "../profile/atomic_json";

export interface AppModelCatalogEntry {
  id: LocalModelBundleId;
  displayName: string;
  version: string;
  distributionEligible: boolean;
  developmentOnly: boolean;
  licenseComplete: boolean;
  target: "darwin-arm64";
  runtimeProtocol: string;
  download: TrustedModelDownload | null;
  inventory: readonly ExpectedModelFile[];
}

export const developmentModelCatalog: readonly AppModelCatalogEntry[] = [
  {
    id: "formal-transcription",
    displayName: "本地转写",
    version: "development-only",
    distributionEligible: false,
    developmentOnly: true,
    licenseComplete: false,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: null,
    inventory: [],
  },
  {
    id: "live-caption",
    displayName: "实时字幕",
    version: "development-only",
    distributionEligible: false,
    developmentOnly: true,
    licenseComplete: false,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: null,
    inventory: [],
  },
] as const;

interface InstalledManifest {
  schemaVersion: 1;
  bundleId: LocalModelBundleId;
  version: string;
  catalogIdentity: string;
  generation: number;
  inventory: ExpectedModelFile[];
}

type BundleState = LocalModelSnapshot["bundles"][number];

export class LocalModelService {
  private revision = 0;
  private activeStore: ManagedModelStore | null = null;
  private storageState: LocalModelSnapshot["storage"]["state"] = "ready";
  private operation: LocalModelSnapshot["operation"] = null;
  private readonly listeners = new Set<
    (snapshot: LocalModelSnapshot) => void
  >();
  private readonly migration: ModelMigrationCoordinator;
  private pendingCleanupStore: ManagedModelStore | null = null;
  private readonly unsubscribeGate: () => void;
  private closed = false;
  private downloadTask: Promise<void> | null = null;
  private readonly bundleValidationCache = new Map<string, BundleState>();

  constructor(
    private readonly options: {
      store: ModelStore;
      gate: ModelLeaseCoordinator;
      runtime: LocalModelSnapshot["runtime"];
      catalog?: readonly AppModelCatalogEntry[];
      downloader?: ModelDownloadCoordinator;
      archiveAdapter?: StreamingArchiveAdapter;
      acquireStorageAccess?: (storeId: string) => () => void;
      probeBundle?: (
        bundleId: LocalModelBundleId,
        root: string,
      ) => Promise<void>;
      probeStore?: (store: ManagedModelStore) => Promise<void>;
    },
  ) {
    this.migration = new ModelMigrationCoordinator(options.store, options.gate);
    this.unsubscribeGate = options.gate.subscribe(() => {
      if (this.activeStore && !this.closed) void this.publish();
    });
  }

  async initialize(): Promise<LocalModelSnapshot> {
    if (this.activeStore) return await this.snapshot();
    try {
      const selected = this.options.store.selectedStore();
      if (selected && !existsSync(selected.root)) {
        this.activeStore = selected;
        this.storageState = "unavailable";
      } else {
        this.activeStore =
          this.options.store.readActive() ??
          this.options.store.publishActive(
            this.options.store.createDefaultRoot(),
          );
      }
      const migrationJournalPath = path.join(
        this.options.store.metadataRoot,
        "migration.json",
      );
      if (existsSync(migrationJournalPath)) {
        const journal = JSON.parse(
          readFileSync(migrationJournalPath, "utf8"),
        ) as { phase?: unknown; targetIdentity?: unknown };
        if (["cleaning", "cleanup-required"].includes(String(journal.phase))) {
          this.pendingCleanupStore = this.options.store.readPrevious(
            this.activeStore,
          );
          if (this.pendingCleanupStore) {
            this.storageState = "cleanup-required";
            this.operation = {
              id: "migration-cleanup-recovery",
              kind: "cleanup",
              bundleId: null,
              phase: "cleanup-required",
              cancelable: false,
              copiedBytes: 0,
              totalBytes: 0,
              message: "旧模型目录待清理",
            };
          }
        } else if (
          ["switching", "probing"].includes(String(journal.phase)) &&
          typeof journal.targetIdentity === "string" &&
          pathIdentity(this.activeStore.root) === journal.targetIdentity
        ) {
          const previous = this.options.store.readPrevious(this.activeStore);
          try {
            await this.options.probeStore?.(this.activeStore);
            this.pendingCleanupStore = previous;
            if (previous) {
              this.storageState = "cleanup-required";
              this.operation = cleanupRecoveryOperation();
            }
          } catch {
            if (previous) {
              try {
                this.activeStore = this.options.store.publishActive(previous);
                await this.options.probeStore?.(this.activeStore);
                this.migration.recoverPreSwitch(this.activeStore);
                this.storageState = "ready";
              } catch {
                this.storageState = "recovery-required";
              }
            } else {
              this.storageState = "recovery-required";
            }
          }
        } else {
          this.migration.recoverPreSwitch(this.activeStore);
        }
      }
    } catch {
      this.storageState = "recovery-required";
    }
    return await this.publish();
  }

  subscribe(listener: (snapshot: LocalModelSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get activeStoreId(): string | null {
    return this.activeStore?.storeId ?? null;
  }

  async snapshot(): Promise<LocalModelSnapshot> {
    const store = this.activeStore;
    if (store && !existsSync(store.markerPath)) {
      this.storageState = "unavailable";
      this.bundleValidationCache.clear();
    } else if (store && this.storageState === "unavailable") {
      try {
        const reopened = this.options.store.openManagedRoot(
          store.root,
          store.generation,
        );
        if (reopened.storeId !== store.storeId) {
          throw new Error("模型目录身份已变化");
        }
        this.activeStore = reopened;
        this.storageState = this.pendingCleanupStore
          ? "cleanup-required"
          : "ready";
      } catch {
        this.storageState = "recovery-required";
      }
    }
    const bundles = await Promise.all(
      this.catalog.map(async (entry) => await this.bundleSnapshot(entry)),
    );
    const gate = this.options.gate.snapshot;
    return localModelSnapshotSchema.parse({
      schemaVersion: 1,
      revision: this.revision,
      runtime: this.options.runtime,
      storage: {
        state: this.storageState,
        displayPath: store?.root ?? "模型位置不可用",
        storeId: store?.storeId ?? null,
        usedBytes: bundles.reduce((sum, item) => sum + item.installedBytes, 0),
      },
      bundles,
      operation: this.operation,
      leaseCount: gate.leaseCount,
      processingTaskCount: gate.processingTaskCount,
      canChangeRoot: gate.idle && this.operation === null,
    });
  }

  rootPath(): string {
    if (!this.activeStore) throw new Error("本地模型位置不可用");
    return this.activeStore.root;
  }

  async capability(bundleId: LocalModelBundleId): Promise<
    | {
        available: true;
        root: string;
        storeId: string;
        generation: number;
        identity: string;
      }
    | { available: false; reason: LocalModelCapabilityReason }
  > {
    if (this.options.runtime.state !== "ready") {
      return { available: false, reason: "runtime-damaged" };
    }
    if (
      !this.activeStore ||
      !["ready", "cleanup-required"].includes(this.storageState)
    ) {
      return { available: false, reason: "storage-unavailable" };
    }
    if (this.operation?.kind === "migration") {
      return { available: false, reason: "busy" };
    }
    const entry = this.requireEntry(bundleId);
    const bundle = await this.bundleSnapshot(entry, true);
    if (bundle.state === "corrupt") {
      return { available: false, reason: "model-corrupt" };
    }
    if (bundle.state !== "installed") {
      return { available: false, reason: "model-not-installed" };
    }
    const root = this.options.store.bundleRoot(this.activeStore, bundleId);
    return {
      available: true,
      root,
      storeId: this.activeStore.storeId,
      generation: this.activeStore.generation,
      identity: createHash("sha256")
        .update(entryIdentity(entry))
        .update("\0")
        .update(String(this.activeStore.generation))
        .digest("hex"),
    };
  }

  async resourceAuthority(
    bundleId: LocalModelBundleId,
  ): Promise<ModelResourceAuthority | null> {
    const capability = await this.capability(bundleId);
    if (!capability.available) return null;
    const entry = this.requireEntry(bundleId);
    return Object.freeze({
      bundleId,
      root: capability.root,
      identity: capability.identity,
      artifacts: Object.freeze(
        entry.inventory.map((item) =>
          Object.freeze({ path: item.path, sha256: item.sha256 }),
        ),
      ),
    });
  }

  async intent(raw: LocalModelIntent): Promise<LocalModelSnapshot> {
    const intent = localModelIntentSchema.parse(raw);
    this.assertRevision(intent.expectedRevision);
    if (intent.action === "cancel-migration") {
      this.migration.cancel();
      return await this.snapshot();
    }
    if (intent.action === "retry-cleanup") {
      if (!this.pendingCleanupStore) throw new Error("没有待清理的旧模型目录");
      await this.migration.retryCleanup(this.pendingCleanupStore);
      this.pendingCleanupStore = null;
      this.storageState = "ready";
      this.operation = null;
      return await this.publish();
    }
    const bundleId = intent.bundleId!;
    if (
      this.operation &&
      !(
        this.operation.kind === "download" &&
        this.operation.bundleId === bundleId &&
        ["pause", "resume", "cancel"].includes(intent.action)
      )
    ) {
      throw new Error("已有本地模型操作正在进行");
    }
    try {
      switch (intent.action) {
        case "download":
          this.assertDownloadEligible(bundleId);
          this.startDownload(bundleId);
          return await this.snapshot();
        case "resume":
          await this.downloadTask?.catch(() => undefined);
          this.assertDownloadEligible(bundleId);
          this.startDownload(bundleId);
          return await this.snapshot();
        case "pause":
          if (this.operation?.bundleId === bundleId) {
            this.operation = {
              ...this.operation,
              message: "已暂停",
              cancelable: true,
            };
          }
          this.options.downloader?.pause();
          await this.downloadTask?.catch(() => undefined);
          break;
        case "cancel":
          this.cancelDownload(bundleId);
          await this.downloadTask?.catch(() => undefined);
          break;
        case "delete":
          await this.delete(bundleId);
          break;
        case "redownload":
          this.assertDownloadEligible(bundleId);
          await this.delete(bundleId);
          this.startDownload(bundleId);
          return await this.snapshot();
      }
    } catch (error) {
      throw publicModelError(error, "本地模型操作失败，请重试");
    }
    return await this.publish();
  }

  async changeRoot(
    targetPath: string,
    expectedRevision: number,
  ): Promise<LocalModelSnapshot> {
    this.assertRevision(expectedRevision);
    if (this.operation) throw new Error("已有本地模型操作正在进行");
    const source = this.requireStore();
    const hasModels = (
      await Promise.all(
        this.catalog.map((entry) => this.bundleSnapshot(entry, true)),
      )
    ).some(
      (bundle) => bundle.state === "installed" || bundle.state === "corrupt",
    );
    if (!hasModels) {
      const release = this.options.gate.beginMutation("change-empty-root", {
        migration: true,
      });
      try {
        const target = this.options.store.createManagedRoot(targetPath);
        this.activeStore = this.options.store.publishActive(target);
        this.bundleValidationCache.clear();
      } finally {
        release();
      }
      return await this.publish();
    }
    const operationId = `migration-${randomUUID()}`;
    this.operation = {
      id: operationId,
      kind: "migration",
      bundleId: null,
      phase: "preparing",
      cancelable: true,
      copiedBytes: 0,
      totalBytes: 0,
      message: null,
    };
    await this.publish();
    let result;
    let lastMigrationPublishMs = 0;
    try {
      result = await this.migration.migrate({
        source,
        targetPath: this.options.store.resolveSelectionPath(targetPath),
        onProgress: (progress) => {
          this.operation = {
            id: operationId,
            kind: "migration",
            bundleId: null,
            phase: progress.phase,
            cancelable: progress.cancelable,
            copiedBytes: progress.copiedBytes,
            totalBytes: progress.totalBytes,
            message: null,
          };
          if (Date.now() - lastMigrationPublishMs >= 250) {
            lastMigrationPublishMs = Date.now();
            void this.publish();
          }
        },
        probe: async (candidate) => {
          const previous = this.activeStore;
          this.activeStore = candidate;
          try {
            await this.options.probeStore?.(candidate);
          } finally {
            this.activeStore = previous;
          }
        },
      });
    } catch (error) {
      this.activeStore = source;
      await this.options.probeStore?.(source).catch(() => undefined);
      this.operation = null;
      await this.publish();
      throw publicModelError(error, "模型位置迁移失败，原位置保持不变");
    }
    this.activeStore = result.store;
    this.bundleValidationCache.clear();
    this.storageState = result.cleanupRequired ? "cleanup-required" : "ready";
    this.pendingCleanupStore = result.cleanupSource;
    this.operation = result.cleanupRequired
      ? {
          id: operationId,
          kind: "cleanup",
          bundleId: null,
          phase: "cleanup-required",
          cancelable: false,
          copiedBytes: 0,
          totalBytes: 0,
          message: "旧模型目录待清理",
        }
      : null;
    return await this.publish();
  }

  close(): void {
    this.closed = true;
    this.unsubscribeGate();
    this.options.downloader?.pause();
  }

  private async download(bundleId: LocalModelBundleId): Promise<void> {
    const entry = this.requireEntry(bundleId);
    if (
      !entry.distributionEligible ||
      entry.developmentOnly ||
      !entry.licenseComplete ||
      !entry.download
    ) {
      throw new Error("正式模型下载尚未开放；发布前仍需完成下载端点与许可验证");
    }
    const downloader = this.options.downloader;
    const adapter = this.options.archiveAdapter;
    if (!downloader || !adapter) throw new Error("模型安装组件不可用");
    const store = this.requireStore();
    const id = `download-${randomUUID()}`;
    const partial = path.join(
      store.stagingRoot,
      "downloads",
      `${bundleId}.partial`,
    );
    const journal = path.join(
      store.stagingRoot,
      "downloads",
      `${bundleId}.json`,
    );
    const archive = path.join(
      store.stagingRoot,
      "downloads",
      `${bundleId}.archive`,
    );
    const extraction = path.join(store.stagingRoot, `${bundleId}-${id}`);
    let lastProgressPublishMs = 0;
    try {
      this.operation = {
        id,
        kind: "download",
        bundleId,
        phase: null,
        cancelable: true,
        copiedBytes: 0,
        totalBytes: entry.download.archiveBytes,
        message: null,
      };
      await this.publish();
      await downloader.download({
        entry: entry.download,
        partialPath: partial,
        journalPath: journal,
        completedPath: archive,
        onProgress: (bytes) => {
          if (this.operation?.id !== id) return;
          this.operation.copiedBytes = bytes;
          if (Date.now() - lastProgressPublishMs >= 250) {
            lastProgressPublishMs = Date.now();
            void this.publish();
          }
        },
      });
      this.operation = {
        ...this.operation!,
        kind: "install",
        cancelable: false,
      };
      await extractTrustedModelArchive({
        archivePath: archive,
        stagingRoot: extraction,
        adapter,
        inventory: entry.inventory,
      });
      const releasePublication = await this.options.gate.beginMutationWhenIdle(
        `install:${bundleId}`,
      );
      const manifest: InstalledManifest = {
        schemaVersion: 1,
        bundleId,
        version: entry.version,
        catalogIdentity: entryIdentity(entry),
        generation: store.generation + 1,
        inventory: [...entry.inventory],
      };
      const manifestPath = path.join(extraction, "installed.json");
      try {
        writeJsonAtomically(
          manifestPath,
          manifest as unknown as Record<string, unknown>,
        );
        const target = this.options.store.bundleRoot(store, bundleId);
        if (existsSync(target)) throw new Error("模型已安装，请先删除旧版本");
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        renameSync(extraction, target);
        try {
          await this.options.probeBundle?.(bundleId, target);
        } catch (error) {
          const quarantine = path.join(
            store.stagingRoot,
            `quarantine-${bundleId}-${id}`,
          );
          renameSync(target, quarantine);
          unlinkIfPresent(archive);
          try {
            removeVerifiedBundleCandidate(quarantine, entry.inventory);
          } catch {
            // An identity conflict leaves a bounded quarantine for recovery.
          }
          throw error;
        }
        this.activeStore = this.options.store.publishActive(store);
        this.bundleValidationCache.clear();
        unlinkIfPresent(archive);
        this.operation = null;
      } finally {
        releasePublication();
      }
    } catch (error) {
      if (this.operation?.id === id && this.operation.message !== "已暂停") {
        this.operation = {
          ...this.operation,
          kind: "download",
          cancelable: true,
          message: "下载失败",
        };
      }
      throw error;
    }
  }

  private assertDownloadEligible(bundleId: LocalModelBundleId): void {
    const entry = this.requireEntry(bundleId);
    if (
      !entry.distributionEligible ||
      entry.developmentOnly ||
      !entry.licenseComplete ||
      !entry.download
    ) {
      throw new Error("正式模型下载尚未开放；发布前仍需完成下载端点与许可验证");
    }
    if (!this.options.downloader || !this.options.archiveAdapter) {
      throw new Error("模型安装组件不可用");
    }
  }

  private startDownload(bundleId: LocalModelBundleId): void {
    if (this.downloadTask) throw new Error("已有模型下载正在收尾");
    const releaseStorageAccess = this.activeStore
      ? this.options.acquireStorageAccess?.(this.activeStore.storeId)
      : undefined;
    const task = this.download(bundleId)
      .catch(() => undefined)
      .then(async () => {
        await this.publish();
      })
      .finally(() => {
        releaseStorageAccess?.();
        if (this.downloadTask === task) this.downloadTask = null;
      });
    this.downloadTask = task;
  }

  private cancelDownload(bundleId: LocalModelBundleId): void {
    const store = this.requireStore();
    this.options.downloader?.cancel(
      path.join(store.stagingRoot, "downloads", `${bundleId}.partial`),
      path.join(store.stagingRoot, "downloads", `${bundleId}.json`),
    );
    this.operation = null;
  }

  private async delete(bundleId: LocalModelBundleId): Promise<void> {
    const store = this.requireStore();
    const release = this.options.gate.beginMutation(`delete:${bundleId}`);
    try {
      const root = this.options.store.bundleRoot(store, bundleId);
      if (!existsSync(root)) return;
      const inventory = [...this.requireEntry(bundleId).inventory];
      const actualFiles = scanOwnedFiles(root);
      const expectedFiles = new Set([
        "installed.json",
        ...inventory.map((item) => item.path),
      ]);
      if (
        actualFiles.length !== expectedFiles.size ||
        actualFiles.some((item) => !expectedFiles.has(item))
      ) {
        throw new Error("模型目录包含未登记文件，拒绝删除");
      }
      for (const item of inventory.reverse()) {
        const candidate = contained(root, item.path);
        const stat = lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error("模型文件身份发生变化，拒绝删除");
        }
        unlinkSync(candidate);
        removeEmptyParents(path.dirname(candidate), root);
      }
      unlinkSync(path.join(root, "installed.json"));
      rmdirSync(root);
      this.activeStore = this.options.store.publishActive(store);
      this.bundleValidationCache.clear();
    } finally {
      release();
    }
  }

  private async bundleSnapshot(
    entry: AppModelCatalogEntry,
    forceValidation = false,
  ): Promise<BundleState> {
    const base = {
      id: entry.id,
      displayName: entry.displayName,
      version: null,
      installedBytes: 0,
      expectedBytes: entry.inventory.reduce((sum, item) => sum + item.bytes, 0),
      progressBytes:
        this.operation?.bundleId === entry.id ? this.operation.copiedBytes : 0,
      message: null,
      distributionEligible:
        entry.distributionEligible &&
        !entry.developmentOnly &&
        entry.licenseComplete,
    };
    if (!this.activeStore || this.storageState === "unavailable") {
      return { ...base, state: "storage-unavailable" };
    }
    if (this.operation?.bundleId === entry.id) {
      return {
        ...base,
        state:
          this.operation.message === "已暂停"
            ? "paused"
            : this.operation.message === "下载失败"
              ? "failed"
              : this.operation.kind === "install"
                ? "installing"
                : "downloading",
      };
    }
    const root = this.options.store.bundleRoot(this.activeStore, entry.id);
    if (!existsSync(root)) return { ...base, state: "not-installed" };
    const cacheKey = `${this.activeStore.root}\0${this.activeStore.generation}\0${entryIdentity(entry)}`;
    if (!forceValidation) {
      const cached = this.bundleValidationCache.get(cacheKey);
      if (cached) return { ...cached, progressBytes: base.progressBytes };
    }
    try {
      const manifest = readInstalledManifest(root);
      if (
        manifest.bundleId !== entry.id ||
        manifest.catalogIdentity !== entryIdentity(entry)
      ) {
        throw new Error("catalog mismatch");
      }
      if (!sameInventory(manifest.inventory, entry.inventory)) {
        throw new Error("inventory mismatch");
      }
      const actualFiles = scanOwnedFiles(root);
      const expectedFiles = new Set([
        "installed.json",
        ...entry.inventory.map((item) => item.path),
      ]);
      if (
        actualFiles.length !== expectedFiles.size ||
        actualFiles.some((item) => !expectedFiles.has(item))
      ) {
        throw new Error("inventory mismatch");
      }
      let installedBytes = 0;
      for (const item of entry.inventory) {
        const candidate = contained(root, item.path);
        const stat = lstatSync(candidate);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size !== item.bytes
        ) {
          throw new Error("inventory mismatch");
        }
        if ((await sha256File(candidate)) !== item.sha256)
          throw new Error("hash mismatch");
        installedBytes += item.bytes;
      }
      const installed: BundleState = {
        ...base,
        state: "installed",
        version: manifest.version,
        installedBytes,
      };
      this.bundleValidationCache.set(cacheKey, installed);
      return installed;
    } catch {
      return {
        ...base,
        state: "corrupt",
        message: "模型已损坏，请删除并重新下载",
      };
    }
  }

  private requireStore(): ManagedModelStore {
    if (!this.activeStore) throw new Error("模型位置不可用");
    return this.activeStore;
  }

  private requireEntry(bundleId: LocalModelBundleId): AppModelCatalogEntry {
    const entry = this.catalog.find((candidate) => candidate.id === bundleId);
    if (!entry) throw new Error("未知模型 bundle");
    return entry;
  }

  private get catalog(): readonly AppModelCatalogEntry[] {
    return this.options.catalog ?? developmentModelCatalog;
  }

  private assertRevision(expected: number): void {
    if (expected !== this.revision)
      throw new Error("本地模型状态已变化，请重试");
    if (this.closed) throw new Error("本地模型服务正在关闭");
  }

  private async publish(): Promise<LocalModelSnapshot> {
    this.revision += 1;
    const snapshot = await this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}

function sameInventory(
  actual: readonly ExpectedModelFile[],
  expected: readonly ExpectedModelFile[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function removeVerifiedBundleCandidate(
  root: string,
  inventory: readonly ExpectedModelFile[],
): void {
  const expected = new Set([
    "installed.json",
    ...inventory.map((item) => item.path),
  ]);
  const actual = scanOwnedFiles(root);
  if (
    actual.length !== expected.size ||
    actual.some((relative) => !expected.has(relative))
  ) {
    throw new Error("隔离模型目录包含未登记文件");
  }
  for (const item of [...inventory].reverse()) {
    const candidate = contained(root, item.path);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("隔离模型文件身份已变化");
    }
    unlinkSync(candidate);
    removeEmptyParents(path.dirname(candidate), root);
  }
  unlinkSync(path.join(root, "installed.json"));
  rmdirSync(root);
}

function pathIdentity(candidate: string): string {
  return createHash("sha256").update(path.resolve(candidate)).digest("hex");
}

function cleanupRecoveryOperation(): NonNullable<
  LocalModelSnapshot["operation"]
> {
  return {
    id: "migration-cleanup-recovery",
    kind: "cleanup",
    bundleId: null,
    phase: "cleanup-required",
    cancelable: false,
    copiedBytes: 0,
    totalBytes: 0,
    message: "旧模型目录待清理",
  };
}

function entryIdentity(entry: AppModelCatalogEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: entry.id,
        version: entry.version,
        target: entry.target,
        runtimeProtocol: entry.runtimeProtocol,
        inventory: entry.inventory,
      }),
    )
    .digest("hex");
}

function readInstalledManifest(root: string): InstalledManifest {
  const manifestPath = path.join(root, "installed.json");
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("模型安装清单无效");
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as InstalledManifest;
}

function contained(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  const relation = path.relative(root, candidate);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("模型清单路径超出 bundle");
  }
  return candidate;
}

function removeEmptyParents(directory: string, stop: string): void {
  let current = directory;
  while (current !== stop) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function unlinkIfPresent(candidate: string): void {
  try {
    unlinkSync(candidate);
  } catch {
    // Missing residue is already clean.
  }
}

function scanOwnedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("模型目录包含链接，拒绝删除");
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && stat.nlink === 1) {
        files.push(path.relative(root, candidate));
      } else {
        throw new Error("模型目录包含不受支持的文件，拒绝删除");
      }
    }
  };
  visit(root);
  return files;
}

function publicModelError(error: unknown, fallback: string): Error {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message.length <= 240 &&
    !/[\\/]|https?:|file:/i.test(error.message)
  ) {
    return error;
  }
  return new Error(fallback);
}
