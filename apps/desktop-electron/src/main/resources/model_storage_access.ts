import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { App, BrowserWindow, Dialog } from "electron";

import { writeJsonAtomically } from "../profile/atomic_json";

/** Main-only directory selection and security-scoped bookmark ownership. */
export class ModelStorageAccess {
  private readonly bookmarkPath: string;
  private readonly bookmarks = new Map<string, string>();

  constructor(
    private readonly dialog: Pick<Dialog, "showOpenDialog">,
    private readonly application?: Pick<
      App,
      "startAccessingSecurityScopedResource"
    >,
    metadataRoot?: string,
  ) {
    const root =
      metadataRoot ?? path.join(process.cwd(), ".local-model-access");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.bookmarkPath = path.join(root, "security-scoped-bookmarks.json");
    if (!existsSync(this.bookmarkPath)) return;
    try {
      const decoded = JSON.parse(readFileSync(this.bookmarkPath, "utf8")) as {
        schemaVersion?: unknown;
        bookmarks?: Record<string, unknown>;
      };
      if (decoded.schemaVersion !== 1 || !decoded.bookmarks) return;
      for (const [storeId, bookmark] of Object.entries(decoded.bookmarks)) {
        if (
          /^store-[a-zA-Z0-9-]{12,120}$/.test(storeId) &&
          typeof bookmark === "string" &&
          bookmark.length > 0
        ) {
          this.bookmarks.set(storeId, bookmark);
        }
      }
    } catch {
      // Invalid bookmark metadata is ignored; filesystem identity still gates use.
    }
  }

  async chooseRoot(owner: BrowserWindow): Promise<{
    path: string;
    securityScopedBookmark: string | null;
  } | null> {
    const result = await this.dialog.showOpenDialog(owner, {
      title: "选择本地模型位置",
      buttonLabel: "使用此位置",
      properties: ["openDirectory", "createDirectory"],
      securityScopedBookmarks: process.mas,
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    return {
      path: result.filePaths[0]!,
      securityScopedBookmark: result.bookmarks?.[0] ?? null,
    };
  }

  remember(storeId: string | null, bookmark: string | null): void {
    if (!storeId || !bookmark) return;
    this.bookmarks.set(storeId, bookmark);
    writeJsonAtomically(this.bookmarkPath, {
      schemaVersion: 1,
      bookmarks: Object.fromEntries(this.bookmarks),
    });
  }

  async withStoreAccess<T>(
    storeId: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return await this.withBookmark(
      storeId ? this.bookmarks.get(storeId) : undefined,
      work,
    );
  }

  async withSelectedAccess<T>(
    bookmark: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return await this.withBookmark(bookmark ?? undefined, work);
  }

  async withAllStoredAccess<T>(work: () => Promise<T>): Promise<T> {
    const stops = [...this.bookmarks.values()].map((bookmark) =>
      this.startAccess(bookmark),
    );
    try {
      return await work();
    } finally {
      for (const stop of stops.reverse()) stop?.();
    }
  }

  acquire(storeId: string): () => void {
    return this.startAccess(this.bookmarks.get(storeId)) ?? (() => undefined);
  }

  private async withBookmark<T>(
    bookmark: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const stop = this.startAccess(bookmark);
    try {
      return await work();
    } finally {
      stop?.();
    }
  }

  private startAccess(bookmark: string | undefined): (() => void) | null {
    if (!bookmark || !process.mas || !this.application) return null;
    const release =
      this.application.startAccessingSecurityScopedResource(bookmark);
    return () => release();
  }
}
