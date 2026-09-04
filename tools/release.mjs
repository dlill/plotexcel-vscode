/**
 * Cut a release.
 *
 *     node tools/release.mjs patch | minor | major | 0.4.0 [--pre alpha]
 *
 * One command, because the four things a release needs — a version, a dated
 * changelog heading, a commit and a tag — go wrong when they are four
 * commands and one is forgotten. Nothing is pushed: it prints the push
 * command and stops, so there is a moment to look at the diff.
 *
 * The version in packages/extension/package.json is the only one that means
 * anything; the tag is derived from it, and the release workflow refuses to
 * build if the two disagree.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const manifest = path.join(root, 'packages/extension/package.json');
const changelog = path.join(root, 'packages/extension/CHANGELOG.md');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------------- //

const [request, ...rest] = process.argv.slice(2);
if (request === undefined) fail('Usage: node tools/release.mjs patch|minor|major|<version> [--pre <label>]');

const preIndex = rest.indexOf('--pre');
const pre = preIndex === -1 ? undefined : rest[preIndex + 1];
if (preIndex !== -1 && pre === undefined) fail('--pre needs a label, such as: --pre alpha');

if (git('status', '--porcelain') !== '') {
  fail('The working tree has uncommitted changes. Commit or stash them first.');
}

const packageJson = JSON.parse(await readFile(manifest, 'utf8'));
const current = packageJson.version;

const next = nextVersion(current, request, pre);
if (next === undefined) fail(`Cannot read "${request}" as a version or as patch/minor/major.`);

const tag = `v${next}`;
if (git('tag', '--list', tag) !== '') fail(`Tag ${tag} already exists.`);

// ------------------------------------------------------------------------- //

packageJson.version = next;
await writeFile(manifest, `${JSON.stringify(packageJson, undefined, 2)}\n`, 'utf8');

const today = new Date().toISOString().slice(0, 10);
const notes = await readFile(changelog, 'utf8');

/**
 * An "unreleased" heading becomes this release; otherwise a new section is
 * opened with an empty body, which the release workflow then rejects — the
 * failure lands here, before the tag is pushed, rather than in CI.
 */
const unreleased = /^## +(?:[0-9]+\.[0-9]+\.[0-9]+[^\n]*?(?: +—)? +)?unreleased *$/im;

const updated = unreleased.test(notes)
  ? notes.replace(unreleased, `## ${next} — ${today}`)
  : notes.replace(/^(# Changelog\n)/m, `$1\n## ${next} — ${today}\n\n- \n`);

await writeFile(changelog, updated, 'utf8');

if (!unreleased.test(notes)) {
  process.stdout.write(
    `Opened an empty "## ${next}" section in the changelog. Write it, amend the commit, then push.\n`,
  );
}

git('add', 'packages/extension/package.json', 'packages/extension/CHANGELOG.md');
git('commit', '-m', `Release ${next}`);
git('tag', '-a', tag, '-m', `plotExcel ${next}`);

process.stdout.write(
  `\n${current} -> ${next}, committed and tagged ${tag}.\n\n` +
    'Look at it, then push. The tag is what starts the build:\n\n' +
    '    git push --follow-tags\n\n',
);

// ------------------------------------------------------------------------- //

function nextVersion(from, what, label) {
  const explicit = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.exec(what);
  if (explicit !== null) return what;

  const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(from);
  if (parts === null) return undefined;

  const [major, minor, patch] = parts.slice(1).map(Number);

  const bumped =
    what === 'major'
      ? `${major + 1}.0.0`
      : what === 'minor'
        ? `${major}.${minor + 1}.0`
        : what === 'patch'
          ? `${major}.${minor}.${patch + 1}`
          : undefined;

  if (bumped === undefined) return undefined;
  return label === undefined ? bumped : `${bumped}-${label}.0`;
}
