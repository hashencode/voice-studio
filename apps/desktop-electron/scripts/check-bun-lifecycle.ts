import { spawnSync } from "node:child_process";

const result = spawnSync("bun", ["pm", "untrusted"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.status !== 0 || !output.includes("Found 0 untrusted dependencies")) {
  process.stderr.write(output);
  throw new Error("Bun lifecycle audit found unexplained blocked scripts");
}
console.log("Bun lifecycle audit passed.");
