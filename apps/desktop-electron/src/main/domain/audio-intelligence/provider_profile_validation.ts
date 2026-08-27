import { AiProviderFailure, parseRemoteAiEndpoint } from "./provider_security";

export interface AiProviderProfileInput {
  protocol: "deepseek" | "openai-compatible";
  modelId: string;
  endpoint: string;
}

export function validateAiProviderProfileInput(input: AiProviderProfileInput): {
  protocol: AiProviderProfileInput["protocol"];
  modelId: string;
  endpoint: string;
} {
  const modelId = input.modelId.trim();
  if (modelId.length === 0 || [...modelId].length > 256) {
    throw new AiProviderFailure(
      "AI_INVALID_CONFIGURATION",
      "AI provider profile is invalid",
    );
  }
  if (input.protocol === "deepseek" && !modelId.startsWith("deepseek-")) {
    throw new AiProviderFailure(
      "AI_INVALID_CONFIGURATION",
      "DeepSeek model ID must start with deepseek-",
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
  return {
    protocol: input.protocol,
    modelId,
    endpoint: endpoint.baseUrl,
  };
}

export function projectAiModelDisplayName(modelId: string): string {
  const codePoints = [...modelId];
  if (codePoints.length <= 128) return modelId;
  return `${codePoints.slice(0, 64).join("")}…${codePoints.slice(-63).join("")}`;
}
