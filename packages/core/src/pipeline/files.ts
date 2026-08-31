import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** `stat`, but a missing file is an answer rather than an exception. */
export async function statOrUndefined(filePath: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

/**
 * Write a file so a reader never sees it half-written.
 *
 * Two VS Code windows can render the same layout at the same time, and both
 * write to the same cache path. Writing to a unique name and renaming into
 * place makes the swap atomic on every platform this runs on, so the loser of
 * the race overwrites the winner with identical bytes instead of handing
 * someone a truncated PNG.
 */
export async function writeFileAtomic(filePath: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readFileOrUndefined(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Whether a cached output can be used.
 *
 * A revision other than HEAD is immutable, so its output is always current. A
 * working-tree file has to be compared: the cache is good only if it is at
 * least as new as every input. A cache file that has vanished — the OS cleans
 * the temp tree whenever it likes — simply misses, and the stage runs again.
 */
export async function isFresh(output: string, inputs: readonly string[], immutable: boolean): Promise<boolean> {
  const cached = await statOrUndefined(output);
  if (cached === undefined || cached.size === 0) return false;
  if (immutable) return true;

  for (const input of inputs) {
    const source = await statOrUndefined(input);
    if (source === undefined) return false;
    if (source.mtimeMs > cached.mtimeMs) return false;
  }

  return true;
}
