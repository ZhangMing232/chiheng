import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RULES, parseRules, sameSelection, type EarlyRules } from "@/lib/market/rules";

const path = join(process.cwd(), "data", "rules.json");

export async function readRules(): Promise<EarlyRules> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    const parsed = parseRules(raw);
    if (!parsed) return DEFAULT_RULES;
    const version = Number(raw.version);
    return { ...parsed, version: Number.isFinite(version) && version >= 1 ? version : 1 };
  } catch {
    return DEFAULT_RULES;
  }
}

export async function writeRules(input: EarlyRules): Promise<EarlyRules> {
  const prev = await readRules();
  const version = sameSelection(prev, input) ? prev.version : prev.version + 1;
  const next = { ...input, version };
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2));
  return next;
}
