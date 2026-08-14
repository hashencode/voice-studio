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

const artifacts: Array<{ path: string; sha256: string }> = [];
const artifactFiles = await files(root);
for (let index = 0; index < artifactFiles.length; index += 4) {
  artifacts.push(
    ...(await Promise.all(
      artifactFiles.slice(index, index + 4).map(async (file) => ({
        path: path.relative(root, file),
        sha256: await sha256FileWithShasum(file),
      })),
    )),
  );
}
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
          operation: "asr",
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
            "{resourceRoot}/models/asr/conv_frontend.onnx",
            "--encoder",
            "{resourceRoot}/models/asr/encoder.int8.onnx",
            "--decoder",
            "{resourceRoot}/models/asr/decoder.int8.onnx",
            "--tokenizer",
            "{resourceRoot}/models/asr/tokenizer",
            "--vad",
            "{resourceRoot}/models/asr/silero_vad.onnx",
          ],
          modelArtifacts: [
            "models/asr/conv_frontend.onnx",
            "models/asr/encoder.int8.onnx",
            "models/asr/decoder.int8.onnx",
            "models/asr/tokenizer/tokenizer_config.json",
            "models/asr/tokenizer/merges.txt",
            "models/asr/tokenizer/vocab.json",
            "models/asr/silero_vad.onnx",
            "models/diarization/segmentation.onnx",
            "models/diarization/embedding.onnx",
          ],
          runtimeArtifacts: [
            "runtime/libonnxruntime.1.27.0.dylib",
            "runtime/libsherpa-onnx-c-api.dylib",
            "runtime/libsherpa-onnx-cxx-api.dylib",
          ],
        },
        {
          operation: "diarization",
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
            "{resourceRoot}/models/diarization/segmentation.onnx",
            "--embedding",
            "{resourceRoot}/models/diarization/embedding.onnx",
          ],
          modelArtifacts: [
            "models/asr/conv_frontend.onnx",
            "models/asr/encoder.int8.onnx",
            "models/asr/decoder.int8.onnx",
            "models/asr/tokenizer/tokenizer_config.json",
            "models/asr/tokenizer/merges.txt",
            "models/asr/tokenizer/vocab.json",
            "models/asr/silero_vad.onnx",
            "models/diarization/segmentation.onnx",
            "models/diarization/embedding.onnx",
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
