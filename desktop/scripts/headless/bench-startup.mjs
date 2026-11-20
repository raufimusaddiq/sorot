// Mirrors Rune 73b7dec scripts/bench-startup.py for Sorot's perf binary.
// Fresh process launch to --first-pixels; OS/driver caches stay warm.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "design/perf-startup";
const runsN = 7;
mkdirSync(out, { recursive: true });
const cmd = "target/perf/sorot-desktop.exe";
const rows = [];
for (let i = 0; i <= runsN; i++) {
  const start = performance.now();
  const p = spawn(cmd, ["--first-pixels", "--frames", "1"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", d => (stdout += d));
  p.stderr.on("data", d => (stderr += d));
  const line = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("first pixels not ready after 30s")), 30000);
    p.stdout.on("data", d => {
      buf += d.toString();
      if (buf.includes("\n")) { clearTimeout(t); resolve(buf.split("\n")[0]); }
    });
    p.on("error", reject);
  });
  const elapsed = performance.now() - start;
  await new Promise(resolve => p.on("close", resolve));
  if (!line.startsWith("rune-first-pixels ")) throw new Error(`${line}\n${stderr}`);
  const row = JSON.parse(line.slice("rune-first-pixels ".length));
  row.process_ms = elapsed;
  if (i) rows.push(row);
}
const med = k => {
  const v = rows.map(r => r[k]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
const mad = k => {
  const m = med(k);
  return rows.map(r => Math.abs(r[k] - m)).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
};
const keys = Object.keys(rows[0]);
const median = {}, madOut = {};
for (const k of keys) { median[k] = med(k); madOut[k] = mad(k); }
const result = { median, mad: madOut, runs: rows };
writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2) + "\n");
console.log("settings", JSON.stringify(median));
