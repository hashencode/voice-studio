import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasVerifiedLiveCaptionCapability } from "../../src/main/domain/capture/capture_capability";
import {
  assertAuthorizedResourceCommand,
  ResourceCatalog,
} from "../../src/main/resources/resource_catalog";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("worker resource publication", () => {
  it("keeps disposable materialization staging separate from the shared cache", () => {
    const builder = readFileSync(
      resolve("scripts/build-worker-resources.sh"),
      "utf8",
    );
    const materializer = readFileSync(
      resolve("scripts/materialize-frozen-sherpa-resources.ts"),
      "utf8",
    );

    expect(builder).toContain('materialization_root="$(mktemp -d');
    expect(builder).not.toContain("RESOURCE_CACHE_DIR");
    expect(materializer).toContain("new ResourceDownloadCache()");
    expect(materializer).not.toContain("freshDownload(");
  });

  it("exposes guarded UI, code, and release verification lanes", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    const releaseGuard = readFileSync(
      resolve("scripts/check-release.sh"),
      "utf8",
    );

    expect(packageJson.scripts["check:ui:quick"]).not.toMatch(
      /playwright|test:visual|electron-forge|resources:|bun run package/,
    );
    expect(packageJson.scripts["check:ui"]).toBe("bun run check:ui:quick");
    expect(packageJson.scripts["check:ui"]).not.toMatch(
      /playwright|test:visual|electron-forge|resources:|bun run package|audio_sidebar_release_candidate/,
    );
    expect(packageJson.scripts["check:ui:visual"]).toBe("bun run test:visual");
    expect(packageJson.scripts["check:ui:visual:update"]).toBe(
      "bun run test:visual -- --update-snapshots",
    );
    expect(packageJson.scripts["check:code"]).toBe("bun run check");
    expect(packageJson.scripts["check:release"]).toBe(
      "bash scripts/check-release.sh",
    );
    expect(releaseGuard).toContain("VOICE2TEXT_RELEASE_VALIDATION");
    expect(releaseGuard).toContain("audio_sidebar_release_candidate.py");
  });

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
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    ) as {
      artifacts: Array<{ path: string; sha256: string }>;
      operations: Array<Record<string, unknown>>;
    };
    expect(
      manifest.artifacts.every((item) => !item.path.startsWith("models/")),
    ).toBe(true);
    const formalRoot = mkdtempSync(join(tmpdir(), "formal-model-authority-"));
    const liveRoot = mkdtempSync(join(tmpdir(), "live-model-authority-"));
    roots.push(formalRoot, liveRoot);
    const formalPaths = artifactPaths
      .filter(
        (item) =>
          item.startsWith("models/asr/") ||
          item.startsWith("models/diarization/"),
      )
      .map((item) => item.slice("models/".length));
    const livePaths = artifactPaths
      .filter((item) => item.startsWith("models/live-caption/"))
      .map((item) => item.slice("models/live-caption/".length));
    for (const [authorityRoot, paths] of [
      [formalRoot, formalPaths],
      [liveRoot, livePaths],
    ] as const) {
      mkdirSync(authorityRoot, { recursive: true });
      writeFileSync(join(authorityRoot, "installed.json"), "{}\n");
      for (const relativePath of paths) {
        const destination = join(authorityRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        const sourcePrefix =
          authorityRoot === liveRoot ? "models/live-caption/" : "models/";
        writeFileSync(destination, `fixture:${sourcePrefix}${relativePath}`);
      }
    }
    rmSync(join(root, "models"), { recursive: true });
    const catalog = await ResourceCatalog.load(root);
    const authority = (
      bundleId: "formal-transcription" | "live-caption",
      authorityRoot: string,
      paths: readonly string[],
    ) => ({
      bundleId,
      root: authorityRoot,
      identity: `${bundleId}-identity`,
      artifacts: paths.map((relativePath) => ({
        path: relativePath,
        sha256: createHash("sha256")
          .update(readFileSync(join(authorityRoot, relativePath)))
          .digest("hex"),
      })),
    });
    catalog.installModelAuthority(
      authority("formal-transcription", formalRoot, formalPaths),
    );
    catalog.installModelAuthority(
      authority("live-caption", liveRoot, livePaths),
    );
    const command = catalog.command("live-caption", {
      attemptOutput: join(root, "..", "caption-attempt"),
    });
    expect(command.executable).toBe(
      join(root, "bin/desktop_sensevoice_caption_worker"),
    );
    expect(command.args).toContain(
      `--model=${join(realpathSync(liveRoot), "model.int8.onnx")}`,
    );
    expect(
      manifest.operations.find(
        (operation) => operation.operation === "live-caption",
      ),
    ).toMatchObject({
      workerReportedModelArtifact: "model.int8.onnx",
      modelBundleId: "live-caption",
    });
    const liveCaptionIdentity = catalog.processingIdentity("live-caption");
    expect(liveCaptionIdentity).toEqual({
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      resourceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      modelSha256: createHash("sha256")
        .update("fixture:models/live-caption/model.int8.onnx")
        .digest("hex"),
      runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(hasVerifiedLiveCaptionCapability(catalog)).toBe(true);
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

    writeFileSync(join(liveRoot, "model.int8.onnx"), "replacement");
    await expect(assertAuthorizedResourceCommand(command)).rejects.toThrow(
      /artifact hash mismatch/i,
    );
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
          "packages/desktop_sherpa_worker/assets/processing/frozen_sherpa_macos_arm64.json",
        ),
        join(root, "output"),
        join(repositoryRoot, "pubspec.lock"),
        root,
        join(
          repositoryRoot,
          "packages/desktop_sherpa_worker/assets/processing/frozen_sensevoice_macos_arm64.json",
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
          "packages/desktop_sherpa_worker/assets/processing/frozen_sherpa_macos_arm64.json",
        ),
        join(root, "output"),
        join(repositoryRoot, "pubspec.lock"),
        root,
        join(
          repositoryRoot,
          "packages/desktop_sherpa_worker/assets/processing/frozen_sensevoice_macos_arm64.json",
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
