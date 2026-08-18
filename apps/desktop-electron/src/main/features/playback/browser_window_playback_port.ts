import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

import type { MainPlaybackPort } from "./audio_playback_service";

const playerExpression = "document.querySelector('audio, video')";

export class BrowserWindowPlaybackPort implements MainPlaybackPort {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly playerDocumentPath: string,
    private readonly createWindow: (
      options: BrowserWindowConstructorOptions,
    ) => BrowserWindow = (options) => new BrowserWindow(options),
  ) {}

  async open(mediaPath: string): Promise<void> {
    if (!existsSync(mediaPath)) throw new Error("audio file is missing");
    const window = await this.requireWindow();
    const source = JSON.stringify(pathToFileURL(mediaPath).href);
    try {
      await window.webContents.executeJavaScript(
        `new Promise((resolve, reject) => {
        const audio = ${playerExpression};
        if (!audio) {
          reject(new Error("audio element is unavailable"));
          return;
        }
        if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          resolve(true);
          return;
        }
        const ready = () => { cleanup(); resolve(true); };
        const failed = () => { cleanup(); reject(new Error("audio decode failed")); };
        const cleanup = () => {
          audio.removeEventListener("canplay", ready);
          audio.removeEventListener("error", failed);
        };
        audio.addEventListener("canplay", ready, { once: true });
        audio.addEventListener("error", failed, { once: true });
        audio.src = ${source};
        audio.load();
        })`,
        true,
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async play(): Promise<void> {
    await this.execute(`${playerExpression}.play()`);
  }

  async pause(): Promise<void> {
    await this.execute(`${playerExpression}.pause()`);
  }

  async seek(positionMs: number): Promise<void> {
    await this.execute(
      `${playerExpression}.currentTime = ${Math.max(0, positionMs) / 1_000}`,
    );
  }

  async setSpeed(speed: number): Promise<void> {
    await this.execute(`${playerExpression}.playbackRate = ${speed}`);
  }

  async close(): Promise<void> {
    const window = this.window;
    this.window = null;
    if (!window || window.isDestroyed()) return;
    window.destroy();
  }

  private async requireWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = this.createWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await window.loadFile(this.playerDocumentPath);
    } catch (error) {
      await this.close();
      throw error;
    }
    return window;
  }

  private async execute(script: string): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("audio is not open");
    await window.webContents.executeJavaScript(script, true);
  }
}
