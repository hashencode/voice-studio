import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const identity = packageJson.electronDev;

function prepareRuntime() {
  if (
    !identity ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(identity.appId) ||
    /^(com\.github\.electron|com\.electron\.app)$/i.test(identity.appId) ||
    typeof identity.productName !== "string" ||
    !identity.productName.trim()
  ) {
    throw new Error(
      "electronDev requires a unique appId and a productName in package.json",
    );
  }
  if (process.platform !== "darwin") return;

  const require = createRequire(path.join(projectRoot, "package.json"));
  const electronRoot = path.dirname(require.resolve("electron/package.json"));
  const checkoutRoot = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim(),
  );
  const dependencyPath = path.relative(
    checkoutRoot,
    realpathSync(electronRoot),
  );
  if (
    dependencyPath.startsWith(`..${path.sep}`) ||
    dependencyPath === ".." ||
    path.isAbsolute(dependencyPath)
  ) {
    throw new Error(
      "Electron must be installed in the active checkout, not another repository or worktree",
    );
  }
  const sourceApp = path.join(electronRoot, "dist", "Electron.app");
  if (!existsSync(sourceApp))
    throw new Error(
      "Install this project's Electron dependency before starting it",
    );
  const sourcePlist = path.join(sourceApp, "Contents", "Info.plist");
  // Keep the original dependency intact and exclude the copy from packaged apps.
  const checkoutKey = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 12);
  const runtimeRoot = path.join(
    electronRoot,
    ".project-dev",
    checkoutKey,
    identity.appId,
  );
  const runtimeApp = path.join(runtimeRoot, "Electron.app");
  const stampPath = path.join(runtimeRoot, "identity.json");
  const stamp = JSON.stringify({
    preparationHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    version: JSON.parse(
      readFileSync(path.join(electronRoot, "package.json"), "utf8"),
    ).version,
    sourcePlist: createHash("sha256")
      .update(readFileSync(sourcePlist))
      .digest("hex"),
    identity,
    projectRoot,
  });

  mkdirSync(path.dirname(runtimeRoot), { recursive: true });
  const lockFd = openSync(`${runtimeRoot}.lock`, "a");
  try {
    // The inherited descriptor keeps the OS lock until close, even after lockf exits.
    execFileSync("/usr/bin/lockf", ["-t", "30", "3"], {
      stdio: ["ignore", "pipe", "pipe", lockFd],
    });
    if (
      !existsSync(runtimeApp) ||
      !existsSync(stampPath) ||
      readFileSync(stampPath, "utf8") !== stamp
    ) {
      rmSync(runtimeRoot, { recursive: true, force: true });
      mkdirSync(runtimeRoot, { recursive: true });
      cpSync(sourceApp, runtimeApp, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });

      const readPlist = (plist, key) =>
        execFileSync(
          "/usr/bin/plutil",
          ["-extract", key, "raw", "-o", "-", plist],
          {
            encoding: "utf8",
          },
        ).trim();
      const setPlist = (plist, key, value) =>
        execFileSync("/usr/bin/plutil", [
          "-replace",
          key,
          "-string",
          value,
          plist,
        ]);
      const originalId = readPlist(sourcePlist, "CFBundleIdentifier");
      const frameworks = path.join(runtimeApp, "Contents", "Frameworks");
      for (const name of readdirSync(frameworks).filter((name) =>
        name.endsWith(".app"),
      )) {
        const helperApp = path.join(frameworks, name);
        const helperPlist = path.join(helperApp, "Contents", "Info.plist");
        const helperId = readPlist(helperPlist, "CFBundleIdentifier");
        if (!helperId.startsWith(`${originalId}.`))
          throw new Error(`Unexpected Electron helper identity: ${helperId}`);
        setPlist(
          helperPlist,
          "CFBundleIdentifier",
          identity.appId + helperId.slice(originalId.length),
        );
      }
      const runtimePlist = path.join(runtimeApp, "Contents", "Info.plist");
      setPlist(runtimePlist, "CFBundleIdentifier", identity.appId);
      setPlist(runtimePlist, "CFBundleName", identity.productName);
      setPlist(runtimePlist, "CFBundleDisplayName", identity.productName);
      // Distributed Electron binaries can omit nested resource signatures.
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "--deep",
        "--preserve-metadata=entitlements,flags,runtime",
        runtimeApp,
      ]);
      execFileSync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        runtimeApp,
      ]);
      writeFileSync(stampPath, stamp);
    }
  } finally {
    closeSync(lockFd);
  }
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", runtimeApp],
  );
  return runtimeRoot;
}

try {
  const runtimeRoot = prepareRuntime();
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(
      JSON.stringify({
        ...identity,
        runtimeApp: runtimeRoot && path.join(runtimeRoot, "Electron.app"),
      }),
    );
  } else {
    // Bun resolves package CLIs, including their Windows launch shims.
    const packageCommand = !path.isAbsolute(command);
    const child = spawn(
      packageCommand ? process.execPath : command,
      packageCommand ? ["run", command, ...args] : args,
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...(runtimeRoot && {
            ELECTRON_OVERRIDE_DIST_PATH: runtimeRoot,
            ELECTRON_EXEC_PATH: path.join(
              runtimeRoot,
              "Electron.app",
              "Contents",
              "MacOS",
              "Electron",
            ),
          }),
        },
        stdio: "inherit",
      },
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) =>
      process.exit(code ?? (signal === "SIGINT" ? 130 : 143)),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
