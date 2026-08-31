import path from 'node:path';

import type { RevisionReader } from '../../core/src/pipeline/ports.ts';
import { run } from './exec.ts';

/**
 * Reading plots out of git.
 *
 * `git show <revision>:<path>` is the whole mechanism, and it is why comparing
 * a figure against last month's version costs nothing: the old PDF never has
 * to exist as a file. The R package shelled out through a Windows-only
 * `shell()` call; this uses the git executable directly and works everywhere.
 */

export interface Revision {
  readonly hash: string;
  readonly shortHash: string;
  /** ISO date, for showing next to the subject line. */
  readonly date: string;
  readonly subject: string;
  readonly author: string;
}

const UNIT = '\u001f';

export function createGitRevisionReader(command = 'git'): RevisionReader & {
  listRevisions(filePath: string, limit?: number): Promise<Revision[]>;
  listFiles(folderPath: string, revision: string): Promise<string[] | undefined>;
  repositoryRoot(filePath: string): Promise<string | undefined>;
} {
  async function repositoryRoot(filePath: string): Promise<string | undefined> {
    const result = await run(command, ['-C', path.dirname(filePath), 'rev-parse', '--show-toplevel'], {
      timeoutMs: 15_000,
    });
    if (result.code !== 0) return undefined;

    const root = result.stdout.toString('utf8').trim();
    return root.length > 0 ? root : undefined;
  }

  return {
    name: 'git',

    async isTracked(filePath: string): Promise<boolean> {
      const root = await repositoryRoot(filePath);
      if (root === undefined) return false;

      const result = await run(command, ['-C', root, 'ls-files', '--error-unmatch', relativeTo(root, filePath)], {
        timeoutMs: 15_000,
      });
      return result.code === 0;
    },

    async read({ path: filePath, revision }): Promise<Buffer | undefined> {
      const root = await repositoryRoot(filePath);
      if (root === undefined) {
        throw new Error(`${path.basename(filePath)} is not inside a git repository.`);
      }

      const result = await run(command, ['-C', root, 'show', `${revision}:${relativeTo(root, filePath)}`], {
        timeoutMs: 60_000,
      });

      // Exit 128 covers both "no such revision" and "no such path in that
      // revision". Neither is exceptional: a plot added last week simply has
      // no version in last month's commit.
      if (result.code !== 0) return undefined;
      return result.stdout;
    },

    async listRevisions(filePath: string, limit = 25): Promise<Revision[]> {
      const root = await repositoryRoot(filePath);
      if (root === undefined) return [];

      const result = await run(
        command,
        [
          '-C',
          root,
          'log',
          `-n${limit}`,
          `--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s`,
          '--date=short',
          '--',
          relativeTo(root, filePath),
        ],
        { timeoutMs: 30_000 },
      );

      if (result.code !== 0) return [];

      return result.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [hash = '', shortHash = '', date = '', author = '', subject = ''] = line.split(UNIT);
          return { hash, shortHash, date, author, subject };
        });
    },

    /**
     * What a folder held at a revision, relative to the folder itself.
     *
     * Comparing a folder against an earlier commit needs both sides' file
     * lists, and only one of them is on disk. Undefined rather than an empty
     * array when git cannot answer, so a caller can tell "the folder was
     * empty then" apart from "there is no repository here" — they lead to
     * very different tables.
     */
    async listFiles(folderPath: string, revision: string): Promise<string[] | undefined> {
      const root = await repositoryRoot(folderPath);
      if (root === undefined) return undefined;

      const prefix = relativeTo(root, folderPath);
      const scope = prefix === '' || prefix === '.' ? '.' : `${prefix}/`;

      const result = await run(command, ['-C', root, 'ls-tree', '-r', '--name-only', revision, '--', scope], {
        timeoutMs: 30_000,
      });
      if (result.code !== 0) return undefined;

      const base = scope === '.' ? '' : scope;
      return result.stdout
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.startsWith(base))
        .map((line) => line.slice(base.length));
    },

    repositoryRoot,
  };
}

/** git wants forward slashes, even on Windows. */
function relativeTo(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}
