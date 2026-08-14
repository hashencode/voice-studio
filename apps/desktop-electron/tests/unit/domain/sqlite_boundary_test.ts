import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { globSync } from "node:fs";

describe("SQLite write boundary", () => {
  it("keeps SQLite imports out of Renderer, Preload, domain, and helpers", () => {
    const applicationRoot = join(import.meta.dirname, "../../..");
    const forbiddenRoots = [
      join(applicationRoot, "src/renderer"),
      join(applicationRoot, "src/preload"),
      join(applicationRoot, "src/main/domain"),
      join(applicationRoot, "src/main/native"),
      join(applicationRoot, "src/main/helpers"),
    ];
    const offenders = forbiddenRoots.flatMap((root) =>
      globSync("**/*.{ts,tsx,js,mjs}", { cwd: root })
        .filter((path) =>
          /(?:node:sqlite|DatabaseSync|sqlite3|better-sqlite3)/.test(
            readFileSync(join(root, path), "utf8"),
          ),
        )
        .map((path) => relative(applicationRoot, join(root, path))),
    );

    expect(offenders).toEqual([]);
  });
});
