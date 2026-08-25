import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { sha256File } from "../security/sha256_file";

export interface ArchiveMember {
  path: string;
  kind: "file" | "directory" | "symlink" | "hardlink" | "special";
  size: number;
  open?(): AsyncIterable<Uint8Array>;
}

export interface StreamingArchiveAdapter {
  members(archivePath: string): AsyncIterable<ArchiveMember>;
}

export interface ExpectedModelFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** Validates every member before opening its byte stream. */
export async function extractTrustedModelArchive(options: {
  archivePath: string;
  stagingRoot: string;
  adapter: StreamingArchiveAdapter;
  inventory: readonly ExpectedModelFile[];
  maximumMembers?: number;
  maximumExpandedBytes?: number;
}): Promise<void> {
  mkdirSync(options.stagingRoot, { recursive: false, mode: 0o700 });
  const canonicalRoot = realpathSync(options.stagingRoot);
  const expected = new Map(options.inventory.map((item) => [item.path, item]));
  const expectedDirectories = new Set(
    options.inventory.flatMap((item) => {
      const directories: string[] = [];
      let current = path.posix.dirname(item.path);
      while (current !== ".") {
        directories.push(current);
        current = path.posix.dirname(current);
      }
      return directories;
    }),
  );
  const seenCaseFolded = new Set<string>();
  let members = 0;
  let expandedBytes = 0;
  for await (const member of options.adapter.members(options.archivePath)) {
    members += 1;
    if (members > (options.maximumMembers ?? 10_000)) {
      throw new Error("模型压缩包文件数量超出限制");
    }
    const relative = safeArchivePath(member.path);
    const folded = relative.normalize("NFC").toLocaleLowerCase("en-US");
    if (seenCaseFolded.has(folded)) {
      throw new Error("模型压缩包包含重复或大小写冲突路径");
    }
    seenCaseFolded.add(folded);
    if (member.kind === "directory") {
      if (!expectedDirectories.has(relative)) {
        throw new Error("模型压缩包与可信目录清单不一致");
      }
      mkdirSync(contained(canonicalRoot, relative), {
        recursive: true,
        mode: 0o700,
      });
      continue;
    }
    if (member.kind !== "file" || !member.open) {
      throw new Error("模型压缩包包含链接或特殊文件");
    }
    const expectedFile = expected.get(relative);
    if (!expectedFile || expectedFile.bytes !== member.size) {
      throw new Error("模型压缩包与可信清单不一致");
    }
    const destination = contained(canonicalRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    let memberBytes = 0;
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        memberBytes += chunk.byteLength;
        expandedBytes += chunk.byteLength;
        if (memberBytes > expectedFile.bytes) {
          callback(new Error("模型压缩包成员超过可信大小"));
        } else if (
          expandedBytes > (options.maximumExpandedBytes ?? 16 * 1024 ** 3)
        ) {
          callback(new Error("模型压缩包展开大小超出限制"));
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(
        Readable.from(member.open()),
        byteLimit,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      try {
        unlinkSync(destination);
      } catch {
        // The destination may not have been created yet.
      }
      throw error;
    }
    const stat = lstatSync(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== member.size
    ) {
      throw new Error("模型文件发布前身份校验失败");
    }
    if ((await sha256File(destination)) !== expectedFile.sha256) {
      throw new Error("模型文件哈希与可信清单不一致");
    }
    expected.delete(relative);
  }
  if (expected.size > 0) {
    throw new Error("模型压缩包缺少可信清单文件");
  }
}

function safeArchivePath(value: string): string {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((segment) => !segment || segment === ".." || segment === ".")
  ) {
    throw new Error("模型压缩包包含不安全路径");
  }
  return value;
}

function contained(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  const relation = path.relative(root, candidate);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("模型文件超出安装暂存目录");
  }
  return candidate;
}
