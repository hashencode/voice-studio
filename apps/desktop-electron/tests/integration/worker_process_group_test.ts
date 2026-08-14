import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import type { ExecutionIntent } from "../../src/main/domain/models";
import {
  DurableProcessCoordinator,
  ProcessCanceledError,
} from "../../src/main/processes/durable_process_coordinator";
import { OwnedProcessSupervisor } from "../../src/main/processes/owned_process_supervisor";
import { initializeElectronProfile } from "../../src/main/profile/electron_profile";
import {
  ResourceCatalog,
  resolveResourceRoot,
} from "../../src/main/resources/resource_catalog";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "voice2text-process-group-"));
  temporaryRoots.push(root);
  const developmentAppRoot = join(root, "development-app");
  const packagedResourcesRoot = join(root, "packaged-resources");
  const developmentRoot = join(developmentAppRoot, "resources", "worker");
  const packagedRoot = join(packagedResourcesRoot, "worker");
  mkdirSync(join(developmentRoot, "bin"), { recursive: true });
  mkdirSync(join(packagedRoot, "bin"), { recursive: true });
  const script = `#!/bin/sh
set -eu
echo $$ > "$VOICE2TEXT_ATTEMPT_OUTPUT/leader.pid"
(
  trap '' TERM
  while :; do sleep 1; done
) &
echo $! > "$VOICE2TEXT_ATTEMPT_OUTPUT/descendant.pid"
trap '' TERM
printf '%s\\n' '{"schemaVersion":1,"type":"progress","operationId":"fixture-operation","attempt":1,"sourceIdentity":"fixture-source","fraction":0.5}'
sleep 30
printf '%s\\n' '{"schemaVersion":1,"type":"result","operationId":"fixture-operation","attempt":1,"sourceIdentity":"fixture-source","payload":{"late":true}}'
`;
  const manifest = {
    schemaVersion: 1,
    target: "darwin-arm64",
    workerProtocol: "desktop-sherpa-worker-health/v1",
    artifacts: [
      {
        path: "bin/process-tree-fixture",
        sha256: createHash("sha256").update(script).digest("hex"),
      },
    ],
    operations: [
      {
        operation: "fixture-operation",
        executable: "bin/process-tree-fixture",
        arguments: [],
      },
      {
        operation: "unsafe-operation",
        executable: "bin/process-tree-fixture",
        arguments: ["/etc/passwd"],
      },
    ],
  };
  for (const resourceRoot of [developmentRoot, packagedRoot]) {
    writeFileSync(join(resourceRoot, "bin", "process-tree-fixture"), script);
    chmodSync(join(resourceRoot, "bin", "process-tree-fixture"), 0o700);
    writeFileSync(
      join(resourceRoot, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
  }
  return {
    developmentAppRoot,
    packagedResourcesRoot,
    root,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function intent(resourceIdentity: string, jobId = 1): ExecutionIntent {
  return {
    jobId,
    meetingId: 1,
    operationId: "fixture-operation",
    attempt: 1,
    sourceIdentity: "fixture-source",
    deadlineAtMs: Date.now() + 15_000,
    resourceIdentity,
  };
}

describe.skipIf(process.platform !== "darwin")(
  "owned worker process groups on macOS",
  () => {
    it("uses one manifest identity in development and packaged layouts without cwd", async () => {
      const paths = fixture();
      const previousCwd = process.cwd();
      process.chdir(tmpdir());
      try {
        const development = await ResourceCatalog.load(
          resolveResourceRoot({
            appRoot: paths.developmentAppRoot,
            packaged: false,
            resourcesPath: "/not-used",
          }),
        );
        const packaged = await ResourceCatalog.load(
          resolveResourceRoot({
            appRoot: "/Applications/Voice2Text.app/Contents/Resources/app.asar",
            packaged: true,
            resourcesPath: paths.packagedResourcesRoot,
          }),
        );
        expect(development.identity).toBe(packaged.identity);
        expect(development.command("fixture-operation").executable).toBe(
          join(
            paths.developmentAppRoot,
            "resources/worker/bin/process-tree-fixture",
          ),
        );
        expect(() => development.command("../../bin/sh")).toThrow();
      } finally {
        process.chdir(previousCwd);
      }
    });

    it("persists cancel intent before killing descendants, cleans output, and rejects late results", async () => {
      const paths = fixture();
      const catalog = await ResourceCatalog.load(
        resolveResourceRoot({
          appRoot: "/Applications/Voice2Text.app/Contents/Resources/app.asar",
          packaged: true,
          resourcesPath: paths.packagedResourcesRoot,
        }),
      );
      const initialized = initializeElectronProfile(
        join(paths.root, "app-data"),
      );
      if (initialized.status !== "ready") throw new Error(initialized.message);
      const repository = new DesktopRepository(
        initialized.database,
        initialized.profile,
      );
      const service = new DesktopDomainService(repository);
      const meeting = service.createMeeting({
        idempotencyKey: "fixture-meeting",
        sourceIdentity: "fixture-source-media",
        displayName: "Fixture",
        mediaPath: join(initialized.profile.mediaDirectory, "fixture.wav"),
        durationMs: 1000,
      });
      const job = service.enqueueProcessingJob({
        meetingId: meeting.value.id,
        idempotencyKey: "fixture-job",
        operationId: "fixture-operation",
        resourceIdentity: catalog.identity,
      });
      const executionIntent = service.claimNextProcessingJob({
        sourceIdentity: "fixture-source",
        deadlineAtMs: Date.now() + 15_000,
      });
      if (!executionIntent) throw new Error("fixture job was not claimed");
      const attemptOutput = join(
        initialized.profile.workspaceDirectory,
        "attempts",
        "1",
      );
      mkdirSync(attemptOutput, { recursive: true });
      writeFileSync(join(attemptOutput, "partial.json"), "partial");
      const order: string[] = [];
      const publishResult = vi.fn();
      const authority = {
        requestCancellation: async (jobId: number) => {
          expect(jobId).toBe(executionIntent.jobId);
          order.push("durable-cancel");
          return service.requestProcessingCancellation(jobId);
        },
        completeCancellation: async (intent: ExecutionIntent) => {
          expect(service.completeProcessingCancellation(intent)).toBe(true);
          order.push("durable-canceled");
        },
        publishResult: async (
          intent: ExecutionIntent,
          payload: Record<string, unknown>,
        ) => {
          publishResult(payload);
          service.publishProcessingResult({
            ...intent,
            complete: true,
            payload,
          });
        },
      };
      const supervisor = new OwnedProcessSupervisor({
        workspaceRoot: initialized.profile.workspaceDirectory,
        terminationGraceMs: 100,
        onTerminate: () => {
          expect(repository.findJob(job.value.id)?.state).toBe("canceling");
          order.push("terminate-group");
        },
      });
      const coordinator = new DurableProcessCoordinator(supervisor, authority);
      const run = coordinator.run({
        intent: executionIntent,
        command: catalog.command("fixture-operation"),
        attemptOutputDirectory: attemptOutput,
      });
      const runCanceled =
        expect(run).rejects.toBeInstanceOf(ProcessCanceledError);
      await waitForFile(join(attemptOutput, "descendant.pid"));
      const leaderPid = Number(
        readFileSync(join(attemptOutput, "leader.pid"), "utf8"),
      );
      const descendantPid = Number(
        readFileSync(join(attemptOutput, "descendant.pid"), "utf8"),
      );

      await expect(coordinator.cancel(executionIntent.jobId)).resolves.toBe(
        true,
      );
      await runCanceled;
      expect(order).toEqual([
        "durable-cancel",
        "terminate-group",
        "durable-canceled",
      ]);
      expect(existsSync(attemptOutput)).toBe(false);
      expect(processExists(leaderPid)).toBe(false);
      expect(processExists(descendantPid)).toBe(false);
      expect(publishResult).not.toHaveBeenCalled();
      expect(repository.findJob(job.value.id)?.state).toBe("canceled");
      initialized.database.close();
    });

    it("rejects unauthorized arguments before spawn and enforces output and deadline limits", async () => {
      const paths = fixture();
      const catalog = await ResourceCatalog.load(
        resolveResourceRoot({
          appRoot: paths.developmentAppRoot,
          packaged: false,
          resourcesPath: "/not-used",
        }),
      );
      const workspaceRoot = join(paths.root, "profile-limits");
      const unsafeOutput = join(workspaceRoot, "unsafe");
      mkdirSync(unsafeOutput, { recursive: true });
      const unsafeSupervisor = new OwnedProcessSupervisor({ workspaceRoot });
      await expect(
        unsafeSupervisor.run({
          intent: {
            ...intent(catalog.identity, 80),
            operationId: "unsafe-operation",
          },
          command: catalog.command("unsafe-operation"),
          attemptOutputDirectory: unsafeOutput,
        }),
      ).rejects.toThrow("authorized roots");
      expect(existsSync(join(unsafeOutput, "leader.pid"))).toBe(false);

      const limitedOutput = join(workspaceRoot, "limited");
      mkdirSync(limitedOutput, { recursive: true });
      const limitedSupervisor = new OwnedProcessSupervisor({
        workspaceRoot,
        maximumOutputBytes: 32,
        terminationGraceMs: 100,
      });
      const limitedRun = limitedSupervisor.run({
        intent: intent(catalog.identity, 81),
        command: catalog.command("fixture-operation"),
        attemptOutputDirectory: limitedOutput,
      });
      const limitedFailure = expect(limitedRun).rejects.toThrow("byte limit");
      await limitedFailure;
      const limitedDescendant = Number(
        readFileSync(join(limitedOutput, "descendant.pid"), "utf8"),
      );
      expect(processExists(limitedDescendant)).toBe(false);

      const deadlineOutput = join(workspaceRoot, "deadline");
      mkdirSync(deadlineOutput, { recursive: true });
      const deadlineSupervisor = new OwnedProcessSupervisor({
        workspaceRoot,
        terminationGraceMs: 100,
      });
      const deadlineRun = deadlineSupervisor.run({
        intent: {
          ...intent(catalog.identity, 82),
          deadlineAtMs: Date.now() + 200,
        },
        command: catalog.command("fixture-operation"),
        attemptOutputDirectory: deadlineOutput,
      });
      const deadlineFailure = expect(deadlineRun).rejects.toThrow(
        "deadline was exceeded",
      );
      await deadlineFailure;
      const deadlineDescendant = Number(
        readFileSync(join(deadlineOutput, "descendant.pid"), "utf8"),
      );
      expect(processExists(deadlineDescendant)).toBe(false);
    });

    it("tears every owned process down once on repeated application quit", async () => {
      const paths = fixture();
      const catalog = await ResourceCatalog.load(
        resolveResourceRoot({
          appRoot: paths.developmentAppRoot,
          packaged: false,
          resourcesPath: "/not-used",
        }),
      );
      const terminated: number[] = [];
      const supervisor = new OwnedProcessSupervisor({
        workspaceRoot: join(paths.root, "profile"),
        terminationGraceMs: 100,
        onTerminate: (owned) => terminated.push(owned.intent.jobId),
      });
      const attempts = [1, 2].map((jobId) => {
        const directory = join(
          paths.root,
          "profile",
          "attempts",
          String(jobId),
        );
        mkdirSync(directory, { recursive: true });
        const run = supervisor.run({
          intent: intent(catalog.identity, jobId),
          command: catalog.command("fixture-operation"),
          attemptOutputDirectory: directory,
        });
        const canceled =
          expect(run).rejects.toBeInstanceOf(ProcessCanceledError);
        return { canceled, directory };
      });
      await Promise.all(
        attempts.map(({ directory }) =>
          waitForFile(join(directory, "descendant.pid")),
        ),
      );
      const descendants = attempts.map(({ directory }) =>
        Number(readFileSync(join(directory, "descendant.pid"), "utf8")),
      );

      await supervisor.shutdown();
      await supervisor.shutdown();
      await Promise.all(attempts.map(({ canceled }) => canceled));
      expect(terminated.sort()).toEqual([1, 2]);
      expect(descendants.every((pid) => !processExists(pid))).toBe(true);
    });
  },
);
