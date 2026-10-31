import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, ApiError } from "../src/api";
import { realDeps } from "../src/main";

test("real file helpers: write and read text and bytes, and a scratch path in the temp folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "sorot-gen-"));
  try {
    const d = realDeps();
    const file = join(dir, "plan.json");
    d.fs.writeText(file, '{"a":1}\n');
    expect(d.fs.readText(file)).toBe('{"a":1}\n');
    expect(Array.from(d.fs.read(file).slice(0, 2))).toEqual([123, 34]);
    const scratch = d.fs.tempPath("plan-abc.json");
    expect(scratch.startsWith(tmpdir())).toBe(true);
    expect(scratch.endsWith("plan-abc.json")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the editor comes from $VISUAL, then $EDITOR", () => {
  const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
  try {
    process.env.VISUAL = "";
    process.env.EDITOR = "nano";
    expect(realDeps().editor).toBe("nano");
    process.env.VISUAL = "code -w";
    expect(realDeps().editor).toBe("code -w");
  } finally {
    process.env.VISUAL = saved.v;
    process.env.EDITOR = saved.e;
  }
});

test("Api.upload sends multipart and returns the data; errors keep the server's message", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ok") {
        const form = await req.formData();
        return Response.json({ status: "ok", data: { name: (form.get("file") as File).name, kind: form.get("kind") } });
      }
      if (path === "/refused") return Response.json({ status: "error", error: "A logo must be .png" }, { status: 400 });
      return new Response("<html>nope</html>", { status: 502 });
    },
  });
  try {
    const api = new Api(`http://localhost:${server.port}`);
    const form = new FormData();
    form.set("file", new File(["x"], "logo.png"));
    form.set("kind", "logo");
    expect(await api.upload("/ok", form)).toEqual({ name: "logo.png", kind: "logo" });
    await expect(api.upload("/refused", form)).rejects.toMatchObject({ message: "A logo must be .png", status: 400 });
    await expect(api.upload("/broken", form)).rejects.toMatchObject({ status: 502 });
  } finally {
    server.stop(true);
  }
  await expect(new Api("http://localhost:1").upload("/x", new FormData())).rejects.toBeInstanceOf(ApiError);
});
