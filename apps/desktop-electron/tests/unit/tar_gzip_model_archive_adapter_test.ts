import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { extractTrustedModelArchive } from "../../src/main/resources/model_archive_extractor";
import { TarGzipModelArchiveAdapter } from "../../src/main/resources/tar_gzip_model_archive_adapter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("tar gzip model archive adapter", () => {
  it("streams a normalized tar.gz archive through exact inventory validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-tar-gzip-model-"));
    roots.push(root);
    const model = Buffer.from("fixture model bytes");
    const archivePath = join(root, "model.tar.gz");
    writeFileSync(archivePath, gzipSync(await fixtureTar(model)));

    await extractTrustedModelArchive({
      archivePath,
      stagingRoot: join(root, "staging"),
      adapter: new TarGzipModelArchiveAdapter(),
      inventory: [
        {
          path: "model/model.bin",
          bytes: model.byteLength,
          sha256: createHash("sha256").update(model).digest("hex"),
        },
      ],
    });

    expect(readFileSync(join(root, "staging/model/model.bin"))).toEqual(model);
  });
});

async function fixtureTar(model: Buffer): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: unknown) => {
    chunks.push(Buffer.from(chunk as Uint8Array));
  });
  const completed = new Promise<void>((resolve, reject) => {
    archive.once("end", resolve);
    archive.once("error", reject);
  });
  archive.entry({ name: "model/", type: "directory", mode: 0o755 });
  archive.entry(
    { name: "model/model.bin", type: "file", size: model.byteLength },
    model,
  );
  archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}
