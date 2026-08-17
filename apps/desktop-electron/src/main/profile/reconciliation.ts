import { lstatSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DesktopRepository } from "../storage/desktop_repository";
import { writeJsonAtomically } from "./atomic_json";
import {
  assertProfileOwnedPath,
  type AudioProfilePaths,
} from "./profile_paths";

export type ReconciliationKind =
  "processing" | "capture" | "staging" | "ai" | "transfer";
export type ReconciliationState = "interrupted" | "repairable";

export interface ReconciliationItem {
  kind: ReconciliationKind;
  identity: string;
  state: ReconciliationState;
  requiresExplicitAction: true;
  receiptPath: string;
}

export interface StartupReconciliationReport {
  reconciledAtMs: number;
  items: ReconciliationItem[];
}

export function reconcileAudioProfile(
  database: DatabaseSync,
  profile: AudioProfilePaths,
  nowMs: number,
): StartupReconciliationReport {
  const items: ReconciliationItem[] = [];
  const interruptedProcessing = new DesktopRepository(
    database,
    profile,
  ).reconcileStartup(nowMs);
  if (interruptedProcessing > 0) {
    items.push(
      persistReceipt(profile, nowMs, {
        kind: "processing",
        identity: `running-jobs:${interruptedProcessing}`,
        state: "interrupted",
      }),
    );
  }

  items.push(
    ...scanCheckpoints(
      profile,
      nowMs,
      profile.captureDirectory,
      "capture",
      "repairable",
      "journal.json",
    ),
    ...scanCheckpoints(
      profile,
      nowMs,
      profile.stagingDirectory,
      "staging",
      "repairable",
    ),
    ...scanCheckpoints(
      profile,
      nowMs,
      profile.aiWorkspaceDirectory,
      "ai",
      "interrupted",
    ),
    ...scanCheckpoints(
      profile,
      nowMs,
      profile.transferDirectory,
      "transfer",
      "interrupted",
      "checkpoint.json",
    ),
  );

  return { reconciledAtMs: nowMs, items };
}

function scanCheckpoints(
  profile: AudioProfilePaths,
  observedAtMs: number,
  root: string,
  kind: ReconciliationKind,
  state: ReconciliationState,
  checkpointName?: string,
): ReconciliationItem[] {
  assertProfileOwnedPath(profile, root);
  const items: ReconciliationItem[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const artifactPath = join(root, entry.name);
    assertProfileOwnedPath(profile, artifactPath);
    if (checkpointName && entry.isDirectory()) {
      const checkpoint = join(artifactPath, checkpointName);
      try {
        const stat = lstatSync(checkpoint);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
    } else if (checkpointName && !entry.isSymbolicLink()) {
      continue;
    }
    items.push(
      persistReceipt(profile, observedAtMs, {
        kind,
        identity: basename(artifactPath),
        state,
        artifactRelativePath: relative(profile.root, artifactPath),
      }),
    );
  }
  return items;
}

function persistReceipt(
  profile: AudioProfilePaths,
  observedAtMs: number,
  item: {
    kind: ReconciliationKind;
    identity: string;
    state: ReconciliationState;
    artifactRelativePath?: string;
  },
): ReconciliationItem {
  const key = createHash("sha256")
    .update(`${item.kind}\0${item.identity}`)
    .digest("hex");
  const receiptPath = join(profile.reconciliationDirectory, `${key}.json`);
  assertProfileOwnedPath(profile, receiptPath);
  writeJsonAtomically(receiptPath, {
    schema: "voice2text-electron-reconciliation/v1",
    ...item,
    observedAtMs,
    requiresExplicitAction: true,
  });
  return {
    kind: item.kind,
    identity: item.identity,
    state: item.state,
    requiresExplicitAction: true,
    receiptPath,
  };
}
