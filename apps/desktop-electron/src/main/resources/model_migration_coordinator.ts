import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";

import type { LocalModelSnapshot } from "../../shared/contracts";
import { sha256File } from "../security/sha256_file";
import { writeJsonAtomically } from "../profile/atomic_json";
import type { ModelLeaseCoordinator } from "./model_lease_coordinator";
import { ModelStore, type ManagedModelStore } from "./model_store";

type MigrationPhase = NonNullable<LocalModelSnapshot["operation"]>["phase"];

interface MigrationLocation {
  schemaVersion: 1;
  operationId: string;
  sourceStoreId: string;
  target: string;
  staging: string;
  sourceIdentity: FileSystemIdentity;
  stagingIdentity: FileSystemIdentity | null;
  ownedInventory: InventoryItem[];
}

interface FileSystemIdentity {
  device: number;
  inode: number;
}

export class ModelMigrationCoordinator {
  private cancelRequested = false;

  constructor(
    private readonly store: ModelStore,
    private readonly gate: ModelLeaseCoordinator,
  ) {}

  cancel(): void {
    this.cancelRequested = true;
  }

  async migrate(options: {
    source: ManagedModelStore;
    targetPath: string;
    onProgress: (progress: {
      phase: MigrationPhase;
      copiedBytes: number;
      totalBytes: number;
      cancelable: boolean;
    }) => void;
    probe: (store: ManagedModelStore) => Promise<void>;
  }): Promise<{
    store: ManagedModelStore;
    cleanupRequired: boolean;
    cleanupSource: ManagedModelStore | null;
  }> {
    const release = this.gate.beginMutation("root", { migration: true });
    const operationId = `migration-${randomUUID()}`;
    this.cancelRequested = false;
    let switched = false;
    let rollbackConfirmed = false;
    let published: ManagedModelStore | null = null;
    let stagingIdentity: FileSystemIdentity | null = null;
    const ownedInventory: InventoryItem[] = [];
    const target = path.resolve(options.targetPath);
    const staging = `${target}.migration-${operationId}`;
    try {
      this.store.assertDistinctTopology(options.source.root, target);
      if (exists(target) && readdirSync(target).length > 0) {
        throw new Error("目标模型目录不是空目录");
      }
      if (exists(staging)) throw new Error("迁移暂存目录已存在");
      const boundSourceIdentity = fileSystemIdentity(options.source.root);
      const inventory = scanInventory(options.source.root);
      const totalBytes = inventory.reduce((sum, item) => sum + item.bytes, 0);
      const publishLocation = () =>
        this.publishLocation({
          schemaVersion: 1,
          operationId,
          sourceStoreId: options.source.storeId,
          target,
          staging,
          sourceIdentity: boundSourceIdentity,
          stagingIdentity,
          ownedInventory,
        });
      publishLocation();
      this.publishJournal(
        operationId,
        "preparing",
        options.source.root,
        target,
      );
      options.onProgress({
        phase: "preparing",
        copiedBytes: 0,
        totalBytes,
        cancelable: true,
      });
      this.throwIfCanceled();
      mkdirSync(staging, { recursive: false, mode: 0o700 });
      stagingIdentity = fileSystemIdentity(staging);
      publishLocation();
      let copiedBytes = 0;
      this.publishJournal(operationId, "copying", options.source.root, target);
      for (const item of inventory) {
        this.throwIfCanceled();
        const destination = path.join(staging, item.relativePath);
        if (item.kind === "directory") {
          mkdirSync(destination, { mode: 0o700 });
          ownedInventory.push(item);
          publishLocation();
          continue;
        }
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(
          path.join(options.source.root, item.relativePath),
          destination,
        );
        ownedInventory.push(item);
        publishLocation();
        copiedBytes += item.bytes;
        options.onProgress({
          phase: "copying",
          copiedBytes,
          totalBytes,
          cancelable: true,
        });
      }
      this.publishJournal(
        operationId,
        "verifying",
        options.source.root,
        target,
      );
      options.onProgress({
        phase: "verifying",
        copiedBytes,
        totalBytes,
        cancelable: true,
      });
      for (const item of inventory) {
        if (item.kind !== "file") continue;
        this.throwIfCanceled();
        const sourceHash = await sha256File(
          path.join(options.source.root, item.relativePath),
        );
        const targetHash = await sha256File(
          path.join(staging, item.relativePath),
        );
        if (sourceHash !== targetHash) throw new Error("迁移文件校验失败");
        item.sha256 = sourceHash;
      }
      publishLocation();
      this.throwIfCanceled();
      assertFileSystemIdentity(options.source.root, boundSourceIdentity);
      assertFileSystemIdentity(staging, stagingIdentity);
      if (
        !sameInventoryStructure(scanInventory(options.source.root), inventory)
      ) {
        throw new Error("迁移期间源模型目录内容已变化");
      }
      if (!sameInventoryStructure(scanInventory(staging), inventory)) {
        throw new Error("迁移暂存目录内容已变化");
      }
      this.writeCleanupInventory(
        options.source,
        boundSourceIdentity,
        inventory,
      );
      options.onProgress({
        phase: "switching",
        copiedBytes,
        totalBytes,
        cancelable: false,
      });
      this.publishJournal(
        operationId,
        "switching",
        options.source.root,
        target,
      );
      if (exists(target)) rmdirSync(target);
      renameSync(staging, target);
      const candidate = this.store.openManagedRoot(
        target,
        options.source.generation,
      );
      published = this.store.publishActive(candidate);
      switched = true;
      options.onProgress({
        phase: "probing",
        copiedBytes,
        totalBytes,
        cancelable: false,
      });
      this.publishJournal(operationId, "probing", options.source.root, target);
      try {
        await options.probe(published);
      } catch (error) {
        this.store.publishActive(options.source);
        rollbackConfirmed = true;
        throw error;
      }
      options.onProgress({
        phase: "cleaning",
        copiedBytes,
        totalBytes,
        cancelable: false,
      });
      this.publishJournal(operationId, "cleaning", options.source.root, target);
      try {
        assertFileSystemIdentity(options.source.root, boundSourceIdentity);
        const cleanupInventory = scanInventory(options.source.root);
        if (!sameInventoryStructure(cleanupInventory, inventory)) {
          throw new Error("旧模型目录内容已变化");
        }
        await verifyInventoryHashes(options.source.root, inventory);
        removeScannedRoot(
          options.source.root,
          inventory,
          boundSourceIdentity,
          (remaining) =>
            this.writeCleanupInventory(
              options.source,
              boundSourceIdentity,
              remaining,
            ),
        );
        this.clearJournal();
        return {
          store: published,
          cleanupRequired: false,
          cleanupSource: null,
        };
      } catch {
        this.publishJournal(
          operationId,
          "cleanup-required",
          options.source.root,
          target,
        );
        return {
          store: published,
          cleanupRequired: true,
          cleanupSource: options.source,
        };
      }
    } catch (error) {
      let residueRemoved = !exists(staging);
      if (!switched && exists(staging) && stagingIdentity) {
        try {
          await removeOwnedRoot(staging, stagingIdentity, ownedInventory);
          residueRemoved = true;
        } catch {
          // Unsafe residue is intentionally preserved for recovery.
        }
      }
      if (!switched) {
        if (residueRemoved) {
          this.clearJournal();
        } else {
          this.publishJournal(
            operationId,
            "recovery-required",
            options.source.root,
            target,
          );
        }
      } else if (published && rollbackConfirmed) {
        try {
          if (!stagingIdentity) throw new Error("迁移暂存目录身份缺失");
          await removeOwnedRoot(
            published.root,
            stagingIdentity,
            ownedInventory,
          );
          this.clearJournal();
        } catch {
          this.publishJournal(
            operationId,
            "recovery-required",
            options.source.root,
            target,
          );
        }
      } else if (switched) {
        this.publishJournal(
          operationId,
          "recovery-required",
          options.source.root,
          target,
        );
      }
      throw error;
    } finally {
      release();
    }
  }

