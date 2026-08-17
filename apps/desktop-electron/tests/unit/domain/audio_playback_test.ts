import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AudioPlaybackService,
  type MainPlaybackPort,
} from "../../../src/main/features/playback/audio_playback_service";
import { BrowserWindowPlaybackPort } from "../../../src/main/features/playback/browser_window_playback_port";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Main-owned audio playback", () => {
  it("resolves media privately and accepts only bounded opaque actions", async () => {
    const calls: Array<[string, unknown?]> = [];
    const port: MainPlaybackPort = {
      open: vi.fn(async (mediaPath) => calls.push(["open", mediaPath])),
      play: vi.fn(async () => calls.push(["play"])),
      pause: vi.fn(async () => calls.push(["pause"])),
      seek: vi.fn(async (positionMs) => calls.push(["seek", positionMs])),
      setSpeed: vi.fn(async (speed) => calls.push(["speed", speed])),
      close: vi.fn(async () => calls.push(["close"])),
    };
    const service = new AudioPlaybackService(
      {
        resolvePlayback: () => ({
          mediaPath: "/private/media/audio.wav",
          durationMs: 10_000,
        }),
      },
      port,
    );

    expect(await service.command({ audioId: 7, action: "open" })).toEqual(
      expect.objectContaining({
        audioId: 7,
        initialized: true,
        durationMs: 10_000,
      }),
    );
    await service.command({ audioId: 7, action: "seek", positionMs: 99_000 });
    await service.command({ audioId: 7, action: "speed", speed: 2 });
    await service.command({ audioId: 7, action: "play" });
    expect(calls).toEqual([
      ["open", "/private/media/audio.wav"],
      ["seek", 10_000],
      ["speed", 2],
      ["play"],
    ]);
    expect(JSON.stringify(await service.snapshot())).not.toContain(
      "/private/media",
    );

    await expect(
      service.command({ audioId: 7, action: "speed", speed: 2.01 }),
    ).rejects.toThrow(/speed/i);
    await expect(
      service.command({ audioId: 8, action: "play" }),
    ).rejects.toThrow(/open/i);
  });

  it("destroys Main-owned playback state when media resolution or opening fails", async () => {
    const port: MainPlaybackPort = {
      open: vi.fn(async () => {
        throw new Error("decode failed at /private/profile/media/secret.wav");
      }),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setSpeed: vi.fn(),
      close: vi.fn(),
    };
    const service = new AudioPlaybackService(
      {
        resolvePlayback: async () => ({
          mediaPath: "/private/profile/media/secret.wav",
          durationMs: 100,
        }),
      },
      port,
    );

    await expect(
      service.command({ audioId: 1, action: "open" }),
    ).rejects.toThrow(/decode/i);
    expect(port.close).toHaveBeenCalledOnce();
    expect(service.snapshot()).toEqual(
      expect.objectContaining({ audioId: null, initialized: false }),
    );
    await expect(service.close()).resolves.toBeUndefined();
    expect(port.close).toHaveBeenCalledTimes(2);
  });

  it("destroys the hidden BrowserWindow after document-load and decode failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-playback-window-"));
    roots.push(root);
    const media = join(root, "audio.wav");
    writeFileSync(media, Buffer.alloc(64));
    const destroy = vi.fn();
    const window = {
      isDestroyed: vi.fn(() => false),
      destroy,
      loadFile: vi.fn(async () => undefined),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: vi.fn(async () => {
          throw new Error("audio decode failed");
        }),
      },
    } as unknown as BrowserWindow;
    const port = new BrowserWindowPlaybackPort("/player.html", () => window);
    await expect(port.open(media)).rejects.toThrow(/decode/i);
    expect(destroy).toHaveBeenCalledOnce();

    const loadDestroy = vi.fn();
    const loadFailureWindow = {
      isDestroyed: vi.fn(() => false),
      destroy: loadDestroy,
      loadFile: vi.fn(async () => {
        throw new Error("document load failed");
      }),
      webContents: { setWindowOpenHandler: vi.fn() },
    } as unknown as BrowserWindow;
    const loadFailurePort = new BrowserWindowPlaybackPort(
      "/player.html",
      () => loadFailureWindow,
    );
    await expect(loadFailurePort.open(media)).rejects.toThrow(/load/i);
    expect(loadDestroy).toHaveBeenCalledOnce();
  });
});
