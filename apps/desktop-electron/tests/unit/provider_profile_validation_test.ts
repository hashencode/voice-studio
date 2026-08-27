import { describe, expect, it } from "vitest";

import {
  projectAiModelDisplayName,
  validateAiProviderProfileInput,
} from "../../src/main/domain/audio-intelligence/provider_profile_validation";

describe("AI provider profile validation", () => {
  it("requires the DeepSeek model ID prefix without rewriting the ID", () => {
    expect(() =>
      validateAiProviderProfileInput({
        protocol: "deepseek",
        modelId: "chat",
        endpoint: "https://api.deepseek.com",
      }),
    ).toThrow("DeepSeek model ID must start with deepseek-");

    expect(
      validateAiProviderProfileInput({
        protocol: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
      }).modelId,
    ).toBe("deepseek-chat");
  });

  it("keeps short model IDs exact and preserves both ends of long IDs", () => {
    const exact = "m".repeat(128);
    const long = `${"a".repeat(64)}middle${"z".repeat(63)}`;

    expect(projectAiModelDisplayName(exact)).toBe(exact);
    expect(projectAiModelDisplayName(long)).toBe(
      `${"a".repeat(64)}…${"z".repeat(63)}`,
    );
    expect([...projectAiModelDisplayName(long)]).toHaveLength(128);
  });
});
