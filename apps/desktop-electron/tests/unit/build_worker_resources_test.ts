import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ResourceCatalog } from "../../src/main/resources/resource_catalog";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("worker resource publication", () => {
  it("writes a verified live-caption operation into the worker manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-worker-manifest-"));
    roots.push(root);
    const artifactPaths = [
      "bin/desktop_sherpa_worker",
      "bin/desktop_sensevoice_caption_worker",
      "models/asr/conv_frontend.onnx",
      "models/asr/encoder.int8.onnx",
      "models/asr/decoder.int8.onnx",
      "models/asr/tokenizer/tokenizer_config.json",
      "models/asr/tokenizer/merges.txt",
      "models/asr/tokenizer/vocab.json",
      "models/asr/silero_vad.onnx",
      "models/diarization/segmentation.onnx",
      "models/diarization/embedding.onnx",
      "models/live-caption/model.int8.onnx",
      "models/live-caption/tokens.txt",
      "models/live-caption/silero_vad.onnx",
      "runtime/libonnxruntime.1.27.0.dylib",
      "runtime/libsherpa-onnx-c-api.dylib",
      "runtime/libsherpa-onnx-cxx-api.dylib",
    ];
    for (const relativePath of artifactPaths) {
      const artifactPath = join(root, relativePath);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, `fixture:${relativePath}`);
    }

    const result = spawnSync(
      "bun",
      [resolve("scripts/write-worker-manifest.ts"), root],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const catalog = await ResourceCatalog.load(root);
    const command = catalog.command("live-caption", {
      attemptOutput: join(root, "..", "caption-attempt"),
    });
    expect(command.executable).toBe(
      join(root, "bin/desktop_sensevoice_caption_worker"),
    );
    expect(command.args).toContain(
      `--model=${join(root, "models/live-caption/model.int8.onnx")}`,
    );
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    ) as {
      operations: Array<Record<string, unknown>>;
    };
    expect(
      manifest.operations.find(
        (operation) => operation.operation === "live-caption",
      ),
    ).toMatchObject({
      workerReportedModelArtifact: "models/live-caption/model.int8.onnx",
    });
    const liveCaptionIdentity = catalog.processingIdentity("live-caption");
    expect(liveCaptionIdentity).toEqual({
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      resourceIdentity: catalog.identity,
      modelSha256: createHash("sha256")
        .update("fixture:models/live-caption/model.int8.onnx")
        .digest("hex"),
      runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const processingPipeline = catalog.processingPipelineIdentities();
    expect(processingPipeline?.asr).toEqual(processingPipeline?.diarization);
    expect(processingPipeline?.asr.modelSha256).not.toBe(
      liveCaptionIdentity?.modelSha256,
    );
    const verified = spawnSync(
      "bun",
      [resolve("scripts/verify-worker-resources.ts"), root],
      { encoding: "utf8" },
    );
    expect(verified.status, verified.stderr).toBe(0);

    writeFileSync(
      join(root, "models/live-caption/model.int8.onnx"),
      "replacement",
    );
    const replaced = spawnSync(
      "bun",
      [resolve("scripts/verify-worker-resources.ts"), root],
      { encoding: "utf8" },
    );
    expect(replaced.status).not.toBe(0);
    expect(replaced.stderr).toMatch(/SHA-256 mismatch/i);
  });

  it("rejects a SenseVoice lock that is not bound to the frozen reference", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-electron-sherpa."));
    roots.push(root);
    const repositoryRoot = resolve("../..");
    const lock = JSON.parse(
      readFileSync(
        resolve("assets/processing/frozen_sensevoice_macos_arm64.lock.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    lock.frozenReferenceSha256 = "0".repeat(64);
    const lockPath = join(root, "sensevoice.lock.json");
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);

    const result = spawnSync(
      "bun",
      [
        resolve("scripts/materialize-frozen-sherpa-resources.ts"),
        join(
          repositoryRoot,
          "apps/desktop/assets/processing/frozen_sherpa_macos_arm64.json",
        ),
        join(root, "output"),
        join(repositoryRoot, "pubspec.lock"),
        root,
        join(
          repositoryRoot,
          "apps/desktop/assets/processing/frozen_sensevoice_macos_arm64.json",
        ),
        lockPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/reference hash disagrees with lock/i);
    expect(existsSync(join(root, "output"))).toBe(false);
  });

  it("rejects a SenseVoice lock for any target except darwin-arm64", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-electron-sherpa."));
    roots.push(root);
    const repositoryRoot = resolve("../..");
    const lock = JSON.parse(
      readFileSync(
        resolve("assets/processing/frozen_sensevoice_macos_arm64.lock.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    lock.target = "darwin-x64";
    const lockPath = join(root, "sensevoice.lock.json");
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);

    const result = spawnSync(
      "bun",
      [
        resolve("scripts/materialize-frozen-sherpa-resources.ts"),
        join(
          repositoryRoot,
          "apps/desktop/assets/processing/frozen_sherpa_macos_arm64.json",
        ),
        join(root, "output"),
        join(repositoryRoot, "pubspec.lock"),
        root,
        join(
          repositoryRoot,
          "apps/desktop/assets/processing/frozen_sensevoice_macos_arm64.json",
        ),
        lockPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/SenseVoice lock is invalid/i);
    expect(existsSync(join(root, "output"))).toBe(false);
  });

  it("restores the previous resource tree when signaled after the backup rename", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-resource-publish-"));
    roots.push(root);
    const workerRoot = join(root, "worker");
    const stagingRoot = join(root, ".worker-staging.test");
    mkdirSync(workerRoot);
    mkdirSync(stagingRoot);
    writeFileSync(join(workerRoot, "identity"), "previous");
    writeFileSync(join(stagingRoot, "identity"), "candidate");

    const result = spawnSync(
      "/bin/bash",
      [resolve("scripts/publish-worker-resources.sh"), stagingRoot, workerRoot],
      {
        env: {
          ...process.env,
          VOICE2TEXT_TEST_SIGNAL_AFTER_WORKER_BACKUP: "1",
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(143);
    expect(readFileSync(join(workerRoot, "identity"), "utf8")).toBe("previous");
    expect(readFileSync(join(stagingRoot, "identity"), "utf8")).toBe(
      "candidate",
    );
    expect(
      readdirSync(root).filter((name) => name.startsWith(".worker-previous.")),
    ).toEqual([]);
  });

  it("atomically installs the candidate and removes the backup", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-resource-publish-"));
    roots.push(root);
    const workerRoot = join(root, "worker");
    const stagingRoot = join(root, ".worker-staging.test");
    mkdirSync(workerRoot);
    mkdirSync(stagingRoot);
    writeFileSync(join(workerRoot, "identity"), "previous");
    writeFileSync(join(stagingRoot, "identity"), "candidate");

    const result = spawnSync(
      "/bin/bash",
      [resolve("scripts/publish-worker-resources.sh"), stagingRoot, workerRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(workerRoot, "identity"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(stagingRoot)).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.startsWith(".worker-previous.")),
    ).toEqual([]);
  });
});
