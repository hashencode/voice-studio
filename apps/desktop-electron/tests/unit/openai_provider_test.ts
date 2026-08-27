import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProvider } from "../../src/main/domain/audio-intelligence/openai_provider";
import type { BoundedOpenAiClient } from "../../src/main/domain/audio-intelligence/provider_security";
import type { DesktopSecretStorePort } from "../../src/main/features/secrets/secret_store_port";

describe("custom OpenAI-compatible profile routing", () => {
  it("reads the job secret reference and keeps DeepSeek-specific request options", async () => {
    const read = vi.fn(async () => ({
      state: "available" as const,
      secret: "private-key",
    }));
    const post = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                schema_version: "audio_intelligence_output/v1",
                suggested_title: null,
                audio_type: null,
                items: [
                  {
                    kind: "decision",
                    body: "ship",
                    evidence: [{ segment_id: 7, start_ms: 0, end_ms: 1_000 }],
                    action_owner: null,
                    action_due_at_ms: null,
                  },
                ],
              }),
            },
          },
        ],
      }),
    }));
    const provider = new OpenAiCompatibleProvider(
      {
        providerId: "deepseek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        secretRef: "secret-profile-a",
      },
      {
        read,
        replace: vi.fn(),
        delete: vi.fn(),
        fileVaultStatus: vi.fn(),
      } as DesktopSecretStorePort,
      { post, cancel: vi.fn() } as unknown as BoundedOpenAiClient,
    );

    await provider.generate({
      audioTitle: "Audio",
      templateId: "default",
      segments: [
        {
          id: 7,
          startMs: 0,
          endMs: 1_000,
          text: "ship",
          speakerState: "unknown",
        },
      ],
    });

    expect(read).toHaveBeenCalledWith("secret-profile-a");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('"thinking":{"type":"disabled"}'),
      { authorization: "Bearer private-key" },
    );
  });
});
