import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { desktopWorkerHealthProtocol } from "../src/shared/contracts";

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

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const artifacts: Array<{ path: string; sha256: string }> = [];
const artifactFiles = await files(root);
for (let index = 0; index < artifactFiles.length; index += 4) {
  artifacts.push(
    ...(await Promise.all(
      artifactFiles.slice(index, index + 4).map(async (file) => ({
        path: path.relative(root, file),
        sha256: await sha256(file),
      })),
    )),
  );
}
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target: `darwin-${process.arch}`,
      workerProtocol: desktopWorkerHealthProtocol,
      artifacts,
      operations: [
        {
          operation: "worker-health",
          executable: "bin/desktop_sherpa_worker",
          arguments: ["--phase", "health", "--runtime-root", "{runtimeRoot}"],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
