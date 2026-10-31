import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { Assets, UPLOAD_RULES } from "../../src/generate/assets";
import { HttpError } from "../../src/http";
import { Store } from "../../src/store";
import { loadConfig } from "../../src/config";

let dir: string;
let store: Store;
let assets: Assets;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vc-assets-"));
  store = new Store(openDatabase(":memory:"));
  assets = new Assets({ ...loadConfig({}), genDir: dir }, store);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (n = 4) => new Uint8Array(n).fill(7);
const fail = (fn: () => unknown) => { try { fn(); } catch (e) { return e as HttpError; } throw new Error("did not throw"); };
const onDisk = (projectId: string, path: string) => join(dir, projectId, path);

describe("asset uploads", () => {
  test.each([
    ["logo", "logo.PNG"], ["image", "foto.jpg"], ["font", "Bebas Neue.ttf"], ["music", "lagu.mp3"],
  ])("a %s (%s) is stored under the project's assets/ with an upload row", (kind, filename) => {
    const a = assets.upload("p1", { kind, filename, data: bytes() });
    expect(a).toMatchObject({ projectId: "p1", kind, origin: "upload", shotId: null });
    expect(a.path).toMatch(/^assets\/[0-9a-f]{8}-/);
    expect(readFileSync(onDisk("p1", a.path))).toHaveLength(4);
    expect(store.genAssetsForProject("p1").map((x) => x.id)).toEqual([a.id]);
  });

  test("a font keeps its family name; a file name can't escape the folder", () => {
    const font = assets.upload("p1", { kind: "font", filename: "My-Font_Bold.woff2", data: bytes() });
    expect(JSON.parse(font.meta!)).toEqual({ family: "My Font Bold" });
    const sneaky = assets.upload("p1", { kind: "image", filename: "../../evil name.png", data: bytes() });
    expect(sneaky.path).toMatch(/^assets\/[0-9a-f]{8}-[\w.-]+\.png$/);
    expect(sneaky.path.slice("assets/".length)).not.toMatch(/[\/]/);
    expect(existsSync(onDisk("p1", sneaky.path))).toBe(true);
    expect(assets.upload("p1", { kind: "image", filename: "...png", data: bytes() }).path).toContain("png");
  });

  test.each([
    ["an unknown kind", { kind: "video", filename: "a.mp4" }, "kind must be one of"],
    ["the wrong extension", { kind: "logo", filename: "a.exe" }, "A logo must be"],
    ["no extension", { kind: "music", filename: "song" }, "A music must be"],
    ["an empty file", { kind: "logo", filename: "a.png", data: new Uint8Array() }, "empty"],
    ["a file over the limit", { kind: "font", filename: "a.ttf", data: new Uint8Array(UPLOAD_RULES.font.maxBytes + 1) }, "at most 5 MB"],
  ])("refuses %s", (_name, file, message) => {
    const err = fail(() => assets.upload("p1", { data: bytes(), ...file }));
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toContain(message);
    expect(store.genAssetsForProject("p1")).toEqual([]);
  });

  test("an uploaded image for a shot replaces the generated one (FR-017); other shots are untouched", () => {
    const gen = (shotId: string) => store.saveGenAsset({
      id: `g-${shotId}`, projectId: "p1", kind: "image", origin: "generated", path: `assets/gen-${shotId}.png`, shotId, promptHash: "h", meta: null, createdAt: "t",
    });
    gen("s01");
    gen("s02");
    const up = assets.upload("p1", { kind: "image", filename: "mine.png", data: bytes(), shotId: "s01" });
    expect(up.shotId).toBe("s01");
    expect(store.genAssetsForProject("p1").map((a) => a.id).sort()).toEqual(["g-s02", up.id].sort());
    // an upload without a shot, or a logo, replaces nothing
    assets.upload("p1", { kind: "image", filename: "free.png", data: bytes() });
    assets.upload("p1", { kind: "logo", filename: "l.png", data: bytes(), shotId: "s02" });
    expect(store.genAssetsForProject("p1")).toHaveLength(4);
  });

  test("removing deletes the file and the row; an unknown asset is a 404", () => {
    const a = assets.upload("p1", { kind: "logo", filename: "l.png", data: bytes() });
    assets.remove(a.id);
    expect(existsSync(onDisk("p1", a.path))).toBe(false);
    expect(store.getGenAsset(a.id)).toBeNull();
    expect(fail(() => assets.remove(a.id))).toMatchObject({ status: 404 });
  });
});
