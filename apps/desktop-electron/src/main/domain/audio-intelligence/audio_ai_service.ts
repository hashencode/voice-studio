import { createHash, randomUUID } from "node:crypto";

import type {
  AiSettingsSnapshot,
  CreateAiProviderProfileRequest,
  DeleteAiProviderProfileRequest,
  GenerateAudioAiRequest,
  SelectAiProviderProfileRequest,
  AudioAiConsentPreview,
  AudioAiSnapshot,
  RetryAudioAiRequest,
  UpdateAiProviderProfileRequest,
} from "../../../shared/contracts";
import type { DesktopSecretStorePort } from "../../features/secrets/secret_store_port";
import { assertProviderSecretInput } from "../../features/secrets/secret_store_port";
import type {
  AiJobRecord,
  AiProviderProfileRecord,
  AiProviderSettingsRecord,
} from "../../storage/repositories/ai_job_repository";
import { AiJobRepository } from "../../storage/repositories/ai_job_repository";
import { OpenAiCompatibleProvider } from "./openai_provider";
import type { AudioAiInputSegment } from "./provider_output";
import { AiProviderFailure, parseRemoteAiEndpoint } from "./provider_security";
import { AiProviderRegistry, type AudioAiProvider } from "./provider_registry";

const MAXIMUM_SEGMENTS = 10_000;
const MAXIMUM_TRANSCRIPT_UTF8_BYTES = 1024 * 1024;

interface TranscriptScope {
  audioTitle: string;
  segments: AudioAiInputSegment[];
  sha256: string;
  inputStartMs: number;
  inputEndMs: number;
}

