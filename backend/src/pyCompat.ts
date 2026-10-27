// Python semantics the ported scoring rules depend on, so the Bun versions
// reproduce the Python outputs exactly (tests/fixtures/*.json are golden
// outputs of the original Python).

/** `str.split()` with no argument: split on whitespace runs, no empty parts. */
export const pySplit = (s: string): string[] => s.split(/\s+/u).filter(Boolean);

/** Length in code points, like Python `len(str)` (JS `.length` counts UTF-16 units). */
export const cpLen = (s: string): number => Array.from(s).length;

/** `s[start:end]` by code points. */
export const cpSlice = (s: string, start: number, end?: number): string => Array.from(s).slice(start, end).join("");

const isCased = (c: string) => c.toLowerCase() !== c.toUpperCase();

/** `str.isupper()`: at least one cased character and no lowercase ones. */
export const pyIsUpper = (s: string): boolean => {
  let cased = false;
  for (const c of s) {
    if (!isCased(c)) continue;
    if (c !== c.toUpperCase()) return false;
    cased = true;
  }
  return cased;
};

/** `str.isdigit()` for one character (decimal and other numeric digits). */
export const pyIsDigit = (c: string): boolean => /\p{Nd}|[²³¹⁰-⁹₀-₉①-⑨]/u.test(c);

/**
 * Python `round(x, n)`: rounds the exact binary value, ties to even. JS
 * `toFixed` also rounds the exact value but sends ties up, so exact ties are
 * detected and resolved to the even neighbour.
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  // Exact decimal digits of |x| (a double's expansion ends well within 100 places here).
  const [intPart, frac = ""] = Math.abs(x).toFixed(Math.min(n + 40, 100)).split(".");
  const rest = frac.slice(n);
  let digits = BigInt(`${intPart}${frac.slice(0, n)}`);
  const tie = /^50*$/.test(rest);
  if ((rest[0] ?? "0") > "5" || (rest[0] === "5" && !tie) || (tie && digits % 2n === 1n)) digits += 1n;
  const s = digits.toString().padStart(n + 1, "0");
  const value = Number(n ? `${s.slice(0, -n)}.${s.slice(-n)}` : s);
  return x < 0 && value !== 0 ? -value : value;
}
