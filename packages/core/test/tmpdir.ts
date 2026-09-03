import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';

import { plotexcelTempRoot } from '../src/cache/keys.ts';

/**
 * Fixture directories for the test suite, in one place and cleaned up.
 *
 * Every test file used to call `mkdtemp(os.tmpdir(), 'plotexcel-something-')`
 * and leave the result behind. One `npm test` makes about thirty of them, so a
 * machine that has run the suite for a week has hundreds of
 * `plotexcel-gen-XXXXXX` folders in `%TEMP%` — and Clear Cache reported none of
 * them, because they sat beside the cache rather than inside it.
 *
 * So: under `<temp>/plotexcel/test`, and removed when the file that made them
 * has finished. `node --test` runs each file in its own process, so the `after`
 * hook below belongs to whichever file imported this.
 */

// Before the override below, so this is the machine's own root.
const base = path.join(plotexcelTempRoot(), 'test');
mkdirSync(base, { recursive: true });

/**
 * A cache root of this process's own, for anything that reads the default.
 *
 * `cache --clear` is tested by running it, and it empties the temp root and
 * sweeps the directories beside it. Pointed at the machine's root that would
 * delete the fixtures of every test file running alongside — which is exactly
 * what happened. The subprocess inherits this, so it clears only its own.
 */
process.env['PLOTEXCEL_TEMP_ROOT'] = mkdtempSync(path.join(base, 'root-'));

const made: string[] = [process.env['PLOTEXCEL_TEMP_ROOT']];

/** A fixture directory of its own, gone when this test file finishes. */
export function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(base, `${prefix}-`));
  made.push(directory);

  return directory;
}

after(() => {
  // Best effort: a directory a converter still has open on Windows cannot be
  // removed, and a test suite that fails while tidying up is worse than one
  // leftover folder.
  for (const directory of made) rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
});
