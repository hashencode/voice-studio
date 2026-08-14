import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { sha256Schema } from "../../shared/contracts";
import { sha256File } from "../security/sha256_file";

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

export interface ProcessingResourceIdentity {
  protocolIdentity: string;
  modelSha256: string;
  runtimeSha256: string;
  resourceIdentity: string;
}

export interface ProcessingPipelineIdentities {
  asr: ProcessingResourceIdentity;
  diarization: ProcessingResourceIdentity;
}

const authorizedCommands = new WeakSet<object>();
interface ArtifactExpectation {
  path: string;
  sha256: string;
}
const commandArtifacts = new WeakMap<object, readonly ArtifactExpectation[]>();
const commandInventories = new WeakMap<object, readonly string[]>();
const supportedResourceTarget = "darwin-arm64";

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
          sha256: sha256Schema,
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
            protocolIdentity: z.string().min(1).max(256).optional(),
            modelArtifacts: z
              .array(relativeArtifactPathSchema)
              .max(64)
              .optional(),
            workerReportedModelArtifact: relativeArtifactPathSchema.optional(),
            runtimeArtifacts: z
              .array(relativeArtifactPathSchema)
              .max(64)
              .optional(),
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
    const manifestPath = path.join(canonicalRoot, "manifest.json");
    const manifestBytes = await readFile(manifestPath);
    const manifestIdentity = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    const manifest = manifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
    );
    if (
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      manifest.target !== supportedResourceTarget
    ) {
      throw new Error(
        `resource manifest target must match ${supportedResourceTarget}`,
      );
    }
    assertUniqueManifestEntries(manifest);
    await assertExactInventory(
      canonicalRoot,
      manifest.artifacts.map((artifact) => artifact.path),
    );
    await verifyArtifacts(canonicalRoot, manifest);
    return new ResourceCatalog(resolvedRoot, manifestIdentity, manifest);
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
    const referencedArtifacts = [
      operationEntry.executable,
      ...(operationEntry.modelArtifacts ?? []),
      ...(operationEntry.runtimeArtifacts ?? []),
    ].map((artifactPath) => {
      const referenced = this.manifest.artifacts.find(
        (candidate) => candidate.path === artifactPath,
      );
      if (!referenced) {
        throw new Error(
          `resource operation artifact is absent from manifest: ${artifactPath}`,
        );
      }
      return Object.freeze({
        path: containedResourcePath(this.root, referenced.path),
        sha256: referenced.sha256,
      });
    });
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
    commandArtifacts.set(command, Object.freeze(referencedArtifacts));
    commandInventories.set(
      command,
      Object.freeze(this.manifest.artifacts.map((artifact) => artifact.path)),
    );
    return command;
  }

  processingIdentity(operation: string): ProcessingResourceIdentity | null {
    const entry = this.manifest.operations.find(
      (candidate) => candidate.operation === operation,
    );
    if (
      !entry?.protocolIdentity ||
      !entry.modelArtifacts?.length ||
      !entry.runtimeArtifacts?.length
    ) {
      return null;
    }
    return {
      protocolIdentity: entry.protocolIdentity,
      modelSha256: entry.workerReportedModelArtifact
        ? artifactHash(this.manifest, entry.workerReportedModelArtifact)
        : combinedArtifactHash(this.manifest, entry.modelArtifacts),
      runtimeSha256: combinedArtifactHash(
        this.manifest,
        entry.runtimeArtifacts,
      ),
      resourceIdentity: this.identity,
    };
  }

  processingPipelineIdentities(): ProcessingPipelineIdentities | null {
    const asr = this.processingIdentity("asr");
    const diarization = this.processingIdentity("diarization");
    if (
      !asr ||
      !diarization ||
      asr.protocolIdentity !== diarization.protocolIdentity ||
      asr.modelSha256 !== diarization.modelSha256 ||
      asr.runtimeSha256 !== diarization.runtimeSha256 ||
      asr.resourceIdentity !== diarization.resourceIdentity
    ) {
      return null;
    }
    return { asr, diarization };
  }
}

