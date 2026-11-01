// Numbers in text, the way a viewer reads or hears them: digits ("1,5%", "2.500", "5 juta") and
// spelled-out Indonesian or English ("satu koma lima persen", "twenty one", "seribu dua ratus").
// Two mentions are the same number when they have the same value and both are percentages or both
// are not, so "1,5%" = "1.5 %" = "satu koma lima persen". Facts and plans are compared with this.

export interface NumberMention {
  value: number;
  percent: boolean;
  /** The words or digits as they were written. */
  raw: string;
}

const UNITS: Record<string, number> = {
  nol: 0, kosong: 0, zero: 0,
  satu: 1, se: 1, one: 1, dua: 2, two: 2, tiga: 3, three: 3, empat: 4, four: 4, lima: 5, five: 5,
  enam: 6, six: 6, tujuh: 7, seven: 7, delapan: 8, eight: 8, sembilan: 9, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Words that scale what came before. */
const SCALES: Record<string, number> = {
  ratus: 100, hundred: 100, ribu: 1e3, thousand: 1e3, juta: 1e6, million: 1e6, miliar: 1e9, milyar: 1e9, billion: 1e9, triliun: 1e12, trillion: 1e12,
};
/** Indonesian words that already contain "se": sebelas, sepuluh, seratus, seribu, sejuta, semiliar. */
const SE: Record<string, number> = { sebelas: 11, sepuluh: 10, seratus: 100, seribu: 1e3, sejuta: 1e6, semiliar: 1e9, semilyar: 1e9, setriliun: 1e12 };
const PERCENT = new Set(["persen", "percent", "%"]);
const POINT = new Set(["koma", "point"]);
const FILLER = new Set(["and", "dan"]);

/** "2.500" -> 2500, "1,5" -> 1.5, "1,000" -> 1000, "0,500" -> 0.5, "1.234,56" -> 1234.56. */
export function parseDigits(text: string): number {
  const t = text.trim();
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    return Number(t.split(decimal === "." ? "," : ".").join("").replace(decimal, "."));
  }
  const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
  if (!sep) return Number(t);
  const parts = t.split(sep);
  const grouped = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3 && parts[0]!.length <= 3 && parts[0] !== "0");
  return grouped ? Number(parts.join("")) : Number(`${parts[0]}.${parts[1]}`);
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

interface Token { word: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /\d+(?:[.,]\d+)*|%|[\p{L}]+/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

const isDigits = (w: string) => /^\d/.test(w);
const isNumberWord = (w: string) => w in UNITS || w in TENS || w in SCALES || w in SE || w === "belas" || w === "puluh";

/**
 * Reads a run of number words starting at `i` ("dua ratus lima puluh", "twenty one", "sebelas").
 * Returns the value and the index after the run.
 */
function spelled(tokens: Token[], i: number): { value: number; next: number } | null {
  let total = 0;
  let current = 0;
  /** A unit waiting to be multiplied by puluh, belas or ratus. */
  let pending = 0;
  let any = false;
  let j = i;
  for (; j < tokens.length; j++) {
    const w = tokens[j]!.word;
    if (FILLER.has(w) && any && j + 1 < tokens.length && isNumberWord(tokens[j + 1]!.word)) continue;
    if (!isNumberWord(w)) break;
    any = true;
    if (w === "se") {
      pending = 1;   // "se" on its own, as in "se ratus", is a one
    } else if (w in SE) {
      const v = SE[w]!;
      if (v >= 1e3) { total += v; current = 0; pending = 0; } else { current += v; pending = 0; }
    } else if (w in UNITS) {
      current += pending;
      pending = UNITS[w]!;
    } else if (w in TENS) {
      current += pending + TENS[w]!;
      pending = 0;
    } else if (w === "belas") {
      current += 10 + pending;
      pending = 0;
    } else if (w === "puluh") {
      current += (pending || 1) * 10;
      pending = 0;
    } else {
      const scale = SCALES[w]!;
      if (scale === 100) {
        current += (pending || 1) * 100;
        pending = 0;
      } else {
        total += ((current + pending) || 1) * scale;
        current = 0;
        pending = 0;
      }
    }
  }
  return any ? { value: total + current + pending, next: j } : null;
}

/** Digit words after "koma"/"point": "lima" -> 5, "lima lima" -> 55 (as .55). */
function fraction(tokens: Token[], i: number): { digits: string; next: number } {
  let digits = "";
  let j = i;
  for (; j < tokens.length; j++) {
    const w = tokens[j]!.word;
    if (w in UNITS && UNITS[w]! <= 9 && w !== "se") digits += String(UNITS[w]);
    else if (isDigits(w) && /^\d+$/.test(w)) digits += w;
    else break;
  }
  return { digits, next: j };
}

/** Every number in `text`, in the order it appears. */
export function numbersOf(text: string): NumberMention[] {
  const tokens = tokenize(text);
  const found: NumberMention[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    let value: number | null = null;
    let next = i + 1;
    if (isDigits(t.word)) {
      value = parseDigits(t.word);
      const scale = tokens[next] && SCALES[tokens[next]!.word];
      if (scale && scale >= 1e3) { value *= scale; next++; }
    } else if (isNumberWord(t.word)) {
      const s = spelled(tokens, i);
      if (s) { value = s.value; next = s.next; }
    }
    if (value === null || Number.isNaN(value)) { i = next; continue; }
    // "koma lima", "point five"
    if (tokens[next] && POINT.has(tokens[next]!.word)) {
      const f = fraction(tokens, next + 1);
      if (f.digits) { value = Number(`${value}.${f.digits}`); next = f.next; }
    }
    const percent = !!tokens[next] && PERCENT.has(tokens[next]!.word);
    if (percent) next++;
    found.push({ value: round(value), percent, raw: text.slice(t.start, tokens[next - 1]!.end) });
    i = next;
  }
  return found;
}

/** The same number: equal value, and both a percentage or neither. */
export const sameNumber = (a: NumberMention, b: NumberMention): boolean => a.percent === b.percent && Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(a.value));

/** The numbers in `shown` that none of `allowed` accounts for. */
export function unmatchedNumbers(shown: string, allowed: string[]): NumberMention[] {
  const known = allowed.flatMap(numbersOf);
  return numbersOf(shown).filter((n) => !known.some((k) => sameNumber(n, k)));
}

/** A fact's value as a number, when it is one ("1,5%", "tiga juta"). */
export const valueOf = (text: string | null): NumberMention | null => (text ? (numbersOf(text)[0] ?? null) : null);
