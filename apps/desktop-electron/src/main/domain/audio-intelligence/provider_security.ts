import { isIP } from "node:net";

import type { AudioAiErrorCode } from "../../../shared/contracts";

export const AI_MAXIMUM_REQUEST_BYTES = 2 * 1024 * 1024;
export const AI_MAXIMUM_RESPONSE_BYTES = 512 * 1024;
export const AI_CONNECT_TIMEOUT_MS = 10_000;
export const AI_RESPONSE_TIMEOUT_MS = 45_000;

export type AiFailureCode = AudioAiErrorCode;

export class AiProviderFailure extends Error {
  constructor(
    readonly code: AiFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiProviderFailure";
  }
}

export interface RemoteAiEndpoint {
  readonly baseUrl: string;
  readonly origin: string;
  readonly chatCompletionsUrl: string;
}

export function parseRemoteAiEndpoint(source: string): RemoteAiEndpoint {
  const value = source.trim();
  if (value.length === 0 || value.length > 2_048) invalidEndpoint();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidEndpoint();
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isIP(host) !== 0
  ) {
    return invalidEndpoint();
  }
  let decodedSegments: string[];
  try {
    decodedSegments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return invalidEndpoint();
  }
  if (decodedSegments.some((part) => part === "." || part === "..")) {
    return invalidEndpoint();
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) {
    path += "/chat/completions";
  } else if (!path.endsWith("/v1/chat/completions")) {
    path += "/v1/chat/completions";
  }
  const chat = new URL(url.origin);
  chat.pathname = path;
  const basePath = url.pathname.replace(/\/+$/, "");
  const base = new URL(url.origin);
  base.pathname = basePath;
  return {
    baseUrl: base.toString().replace(/\/$/, ""),
    origin: url.origin,
    chatCompletionsUrl: chat.toString(),
  };
}

function invalidEndpoint(): never {
  throw new AiProviderFailure(
    "AI_INVALID_CONFIGURATION",
    "AI provider endpoint is not an allowed remote HTTPS address",
  );
}

export interface BoundedOpenAiClientOptions {
  endpoint: RemoteAiEndpoint;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  fetcher?: typeof fetch;
}

export class BoundedOpenAiClient {
  private activeController: AbortController | undefined;
  private readonly maximumRequestBytes: number;
  private readonly maximumResponseBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: BoundedOpenAiClientOptions) {
    this.maximumRequestBytes =
      options.maximumRequestBytes ?? AI_MAXIMUM_REQUEST_BYTES;
    this.maximumResponseBytes =
      options.maximumResponseBytes ?? AI_MAXIMUM_RESPONSE_BYTES;
    this.connectTimeoutMs = options.connectTimeoutMs ?? AI_CONNECT_TIMEOUT_MS;
    this.responseTimeoutMs =
      options.responseTimeoutMs ?? AI_RESPONSE_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? fetch;
    if (
      this.maximumRequestBytes <= 0 ||
      this.maximumResponseBytes <= 0 ||
      this.connectTimeoutMs <= 0 ||
      this.responseTimeoutMs <= 0
    ) {
      throw new RangeError("AI transport bounds must be positive");
    }
  }

  async post(
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ statusCode: number; body: string }> {
    if (Buffer.byteLength(body, "utf8") > this.maximumRequestBytes) {
      throw new AiProviderFailure(
        "AI_REQUEST_TOO_LARGE",
        "AI request exceeds the safe size limit",
      );
    }
    if (this.activeController) {
      throw new AiProviderFailure(
        "AI_SERVICE_UNAVAILABLE",
        "another AI request is already active",
      );
    }
    const controller = new AbortController();
    this.activeController = controller;
    let deadline = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    try {
      const response = await this.fetcher(
        this.options.endpoint.chatCompletionsUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...headers,
          },
          body,
          redirect: "manual",
          signal: controller.signal,
        },
      );
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), this.responseTimeoutMs);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new AiProviderFailure(
          "AI_UNTRUSTED_REDIRECT",
          "AI provider returned a redirect outside the configured boundary",
        );
      }
      return {
        statusCode: response.status,
        body: await readBoundedResponseBody(
          response,
          this.maximumResponseBytes,
          controller.signal,
        ),
      };
    } catch (error) {
      if (error instanceof AiProviderFailure) throw error;
      throw new AiProviderFailure(
        "AI_NETWORK_UNAVAILABLE",
        "AI provider request failed",
        { cause: error },
      );
    } finally {
      clearTimeout(deadline);
      this.activeController = undefined;
    }
  }

  cancel(): void {
    this.activeController?.abort();
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AiProviderFailure(
        "AI_RESPONSE_TOO_LARGE",
        "AI response exceeds the safe size limit",
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new Error("AI response body timed out"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) onAbort();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value.byteLength > maximumBytes - total) {
        throw new AiProviderFailure(
          "AI_RESPONSE_TOO_LARGE",
          "AI response exceeds the safe size limit",
        );
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    await response.body?.cancel(error).catch(() => undefined);
    throw new AiProviderFailure(
      "AI_INVALID_OUTPUT",
      "AI response is not UTF-8",
      {
        cause: error,
      },
    );
  }
}
