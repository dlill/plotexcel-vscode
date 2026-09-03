import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { tempScratchRoot } from '../../core/src/cache/keys.ts';

/**
 * Running external programs, with the sharp edges blunted.
 *
 * Three of them, learned the hard way:
 *
 * Arguments are always an array, never a shell string. Plot paths come from a
 * layout file and routinely contain spaces, ampersands and brackets; handing
 * those to a shell is how a rendering tool ends up executing part of a name.
 *
 * A timeout kills the whole process group, not just the child. A headless
 * browser spawns helpers, and killing only the parent leaves them holding the
 * pipes open — which looks exactly like a hang.
 *
 * And a process that has exited is not waited on forever. If orphaned children
 * keep the output streams open, the result we already have is the result.
 */

export interface RunOptions {
  readonly cwd?: string | undefined;
  /** Milliseconds before the process group is killed. */
  readonly timeoutMs?: number | undefined;
  readonly maxBuffer?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Throw away stdout instead of collecting it. For tools that communicate
   * through files and whose chatter is of no interest.
   */
  readonly discardOutput?: boolean | undefined;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/** How long to wait for the streams to close after the process has exited. */
const CLOSE_GRACE_MS = 2000;

export class MissingExecutableError extends Error {
  readonly executable: string;

  constructor(executable: string) {
    super(`${executable} was not found on this machine.`);
    this.name = 'MissingExecutableError';
    this.executable = executable;
  }
}

export class TimedOutError extends Error {
  constructor(command: string, timeoutMs: number) {
    const howLong = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(`${path.basename(command)} did not finish within ${howLong} and was stopped.`);
    this.name = 'TimedOutError';
  }
}

/** Run a command. A non-zero exit is a result, not an exception. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const groupKill = process.platform !== 'win32';

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      // Its own process group, so a timeout can take the helpers with it.
      detached: groupKill,
      stdio: ['ignore', options.discardOutput === true ? 'ignore' : 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const out: Buffer[] = [];
    const errors: Buffer[] = [];
    let collected = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    let exitCode: number | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (result: RunResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      collected += chunk.length;
      if (collected > maxBuffer) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(errors));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, groupKill);
    }, timeoutMs);

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? new MissingExecutableError(command) : error);
    });

    const settleWith = () => {
      if (timedOut) {
        finish(new TimedOutError(command, timeoutMs));
        return;
      }
      if (overflowed) {
        finish(new Error(`${path.basename(command)} produced more output than expected and was stopped.`));
        return;
      }
      finish({
        code: exitCode ?? 1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errors).toString('utf8'),
      });
    };

    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal === null ? 1 : 128);
      // Normally 'close' follows immediately; if a leaked grandchild keeps the
      // pipes open it never comes, and what we have is what there is.
      graceTimer = setTimeout(settleWith, CLOSE_GRACE_MS);
      graceTimer.unref?.();
    });

    child.on('close', () => settleWith());
  });
}

function killTree(pid: number | undefined, groupKill: boolean): void {
  if (pid === undefined) return;

  try {
    if (groupKill) {
      process.kill(-pid, 'SIGKILL');
      return;
    }
    // Windows has no process groups here; taskkill walks the tree instead.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Run a command and throw with its stderr when it fails. */
export async function runOrThrow(command: string, args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`${path.basename(command)} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

/**
 * Give a callback a private directory, and clean it up afterwards.
 *
 * Under `<temp>/plotexcel/scratch` rather than straight in `os.tmpdir()`: the
 * `finally` below covers every ordinary exit, but a killed process or a
 * converter that takes the window down with it leaves the directory behind, and
 * there it is somewhere Clear Cache both counts and removes.
 */
export async function withScratchDir<T>(prefix: string, work: (directory: string) => Promise<T>): Promise<T> {
  const root = tempScratchRoot();
  await mkdir(root, { recursive: true });

  const directory = await mkdtemp(path.join(root, `${prefix}-`));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * True when the current process is root on a Unix-like system.
 *
 * Chromium refuses to start as root unless its sandbox is disabled, which is
 * the state inside most containers — and never the state on the desktop this
 * extension is aimed at, so the weaker setting stays confined to that case.
 */
export function runningAsRoot(): boolean {
  return process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
}
