import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { desktopWorkerHealthProtocol } from "../src/shared/contracts";
import {
  assertMacOSArm64ResourceHost,
  macOSArm64ResourceTarget,
} from "./resource_target";
import { sha256FileWithShasum } from "./shasum_file";

assertMacOSArm64ResourceHost();

const root = path.resolve(process.argv[2] ?? "resources/worker");
const frozenModelHashes = await readFrozenModelHashes(
  process.argv[3],
  process.argv[4],
);

const runtimeLibraries = [
  "runtime/libonnxruntime.1.27.0.dylib",
  "runtime/libsherpa-onnx-c-api.dylib",
  "runtime/libsherpa-onnx-cxx-api.dylib",
] as const;
const formalModelArtifacts = [
  "asr/conv_frontend.onnx",
  "asr/encoder.int8.onnx",
  "asr/decoder.int8.onnx",
  "asr/tokenizer/tokenizer_config.json",
  "asr/tokenizer/merges.txt",
  "asr/tokenizer/vocab.json",
] as const;
const formalRuntimeArtifacts = [
  ...runtimeLibraries,
  "auxiliary/silero_vad.onnx",
  "auxiliary/pyannote-segmentation/model.onnx",
  "auxiliary/3d-speaker/embedding.onnx",
] as const;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return await files(candidate);
      return entry.name === "manifest.json" ? [] : [candidate];
    }),
  );
  return nested.flat().sort();
}

