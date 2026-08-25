import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalModelService } from "../../src/main/resources/local_model_service";
import {
  extractTrustedModelArchive,
  type StreamingArchiveAdapter,
} from "../../src/main/resources/model_archive_extractor";
import { ModelDownloadCoordinator } from "../../src/main/resources/model_download_coordinator";
import { ModelLeaseCoordinator } from "../../src/main/resources/model_lease_coordinator";
import { ModelMigrationCoordinator } from "../../src/main/resources/model_migration_coordinator";
import { ModelStore } from "../../src/main/resources/model_store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `voice2text-${label}-`));
  roots.push(root);
  return root;
}

describe("managed local model authority", () => {
  it("creates a private child instead of adopting an ordinary non-empty directory", () => {
    const userData = temporaryRoot("model-store-user-data");
    const selected = temporaryRoot("model-store-selected");
    writeFileSync(join(selected, "personal.txt"), "keep me");
    const store = new ModelStore(userData);

    const managed = store.createManagedRoot(selected);

    expect(managed.root).toBe(
      join(realpathSync(selected), "Voice2Text Models"),
    );
    expect(readFileSync(join(selected, "personal.txt"), "utf8")).toBe(
      "keep me",
    );
    expect(existsSync(managed.markerPath)).toBe(true);
    expect(() => store.assertDistinctTopology(managed.root, selected)).toThrow(
      /不能相同、重叠/,
    );
  });

  it("blocks mutations while a Worker lease or processing task is active", () => {
    const gate = new ModelLeaseCoordinator();
    const lease = gate.acquire("formal-transcription", 4);
    expect(() => gate.beginMutation("delete")).toThrow(/正在被处理任务使用/);
    lease.release();
    const releaseTask = gate.beginProcessingTask();
    expect(() => gate.beginMutation("migration", { migration: true })).toThrow(
      /正在被处理任务使用/,
    );
    releaseTask();
    const releaseMutation = gate.beginMutation("migration", {
      migration: true,
    });
    expect(() => gate.acquire("live-caption", 4)).toThrow(/正在变更/);
    expect(() => gate.beginProcessingTask()).toThrow(/正在变更/);
    releaseMutation();
    expect(gate.snapshot.idle).toBe(true);
  });

  it("validates archive members before writing and publishes only exact files", async () => {
    const root = temporaryRoot("model-archive");
    const bytes = Buffer.from("trusted model");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const valid: StreamingArchiveAdapter = {
      async *members() {
        yield {
          path: "model.bin",
          kind: "file" as const,
          size: bytes.byteLength,
          async *open() {
            yield bytes;
          },
        };
      },
    };
    await extractTrustedModelArchive({
      archivePath: join(root, "fixture.archive"),
      stagingRoot: join(root, "valid"),
      adapter: valid,
      inventory: [{ path: "model.bin", bytes: bytes.byteLength, sha256 }],
    });
    expect(readFileSync(join(root, "valid", "model.bin"))).toEqual(bytes);

    const traversal: StreamingArchiveAdapter = {
      async *members() {
        yield { path: "../escape", kind: "file" as const, size: 1 };
      },
    };
    await expect(
      extractTrustedModelArchive({
        archivePath: join(root, "fixture.archive"),
        stagingRoot: join(root, "traversal"),
        adapter: traversal,
        inventory: [],
      }),
    ).rejects.toThrow(/不安全路径/);

    const link: StreamingArchiveAdapter = {
      async *members() {
        yield { path: "model.bin", kind: "symlink" as const, size: 0 };
      },
    };
    await expect(
      extractTrustedModelArchive({
        archivePath: join(root, "fixture.archive"),
        stagingRoot: join(root, "link"),
        adapter: link,
        inventory: [],
      }),
    ).rejects.toThrow(/链接或特殊文件/);
    const oversized: StreamingArchiveAdapter = {
      async *members() {
        yield {
          path: "model.bin",
          kind: "file" as const,
          size: 1,
          async *open() {
            yield Buffer.from("too large");
          },
        };
      },
    };
    await expect(
      extractTrustedModelArchive({
        archivePath: join(root, "fixture.archive"),
        stagingRoot: join(root, "oversized"),
        adapter: oversized,
        inventory: [
          {
            path: "model.bin",
            bytes: 1,
            sha256: createHash("sha256").update("x").digest("hex"),
          },
        ],
      }),
    ).rejects.toThrow(/超过可信大小/);
    expect(existsSync(join(root, "oversized", "model.bin"))).toBe(false);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  it("copies, verifies, switches, probes, and only then removes the old root", async () => {
    const userData = temporaryRoot("model-migration-user-data");
    const destinationParent = temporaryRoot("model-migration-target");
    const store = new ModelStore(userData);
    const source = store.publishActive(store.createDefaultRoot());
    const modelFile = join(
      source.bundlesRoot,
      "formal-transcription",
      "model.bin",
    );
    mkdirSync(join(source.bundlesRoot, "formal-transcription"), {
      recursive: true,
    });
    writeFileSync(modelFile, "migration authority");
    const target = join(destinationParent, "Voice2Text Models");
    const phases: string[] = [];
    const migration = new ModelMigrationCoordinator(
      store,
      new ModelLeaseCoordinator(),
    );

    const result = await migration.migrate({
      source,
      targetPath: target,
      onProgress: (progress) => phases.push(progress.phase ?? "unknown"),
      probe: async (candidate) => {
        expect(
          readFileSync(
            join(
              candidate.root,
              "bundles",
              "formal-transcription",
              "model.bin",
            ),
            "utf8",
          ),
        ).toBe("migration authority");
        expect(existsSync(source.root)).toBe(true);
      },
    });

    expect(result.cleanupRequired).toBe(false);
    expect(store.readActive()?.root).toBe(result.store.root);
    expect(existsSync(source.root)).toBe(false);
    expect(phases).toEqual(
      expect.arrayContaining([
        "preparing",
        "copying",
        "verifying",
        "switching",
        "probing",
        "cleaning",
      ]),
    );
  });

  it("refuses cleanup retry when the old managed root gains an unknown file", async () => {
    const userData = temporaryRoot("cleanup-identity-user-data");
    const destinationParent = temporaryRoot("cleanup-identity-target");
    const store = new ModelStore(userData);
    const source = store.publishActive(store.createDefaultRoot());
    const migration = new ModelMigrationCoordinator(
      store,
      new ModelLeaseCoordinator(),
    );
    const result = await migration.migrate({
      source,
      targetPath: join(destinationParent, "Voice2Text Models"),
      onProgress: () => undefined,
      probe: async () => {
        writeFileSync(join(source.root, "unknown.txt"), "do not delete");
      },
    });
    expect(result.cleanupRequired).toBe(true);
    expect(result.cleanupSource).not.toBeNull();
    await expect(migration.retryCleanup(result.cleanupSource!)).rejects.toThrow(
      /内容已变化/,
    );
    expect(readFileSync(join(source.root, "unknown.txt"), "utf8")).toBe(
      "do not delete",
    );
  });

  it("removes a verified pre-switch migration staging root during startup", async () => {
    const userData = temporaryRoot("migration-recovery-user-data");
    const targetParent = temporaryRoot("migration-recovery-target");
    const store = new ModelStore(userData);
    const source = store.publishActive(store.createDefaultRoot());
    const operationId = "migration-recovery-123456";
    const target = join(targetParent, "Voice2Text Models");
    const staging = `${target}.migration-${operationId}`;
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "partial.bin"), "partial");
    const sourceStat = lstatSync(source.root);
    const stagingStat = lstatSync(staging);
    const location = {
      schemaVersion: 1,
      operationId,
      sourceStoreId: source.storeId,
      target,
      staging,
      sourceIdentity: { device: sourceStat.dev, inode: sourceStat.ino },
      stagingIdentity: { device: stagingStat.dev, inode: stagingStat.ino },
      ownedInventory: [{ relativePath: "partial.bin", kind: "file", bytes: 7 }],
    };
    writeFileSync(
      join(store.metadataRoot, "migration-location.json"),
      JSON.stringify({
        ...location,
        checksum: createHash("sha256")
          .update(JSON.stringify(location))
          .digest("hex"),
      }),
    );
    writeFileSync(
      join(store.metadataRoot, "migration.json"),
      JSON.stringify({ schemaVersion: 1, operationId, phase: "copying" }),
    );
    const service = new LocalModelService({
      store,
      gate: new ModelLeaseCoordinator(),
      runtime: { state: "ready", message: "ready", identity: "runtime" },
    });

    const snapshot = await service.initialize();

    expect(snapshot.storage.state).toBe("ready");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(join(store.metadataRoot, "migration.json"))).toBe(false);
  });

  it("keeps production downloads closed until an eligible trusted catalog exists", async () => {
    const service = new LocalModelService({
      store: new ModelStore(temporaryRoot("local-model-service")),
      gate: new ModelLeaseCoordinator(),
      runtime: {
        state: "ready",
        message: "Worker Runtime 正常",
        identity: "runtime",
      },
    });
    const snapshot = await service.initialize();
    expect(
      snapshot.bundles.every((bundle) => !bundle.distributionEligible),
    ).toBe(true);
    await expect(
      service.intent({
        action: "download",
        bundleId: "formal-transcription",
        expectedRevision: snapshot.revision,
      }),
    ).rejects.toThrow(/正式模型下载尚未开放/);

    const downloader = new ModelDownloadCoordinator();
    const root = temporaryRoot("download-closed");
    await expect(
      downloader.download({
        entry: {
          bundleId: "formal-transcription",
          catalogIdentity: "catalog",
          url: "https://models.example.test/formal.tar",
          allowedOrigins: ["https://models.example.test"],
          archiveBytes: 1,
          archiveSha256: "a".repeat(64),
          distributionEligible: false,
        },
        partialPath: join(root, "partial"),
        journalPath: join(root, "journal.json"),
        completedPath: join(root, "archive"),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/尚未通过产品分发审核/);
  });

  it("rejects every redirect hop outside the trusted origin set", async () => {
    const root = temporaryRoot("download-redirect");
    const fetcher = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/model.tar" },
      });
    const downloader = new ModelDownloadCoordinator(fetcher as typeof fetch);
    await expect(
      downloader.download({
        entry: {
          bundleId: "formal-transcription",
          catalogIdentity: "catalog",
          url: "https://models.example.test/formal.tar",
          allowedOrigins: ["https://models.example.test"],
          archiveBytes: 1,
          archiveSha256: "a".repeat(64),
          distributionEligible: true,
        },
        partialPath: join(root, "partial"),
        journalPath: join(root, "journal.json"),
        completedPath: join(root, "archive"),
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/不受信任的重定向/);
  });

  it("resumes only a validator-bound partial response", async () => {
    const root = temporaryRoot("download-resume");
    const url = "https://models.example.test/formal.tar";
    const complete = Buffer.from("abcd");
    const partialPath = join(root, "partial");
    const journalPath = join(root, "journal.json");
    const completedPath = join(root, "archive");
    writeFileSync(partialPath, "ab");
    writeFileSync(
      journalPath,
      JSON.stringify({
        schemaVersion: 1,
        bundleId: "formal-transcription",
        catalogIdentity: "catalog",
        urlIdentity: createHash("sha256").update(url).digest("hex"),
        confirmedBytes: 2,
        etag: '"v1"',
        lastModified: null,
      }),
    );
    const requests: RequestInit[] = [];
    const fetcher = async (_input: unknown, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response("cd", {
        status: 206,
        headers: {
          etag: '"v1"',
          "content-range": "bytes 2-3/4",
        },
      });
    };
    const downloader = new ModelDownloadCoordinator(fetcher as typeof fetch);
    await downloader.download({
      entry: {
        bundleId: "formal-transcription",
        catalogIdentity: "catalog",
        url,
        allowedOrigins: ["https://models.example.test"],
        archiveBytes: complete.byteLength,
        archiveSha256: createHash("sha256").update(complete).digest("hex"),
        distributionEligible: true,
      },
      partialPath,
      journalPath,
      completedPath,
      onProgress: () => undefined,
    });
    expect(new Headers(requests[0]?.headers).get("range")).toBe("bytes=2-");
    expect(readFileSync(completedPath)).toEqual(complete);
    expect(existsSync(journalPath)).toBe(false);
  });
});
