import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
