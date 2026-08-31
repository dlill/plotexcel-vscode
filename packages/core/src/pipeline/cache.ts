import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultCacheRoot } from '../cache/keys.ts';

/**
 * Looking after the pipeline cache.
 *
 * Intermediates accumulate in the OS temp tree and nothing cleans them on a
 * schedule, so the extension has to: a size cap enforced after each run, and a
 * command that empties the lot and says how much it freed. Both need the same
 * walk, which is here.
 */

export interface CacheEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
}

export interface CacheStats {
  readonly root: string;
  readonly files: number;
  readonly bytes: number;
  readonly oldestMs?: number | undefined;
  readonly newestMs?: number | undefined;
}

export async function cacheStats(root = defaultCacheRoot()): Promise<CacheStats> {
  const entries = await listCache(root);
  const times = entries.map((entry) => entry.modifiedMs).sort((a, b) => a - b);

  return {
    root,
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
    oldestMs: times[0],
    newestMs: times[times.length - 1],
  };
}

/** Every file under the cache root, with its size and age. */
export async function listCache(root = defaultCacheRoot()): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];

  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const child of children) {
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(full);
        continue;
      }

      const stats = await fs.stat(full).catch(() => undefined);
      if (stats !== undefined) entries.push({ path: full, size: stats.size, modifiedMs: stats.mtimeMs });
    }
  }

  await walk(root);
  return entries;
}

/** Empty the cache. Returns what was freed. */
export async function clearCache(root = defaultCacheRoot()): Promise<{ files: number; bytes: number }> {
  const before = await cacheStats(root);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  return { files: before.files, bytes: before.bytes };
}

/**
 * Bring the cache back under a size limit, oldest first.
 *
 * Age is the right thing to drop by: the cache is keyed on inputs, so an entry
 * nothing has asked for in weeks belongs to a layout nobody is rendering.
 */
export async function pruneCache(
  limitBytes: number,
  root = defaultCacheRoot(),
): Promise<{ removed: number; freed: number }> {
  const entries = await listCache(root);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return { removed: 0, freed: 0 };

  const oldestFirst = [...entries].sort((a, b) => a.modifiedMs - b.modifiedMs);
  let freed = 0;
  let removed = 0;

  for (const entry of oldestFirst) {
    if (total - freed <= limitBytes) break;
    await fs.rm(entry.path, { force: true }).catch(() => undefined);
    freed += entry.size;
    removed += 1;
  }

  return { removed, freed };
}

/** "1.4 GB", "812 KB" — for a notification that has to fit on one line. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