  async retryCleanup(source: ManagedModelStore): Promise<void> {
    const release = this.gate.beginMutation("cleanup");
    try {
      const cleanup = this.readCleanupInventory(source);
      assertFileSystemIdentity(source.root, cleanup.rootIdentity);
      const actual = scanInventory(source.root);
      if (!isInventorySubset(actual, cleanup.inventory)) {
        throw new Error("旧模型目录内容已变化，拒绝自动清理");
      }
      const remaining = withExpectedHashes(actual, cleanup.inventory);
      await verifyInventoryHashes(source.root, remaining);
      removeScannedRoot(
        source.root,
        remaining,
        cleanup.rootIdentity,
        (remaining) =>
          this.writeCleanupInventory(source, cleanup.rootIdentity, remaining),
      );
      this.clearJournal();
    } finally {
      release();
    }
  }

  recoverPreSwitch(source: ManagedModelStore): void {
    const location = this.readLocation();
    if (location.sourceStoreId !== source.storeId) {
      throw new Error("迁移恢复记录与当前模型目录不匹配");
    }
    assertFileSystemIdentity(source.root, location.sourceIdentity);
    this.store.assertDistinctTopology(source.root, location.target);
    if (
      location.staging !==
      `${location.target}.migration-${location.operationId}`
    ) {
      throw new Error("迁移恢复暂存目录无效");
    }
    const residue = exists(location.staging)
      ? location.staging
      : exists(location.target)
        ? location.target
        : null;
    if (residue) {
      if (!location.stagingIdentity) {
        throw new Error("迁移恢复缺少暂存目录身份");
      }
      assertFileSystemIdentity(residue, location.stagingIdentity);
      const actual = scanInventory(residue);
      if (!sameInventoryStructure(actual, location.ownedInventory)) {
        throw new Error("迁移恢复目录内容已变化");
      }
      verifyInventoryHashesSync(residue, location.ownedInventory);
      removeScannedRoot(
        residue,
        location.ownedInventory,
        location.stagingIdentity,
      );
    }
    this.clearJournal();
  }

