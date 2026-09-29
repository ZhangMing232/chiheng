import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs, type Prefs } from "./prefs.ts";

const path = join(process.cwd(), "data", "prefs.json");

export async function readPrefs(): Promise<Prefs> {
  try {
    return parsePrefs(JSON.parse(await readFile(path, "utf8"))) ?? DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function writePrefs(input: Prefs): Promise<Prefs> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(path, JSON.stringify(input, null, 2));
  return input;
}
