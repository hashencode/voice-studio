import { describe, expect, it, vi } from "vitest";

import {
  AiProviderFailure,
  BoundedOpenAiClient,
  parseRemoteAiEndpoint,
} from "../../src/main/domain/meeting-intelligence/provider_security";
import {
  decodeMeetingAiOutput,
  type MeetingAiInputSegment,
} from "../../src/main/domain/meeting-intelligence/provider_output";
import { AiProviderRegistry } from "../../src/main/domain/meeting-intelligence/provider_registry";

describe("U10 provider security", () => {
  it.each([
    "http://ai.example.com",
    "https://user:secret@ai.example.com",
    "https://192.168.1.5",
    "https://model.local",
    "https://ai.example.com:8443",
    "https://ai.example.com?secret=x",
    "https://ai.example.com/#fragment",
  ])("rejects an untrusted remote endpoint: %s", (source) => {
    expect(() => parseRemoteAiEndpoint(source)).toThrowError(
      expect.objectContaining({ code: "AI_INVALID_CONFIGURATION" }),
    );
  });

  it("normalizes only the configured HTTPS origin and path", () => {
    expect(parseRemoteAiEndpoint("https://ai.example.com/v1")).toMatchObject({
      origin: "https://ai.example.com",
      chatCompletionsUrl: "https://ai.example.com/v1/chat/completions",
    });
  });

  it("rejects redirects and bounded response overflow without following", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/v1/chat/completions" },
        }),
      )
      .mockResolvedValueOnce(new Response("x".repeat(1_025), { status: 200 }));
    const client = new BoundedOpenAiClient({
      endpoint: parseRemoteAiEndpoint("https://ai.example.com"),
      maximumResponseBytes: 1_024,
      fetcher,
    });

    await expect(client.post("{}", {})).rejects.toMatchObject({
      code: "AI_UNTRUSTED_REDIRECT",
    });
    await expect(client.post("{}", {})).rejects.toMatchObject({
      code: "AI_RESPONSE_TOO_LARGE",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("enforces an independent connect deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          {
            once: true,
          },
        );
      });
    });
    const client = new BoundedOpenAiClient({
      endpoint: parseRemoteAiEndpoint("https://ai.example.com"),
      connectTimeoutMs: 20,
      responseTimeoutMs: 200,
      fetcher,
    });

    await expect(client.post("{}", {})).rejects.toMatchObject({
      code: "AI_NETWORK_UNAVAILABLE",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("gives the response body its own deadline and cancels a stalled stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel,
      }),
      { status: 200 },
    );
    const client = new BoundedOpenAiClient({
      endpoint: parseRemoteAiEndpoint("https://ai.example.com"),
      connectTimeoutMs: 200,
      responseTimeoutMs: 20,
      fetcher: vi.fn(async () => response),
    });

    await expect(client.post("{}", {})).rejects.toMatchObject({
      code: "AI_NETWORK_UNAVAILABLE",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("validates the strict schema and every evidence reference", () => {
    const segments: MeetingAiInputSegment[] = [
      { id: 41, startMs: 1_000, endMs: 2_500, text: "下周一发布。" },
    ];
    expect(
      decodeMeetingAiOutput(
        JSON.stringify({
          schema_version: "meeting_intelligence_output/v1",
          suggested_title: null,
          meeting_type: null,
          items: [
            {
              kind: "decision",
              body: "下周一发布。",
              evidence: [{ segment_id: 41, start_ms: 1_000, end_ms: 2_500 }],
              action_owner: null,
              action_due_at_ms: null,
            },
          ],
        }),
        segments,
      ).items,
    ).toHaveLength(1);

    expect(() =>
      decodeMeetingAiOutput(
        JSON.stringify({
          schema_version: "meeting_intelligence_output/v1",
          suggested_title: null,
          meeting_type: null,
          items: [
            {
              kind: "decision",
              body: "unsupported",
              evidence: [{ segment_id: 999, start_ms: 0, end_ms: 1 }],
              action_owner: null,
              action_due_at_ms: null,
            },
          ],
        }),
        segments,
      ),
    ).toThrowError(expect.objectContaining({ code: "AI_EVIDENCE_INVALID" }));

    expect(() =>
      decodeMeetingAiOutput(
        JSON.stringify({
          schema_version: "meeting_intelligence_output/v1",
          suggested_title: null,
          meeting_type: null,
          items: [
            {
              kind: "decision",
              body: "missing evidence",
              evidence: [],
              action_owner: null,
              action_due_at_ms: null,
            },
          ],
        }),
        segments,
      ),
    ).toThrowError(expect.objectContaining({ code: "AI_INVALID_OUTPUT" }));
  });

  it("selects exactly one provider and never falls back after failure", async () => {
    const failed = vi.fn(async () => {
      throw new AiProviderFailure("AI_PROVIDER_FAILED", "failed");
    });
    const fallback = vi.fn(async () => ({
      schemaVersion: "meeting_intelligence_output/v1" as const,
      suggestedTitle: null,
      meetingType: null,
      items: [],
    }));
    const registry = new AiProviderRegistry([
      { id: "deepseek", generate: failed },
      { id: "openai-compatible", generate: fallback },
    ]);

    await expect(
      registry.resolve("deepseek").generate({} as never),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_FAILED",
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(() => registry.resolve("missing")).toThrowError(
      expect.objectContaining({ code: "AI_PROVIDER_MISSING" }),
    );
  });
});
