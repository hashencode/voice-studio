import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

const artifacts = await Promise.all(
  (await files(root)).map(async (file) => ({
    path: path.relative(root, file),
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  })),
);
await writeFile(
  path.join(root, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target: `darwin-${process.arch}`,
      workerProtocol: "desktop-sherpa-worker-health/v1",
      artifacts,
    },
    null,
    2,
  )}\n`,
);
