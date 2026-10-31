import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config";
import { HttpError } from "../http";
import { now, type Store } from "../store";
import type { GenAsset } from "../types";

// Files the owner brings (logo, images, fonts, music), stored under the project's assets/.
// Generated images, voiceovers and captions are added by their own steps with other origins.

export type UploadKind = "logo" | "image" | "font" | "music";

const MB = 1024 * 1024;
export const UPLOAD_RULES: Record<UploadKind, { exts: string[]; maxBytes: number }> = {
  logo: { exts: ["png", "jpg", "jpeg", "webp", "svg"], maxBytes: 5 * MB },
  image: { exts: ["png", "jpg", "jpeg", "webp", "svg"], maxBytes: 10 * MB },
  font: { exts: ["ttf", "otf", "woff", "woff2"], maxBytes: 5 * MB },
  music: { exts: ["mp3", "m4a", "wav", "ogg"], maxBytes: 30 * MB },
};

export const projectDir = (config: Pick<AppConfig, "genDir">, projectId: string) => `${config.genDir}/${projectId}`;

export class Assets {
  constructor(private readonly config: AppConfig, private readonly store: Store) {}

  /** Saves an upload. An uploaded image for a shot replaces the image generated for it (FR-017). */
  upload(projectId: string, file: { kind: string; filename: string; data: Uint8Array; shotId?: string | null }): GenAsset {
    const rules = UPLOAD_RULES[file.kind as UploadKind];
    if (!rules) throw new HttpError(400, `kind must be one of ${Object.keys(UPLOAD_RULES).join(", ")}`);
    const ext = file.filename.includes(".") ? file.filename.split(".").pop()!.toLowerCase() : "";
    if (!rules.exts.includes(ext)) throw new HttpError(400, `A ${file.kind} must be ${rules.exts.map((e) => `.${e}`).join(", ")}`);
    if (file.data.byteLength === 0) throw new HttpError(400, "The file is empty");
    if (file.data.byteLength > rules.maxBytes) throw new HttpError(400, `A ${file.kind} can be at most ${rules.maxBytes / MB} MB`);

    const id = crypto.randomUUID();
    const safe = file.filename.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || `file.${ext}`;
    const path = `assets/${id.slice(0, 8)}-${safe}`;
    const abs = join(projectDir(this.config, projectId), path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.data);

    if (file.kind === "image" && file.shotId) {
      for (const old of this.store.genAssetsForProject(projectId)) {
        if (old.origin === "generated" && old.shotId === file.shotId) this.remove(old.id);
      }
    }
    const family = file.kind === "font" ? { meta: JSON.stringify({ family: safe.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") }) } : { meta: null };
    return this.store.saveGenAsset({
      id, projectId, kind: file.kind as UploadKind, origin: "upload", path, shotId: file.shotId ?? null, promptHash: null,
      createdAt: now(), ...family,
    });
  }

  /** Deletes the row and the file. */
  remove(assetId: string): void {
    const asset = this.store.getGenAsset(assetId);
    if (!asset) throw new HttpError(404, "Asset not found");
    rmSync(join(projectDir(this.config, asset.projectId), asset.path), { force: true });
    this.store.deleteGenAsset(assetId);
  }
}
