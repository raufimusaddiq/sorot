import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Ready-made formats (generator/presets.json): a starting point for a brief instead of a blank
// page. A preset sets the default length and gives the director its pacing, the kinds of registry
// block to prefer, and a few lines of advice. The owner's brief always wins over any of it.

export interface Preset {
  id: string;
  label: string;
  description: string;
  targetSec: number;
  pacing: string;
  blockTags: string[];
  hints: string;
}

const cache = new Map<string, Preset[]>();

/** The shipped presets; none when the file is missing (clipping and Quick still work). */
export function loadPresets(generatorDir: string): Preset[] {
  const path = join(generatorDir, "presets.json");
  const hit = cache.get(path);
  if (hit) return hit;
  const list = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf-8")) as { presets?: Preset[] }).presets ?? []) : [];
  cache.set(path, list);
  return list;
}

export const findPreset = (generatorDir: string, id: string | null): Preset | null => (id ? loadPresets(generatorDir).find((p) => p.id === id) ?? null : null);

/** What the director is told about the preset: its pacing, block tags and advice. */
export function presetBrief(preset: Preset): { name: string; pacing: string; preferBlocksTagged: string[]; advice: string } {
  return { name: preset.id, pacing: preset.pacing, preferBlocksTagged: preset.blockTags, advice: preset.hints };
}
