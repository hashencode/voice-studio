import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { desktopWorkerHealthProtocol } from "../src/shared/contracts";

export interface PackagedSmokeReceipt {
  schemaVersion: number;
  appVersion: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  worker: {
    protocolVersion: number;
    protocol: string;
    runtime: string;
    workerSha256: string;
  };
  appSha256: string;
}

export async function runPackagedMacosSmoke(): Promise<PackagedSmokeReceipt> {
  const appRoot = path.resolve("out/Voice2Text-darwin-arm64/Voice2Text.app");
  const executable = path.join(appRoot, "Contents/MacOS/Voice2Text");
  const temporaryRoot = await mkdtemp(
    path.join(await realpath(os.homedir()), ".voice2text-app-bootstrap-"),
  );
  const processTemporaryPath = path.join(temporaryRoot, "tmp");
  const appDataPath = path.join(processTemporaryPath, "app-data");
  const evidencePath = path.join(processTemporaryPath, "evidence");
  const receiptPath = path.join(
    evidencePath,
    `voice2text-bootstrap-${randomUUID()}.json`,
  );
  await mkdir(appDataPath, { recursive: true, mode: 0o700 });
  await mkdir(evidencePath, { mode: 0o700 });
  try {
    const child = spawn(executable, [], {
      cwd: os.tmpdir(),
      env: {
        HOME: temporaryRoot,
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: processTemporaryPath,
        VOICE2TEXT_BOOTSTRAP_SMOKE_APP_DATA: appDataPath,
        VOICE2TEXT_BOOTSTRAP_SMOKE_OUTPUT: receiptPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("packaged bootstrap smoke timed out"));
      }, 30_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    if (exitCode !== 0) {
      throw new Error(`packaged app exited with ${exitCode}`);
    }

    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Omit<
      PackagedSmokeReceipt,
      "appSha256"
    >;
    if (
      receipt.worker?.protocol !== desktopWorkerHealthProtocol ||
      !/^[a-f0-9]{64}$/.test(receipt.worker.workerSha256 ?? "")
    ) {
      throw new Error("packaged worker health receipt is invalid");
    }
    const appSha256 = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
    return { ...receipt, appSha256 };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(await runPackagedMacosSmoke(), null, 2));
}