export function requireProcessingPipelineIdentities(
  catalog: ResourceCatalog | null,
): ProcessingPipelineIdentities {
  const pipeline = catalog?.processingPipelineIdentities();
  if (!pipeline) {
    throw new Error(
      "processing catalog must contain matching ASR and diarization identities",
    );
  }
  return pipeline;
}

async function assertExactInventory(
  root: string,
  artifactPaths: readonly string[],
): Promise<void> {
  const expected = new Set(["manifest.json", ...artifactPaths]);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("resource catalog contains a non-regular entry");
      }
      const relative = path.relative(root, candidate);
      if (!expected.delete(relative)) {
        throw new Error(
          `resource catalog contains an unmanifested file: ${relative}`,
        );
      }
    }
  };
  await visit(root);
  if (expected.size > 0) {
    throw new Error(
      `resource catalog is missing manifest inventory: ${[...expected].join(", ")}`,
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
    const actual = await sha256File(canonicalArtifact);
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
  const expectedArtifacts = commandArtifacts.get(command);
  if (!expectedArtifacts) {
    throw new Error("resource command verification metadata is unavailable");
  }
  const canonicalRoot = await realpath(command.resourceRoot);
  const expectedInventory = commandInventories.get(command);
  if (!expectedInventory) {
    throw new Error("resource command inventory metadata is unavailable");
  }
  await assertExactInventory(canonicalRoot, expectedInventory);
  for (const artifact of expectedArtifacts) {
    const canonicalArtifact = await realpath(artifact.path);
    if (!isInside(canonicalRoot, canonicalArtifact)) {
      throw new Error("resource command artifact escapes the catalog root");
    }
    if ((await sha256File(canonicalArtifact)) !== artifact.sha256) {
      throw new Error("resource command artifact hash mismatch before spawn");
    }
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
  const option = /^(--[a-z][a-z0-9-]{0,127})=(.+)$/i.exec(argument);
  if (option) {
    if (option[1] === "--control-json") {
      const parsed = JSON.parse(option[2]!) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("resource control argument must be a JSON object");
      }
      return argument;
    }
    return `${option[1]}=${substituteArgument(
      option[2]!,
      variables,
      resourceRoot,
    )}`;
  }
  if (argument === "{runtimeRoot}") {
    return variables.runtimeRoot ?? path.join(resourceRoot, "runtime");
  }
  if (argument === "{attemptOutput}") {
    if (!variables.attemptOutput) {
      throw new Error("resource operation requires attempt output");
    }
    return variables.attemptOutput;
  }
  if (argument === "{resourceRoot}") return resourceRoot;
  if (argument.startsWith("{resourceRoot}/")) {
    return containedResourcePath(
      resourceRoot,
      argument.slice("{resourceRoot}/".length),
    );
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
  for (const operation of manifest.operations) {
    if (
      operation.workerReportedModelArtifact &&
      !operation.modelArtifacts?.includes(operation.workerReportedModelArtifact)
    ) {
      throw new Error(
        "worker-reported model artifact must be an operation model artifact",
      );
    }
  }
}

function artifactHash(
  manifest: ResourceManifest,
  artifactPath: string,
): string {
  const artifact = manifest.artifacts.find(
    (item) => item.path === artifactPath,
  );
  if (!artifact) {
    throw new Error(`processing identity artifact is absent: ${artifactPath}`);
  }
  return artifact.sha256;
}

function combinedArtifactHash(
  manifest: ResourceManifest,
  paths: readonly string[],
): string {
  const hash = createHash("sha256");
  for (const artifactPath of [...paths].sort()) {
    const artifact = manifest.artifacts.find(
      (item) => item.path === artifactPath,
    );
    if (!artifact)
      throw new Error(
        `processing identity artifact is absent: ${artifactPath}`,
      );
    hash
      .update(artifact.path)
      .update("\0")
      .update(artifact.sha256)
      .update("\0");
  }
  return hash.digest("hex");
}