  private throwIfCanceled(): void {
    if (this.cancelRequested) throw new Error("模型目录迁移已取消");
  }

  private publishJournal(
    operationId: string,
    phase: MigrationPhase,
    source: string,
    target: string,
  ): void {
    writeJsonAtomically(path.join(this.store.metadataRoot, "migration.json"), {
      schemaVersion: 1,
      operationId,
      phase,
      sourceIdentity: pathIdentity(source),
      targetIdentity: pathIdentity(target),
    });
  }

  private clearJournal(): void {
    try {
      unlinkSync(path.join(this.store.metadataRoot, "migration.json"));
    } catch {
      // Missing journal is already clear.
    }
    try {
      unlinkSync(path.join(this.store.metadataRoot, "cleanup.json"));
    } catch {
      // Missing cleanup inventory is already clear.
    }
    try {
      unlinkSync(path.join(this.store.metadataRoot, "migration-location.json"));
    } catch {
      // Missing location metadata is already clear.
    }
  }

  private publishLocation(payload: MigrationLocation): void {
    writeJsonAtomically(
      path.join(this.store.metadataRoot, "migration-location.json"),
      { ...payload, checksum: locationChecksum(payload) },
    );
  }

  private readLocation(): MigrationLocation {
    const decoded = JSON.parse(
      readFileSync(
        path.join(this.store.metadataRoot, "migration-location.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const payload = {
      schemaVersion: decoded.schemaVersion,
      operationId: decoded.operationId,
      sourceStoreId: decoded.sourceStoreId,
      target: decoded.target,
      staging: decoded.staging,
      sourceIdentity: decoded.sourceIdentity,
      stagingIdentity: decoded.stagingIdentity,
      ownedInventory: decoded.ownedInventory,
    };
    if (
      payload.schemaVersion !== 1 ||
      typeof payload.operationId !== "string" ||
      !/^migration-[a-zA-Z0-9-]{12,120}$/.test(payload.operationId) ||
      typeof payload.sourceStoreId !== "string" ||
      !/^store-[a-zA-Z0-9-]{12,120}$/.test(payload.sourceStoreId) ||
      typeof payload.target !== "string" ||
      !path.isAbsolute(payload.target) ||
      typeof payload.staging !== "string" ||
      !path.isAbsolute(payload.staging) ||
      !validFileSystemIdentity(payload.sourceIdentity) ||
      !(
        payload.stagingIdentity === null ||
        validFileSystemIdentity(payload.stagingIdentity)
      ) ||
      !Array.isArray(payload.ownedInventory) ||
      decoded.checksum !== locationChecksum(payload)
    ) {
      throw new Error("迁移恢复位置记录无效");
    }
    return {
      ...payload,
      sourceIdentity: payload.sourceIdentity as FileSystemIdentity,
      stagingIdentity: payload.stagingIdentity as FileSystemIdentity | null,
      ownedInventory: (payload.ownedInventory as unknown[]).map((item) =>
        parseInventoryItem(item),
      ),
    } as MigrationLocation;
  }

  private writeCleanupInventory(
    source: ManagedModelStore,
    rootIdentity: FileSystemIdentity,
    inventory: readonly InventoryItem[],
  ): void {
    writeJsonAtomically(path.join(this.store.metadataRoot, "cleanup.json"), {
      schemaVersion: 1,
      storeId: source.storeId,
      rootIdentity,
      inventory,
    });
  }

  private readCleanupInventory(source: ManagedModelStore): {
    rootIdentity: FileSystemIdentity;
    inventory: InventoryItem[];
  } {
    const decoded = JSON.parse(
      readFileSync(path.join(this.store.metadataRoot, "cleanup.json"), "utf8"),
    ) as {
      schemaVersion?: unknown;
      storeId?: unknown;
      rootIdentity?: unknown;
      inventory?: unknown;
    };
    if (
      decoded.schemaVersion !== 1 ||
      decoded.storeId !== source.storeId ||
      !validFileSystemIdentity(decoded.rootIdentity) ||
      !Array.isArray(decoded.inventory)
    ) {
      throw new Error("旧模型清理清单无效");
    }
    return {
      rootIdentity: decoded.rootIdentity as FileSystemIdentity,
      inventory: decoded.inventory.map((item) => parseInventoryItem(item)),
    };
  }
}

interface InventoryItem {
  relativePath: string;
  kind: "file" | "directory";
  bytes: number;
  sha256?: string;
}

function parseInventoryItem(value: unknown): InventoryItem {
  const item = value as Partial<InventoryItem>;
  if (
    typeof item.relativePath !== "string" ||
    !item.relativePath ||
    path.isAbsolute(item.relativePath) ||
    item.relativePath.split(path.sep).some((part) => part === "..") ||
    !["file", "directory"].includes(String(item.kind)) ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes! < 0 ||
    (item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256))
  ) {
    throw new Error("旧模型清理清单无效");
  }
  return item as InventoryItem;
}

function scanInventory(root: string): InventoryItem[] {
  const canonical = realpathSync(root);
  const rootIdentity = fileSystemIdentity(canonical);
  const values: InventoryItem[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.dev !== rootIdentity.device) {
        throw new Error("模型目录包含其他文件系统，无法安全迁移或清理");
      }
      if (stat.isSymbolicLink() || (entry.isFile() && stat.nlink !== 1)) {
        throw new Error("模型目录包含链接，无法安全迁移");
      }
      const relativePath = path.relative(canonical, candidate);
      if (entry.isDirectory()) {
        values.push({ relativePath, kind: "directory", bytes: 0 });
        visit(candidate);
      } else if (entry.isFile()) {
        values.push({ relativePath, kind: "file", bytes: stat.size });
      } else {
        throw new Error("模型目录包含不支持的文件类型");
      }
    }
  };
  visit(canonical);
  return values;
}

