import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { desktopWorkerHealthProtocol } from "../src/shared/contracts";
import {
  assertMacOSArm64ResourceHost,
  macOSArm64ResourceTarget,
} from "./resource_target";
import { sha256FileWithShasum } from "./shasum_file";

assertMacOSArm64ResourceHost();

const root = path.resolve(process.argv[2] ?? "resources/worker");

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
            "--asset-root={modelRoot}",
            "--fixture-root={attemptOutput}",
            "--model={modelRoot}/model.int8.onnx",
            `--model-sha256=${artifactSha256("models/live-caption/model.int8.onnx")}`,
            "--tokens={modelRoot}/tokens.txt",
            `--tokens-sha256=${artifactSha256("models/live-caption/tokens.txt")}`,
            "--vad={modelRoot}/silero_vad.onnx",
            `--vad-sha256=${artifactSha256("models/live-caption/silero_vad.onnx")}`,
            '--control-json={"provider":"cpu","threads":2,"concurrency":1,"decodingMethod":"greedy_search","language":"auto","useInverseTextNormalization":false,"recognizerLifecycle":"resident_preloaded","vadThreshold":0.5,"minimumSpeechSeconds":0.25,"minimumSilenceSeconds":0.5,"maximumUtteranceSeconds":15,"publishesTokenPartials":false,"publishesCompletedUtterancesOnly":true}',
          ],
          modelArtifacts: ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"],
          workerReportedModelArtifact: "model.int8.onnx",
          runtimeArtifacts: [
            "runtime/libonnxruntime.1.27.0.dylib",
            "runtime/libsherpa-onnx-c-api.dylib",
            "runtime/libsherpa-onnx-cxx-api.dylib",
          ],
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
            "{modelRoot}/asr/silero_vad.onnx",
          ],
          modelArtifacts: [
            "asr/conv_frontend.onnx",
            "asr/encoder.int8.onnx",
            "asr/decoder.int8.onnx",
            "asr/tokenizer/tokenizer_config.json",
            "asr/tokenizer/merges.txt",
            "asr/tokenizer/vocab.json",
            "asr/silero_vad.onnx",
            "diarization/segmentation.onnx",
            "diarization/embedding.onnx",
          ],
          runtimeArtifacts: [
            "runtime/libonnxruntime.1.27.0.dylib",
            "runtime/libsherpa-onnx-c-api.dylib",
            "runtime/libsherpa-onnx-cxx-api.dylib",
          ],
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
            "{modelRoot}/diarization/segmentation.onnx",
            "--embedding",
            "{modelRoot}/diarization/embedding.onnx",
          ],
          modelArtifacts: [
            "asr/conv_frontend.onnx",
            "asr/encoder.int8.onnx",
            "asr/decoder.int8.onnx",
            "asr/tokenizer/tokenizer_config.json",
            "asr/tokenizer/merges.txt",
            "asr/tokenizer/vocab.json",
            "asr/silero_vad.onnx",
            "diarization/segmentation.onnx",
            "diarization/embedding.onnx",
          ],
          runtimeArtifacts: [
            "runtime/libonnxruntime.1.27.0.dylib",
            "runtime/libsherpa-onnx-c-api.dylib",
            "runtime/libsherpa-onnx-cxx-api.dylib",
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
