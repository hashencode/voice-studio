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
  initializeAudioProfile,
  profilePathsForApplicationData,
  resetAudioProfile,
} from "../../src/main/profile/audio_profile";
import { AUDIO_SCHEMA_VERSION } from "../../src/main/storage/audio_database";

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

function requireReady(result: ReturnType<typeof initializeAudioProfile>) {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}

describe("Electron-only profile initialization", () => {
  it("atomically publishes ready only after every required v2 asset exists", () => {
    const applicationDataRoot = temporaryRoot();
    const result = requireReady(initializeAudioProfile(applicationDataRoot));

    try {
      expect(result.profile.root).toBe(
        join(applicationDataRoot, "voice2text-electron", "v2"),
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
          databaseSchemaVersion: AUDIO_SCHEMA_VERSION,
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

    const result = requireReady(initializeAudioProfile(applicationDataRoot));
    try {
      expect(readFileSync(preserved, "utf8")).toBe("electron-owned-media");
      expect(existsSync(result.profile.readyMarkerPath)).toBe(true);
    } finally {
      result.database.close();
    }
  });

  it("keeps disk-full and path-permission failures blocked and retryable", () => {
    const diskRoot = temporaryRoot();
    const blocked = initializeAudioProfile(diskRoot, {
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
      initializeAudioProfile(diskRoot, {
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
    const collision = initializeAudioProfile(collisionRoot);
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
    incomplete.exec("CREATE TABLE audio_items (id INTEGER PRIMARY KEY)");
    incomplete.close();

    const interrupted = initializeAudioProfile(migrationRoot);
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
    const corrupt = initializeAudioProfile(corruptRoot);
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
    symlinkSync(external, join(container, "v2"), "dir");

    expect(initializeAudioProfile(applicationDataRoot)).toEqual(
      expect.objectContaining({
        status: "blocked",
        code: "path_escape",
        repairable: true,
      }),
    );
    expect(existsSync(join(external, ".audio-profile-ready.json"))).toBe(false);
  });

  it("rejects a database symlink before it can mutate an external target", () => {
    const applicationDataRoot = temporaryRoot();
    const external = temporaryRoot();
    const profile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(profile.databaseDirectory, { recursive: true });
    const externalDatabase = join(external, "outside.sqlite3");
    symlinkSync(externalDatabase, profile.databasePath, "file");

    expect(initializeAudioProfile(applicationDataRoot)).toEqual(
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

    const result = requireReady(initializeAudioProfile(applicationDataRoot));
    result.database.close();

    expect(readFileSync(poison, "utf8")).toBe(
      "flutter-profile-must-stay-untouched",
    );
  });

  it("resets both owned profile roots and rebuilds an empty current schema", () => {
    const applicationDataRoot = temporaryRoot();
    const externalRoot = temporaryRoot();
    const profile = profilePathsForApplicationData(applicationDataRoot);
    const initializingRoot = `${profile.root}.initializing`;
    const adjacentRoot = join(
      applicationDataRoot,
      "voice2text-electron",
      "local-models",
    );

    mkdirSync(profile.databaseDirectory, { recursive: true });
    const legacyDatabase = new DatabaseSync(profile.databasePath);
    legacyDatabase.exec(
      "CREATE TABLE legacy_audio_items (id INTEGER PRIMARY KEY); PRAGMA user_version = 1;",
    );
    legacyDatabase.close();
    writeFileSync(`${profile.databasePath}-wal`, "legacy-wal");
    writeFileSync(`${profile.databasePath}-shm`, "legacy-shm");
    mkdirSync(profile.mediaDirectory, { recursive: true });
    writeFileSync(join(profile.mediaDirectory, "legacy.wav"), "legacy-media");
    mkdirSync(profile.workspaceDirectory, { recursive: true });
    writeFileSync(
      join(profile.workspaceDirectory, "legacy.task"),
      "legacy-task",
    );
    writeFileSync(profile.readyMarkerPath, "legacy-ready-marker");

    mkdirSync(initializingRoot, { recursive: true });
    writeFileSync(join(initializingRoot, "stale-initialization"), "stale");
    const externalTarget = join(externalRoot, "must-survive.txt");
    writeFileSync(externalTarget, "external-data");
    symlinkSync(externalTarget, join(profile.mediaDirectory, "external-link"));
    mkdirSync(adjacentRoot, { recursive: true });
    const adjacentFile = join(adjacentRoot, "model.bin");
    writeFileSync(adjacentFile, "adjacent-data");

    resetAudioProfile(applicationDataRoot);
    expect(existsSync(profile.root)).toBe(false);
    expect(existsSync(initializingRoot)).toBe(false);
    expect(readFileSync(externalTarget, "utf8")).toBe("external-data");
    expect(readFileSync(adjacentFile, "utf8")).toBe("adjacent-data");

    const result = requireReady(initializeAudioProfile(applicationDataRoot));
    try {
      expect(result.database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: AUDIO_SCHEMA_VERSION,
      });
      expect(
        result.database
          .prepare("SELECT COUNT(*) AS count FROM audio_items")
          .get(),
      ).toEqual({ count: 0 });
      expect(existsSync(join(profile.mediaDirectory, "legacy.wav"))).toBe(
        false,
      );
      expect(existsSync(join(profile.workspaceDirectory, "legacy.task"))).toBe(
        false,
      );
      expect(existsSync(join(profile.mediaDirectory, "external-link"))).toBe(
        false,
      );
      expect(existsSync(join(initializingRoot, "stale-initialization"))).toBe(
        false,
      );
    } finally {
      result.database.close();
    }
  });

  it("can reset when both owned profile roots are already absent", () => {
    const applicationDataRoot = temporaryRoot();

    resetAudioProfile(applicationDataRoot);
    expect(
      existsSync(profilePathsForApplicationData(applicationDataRoot).root),
    ).toBe(false);

    const result = requireReady(initializeAudioProfile(applicationDataRoot));
    try {
      expect(result.database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: AUDIO_SCHEMA_VERSION,
      });
      expect(existsSync(result.profile.readyMarkerPath)).toBe(true);
    } finally {
      result.database.close();
    }
  });

  it("propagates deletion failure without starting fresh initialization", () => {
    const applicationDataRoot = temporaryRoot();
    const profile = profilePathsForApplicationData(applicationDataRoot);
    mkdirSync(profile.mediaDirectory, { recursive: true });
    writeFileSync(join(profile.mediaDirectory, "partially-removed.wav"), "old");
    const initializingRoot = `${profile.root}.initializing`;
    mkdirSync(initializingRoot, { recursive: true });
    const staleInitialization = join(
      initializingRoot,
      "must-remain-on-failure",
    );
    writeFileSync(staleInitialization, "stale");
    let removalCount = 0;

    expect(() =>
      resetAudioProfile(applicationDataRoot, {
        removeProfileRoot: (root) => {
          removalCount += 1;
          if (removalCount === 1) {
            rmSync(root, { force: true, recursive: true });
            return;
          }
          throw new Error("injected delete failure");
        },
      }),
    ).toThrow("injected delete failure");

    expect(existsSync(profile.root)).toBe(false);
    expect(readFileSync(staleInitialization, "utf8")).toBe("stale");
    expect(existsSync(profile.databasePath)).toBe(false);
    expect(existsSync(profile.readyMarkerPath)).toBe(false);

    resetAudioProfile(applicationDataRoot);
    expect(existsSync(profile.root)).toBe(false);
    expect(existsSync(initializingRoot)).toBe(false);

    const retried = requireReady(initializeAudioProfile(applicationDataRoot));
    try {
      expect(retried.database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: AUDIO_SCHEMA_VERSION,
      });
    } finally {
      retried.database.close();
    }
  });
});
