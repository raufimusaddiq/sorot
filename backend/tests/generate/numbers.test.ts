import { describe, expect, test } from "bun:test";
import { numbersOf, parseDigits, sameNumber, unmatchedNumbers, valueOf } from "../../src/generate/numbers";

const values = (text: string) => numbersOf(text).map((n) => [n.value, n.percent]);

describe("digits", () => {
  test.each([
    ["40", 40], ["1,5", 1.5], ["1.5", 1.5], ["2.500", 2500], ["1,000", 1000], ["0,500", 0.5], ["12.345.678", 12345678],
    ["1.234,56", 1234.56], ["1,234.56", 1234.56], ["3.14", 3.14], ["10,25", 10.25], ["100,000", 100000], ["7", 7],
  ])("%s is %p", (text, expected) => expect(parseDigits(text)).toBe(expected));

  test.each([
    ["Bunga 1,5% per tahun", [[1.5, true]]],
    ["bunga 1.5 % per tahun", [[1.5, true]]],
    ["interest of 1.5 percent", [[1.5, true]]],
    ["harga Rp 2.500 dan 40 orang", [[2500, false], [40, false]]],
    ["5 juta rupiah", [[5_000_000, false]]],
    ["3 million users, 2 miliar views", [[3_000_000, false], [2_000_000_000, false]]],
    ["no numbers at all", []],
    ["tahun 2024", [[2024, false]]],
  ])("%s", (text, expected) => expect(values(text)).toEqual(expected));
});

describe("spelled-out numbers", () => {
  test.each([
    ["satu", 1], ["sembilan", 9], ["sepuluh", 10], ["sebelas", 11], ["dua belas", 12], ["lima belas", 15], ["dua puluh", 20], ["dua puluh satu", 21],
    ["seratus", 100], ["seratus lima puluh", 150], ["dua ratus lima puluh", 250], ["seribu", 1000], ["seribu dua ratus", 1200], ["dua ribu lima", 2005],
    ["tiga juta", 3_000_000], ["sejuta", 1_000_000], ["dua miliar", 2_000_000_000], ["tiga ratus ribu", 300_000],
    ["twenty", 20], ["twenty one", 21], ["ninety nine", 99], ["one hundred", 100], ["one hundred and five", 105], ["two thousand twenty four", 2024],
    ["three million", 3_000_000], ["fifteen", 15], ["zero", 0], ["nol", 0],
  ])("%s is %p", (text, expected) => expect(numbersOf(text)).toMatchObject([{ value: expected, percent: false }]));

  test.each([
    ["satu koma lima persen", [[1.5, true]]],
    ["dua koma lima lima", [[2.55, false]]],
    ["one point five percent", [[1.5, true]]],
    ["nol koma nol lima persen", [[0.05, true]]],
    ["dua puluh persen dari tiga ratus", [[20, true], [300, false]]],
    ["koma tanpa angka", []],
    ["satu koma", [[1, false]]],
  ])("%s", (text, expected) => expect(values(text)).toEqual(expected));

  test("a number word is only a number when it stands where a number would; words that merely contain one are not", () => {
    expect(values("seorang peneliti dengan seluruh data")).toEqual([]);
    expect(values("ratus ribu")).toEqual([[100_000, false]]);   // scale words alone still read as a number
  });
});

describe("matching", () => {
  test.each([
    ["1,5%", "1.5 %"], ["1,5%", "satu koma lima persen"], ["1.5 %", "one point five percent"],
    ["2.500", "dua ribu lima ratus"], ["40", "empat puluh"], ["5 juta", "lima juta"], ["Rp 1.000", "seribu"],
  ])("%s = %s", (a, b) => expect(sameNumber(numbersOf(a)[0]!, numbersOf(b)[0]!)).toBeTrue());

  test.each([["1,5%", "1,5"], ["1,5%", "15%"], ["40", "41"], ["2.500", "2,5"]])("%s ≠ %s", (a, b) =>
    expect(sameNumber(numbersOf(a)[0]!, numbersOf(b)[0]!)).toBeFalse());

  test("the numbers a text shows that nothing allowed accounts for", () => {
    const allowed = ["bunga 1,5% per tahun", "modal Rp 2.500.000"];
    expect(unmatchedNumbers("Bunganya satu koma lima persen, modalnya dua juta lima ratus ribu", allowed)).toEqual([]);
    expect(unmatchedNumbers("Bunga 2% dan modal 2.500.000 serta 3 tahun", allowed).map((n) => n.raw)).toEqual(["2%", "3"]);
    expect(unmatchedNumbers("tanpa angka", allowed)).toEqual([]);
  });

  test("a fact's value as a number, when it is one", () => {
    expect(valueOf("1,5%")).toMatchObject({ value: 1.5, percent: true });
    expect(valueOf("sekitar tiga juta")).toMatchObject({ value: 3_000_000 });
    expect(valueOf("banyak")).toBeNull();
    expect(valueOf(null)).toBeNull();
  });
});
