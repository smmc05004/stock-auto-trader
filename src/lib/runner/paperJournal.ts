import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { cycleSchema, type PaperCycle } from "./paperCycle";

export async function withPaperLock<T>(directory: string, run: () => Promise<T>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "cycle.lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Cycle lock exists; inspect prior run before recovery.");
    throw error;
  }
  try { return await run(); } finally { await rmdir(lock); }
}

export async function readCycle(directory: string) {
  try { return cycleSchema.parse(JSON.parse(await readFile(path.join(directory, "cycle.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveCycle(directory: string, state: PaperCycle) {
  const valid = cycleSchema.parse(state);
  const temporary = path.join(directory, "cycle.json.tmp");
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(valid)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path.join(directory, "cycle.json"));
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}
