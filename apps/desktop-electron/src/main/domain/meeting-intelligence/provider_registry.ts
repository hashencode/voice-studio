import { AiProviderFailure } from "./provider_security";
import type { MeetingAiOutput } from "./provider_output";
import type { MeetingAiProviderRequest } from "./openai_provider";

export interface MeetingAiProvider {
  readonly id: string;
  generate(request: MeetingAiProviderRequest): Promise<MeetingAiOutput>;
  cancel?(): void | Promise<void>;
}

export class AiProviderRegistry {
  private readonly providers: ReadonlyMap<string, MeetingAiProvider>;

  constructor(providers: readonly MeetingAiProvider[]) {
    const values = new Map<string, MeetingAiProvider>();
    for (const provider of providers) {
      if (values.has(provider.id)) {
        throw new TypeError(`duplicate AI provider: ${provider.id}`);
      }
      values.set(provider.id, provider);
    }
    this.providers = values;
  }

  resolve(providerId: string): MeetingAiProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AiProviderFailure(
        "AI_PROVIDER_MISSING",
        "selected AI provider is unavailable",
      );
    }
    return provider;
  }
}
