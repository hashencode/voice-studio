import { AiProviderFailure } from "./provider_security";
import type { AudioAiOutput } from "./provider_output";
import type { AudioAiProviderRequest } from "./openai_provider";

export interface AudioAiProvider {
  readonly id: string;
  generate(request: AudioAiProviderRequest): Promise<AudioAiOutput>;
  cancel?(): void | Promise<void>;
}

export class AiProviderRegistry {
  private readonly providers: ReadonlyMap<string, AudioAiProvider>;

  constructor(providers: readonly AudioAiProvider[]) {
    const values = new Map<string, AudioAiProvider>();
    for (const provider of providers) {
      if (values.has(provider.id)) {
        throw new TypeError(`duplicate AI provider: ${provider.id}`);
      }
      values.set(provider.id, provider);
    }
    this.providers = values;
  }

  resolve(providerId: string): AudioAiProvider {
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
