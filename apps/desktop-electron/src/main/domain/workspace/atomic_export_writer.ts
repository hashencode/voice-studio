import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

interface AtomicExportHooks {
  beforeRename?: () => Promise<void>;
}

export async function writeExportAtomically(
  destination: string,
  contents: string,
  hooks: AtomicExportHooks = {},
): Promise<void> {
  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await hooks.beforeRename?.();
    await rename(temporary, destination);
    published = true;
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}