export class AudioAiService {
  private readonly listeners = new Set<(snapshot: AudioAiSnapshot) => void>();
  private readonly activeProviders = new Set<AudioAiProvider>();
  private readonly activeRuns = new Set<Promise<AudioAiSnapshot>>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: AiJobRepository,
    private readonly secrets: DesktopSecretStorePort,
    private readonly providerFactory: (
      settings: AiProviderSettingsRecord,
      secrets: DesktopSecretStorePort,
    ) => AudioAiProvider = (settings, store) =>
      new OpenAiCompatibleProvider(settings, store),
    private readonly now: () => number = Date.now,
    private readonly createIdentity: () => {
      profileId: string;
      secretRef: string;
    } = () => ({
      profileId: `profile-${randomUUID()}`,
      secretRef: `secret-${randomUUID()}`,
    }),
  ) {}

  async getSettings(): Promise<AiSettingsSnapshot> {
    const profiles = this.repository.profiles();
    const revision = this.repository.settingsRevision();
    const selectedProfileId =
      this.repository.selectedProfile()?.profileId ?? null;
    const [profileSnapshots, fileVaultState] = await Promise.all([
      Promise.all(
        profiles.map(async (profile) => {
          const endpoint = parseRemoteAiEndpoint(profile.endpoint);
          const secret = await this.secrets.read(profile.secretRef);
          return {
            profileId: profile.profileId,
            kind: "custom" as const,
            displayName: profile.displayName,
            protocol: profile.protocol,
            modelId: profile.modelId,
            modelSummary: profile.modelId,
            endpoint: endpoint.baseUrl,
            endpointOrigin: endpoint.origin,
            processingLocation: "cloudDirect" as const,
            requiresConsent: true as const,
            capabilities: {
              selectable: true as const,
              editable: true as const,
              deletable: true as const,
            },
            secretState: secret.state,
          };
        }),
      ),
      this.secrets.fileVaultStatus(),
    ]);
    return {
      revision,
      profiles: profileSnapshots,
      selectedProfileId,
      deviceSecurity: {
        kind: "device-security",
        fileVaultState,
        applicationLayerEncryption: "not-claimed",
      },
    };
  }

  async createProfile(
    request: CreateAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot> {
    return await this.serializeMutation(async () => {
      this.assertExpectedRevision(request.expectedRevision);
      this.assertProfileInput(request);
      if (this.repository.profiles().length >= 100) {
        throw new AiProviderFailure(
          "AI_INVALID_CONFIGURATION",
          "AI provider profile limit was reached",
        );
      }
      const identity = this.nextIdentity();
      assertProviderSecretInput(identity.secretRef, request.secret);
      await this.secrets.replace(identity.secretRef, request.secret.trim());
      try {
        this.repository.createProfile({
          ...request,
          ...identity,
          nowMs: this.now(),
        });
      } catch (error) {
        await this.secrets.delete(identity.secretRef).catch(() => undefined);
        throw error;
      }
      return await this.getSettings();
    });
  }

  async updateProfile(
    request: UpdateAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot> {
    return await this.serializeMutation(async () => {
      this.assertExpectedRevision(request.expectedRevision);
      const current = this.requireProfile(request.profileId);
      this.assertProfileInput(request, request.profileId);
      const previousSecret = request.secret
        ? await this.secrets.read(current.secretRef)
        : null;
      if (request.secret) {
        assertProviderSecretInput(current.secretRef, request.secret);
        await this.secrets.replace(current.secretRef, request.secret.trim());
      }
      try {
        this.repository.updateProfile({
          ...request,
          nowMs: this.now(),
        });
      } catch (error) {
        if (request.secret) {
          if (previousSecret?.state === "available") {
            await this.secrets
              .replace(current.secretRef, previousSecret.secret)
              .catch(() => undefined);
          } else if (previousSecret?.state === "missing") {
            await this.secrets.delete(current.secretRef).catch(() => undefined);
          }
        }
        throw error;
      }
      return await this.getSettings();
    });
  }

  async selectProfile(
    request: SelectAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot> {
    return await this.serializeMutation(async () => {
      this.assertExpectedRevision(request.expectedRevision);
      this.repository.selectProfile(request);
      return await this.getSettings();
    });
  }

  async deleteProfile(
    request: DeleteAiProviderProfileRequest,
  ): Promise<AiSettingsSnapshot> {
    return await this.serializeMutation(async () => {
      this.assertExpectedRevision(request.expectedRevision);
      const current = this.requireProfile(request.profileId);
      const previousSecret = await this.secrets.read(current.secretRef);
      const deletion = await this.secrets.delete(current.secretRef);
      if (deletion === "denied") {
        throw new AiProviderFailure(
          "AI_SECRET_DENIED",
          "provider secret could not be deleted",
        );
      }
      try {
        this.repository.deleteProfile({
          ...request,
          nowMs: this.now(),
        });
      } catch (error) {
        if (previousSecret.state === "available") {
          await this.secrets
            .replace(current.secretRef, previousSecret.secret)
            .catch(() => undefined);
        }
        throw error;
      }
      return await this.getSettings();
    });
  }

  prepare(options: {
    audioId: number;
    generationId: number;
    templateId: string;
  }): AudioAiConsentPreview {
    const settings = this.repository.selectedProfile();
    if (!settings) {
      throw new AiProviderFailure(
        "AI_PROVIDER_MISSING",
        "selected AI provider is unavailable",
      );
    }
    const endpoint = parseRemoteAiEndpoint(settings.endpoint);
    const scope = this.transcriptScope(options.audioId, options.generationId);
    return {
      audioId: options.audioId,
      generationId: options.generationId,
      profileId: settings.profileId,
      providerId: settings.protocol,
      modelId: settings.modelId,
      endpointOrigin: endpoint.origin,
      endpointIdentitySha256: sha256(endpoint.baseUrl),
      transcriptScopeSha256: scope.sha256,
      audioTitle: scope.audioTitle,
      segmentCount: scope.segments.length,
      inputStartMs: scope.inputStartMs,
      inputEndMs: scope.inputEndMs,
      requiresConsent: true,
    };
  }

  snapshot(audioId: number): AudioAiSnapshot | null {
    const job = this.repository.latestForAudio(audioId);
    return job ? this.toSnapshot(job) : null;
  }

  async generate(request: GenerateAudioAiRequest): Promise<AudioAiSnapshot> {
    const replay = this.repository.jobForIdempotency(request.idempotencyKey);
    if (replay) {
      if (
        replay.audioId !== request.audioId ||
        replay.generationId !== request.generationId ||
        replay.templateId !== request.templateId ||
        replay.profileId !== request.consent.profileId ||
        replay.providerId !== request.consent.providerId ||
        replay.endpointOrigin !== request.consent.endpointOrigin ||
        replay.endpointIdentitySha256 !==
          request.consent.endpointIdentitySha256 ||
        replay.transcriptScopeSha256 !== request.consent.transcriptScopeSha256
      ) {
        throw new AiProviderFailure(
          "AI_ATTEMPT_CONFLICT",
          "AI idempotency identity changed",
        );
      }
      return replay.state === "queued"
        ? await this.execute(replay)
        : this.toSnapshot(replay);
    }
    const preview = this.prepare(request);
    this.assertConsent(preview, request.consent);
    const settings = this.requireProfile(preview.profileId);
    const job = this.repository.enqueue(
      {
        audioId: request.audioId,
        generationId: request.generationId,
        profileId: settings.profileId,
        secretRef: settings.secretRef,
        providerId: preview.providerId,
        modelId: preview.modelId,
        endpoint: settings.endpoint,
        endpointOrigin: preview.endpointOrigin,
        endpointIdentitySha256: preview.endpointIdentitySha256,
        transcriptScopeSha256: preview.transcriptScopeSha256,
        templateId: request.templateId,
        idempotencyKey: request.idempotencyKey,
        nowMs: this.now(),
      },
      request.consent,
    );
    this.publish(this.toSnapshot(job));
    if (job.state !== "queued") return this.toSnapshot(job);
    return await this.execute(job);
  }

  async retry(request: RetryAudioAiRequest): Promise<AudioAiSnapshot> {
    const existing = this.repository.getJob(request.jobId);
    if (!existing)
      throw new AiProviderFailure(
        "AI_ATTEMPT_CONFLICT",
        "AI job is unavailable",
      );
    this.assertConsent(
      {
        profileId: existing.profileId,
        providerId: existing.providerId as "deepseek" | "openai-compatible",
        endpointOrigin: existing.endpointOrigin,
        endpointIdentitySha256: existing.endpointIdentitySha256,
        transcriptScopeSha256: existing.transcriptScopeSha256,
      },
      request.consent,
    );
    const replay = this.repository.retryReceiptReplay(request);
    if (replay) return this.toSnapshot(replay);
    const scope = this.transcriptScope(existing.audioId, existing.generationId);
    if (scope.sha256 !== existing.transcriptScopeSha256) {
      throw new AiProviderFailure(
        "AI_CONSENT_REQUIRED",
        "transcript scope changed before retry",
      );
    }
    const job = this.repository.retry({ ...request, nowMs: this.now() });
    this.publish(this.toSnapshot(job));
    if (job.state !== "queued") return this.toSnapshot(job);
    return await this.execute(job);
  }

  reconcileInterrupted(): number {
    return this.repository.reconcileInterrupted(this.now());
  }

  subscribe(listener: (snapshot: AudioAiSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.activeProviders].map(
        async (provider) => await provider.cancel?.(),
      ),
    );
    await Promise.allSettled([...this.activeRuns]);
  }

  private async execute(job: AiJobRecord): Promise<AudioAiSnapshot> {
    const run = this.executeUntracked(job);
    this.activeRuns.add(run);
    try {
      return await run;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async executeUntracked(job: AiJobRecord): Promise<AudioAiSnapshot> {
    const running = this.repository.claim(job.id, this.now());
    this.publish(this.toSnapshot(running));
    try {
      const scope = this.transcriptScope(running.audioId, running.generationId);
      if (scope.sha256 !== running.transcriptScopeSha256) {
        throw new AiProviderFailure(
          "AI_CONSENT_REQUIRED",
          "transcript scope changed after consent",
        );
      }
      if (this.activeProviders.size > 0) {
        throw new AiProviderFailure(
          "AI_SERVICE_UNAVAILABLE",
          "another AI request is already active",
        );
      }
      const provider = new AiProviderRegistry([
        this.providerFactory(
          {
            providerId: running.providerId as "deepseek" | "openai-compatible",
            modelId: running.modelId,
            endpoint: running.endpoint,
            secretRef: running.secretRef,
          },
          this.secrets,
        ),
      ]).resolve(running.providerId);
      this.activeProviders.add(provider);
      let output;
      try {
        output = await provider.generate({
          audioTitle: scope.audioTitle,
          templateId: running.templateId,
          segments: scope.segments,
        });
      } finally {
        this.activeProviders.delete(provider);
      }
      this.repository.publish(running.id, running.attempt, output, this.now());
    } catch (error) {
      const code =
        error instanceof AiProviderFailure ? error.code : "AI_PROVIDER_FAILED";
      this.repository.markFailed(running.id, running.attempt, code, this.now());
    }
    const settled = this.repository.getJob(running.id)!;
    const snapshot = this.toSnapshot(settled);
    this.publish(snapshot);
    return snapshot;
  }

  private transcriptScope(
    audioId: number,
    generationId: number,
  ): TranscriptScope {
    const source = this.repository.transcriptScopeSource(
      audioId,
      generationId,
      MAXIMUM_SEGMENTS + 1,
    );
    if (!source) {
      throw new AiProviderFailure(
        "AI_INVALID_OUTPUT",
        "active audio transcript is unavailable",
      );
    }
    if (
      source.segments.length === 0 ||
      source.segments.length > MAXIMUM_SEGMENTS
    ) {
      throw new AiProviderFailure(
        "AI_REQUEST_TOO_LARGE",
        "transcript segment count is invalid",
      );
    }
    const segments = source.segments;
    const audioTitle = source.audioTitle.slice(0, 512);
    const canonical = JSON.stringify({
      schemaVersion: 1,
      audioId,
      generationId,
      audioTitle,
      segments: segments.map((segment) => ({
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speakerState: segment.speakerState,
      })),
    });
    if (Buffer.byteLength(canonical, "utf8") > MAXIMUM_TRANSCRIPT_UTF8_BYTES) {
      throw new AiProviderFailure(
        "AI_REQUEST_TOO_LARGE",
        "transcript exceeds the safe size limit",
      );
    }
    return {
      audioTitle,
      segments,
      sha256: sha256(canonical),
      inputStartMs: segments[0]!.startMs,
      inputEndMs: segments.at(-1)!.endMs,
    };
  }

  private assertConsent(
    preview: Pick<
      AudioAiConsentPreview,
      | "profileId"
      | "providerId"
      | "endpointOrigin"
      | "endpointIdentitySha256"
      | "transcriptScopeSha256"
    >,
    consent: GenerateAudioAiRequest["consent"],
  ): void {
    if (
      consent.version !== 1 ||
      consent.profileId !== preview.profileId ||
      consent.providerId !== preview.providerId ||
      consent.endpointOrigin !== preview.endpointOrigin ||
      consent.endpointIdentitySha256 !== preview.endpointIdentitySha256 ||
      consent.transcriptScopeSha256 !== preview.transcriptScopeSha256
    ) {
      throw new AiProviderFailure(
        "AI_CONSENT_REQUIRED",
        "audio consent identity is stale",
      );
    }
  }

  private toSnapshot(job: AiJobRecord): AudioAiSnapshot {
    return {
      revision: job.revision,
      jobId: job.id,
      audioId: job.audioId,
      generationId: job.generationId,
      providerId: job.providerId as "deepseek" | "openai-compatible",
      modelId: job.modelId,
      endpointOrigin: job.endpointOrigin,
      endpointIdentitySha256: job.endpointIdentitySha256,
      transcriptScopeSha256: job.transcriptScopeSha256,
      attempt: job.attempt,
      state: job.state,
      errorCode: job.errorCode as AudioAiSnapshot["errorCode"],
      note:
        job.state === "completed" ? this.repository.noteSnapshot(job.id) : null,
    };
  }

  private publish(snapshot: AudioAiSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertExpectedRevision(expectedRevision: number): void {
    if (this.repository.settingsRevision() !== expectedRevision) {
      throw new AiProviderFailure(
        "AI_ATTEMPT_CONFLICT",
        "AI settings revision is stale",
      );
    }
  }

  private nextIdentity(): { profileId: string; secretRef: string } {
    const existing = this.repository.profiles();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const identity = this.createIdentity();
      if (
        !existing.some(
          (profile) =>
            profile.profileId === identity.profileId ||
            profile.secretRef === identity.secretRef,
        )
      ) {
        return identity;
      }
    }
    throw new AiProviderFailure(
      "AI_SERVICE_UNAVAILABLE",
      "AI provider identity could not be allocated",
    );
  }

  private requireProfile(profileId: string): AiProviderProfileRecord {
    const profile = this.repository.profile(profileId);
    if (!profile) {
      throw new AiProviderFailure(
        "AI_PROVIDER_MISSING",
        "AI provider profile is unavailable",
      );
    }
    return profile;
  }

  private assertProfileInput(
    input: {
      displayName: string;
      protocol: "deepseek" | "openai-compatible";
      modelId: string;
      endpoint: string;
    },
    excludingProfileId?: string,
  ): void {
    const displayName = normalizeDisplayName(input.displayName);
    const modelId = input.modelId.trim();
    if (
      displayName.length === 0 ||
      [...displayName].length > 128 ||
      modelId.length === 0 ||
      [...modelId].length > 256
    ) {
      throw new AiProviderFailure(
        "AI_INVALID_CONFIGURATION",
        "AI provider profile is invalid",
      );
    }
    if (
      this.repository
        .profiles()
        .some(
          (profile) =>
            profile.profileId !== excludingProfileId &&
            profile.normalizedDisplayName ===
              displayName.toLocaleLowerCase("en-US"),
        )
    ) {
      throw new AiProviderFailure(
        "AI_INVALID_CONFIGURATION",
        "AI provider display name is already in use",
      );
    }
    const endpoint = parseRemoteAiEndpoint(input.endpoint);
    if (
      input.protocol === "deepseek" &&
      (endpoint.origin !== "https://api.deepseek.com" ||
        endpoint.baseUrl !== "https://api.deepseek.com")
    ) {
      throw new AiProviderFailure(
        "AI_INVALID_CONFIGURATION",
        "DeepSeek endpoint cannot be changed",
      );
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
