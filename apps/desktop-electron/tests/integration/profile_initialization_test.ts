import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeElectronProfile,
  profilePathsForApplicationData,
} from "../../src/main/profile/electron_profile";
import { ELECTRON_SCHEMA_VERSION } from "../../src/main/storage/database";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "voice2text-profile-init-"));
  temporaryRoots.push(root);
  return root;
}

function requireReady(result: ReturnType<typeof initializeElectronProfile>) {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}

describe("Electron-only profile initialization", () => {
  it("atomically publishes ready only after every required v1 asset exists", () => {
    const applicationDataRoot = temporaryRoot();
    const result = requireReady(initializeElectronProfile(applicationDataRoot));

    try {
      expect(result.profile.root).toBe(
        join(applicationDataRoot, "voice2text-electron", "v1"),
      );
      for (const directory of result.profile.requiredDirectories) {
        expect(existsSync(directory)).toBe(true);
      }
      expect(existsSync(result.profile.databasePath)).toBe(true);
      expect(existsSync(result.profile.readyMarkerPath)).toBe(true);
      expect(
        JSON.parse(readFileSync(result.profile.readyMarkerPath, "utf8")),
      ).toEqual(
        expect.objectContaining({
          schema: "voice2text-electron-profile-ready/v1",
          databaseSchemaVersion: ELECTRON_SCHEMA_VERSION,
          status: "ready",
        }),
      );
    } finally {
      result.database.close();
    }
  });

  it("resumes a partial directory initialization without discarding its data", () => {
    const applicationDataRoot = temporaryRoot();
    const profile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(profile.mediaDirectory, { recursive: true });
    const preserved = join(profile.mediaDirectory, "preserved.wav");
    writeFileSync(preserved, "electron-owned-media");

    const result = requireReady(initializeElectronProfile(applicationDataRoot));
    try {
      expect(readFileSync(preserved, "utf8")).toBe("electron-owned-media");
      expect(existsSync(result.profile.readyMarkerPath)).toBe(true);
    } finally {
      result.database.close();
    }
  });

  it("keeps disk-full and path-permission failures blocked and retryable", () => {
    const diskRoot = temporaryRoot();
    const blocked = initializeElectronProfile(diskRoot, {
      minimumFreeBytes: 1024n,
      freeSpaceProbe: () => 1023n,
    });
    expect(blocked).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "insufficient_space",
        repairable: true,
      }),
    );
    expect(
      existsSync(profilePathsForApplicationData(diskRoot).readyMarkerPath),
    ).toBe(false);

    const retried = requireReady(
      initializeElectronProfile(diskRoot, {
        minimumFreeBytes: 1024n,
        freeSpaceProbe: () => 2048n,
      }),
    );
    retried.database.close();

    const collisionRoot = temporaryRoot();
    writeFileSync(
      join(collisionRoot, "voice2text-electron"),
      "not-a-directory",
    );
    const collision = initializeElectronProfile(collisionRoot);
    expect(collision).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "filesystem_unavailable",
        repairable: true,
      }),
    );
  });

  it("does not publish ready for interrupted migration or corrupt schema", () => {
    const migrationRoot = temporaryRoot();
    const migrationProfile = profilePathsForApplicationData(migrationRoot);
    mkdirSync(migrationProfile.databaseDirectory, { recursive: true });
    const incomplete = new DatabaseSync(migrationProfile.databasePath);
    incomplete.exec("CREATE TABLE meetings (id INTEGER PRIMARY KEY)");
    incomplete.close();

    const interrupted = initializeElectronProfile(migrationRoot);
    expect(interrupted).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "schema_invalid",
        repairable: true,
      }),
    );
    expect(existsSync(migrationProfile.readyMarkerPath)).toBe(false);

    const corruptRoot = temporaryRoot();
    const corruptProfile = profilePathsForApplicationData(corruptRoot);
    mkdirSync(corruptProfile.databaseDirectory, { recursive: true });
    writeFileSync(corruptProfile.databasePath, "not sqlite");
    const corrupt = initializeElectronProfile(corruptRoot);
    expect(corrupt).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "schema_invalid",
        repairable: true,
      }),
    );
    expect(existsSync(corruptProfile.readyMarkerPath)).toBe(false);
  });

  it("rejects profile symlinks that escape the application-data root", () => {
    const applicationDataRoot = temporaryRoot();
    const external = temporaryRoot();
    const container = join(applicationDataRoot, "voice2text-electron");
    mkdirSync(container);
    symlinkSync(external, join(container, "v1"), "dir");

    expect(initializeElectronProfile(applicationDataRoot)).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "path_escape",
        repairable: true,
      }),
    );
    expect(existsSync(join(external, ".profile-ready.json"))).toBe(false);
  });

  it("rejects a database symlink before it can mutate an external target", () => {
    const applicationDataRoot = temporaryRoot();
    const external = temporaryRoot();
    const profile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(profile.databaseDirectory, { recursive: true });
    const externalDatabase = join(external, "outside.sqlite3");
    symlinkSync(externalDatabase, profile.databasePath, "file");

    expect(initializeElectronProfile(applicationDataRoot)).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "path_escape",
        repairable: true,
      }),
    );
    expect(existsSync(externalDatabase)).toBe(false);
  });

  it("does not inspect, copy, lock, or mutate a Flutter Desktop sibling", () => {
    const applicationDataRoot = temporaryRoot();
    const flutterRoot = join(applicationDataRoot, "flutter-desktop");
    mkdirSync(flutterRoot);
    const poison = join(flutterRoot, "profile.lock");
    writeFileSync(poison, "flutter-profile-must-stay-untouched");

    const result = requireReady(initializeElectronProfile(applicationDataRoot));
    result.database.close();

    expect(readFileSync(poison, "utf8")).toBe(
      "flutter-profile-must-stay-untouched",
    );
  });
});
