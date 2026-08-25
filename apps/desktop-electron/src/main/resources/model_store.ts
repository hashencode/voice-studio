import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import type { LocalModelBundleId } from "../../shared/contracts";
import { writeJsonAtomically } from "../profile/atomic_json";

const markerName = ".voice2text-model-store.json";
const bundleDirectories: Record<LocalModelBundleId, string> = {
  "formal-transcription": "formal-transcription",
  "live-caption": "live-caption",
};

interface PointerPayload {
  schemaVersion: 1;
  generation: number;
  storeId: string;
  root: string;
}

interface PointerSlot extends PointerPayload {
  checksum: string;
}

export interface ManagedModelStore extends PointerPayload {
  markerPath: string;
  bundlesRoot: string;
  stagingRoot: string;
}

export class ModelStore {
  readonly metadataRoot: string;

  constructor(private readonly userDataRoot: string) {
    this.metadataRoot = path.join(userDataRoot, "local-models");
    mkdirSync(this.metadataRoot, { recursive: true, mode: 0o700 });
  }

  createDefaultRoot(): ManagedModelStore {
    return this.createManagedRoot(
      path.join(this.userDataRoot, "managed-model-store"),
      { adoptEmpty: true },
    );
  }

  createManagedRoot(
    requestedPath: string,
    options: { adoptEmpty?: boolean } = {},
  ): ManagedModelStore {
    const resolvedRequest = path.resolve(requestedPath);
    if (
      exists(resolvedRequest) &&
      lstatSync(resolvedRequest).isSymbolicLink()
    ) {
      throw new Error("模型位置不能是符号链接");
    }
    const requested = exists(resolvedRequest)
      ? realpathSync(resolvedRequest)
      : canonicalForTopology(resolvedRequest);
    assertNoSymlinkAncestors(requested);
    let root = requested;
    if (exists(requested)) {
      const stat = lstatSync(requested);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("模型位置必须是普通目录");
      }
      const entries = readdirSync(requested);
      if (entries.length > 0 && !entries.includes(markerName)) {
        root = path.join(requested, "Voice2Text Models");
      } else if (entries.length > 0 && entries.includes(markerName)) {
        return this.openManagedRoot(requested);
      } else if (!options.adoptEmpty) {
        root = path.join(requested, "Voice2Text Models");
      }
    }
    if (exists(root) && readdirSync(root).length > 0) {
      throw new Error("目标模型目录不是空目录，无法接管");
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(root);
    assertNoSymlinkAncestors(canonical);
    const storeId = `store-${randomUUID()}`;
    writeJsonAtomically(path.join(canonical, markerName), {
      schemaVersion: 1,
      storeId,
    });
    mkdirSync(path.join(canonical, "bundles"), { mode: 0o700 });
    mkdirSync(path.join(canonical, ".staging", "downloads"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(path.join(canonical, ".staging", "migration"), {
      recursive: true,
      mode: 0o700,
    });
    return this.describe(canonical, storeId, 0);
  }

  resolveSelectionPath(requestedPath: string): string {
    const resolved = path.resolve(requestedPath);
    if (exists(resolved) && lstatSync(resolved).isSymbolicLink()) {
      throw new Error("模型位置不能是符号链接");
    }
    const canonical = exists(resolved)
      ? realpathSync(resolved)
      : canonicalForTopology(resolved);
    assertNoSymlinkAncestors(canonical);
    if (!exists(canonical)) return canonical;
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("模型位置必须是普通目录");
    }
    const entries = readdirSync(canonical);
    return entries.includes(markerName)
      ? canonical
      : path.join(canonical, "Voice2Text Models");
  }

  selectedStore(): ManagedModelStore | null {
    const latest = this.readLatestPayload();
    return latest
      ? this.describe(latest.root, latest.storeId, latest.generation)
      : null;
  }

  openManagedRoot(rootPath: string, generation = 0): ManagedModelStore {
    const canonical = realpathSync(path.resolve(rootPath));
    assertNoSymlinkAncestors(canonical);
    const markerPath = path.join(canonical, markerName);
    const markerStat = lstatSync(markerPath);
    if (
      !markerStat.isFile() ||
      markerStat.isSymbolicLink() ||
      markerStat.nlink !== 1
    ) {
      throw new Error("模型目录标记无效");
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      schemaVersion?: unknown;
      storeId?: unknown;
    };
    if (
      marker.schemaVersion !== 1 ||
      typeof marker.storeId !== "string" ||
      !/^store-[a-zA-Z0-9-]{12,120}$/.test(marker.storeId)
    ) {
      throw new Error("模型目录标记损坏");
    }
    return this.describe(canonical, marker.storeId, generation);
  }

  readActive(): ManagedModelStore | null {
    const slots = ["pointer-a.json", "pointer-b.json"]
      .map((name) => this.readPointerSlot(path.join(this.metadataRoot, name)))
      .filter((value): value is PointerPayload => value !== null)
      .sort((left, right) => right.generation - left.generation);
    if (slots.length === 0) return null;
    if (
      slots.length === 2 &&
      slots[0]!.generation === slots[1]!.generation &&
      (slots[0]!.root !== slots[1]!.root ||
        slots[0]!.storeId !== slots[1]!.storeId)
    ) {
      throw new Error("模型位置记录冲突，需要恢复");
    }
    const active = slots[0]!;
    const store = this.openManagedRoot(active.root, active.generation);
    if (store.storeId !== active.storeId) {
      throw new Error("所选磁盘的模型目录身份已变化");
    }
    return store;
  }

  readPrevious(active: ManagedModelStore): ManagedModelStore | null {
    const previous = ["pointer-a.json", "pointer-b.json"]
      .map((name) => this.readPointerSlot(path.join(this.metadataRoot, name)))
      .filter((value): value is PointerPayload => value !== null)
      .filter(
        (value) =>
          value.generation < active.generation &&
          value.root !== active.root &&
          value.storeId === active.storeId,
      )
      .sort((left, right) => right.generation - left.generation)[0];
    if (!previous) return null;
    try {
      return this.openManagedRoot(previous.root, previous.generation);
    } catch {
      return null;
    }
  }

  publishActive(store: ManagedModelStore): ManagedModelStore {
    const current = this.readLatestPayload();
    const payload: PointerPayload = {
      schemaVersion: 1,
      generation: Math.max(store.generation, current?.generation ?? 0) + 1,
      storeId: store.storeId,
      root: store.root,
    };
    const target = path.join(
      this.metadataRoot,
      payload.generation % 2 === 0 ? "pointer-a.json" : "pointer-b.json",
    );
    writeJsonAtomically(target, { ...payload, checksum: checksum(payload) });
    return this.describe(payload.root, payload.storeId, payload.generation);
  }

  bundleRoot(store: ManagedModelStore, bundleId: LocalModelBundleId): string {
    return contained(
      store.root,
      path.join(store.bundlesRoot, bundleDirectories[bundleId]),
    );
  }

  assertDistinctTopology(source: string, target: string): void {
    const left = canonicalForTopology(source);
    const right = canonicalForTopology(target);
    if (left === right || isInside(left, right) || isInside(right, left)) {
      throw new Error("新旧模型目录不能相同、重叠或互为父子目录");
    }
  }

  private readLatestPayload(): PointerPayload | null {
    return (
      ["pointer-a.json", "pointer-b.json"]
        .map((name) => this.readPointerSlot(path.join(this.metadataRoot, name)))
        .filter((value): value is PointerPayload => value !== null)
        .sort((left, right) => right.generation - left.generation)[0] ?? null
    );
  }

  private readPointerSlot(slotPath: string): PointerPayload | null {
    if (!exists(slotPath)) return null;
    try {
      const slot = JSON.parse(readFileSync(slotPath, "utf8")) as PointerSlot;
      const payload: PointerPayload = {
        schemaVersion: slot.schemaVersion,
        generation: slot.generation,
        storeId: slot.storeId,
        root: slot.root,
      };
      if (
        payload.schemaVersion !== 1 ||
        !Number.isSafeInteger(payload.generation) ||
        payload.generation < 1 ||
        !/^store-[a-zA-Z0-9-]{12,120}$/.test(payload.storeId) ||
        !path.isAbsolute(payload.root) ||
        slot.checksum !== checksum(payload)
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private describe(
    root: string,
    storeId: string,
    generation: number,
  ): ManagedModelStore {
    return Object.freeze({
      schemaVersion: 1 as const,
      generation,
      storeId,
      root,
      markerPath: path.join(root, markerName),
      bundlesRoot: path.join(root, "bundles"),
      stagingRoot: path.join(root, ".staging"),
    });
  }
}

function checksum(payload: PointerPayload): string {
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

function assertNoSymlinkAncestors(candidate: string): void {
  let current = path.parse(candidate).root;
  for (const segment of path.relative(current, candidate).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (!exists(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("模型目录不能包含符号链接");
    }
  }
}

function canonicalForTopology(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (exists(resolved)) return realpathSync(resolved);
  let ancestor = path.dirname(resolved);
  while (!exists(ancestor) && ancestor !== path.dirname(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  return path.join(realpathSync(ancestor), path.relative(ancestor, resolved));
}

function contained(root: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved)) throw new Error("模型路径超出托管目录");
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
