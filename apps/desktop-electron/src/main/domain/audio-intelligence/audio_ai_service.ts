import { createHash } from "node:crypto";

import type {
  AiSettingsSnapshot,
  GenerateAudioAiRequest,
  AudioAiConsentPreview,
  AudioAiSnapshot,
  RetryAudioAiRequest,
} from "../../../shared/contracts";
import type { DesktopSecretStorePort } from "../../features/secrets/secret_store_port";
import { assertProviderSecretInput } from "../../features/secrets/secret_store_port";
import type {
  AiJobRecord,
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

  constructor(
    private readonly repository: AiJobRepository,
    private readonly secrets: DesktopSecretStorePort,
    private readonly providerFactory: (
      settings: AiProviderSettingsRecord,
      secrets: DesktopSecretStorePort,
    ) => AudioAiProvider = (settings, store) =>
      new OpenAiCompatibleProvider(settings, store),
    private readonly now: () => number = Date.now,
  ) {}

  async getSettings(): Promise<AiSettingsSnapshot> {
    const settings = this.repository.loadSettings();
    const endpoint = parseRemoteAiEndpoint(settings.endpoint);
    const secret = await this.secrets.read(settings.providerId);
    const fileVaultState = await this.secrets.fileVaultStatus();
    return {
      revision: this.repository.settingsRevision(),
      config: {
        providerId: settings.providerId,
        displayName:
          settings.providerId === "deepseek" ? "DeepSeek" : "OpenAI-compatible",
        modelId: settings.modelId,
        endpoint: endpoint.baseUrl,
        endpointOrigin: endpoint.origin,
        processingLocation: "cloudDirect",
        requiresConsent: true,
      },
      secretState: secret.state,
      deviceSecurity: {
        kind: "device-security",
        fileVaultState,
        applicationLayerEncryption: "not-claimed",
      },
    };
  }

  async saveSettings(
    settings: AiProviderSettingsRecord,
  ): Promise<AiSettingsSnapshot> {
    this.repository.saveSettings(settings, this.now());
    return await this.getSettings();
  }

  async replaceSecret(
    providerId: string,
    secret: string,
  ): Promise<AiSettingsSnapshot> {
    assertProviderSecretInput(providerId, secret);
    await this.secrets.replace(providerId, secret.trim());
    return await this.getSettings();
  }

  async deleteSecret(providerId: string): Promise<AiSettingsSnapshot> {
    assertProviderSecretInput(providerId);
    await this.secrets.delete(providerId);
    return await this.getSettings();
  }

  prepare(options: {
    audioId: number;
    generationId: number;
    templateId: string;
  }): AudioAiConsentPreview {
    const settings = this.repository.loadSettings();
    const endpoint = parseRemoteAiEndpoint(settings.endpoint);
    const scope = this.transcriptScope(options.audioId, options.generationId);
    return {
      audioId: options.audioId,
      generationId: options.generationId,
      providerId: settings.providerId,
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
    const settings = this.repository.loadSettings();
    const job = this.repository.enqueue(
      {
        audioId: request.audioId,
        generationId: request.generationId,
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
      | "providerId"
      | "endpointOrigin"
      | "endpointIdentitySha256"
      | "transcriptScopeSha256"
    >,
    consent: GenerateAudioAiRequest["consent"],
  ): void {
    if (
      consent.version !== 1 ||
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
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
