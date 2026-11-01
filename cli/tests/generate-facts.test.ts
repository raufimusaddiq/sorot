import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseFacts } from "../src/generate";
import { Fail, harness } from "./helpers";

const ID = "11111111-2222-3333-4444-555555555555";
const BASE = "/api/generate/projects";
const at = (file: string) => resolve("/home/u", file).replaceAll("\\", "/");
const fact = (id: string, over: object = {}) => ({
  id: `${id}0000000-0000-0000-0000-000000000000`, claim: "Suku bunga acuan BI adalah 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/rapat", status: "unverified",
  originalValue: null, evidence: null, ...over,
});
const base = () => ({ [`GET ${BASE}`]: { projects: [{ id: ID }] } });

describe("parseFacts", () => {
  test("one fact per line, claim | value | address, with the value optional; headings, blanks and bullets are fine", () => {
    expect(parseFacts("# Facts\n\n- Bunga 5,75 persen | 5,75% | https://bi.go.id/a\n* Inflasi rendah | https://bps.go.id/b\nKurs | 16.000 | http://x.id", "facts.md")).toEqual([
      { claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" },
      { claim: "Inflasi rendah", sourceUrl: "https://bps.go.id/b" },
      { claim: "Kurs", value: "16.000", sourceUrl: "http://x.id" },
    ]);
    expect(parseFacts("", "facts.md")).toEqual([]);
  });

  test.each(["tanpa sumber", "claim | bukan alamat", "| 5% | https://x.id"])("%s is refused with the line", (line) => {
    expect(() => parseFacts(line, "facts.md")).toThrow(`facts.md: "${line}"`);
  });
});

describe("gen facts", () => {
  test("lists the facts with their status, what a correction replaced and why one could not be verified", async () => {
    const h = harness({
      ...base(),
      [`GET ${BASE}/${ID}/facts`]: { facts: [
        fact("a1", { status: "verified" }),
        fact("b2", { status: "corrected", originalValue: "6%", value: "5,75%", evidence: "sebesar 5,75 persen" }),
        fact("c3", { status: "unverifiable", sourceUrl: null, value: null, evidence: "it has no source" }),
      ] },
    });
    expect(await h.run("gen", "facts", "1111")).toBe(0);
    expect(h.out[0]).toMatch(/a1000000\s+verified\s+Suku bunga acuan BI/);
    expect(h.out[0]).toMatch(/b2000000\s+corrected/);
    expect(h.out[1]).toBe("  b2000000 was 6%: sebesar 5,75 persen");
    expect(h.out[2]).toBe("  c3000000 not verifiable: it has no source");
    expect(await h.run("gen", "facts", "1111", "--json")).toBe(0);
    const none = harness({ ...base(), [`GET ${BASE}/${ID}/facts`]: { facts: [] } });
    await none.run("gen", "facts", "1111");
    expect(none.out[0]).toContain("No facts yet");
  });

  test("add needs a source; verify checks them all and exits 1 when one could not be verified", async () => {
    const h = harness({
      ...base(),
      [`POST ${BASE}/${ID}/facts`]: (b: any) => ({ fact: fact("n1", b) }),
      [`POST ${BASE}/${ID}/facts/verify`]: { facts: [fact("a1", { status: "verified" }), fact("c3", { status: "unverifiable", evidence: "headline only" })] },
    });
    expect(await h.run("gen", "facts", "add", "1111", "Bunga 5,75 persen", "--source", "https://bi.go.id/x", "--value", "5,75%")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ claim: "Bunga 5,75 persen", sourceUrl: "https://bi.go.id/x", value: "5,75%" });
    expect(h.out.at(-1)).toContain("Added n1000000. Check it with: sorot gen facts verify 11111111");
    expect(await h.run("gen", "facts", "add", "1111", "Tanpa nilai", "--source", "https://x.id", "--json")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ claim: "Tanpa nilai", sourceUrl: "https://x.id" });
    expect(await h.run("gen", "facts", "add", "1111", "Tanpa sumber")).toBe(2);

    expect(await h.run("gen", "facts", "verify", "1111")).toBe(1);
    expect(h.out).toContain("Checking the facts against their sources…");
    expect(h.out.at(-1)).toBe("  c3000000 not verifiable: headline only");
    const ok = harness({ ...base(), [`POST ${BASE}/${ID}/facts/verify`]: { facts: [fact("a1", { status: "verified" })] } });
    expect(await ok.run("gen", "facts", "verify", "1111", "--json")).toBe(0);
  });

  test("rm finds the fact by the start of its id; an unknown or ambiguous one is a usage error", async () => {
    const h = harness({
      ...base(),
      [`GET ${BASE}/${ID}/facts`]: { facts: [fact("a1"), fact("a2")] },
      [`DELETE /api/generate/facts/a10000000-0000-0000-0000-000000000000`]: { deleted: true },
    });
    expect(await h.run("gen", "facts", "rm", "1111", "a10")).toBe(0);
    expect(h.out.at(-1)).toBe("Deleted.");
    expect(await h.run("gen", "facts", "rm", "1111", "a10", "--json")).toBe(0);
    expect(await h.run("gen", "facts", "rm", "1111", "a")).toBe(2);
    expect(h.err.at(-1)).toContain("More than one fact");
    expect(await h.run("gen", "facts", "rm", "1111", "zz")).toBe(2);
    expect(h.err.at(-1)).toContain("No fact starts with zz");
  });
});

describe("gen new --facts", () => {
  test("reads the facts file and sends them with the brief; --no-numbers forbids numbers beyond the brief", async () => {
    const h = harness({ [`POST ${BASE}`]: { project: { id: ID, status: "RUNNING" } } });
    h.texts.set(at("facts.md"), "- Bunga 5,75 persen | 5,75% | https://bi.go.id/a\n");
    h.existing.add(at("facts.md"));
    expect(await h.run("gen", "new", "Jelaskan bunga", "--facts", "facts.md", "--no-numbers", "--no-wait")).toBe(0);
    expect(h.requests.at(-1)!.body).toMatchObject({ brief: "Jelaskan bunga", forbiddenNumbers: true, facts: [{ claim: "Bunga 5,75 persen", value: "5,75%", sourceUrl: "https://bi.go.id/a" }] });
    expect(await h.run("gen", "new", "Jelaskan bunga", "--facts", "missing.md", "--no-wait")).toBe(2);
    expect(h.err.at(-1)).toContain("No such file: missing.md");
    const refused = harness({ [`POST ${BASE}`]: new Fail(400, "sourceUrl: give the web address") });
    refused.texts.set(at("facts.md"), "A | https://x.id");
    refused.existing.add(at("facts.md"));
    expect(await refused.run("gen", "new", "Jelaskan", "--facts", "facts.md")).toBe(1);
  });
});

describe("gen new --preset", () => {
  test("starts from a ready-made format; the server's refusal of an unknown one is an error", async () => {
    const h = harness({ [`POST ${BASE}`]: { project: { id: ID, status: "RUNNING" } } });
    expect(await h.run("gen", "new", "Ceritakan petani", "--preset", "story", "--no-wait")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ brief: "Ceritakan petani", preset: "story" });
    const bad = harness({ [`POST ${BASE}`]: new Fail(400, 'Unknown preset "cinema" (motion-graphic, story, explainer, card, data, promo)') });
    expect(await bad.run("gen", "new", "x", "--preset", "cinema")).toBe(1);
    expect(bad.err[0]).toContain("Unknown preset");
  });
});
