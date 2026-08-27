import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deepSeekPath = resolve(appRoot, "assets/model-providers/deepseek.svg");

describe("model provider icon assets", () => {
  it("pins the audited DeepSeek SVG and rejects active or external content", () => {
    const source = readFileSync(deepSeekPath, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "da7ea009ae25b2cac7b84ab96212567954c9e4edeb2a1f946a0224208dbce8c2",
    );
    const inspectable = source.replace(
      /\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/u,
      "",
    );
    expect(inspectable).not.toMatch(
      /<script|\son[a-z]+\s*=|foreignObject|\b(?:href|xlink:href)\s*=|<!ENTITY|@import|https?:\/\//iu,
    );
    expect(
      readFileSync(
        resolve(appRoot, "assets/licenses/lobe-icons-MIT.txt"),
        "utf8",
      ),
    ).toContain("Copyright (c) 2023 LobeHub");
    expect(
      readFileSync(
        resolve(appRoot, "assets/model-providers/ASSET_PROVENANCE.md"),
        "utf8",
      ),
    ).toContain("v5.16.0");
  });
});
