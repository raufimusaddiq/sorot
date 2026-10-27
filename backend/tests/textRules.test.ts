// Golden test: the Bun text rules must reproduce the Python originals exactly.
// fixtures/text-rules.json is written by ai-pipeline/tools/golden_text_rules.py
// from real transcript segments plus edge cases.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpLen, pyIsDigit, pyIsUpper, pyRound, pySplit } from "../src/pyCompat";
import { CTA_PHRASES } from "../src/ruleConstants";
import * as R from "../src/textRules";
import golden from "./fixtures/text-rules.json";

type Row = (typeof golden.rows)[number];

describe("matches the Python rules on every fixture row", () => {
  const rows = golden.rows as Row[];
  const check = (name: string, fn: (r: Row) => unknown, expected: (r: Row) => unknown) =>
    test(name, () => {
      const bad = rows.filter((r) => JSON.stringify(fn(r)) !== JSON.stringify(expected(r)));
      expect(bad.map((r) => ({ text: r.text.slice(0, 60), got: fn(r), want: expected(r) }))).toEqual([]);
    });

  test(`${rows.length} rows`, () => expect(rows.length).toBeGreaterThan(200));
  check("firstSentence", (r) => R.firstSentence(r.text), (r) => r.firstSentence);
  check("hookStrength", (r) => R.hookStrength(r.text), (r) => r.hook);
  check("keywordTrigger", (r) => R.keywordTrigger(r.text), (r) => r.keyword);
  check("novelty", (r) => R.novelty(r.text), (r) => r.novelty);
  check("clarity", (r) => R.clarity(r.duration, r.text), (r) => r.clarity);
  check("sentiment", (r) => R.sentiment(r.text), (r) => r.sentiment);
  check("boosts", (r) => R.boosts(r.text), (r) => r.boosts);
  check("penalties", (r) => R.penalties(r.text, r.duration, r.penaltyScores), (r) => r.penalties);
  check("pauseStructure (no transcript)", (r) => R.pauseStructure(r.text, r.duration), (r) => r.pause);
  check("topicFit", (r) => R.topicFit(r.text, golden.niche), (r) => r.topic);
  check("topicFit without niche", (r) => R.topicFit(r.text, null), (r) => r.topicNone);
  check("emotional energy (text only)", (r) => R.emotionalEnergy(r.text, null), (r) => r.energyText);
  check("clipTitle", (r) => R.clipTitle(r.text, ["PRIMARY", "BACKUP", "SKIP"][rows.indexOf(r) % 3]!), (r) => r.title);
  test("clipDescription (call to action is now stable instead of Python's per-run hash)", () => {
    const bad = rows.filter((r, i) => {
      const tier = ["PRIMARY", "BACKUP", "SKIP"][i % 3]!;
      const got = R.clipDescription(r.text, tier).split("\n");
      const want = r.description.split("\n");
      return JSON.stringify(got.slice(0, -1)) !== JSON.stringify(want.slice(0, -1)) || !CTA_PHRASES.includes(got.at(-1)!);
    });
    expect(bad.map((r) => r.text.slice(0, 60))).toEqual([]);
    expect(R.ctaFor("same text")).toBe(R.ctaFor("same text"));
  });
});

describe("pieces the fixtures don't reach", () => {
  test("python compat helpers", () => {
    expect(pySplit("  a \t b\n")).toEqual(["a", "b"]);
    expect(cpLen("a😀")).toBe(2);
    expect(pyIsUpper("ABC1")).toBeTrue();
    expect(pyIsUpper("123")).toBeFalse();
    expect(pyIsUpper("AbC")).toBeFalse();
    expect(pyIsDigit("²")).toBeTrue();
    expect(pyIsDigit("x")).toBeFalse();
    // Python rounds exact ties to even; everything else to nearest
    expect([pyRound(0.125, 2), pyRound(0.375, 2), pyRound(2.5), pyRound(3.5), pyRound(-0.125, 2)]).toEqual([0.12, 0.38, 2, 4, -0.12]);
    expect([pyRound(0.30000000000000004, 4), pyRound(0.6789, 2), pyRound(-0.0001, 2), pyRound(Number.NaN, 2)]).toEqual([0.3, 0.68, 0, Number.NaN]);
  });

  test("energy with loudness, silence ratio and pause bands", () => {
    expect([2, 1.5, 1, 0.5, 0.1].map((rms) => R.emotionalEnergy("biasa saja", rms))).toEqual([0.72, 0.6, 0.42, 0.3, 0.18]);
    const segs = [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 9.5, end: 10 }, { start: 20, end: 30 }];
    expect(R.silenceRatio(segs, 0, 10)).toBeCloseTo(0.15);
    expect(R.silenceRatio(segs, 25, 29)).toBeNull();
    expect(R.silenceRatio(null, 0, 1)).toBeNull();
    expect(R.silenceRatio(segs, 5, 5)).toBeNull();
    expect([0.05, 0.2, 0.3, 0.5].map((r) => R.pauseStructure("x", 10, r))).toEqual([0.9, 0.7, 0.4, 0.1]);
    expect(R.pauseStructure("", 10)).toBe(0.3);
    expect(R.pauseStructure("a b c d e f g h i j k l m n o p q r s t u v w x y z", 4)).toBe(0.5);
  });

  test("history score", () => {
    const hist = [
      { text: "rahasia sukses bisnis kecil di desa", viralScore: 0.9 },
      { text: "rahasia sukses bisnis besar", viralScore: 0.6 },
      { text: "rahasia sukses", viralScore: 0.1 },
      { text: "rahasia sukses bisnis kecil", viralScore: null },
    ];
    expect(R.historyScore(hist, "Rahasia sukses bisnis kecil")).toBe(0.75);
    expect(R.historyScore([], "x")).toBe(0.5);
    expect(R.historyScore(hist, "")).toBe(0.5);
    expect(R.historyScore(hist, "tidak ada yang sama")).toBe(0.5);
  });

  test("keyword TF-IDF corpus", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    writeFileSync(join(dir, "a.txt"), "rahasia besar ternyata ada");
    writeFileSync(join(dir, "b.txt"), "rahasia kecil ternyata");
    writeFileSync(join(dir, "c.txt"), "cuaca cerah hari ini");
    writeFileSync(join(dir, "skip.md"), "rahasia");
    R.clearKeywordCorpusCache();
    expect(R.loadKeywordCorpus(dir)).toEqual({ rahasia: Math.log(1 + 3 / 2), ternyata: Math.log(1 + 3 / 2) });
    expect(R.keywordTrigger("rahasia ternyata", dir)).toBe(1.0);
    expect(R.keywordTrigger("rahasia dan hal lain yang biasa saja di sini", dir)).toBe(0.4);
    expect(R.keywordTrigger("tidak cocok", dir)).toBe(0.1);
    expect(R.keywordTrigger("", dir)).toBe(0.1);
    expect(R.keywordTrigger("rahasia " + "kata ".repeat(10), dir)).toBe(0.2);
    expect(R.keywordTrigger("rahasia ternyata kata", dir)).toBe(0.85);          // 1.96 / 3 tokens
    expect(R.keywordTrigger("rahasia kata kata", dir)).toBe(0.65);              // 0.98 / 3 tokens
    expect(R.loadKeywordCorpus(join(dir, "missing"))).toBeNull();
    const one = mkdtempSync(join(tmpdir(), "corpus-"));
    writeFileSync(join(one, "a.txt"), "satu dokumen saja");
    expect(R.loadKeywordCorpus(one)).toBeNull();
  });
});

afterEach(() => R.clearKeywordCorpusCache());
