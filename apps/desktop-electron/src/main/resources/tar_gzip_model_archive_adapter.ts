import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { extract, type Header } from "tar-stream";

import type {
  ArchiveMember,
  StreamingArchiveAdapter,
} from "./model_archive_extractor";

interface QueuedEntry {
  member: ArchiveMember;
  continue(): Promise<void>;
}

export class TarGzipModelArchiveAdapter implements StreamingArchiveAdapter {
  async *members(archivePath: string): AsyncIterable<ArchiveMember> {
    const archive = createReadStream(archivePath);
    const gunzip = createGunzip();
    const unpack = extract();
    const entries: QueuedEntry[] = [];
    let wake: (() => void) | null = null;
    let terminalError: unknown;
    let completed = false;

    const notify = () => {
      wake?.();
      wake = null;
    };
    unpack.on("entry", (header, stream, next) => {
      let opened = false;
      let consumed = false;
      const consumedPromise = new Promise<void>((resolve, reject) => {
        stream.once("end", () => {
          consumed = true;
          resolve();
        });
        stream.once("error", reject);
      });
      const kind = archiveMemberKind(header.type);
      const name =
        kind === "directory" ? header.name.replace(/\/+$/, "") : header.name;
      entries.push({
        member: {
          path: name,
          kind,
          size: header.size ?? 0,
          ...(kind === "file"
            ? {
                open: async function* () {
                  if (opened) throw new Error("archive member already opened");
                  opened = true;
                  for await (const chunk of stream) {
                    yield Buffer.isBuffer(chunk)
                      ? chunk
                      : Buffer.from(chunk as Uint8Array);
                  }
                },
              }
            : {}),
        },
        async continue() {
          if (!opened && !consumed) stream.resume();
          await consumedPromise;
          next();
        },
      });
      notify();
    });
    unpack.once("finish", () => {
      completed = true;
      notify();
    });
    const transfer = pipeline(archive, gunzip, unpack).catch((error) => {
      terminalError = error;
      completed = true;
      notify();
    });

    try {
      while (true) {
        if (entries.length === 0) {
          if (completed) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const entry = entries.shift()!;
        yield entry.member;
        await entry.continue();
      }
      await transfer;
      if (terminalError) throw terminalError;
    } finally {
      archive.destroy();
      gunzip.destroy();
      unpack.destroy();
    }
  }
}

function archiveMemberKind(type: Header["type"]): ArchiveMember["kind"] {
  switch (type) {
    case "file":
    case "contiguous-file":
      return "file";
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "link":
      return "hardlink";
    default:
      return "special";
  }
}
