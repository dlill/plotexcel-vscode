/**
 * Print the changelog section for one version.
 *
 *     node tools/release-notes.mjs 0.1.0
 *
 * The release notes on GitHub and the changelog in the repository should never
 * be two different accounts of the same change, so there is one source and
 * this reads it. Exits non-zero if the version has no section, which is worth
 * failing a release over: a release with no notes is a file with no
 * explanation.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];

if (version === undefined) {
  process.stderr.write('Usage: node tools/release-notes.mjs <version>\n');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const changelog = path.join(here, '../packages/extension/CHANGELOG.md');
const text = await readFile(changelog, 'utf8');

/**
 * Everything under `## <version>` up to the next `## `.
 *
 * The heading may carry a date or a word after the version — "## 0.1.0 — 2026-09-01"
 * — so the match stops at a word boundary rather than the end of the line.
 */
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## +${escaped}\\b`);
const lines = text.split('\n');
const start = lines.findIndex((line) => heading.test(line));

// Written as a scan rather than one regex because JavaScript has no anchor
// for "end of input" that also works with the multiline flag, and the
// end-of-section case is exactly the last section in the file.
const section =
  start === -1
    ? null
    : [lines.slice(start + 1, findEnd(lines, start)).join('\n')];

function findEnd(all, from) {
  const next = all.slice(from + 1).findIndex((line) => /^## /.test(line));
  return next === -1 ? all.length : from + 1 + next;
}

if (section === null) {
  process.stderr.write(
    `No "## ${version}" section in ${path.relative(process.cwd(), changelog)}.\n` +
      'Add one before tagging — it becomes the release notes.\n',
  );
  process.exit(1);
}

const body = (section[0] ?? '').trim();

if (body === '') {
  process.stderr.write(`The "## ${version}" section is empty.\n`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
