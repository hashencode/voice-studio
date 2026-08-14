import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const rendererRoot = path.resolve("src/renderer");
const forbiddenImport =
  /(?:from\s+|import\s*\()\s*["'](?:electron|node:|fs(?:\/|["'])|path(?:\/|["'])|child_process(?:\/|["'])|sqlite3|better-sqlite3)/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(candidate);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [candidate] : [];
    }),
  );
  return nested.flat();
}

const violations: string[] = [];
for (const file of await sourceFiles(rendererRoot)) {
  const source = await readFile(file, "utf8");
  if (forbiddenImport.test(source) || /\bipcRenderer\b/.test(source)) {
    violations.push(path.relative(process.cwd(), file));
  }
}

if (violations.length > 0) {
  throw new Error(
    `Renderer privilege boundary violated: ${violations.join(", ")}`,
  );
}
console.log("Renderer privilege boundary passed.");