function removeScannedRoot(
  root: string,
  inventory: readonly InventoryItem[],
  rootIdentity: FileSystemIdentity,
  onProgress?: (remaining: readonly InventoryItem[]) => void,
): void {
  assertFileSystemIdentity(root, rootIdentity);
  const canonical = realpathSync(root);
  const remaining = [...inventory];
  const deletionOrder = [...inventory].sort((left, right) => {
    const leftMarker = left.relativePath === ".voice2text-model-store.json";
    const rightMarker = right.relativePath === ".voice2text-model-store.json";
    if (leftMarker !== rightMarker) return leftMarker ? 1 : -1;
    const depthDifference =
      right.relativePath.split(path.sep).length -
      left.relativePath.split(path.sep).length;
    if (depthDifference !== 0) return depthDifference;
    if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
    return right.relativePath.localeCompare(left.relativePath);
  });
  for (const item of deletionOrder) {
    const candidate = path.join(canonical, item.relativePath);
    const stat = lstatSync(candidate);
    if (
      stat.dev !== rootIdentity.device ||
      stat.isSymbolicLink() ||
      (item.kind === "file" && stat.nlink !== 1)
    ) {
      throw new Error("清理前模型目录身份发生变化");
    }
    if (item.kind === "file") unlinkSync(candidate);
    else rmdirSync(candidate);
    remaining.splice(
      remaining.findIndex(
        (candidateItem) => candidateItem.relativePath === item.relativePath,
      ),
      1,
    );
    onProgress?.(remaining);
  }
  rmdirSync(canonical);
}