const allArtifacts: Array<{ path: string; sha256: string }> = [];
const artifactFiles = await files(root);
for (let index = 0; index < artifactFiles.length; index += 4) {
  allArtifacts.push(
    ...(await Promise.all(
      artifactFiles.slice(index, index + 4).map(async (file) => ({
        path: path.relative(root, file),
        sha256: await sha256FileWithShasum(file),
      })),
    )),
  );
}
const artifactSha256 = (relativePath: string): string => {
  const artifact = allArtifacts.find(
    (candidate) => candidate.path === relativePath,
  );
  if (!artifact) throw new Error(`worker artifact is missing: ${relativePath}`);
  return artifact.sha256;
};
const modelArtifactSha256 = (relativePath: string): string => {
  const staged = allArtifacts.find(
    (candidate) => candidate.path === `models/${relativePath}`,
  );
  const sha256 = staged?.sha256 ?? frozenModelHashes.get(relativePath);
  if (!sha256) throw new Error(`model authority is missing: ${relativePath}`);
  return sha256;
};
const artifacts = allArtifacts.filter(
  (artifact) => !artifact.path.startsWith("models/"),
);
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target: macOSArm64ResourceTarget,
      workerProtocol: desktopWorkerHealthProtocol,
      artifacts,
      operations: [
        {
          operation: "worker-health",
          executable: "bin/desktop_sherpa_worker",
          arguments: ["--phase", "health", "--runtime-root", "{runtimeRoot}"],
        },
        {
          operation: "live-caption",
          modelBundleId: "live-caption",
          executable: "bin/desktop_sensevoice_caption_worker",
          protocolIdentity: "sensevoice-live-caption-worker/v1",
          arguments: [
            "--runtime-root={runtimeRoot}",
            "--model-root={modelRoot}",
            "--asset-root={resourceRoot}",
            "--fixture-root={attemptOutput}",
            "--model={modelRoot}/model.int8.onnx",
            `--model-sha256=${modelArtifactSha256("live-caption/model.int8.onnx")}`,
            "--tokens={modelRoot}/tokens.txt",
            `--tokens-sha256=${modelArtifactSha256("live-caption/tokens.txt")}`,
            "--vad={resourceRoot}/auxiliary/silero_vad.onnx",
            `--vad-sha256=${artifactSha256("auxiliary/silero_vad.onnx")}`,
            '--control-json={"provider":"cpu","threads":2,"concurrency":1,"decodingMethod":"greedy_search","language":"auto","useInverseTextNormalization":false,"recognizerLifecycle":"resident_preloaded","vadThreshold":0.5,"minimumSpeechSeconds":0.25,"minimumSilenceSeconds":0.5,"maximumUtteranceSeconds":15,"publishesTokenPartials":false,"publishesCompletedUtterancesOnly":true}',
          ],
          modelArtifacts: ["model.int8.onnx", "tokens.txt"],
          workerReportedModelArtifact: "model.int8.onnx",
          runtimeArtifacts: [...runtimeLibraries, "auxiliary/silero_vad.onnx"],
        },
        {
          operation: "asr",
          modelBundleId: "formal-transcription",
          executable: "bin/desktop_sherpa_worker",
          protocolIdentity: "desktop-sherpa-worker/v1",
          arguments: [
            "--phase",
            "asr",
            "--runtime-root",
            "{runtimeRoot}",
            "--num-threads",
            "2",
            "--max-total-len",
            "512",
            "--max-new-tokens",
            "512",
            "--temperature",
            "0.000001",
            "--top-p",
            "0.8",
            "--seed",
            "42",
            "--segment-duration-seconds",
            "15",
            "--asr-segmentation",
            "official_silero_vad",
            "--vad-threshold",
            "0.2",
            "--minimum-speech-seconds",
            "0.2",
            "--maximum-speech-seconds",
            "12",
            "--conv-frontend",
            "{modelRoot}/asr/conv_frontend.onnx",
            "--encoder",
            "{modelRoot}/asr/encoder.int8.onnx",
            "--decoder",
            "{modelRoot}/asr/decoder.int8.onnx",
            "--tokenizer",
            "{modelRoot}/asr/tokenizer",
            "--vad",
            "{resourceRoot}/auxiliary/silero_vad.onnx",
          ],
          modelArtifacts: formalModelArtifacts,
          runtimeArtifacts: formalRuntimeArtifacts,
        },
        {
          operation: "diarization",
          modelBundleId: "formal-transcription",
          executable: "bin/desktop_sherpa_worker",
          protocolIdentity: "desktop-sherpa-worker/v1",
          arguments: [
            "--phase",
            "diarization",
            "--runtime-root",
            "{runtimeRoot}",
            "--num-threads",
            "2",
            "--diarization-threshold",
            "0.65",
            "--segmentation",
            "{resourceRoot}/auxiliary/pyannote-segmentation/model.onnx",
            "--embedding",
            "{resourceRoot}/auxiliary/3d-speaker/embedding.onnx",
          ],
          modelArtifacts: formalModelArtifacts,
          runtimeArtifacts: formalRuntimeArtifacts,
        },
      ],
    },
    null,
    2,
  )}\n`,
);

async function readFrozenModelHashes(
  sherpaAuthorityPath?: string,
  senseVoiceAuthorityPath?: string,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (sherpaAuthorityPath) {
    const authority = JSON.parse(
      await readFile(path.resolve(sherpaAuthorityPath), "utf8"),
    ) as { files?: Array<{ relativePath?: unknown; sha256?: unknown }> };
    for (const file of authority.files ?? []) {
      if (
        typeof file.relativePath === "string" &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        hashes.set(file.relativePath, file.sha256);
      }
    }
  }
  if (senseVoiceAuthorityPath) {
    const authority = JSON.parse(
      await readFile(path.resolve(senseVoiceAuthorityPath), "utf8"),
    ) as {
      model?: {
        modelRelativePath?: unknown;
        modelSha256?: unknown;
        tokensRelativePath?: unknown;
        tokensSha256?: unknown;
      };
    };
    const model = authority.model;
    if (
      typeof model?.modelRelativePath === "string" &&
      typeof model.modelSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(model.modelSha256)
    ) {
      hashes.set(`live-caption/${model.modelRelativePath}`, model.modelSha256);
    }
    if (
      typeof model?.tokensRelativePath === "string" &&
      typeof model.tokensSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(model.tokensSha256)
    ) {
      hashes.set(
        `live-caption/${model.tokensRelativePath}`,
        model.tokensSha256,
      );
    }
  }
  return hashes;
}
