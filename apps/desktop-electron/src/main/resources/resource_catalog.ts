import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export interface ResourceRootInput {
  appRoot: string;
  packaged: boolean;
  resourcesPath: string;
}

export interface ResolvedResourceCommand {
  readonly catalogIdentity: string;
  readonly resourceRoot: string;
  readonly operation: string;
  readonly executable: string;
  readonly args: readonly string[];
}

const authorizedCommands = new WeakSet<object>();

const relativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment !== ".." && segment !== ""),
    "resource artifact path is unsafe",
  );

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    target: z.string().min(1),
    workerProtocol: z.string().min(1),
    artifacts: z.array(
      z
        .object({
          path: relativeArtifactPathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    operations: z
      .array(
        z
          .object({
            operation: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/),
            executable: relativeArtifactPathSchema,
            arguments: z.array(z.string().max(4096)),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

type ResourceManifest = z.infer<typeof manifestSchema>;

export function resolveResourceRoot(input: ResourceRootInput): string {
  const root = input.packaged
    ? path.join(path.resolve(input.resourcesPath), "worker")
    : path.join(path.resolve(input.appRoot), "resources", "worker");
  return path.resolve(root);
}

export class ResourceCatalog {
  private constructor(
    readonly root: string,
    readonly identity: string,
    private readonly manifest: ResourceManifest,
  ) {}

  static async load(root: string): Promise<ResourceCatalog> {
    const resolvedRoot = path.resolve(root);
    const canonicalRoot = await realpath(resolvedRoot);
    const manifestBytes = await readFile(
      path.join(canonicalRoot, "manifest.json"),
    );
    const manifest = manifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
    );
    assertUniqueManifestEntries(manifest);
    await verifyArtifacts(canonicalRoot, manifest);
    return new ResourceCatalog(
      resolvedRoot,
      createHash("sha256").update(manifestBytes).digest("hex"),
      manifest,
    );
  }

  command(
    operation: string,
    variables: { runtimeRoot?: string; attemptOutput?: string } = {},
  ): ResolvedResourceCommand {
    const operationEntry = this.manifest.operations.find(
      (candidate) => candidate.operation === operation,
    );
    if (!operationEntry)
      throw new Error("resource operation is not allowlisted");
    const artifact = this.manifest.artifacts.find(
      (candidate) => candidate.path === operationEntry.executable,
    );
    if (!artifact) {
      throw new Error("resource operation executable is absent from manifest");
    }
    const executable = containedResourcePath(this.root, artifact.path);
    const command = Object.freeze({
      catalogIdentity: this.identity,
      resourceRoot: this.root,
      operation,
      executable,
      args: Object.freeze(
        operationEntry.arguments.map((argument) =>
          substituteArgument(argument, variables, this.root),
        ),
      ),
    });
    authorizedCommands.add(command);
    return command;
  }

  artifactHash(relativePath: string): string | null {
    return (
      this.manifest.artifacts.find((artifact) => artifact.path === relativePath)
        ?.sha256 ?? null
    );
  }
}

async function verifyArtifacts(
  root: string,
  manifest: ResourceManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const artifactPath = containedResourcePath(root, artifact.path);
    const canonicalArtifact = await realpath(artifactPath);
    if (!isInside(root, canonicalArtifact)) {
      throw new Error("resource artifact resolves outside the catalog root");
    }
    const actual = createHash("sha256")
      .update(await readFile(canonicalArtifact))
      .digest("hex");
    if (actual !== artifact.sha256) {
      throw new Error(`resource artifact hash mismatch: ${artifact.path}`);
    }
  }
}

export async function assertAuthorizedResourceCommand(
  command: ResolvedResourceCommand,
): Promise<void> {
  if (!authorizedCommands.has(command)) {
    throw new Error("resource command was not issued by the catalog");
  }
  const canonicalRoot = await realpath(command.resourceRoot);
  const canonicalExecutable = await realpath(command.executable);
  if (!isInside(canonicalRoot, canonicalExecutable)) {
    throw new Error("resource executable escapes the catalog root");
  }
}

function containedResourcePath(root: string, relativePath: string): string {
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) {
    throw new Error("resource artifact escapes the catalog root");
  }
  return candidate;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function substituteArgument(
  argument: string,
  variables: { runtimeRoot?: string; attemptOutput?: string },
  resourceRoot: string,
): string {
  if (argument === "{runtimeRoot}") {
    return variables.runtimeRoot ?? path.join(resourceRoot, "runtime");
  }
  if (argument === "{attemptOutput}") {
    if (!variables.attemptOutput) {
      throw new Error("resource operation requires attempt output");
    }
    return variables.attemptOutput;
  }
  if (argument.includes("{") || argument.includes("}")) {
    throw new Error("resource operation contains an unknown argument template");
  }
  return argument;
}

function assertUniqueManifestEntries(manifest: ResourceManifest): void {
  if (
    new Set(manifest.artifacts.map((item) => item.path)).size !==
    manifest.artifacts.length
  ) {
    throw new Error("resource manifest contains duplicate artifacts");
  }
  if (
    new Set(manifest.operations.map((item) => item.operation)).size !==
    manifest.operations.length
  ) {
    throw new Error("resource manifest contains duplicate operations");
  }
}