async function removeOwnedRoot(
  root: string,
  rootIdentity: FileSystemIdentity,
  inventory: readonly InventoryItem[],
): Promise<void> {
  assertFileSystemIdentity(root, rootIdentity);
  const actual = scanInventory(root);
  if (!sameInventoryStructure(actual, inventory)) {
    throw new Error("迁移目录内容已变化，拒绝自动清理");
  }
  await verifyInventoryHashes(root, inventory);
  removeScannedRoot(root, inventory, rootIdentity);
}

function fileSystemIdentity(candidate: string): FileSystemIdentity {
  const stat = lstatSync(realpathSync(candidate));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("模型目录身份无效");
  }
  return { device: stat.dev, inode: stat.ino };
}

function validFileSystemIdentity(value: unknown): boolean {
  const identity = value as Partial<FileSystemIdentity> | null;
  return Boolean(
    identity &&
    Number.isSafeInteger(identity.device) &&
    Number.isSafeInteger(identity.inode) &&
    identity.device! >= 0 &&
    identity.inode! > 0,
  );
}

function assertFileSystemIdentity(
  candidate: string,
  expected: FileSystemIdentity,
): void {
  const actual = fileSystemIdentity(candidate);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("模型目录文件系统身份已变化");
  }
}

function sameInventoryStructure(
  actual: readonly InventoryItem[],
  expected: readonly InventoryItem[],
): boolean {
  return (
    JSON.stringify(actual.map(withoutHash)) ===
    JSON.stringify(expected.map(withoutHash))
  );
}

function withoutHash(item: InventoryItem): Omit<InventoryItem, "sha256"> {
  return {
    relativePath: item.relativePath,
    kind: item.kind,
    bytes: item.bytes,
  };
}

function isInventorySubset(
  actual: readonly InventoryItem[],
  expected: readonly InventoryItem[],
): boolean {
  const expectedItems = new Map(
    expected.map((item) => [item.relativePath, withoutHash(item)]),
  );
  return actual.every((item) => {
    const expectedItem = expectedItems.get(item.relativePath);
    return (
      expectedItem !== undefined &&
      JSON.stringify(withoutHash(item)) === JSON.stringify(expectedItem)
    );
  });
}

function withExpectedHashes(
  actual: readonly InventoryItem[],
  expected: readonly InventoryItem[],
): InventoryItem[] {
  const hashes = new Map(
    expected.map((item) => [item.relativePath, item.sha256]),
  );
  return actual.map((item) => ({
    ...item,
    sha256: hashes.get(item.relativePath),
  }));
}

async function verifyInventoryHashes(
  root: string,
  inventory: readonly InventoryItem[],
): Promise<void> {
  for (const item of inventory) {
    if (item.kind !== "file" || !item.sha256) continue;
    if (
      (await sha256File(path.join(root, item.relativePath))) !== item.sha256
    ) {
      throw new Error("旧模型目录文件内容已变化，拒绝自动清理");
    }
  }
}

function verifyInventoryHashesSync(
  root: string,
  inventory: readonly InventoryItem[],
): void {
  for (const item of inventory) {
    if (item.kind !== "file" || !item.sha256) continue;
    const digest = createHash("sha256")
      .update(readFileSync(path.join(root, item.relativePath)))
      .digest("hex");
    if (digest !== item.sha256) {
      throw new Error("迁移恢复目录文件内容已变化");
    }
  }
}

function pathIdentity(candidate: string): string {
  return createHash("sha256").update(path.resolve(candidate)).digest("hex");
}

function locationChecksum(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function exists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
