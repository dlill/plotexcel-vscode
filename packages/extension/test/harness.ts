import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Put the stub where `vscode` resolves, and hand a test the way in.
 *
 * `vscode` is a bare specifier that only exists inside an extension host, so
 * the only way to satisfy it here is to put a module at that name. Copying the
 * checked-in file rather than generating one means the stub can be read,
 * reviewed and improved like any other source.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, '../../..');

const stubSource = path.join(here, 'vscode.cjs');
const stubHome = path.join(repositoryRoot, 'node_modules', 'vscode');

export interface Recorder {
  readonly commands: Map<string, (...args: never[]) => unknown>;
  readonly executed: { name: string; args: unknown[] }[];
  readonly context: Map<string, unknown>;
  readonly configReads: { section: string; key: string; fallback: unknown }[];
  readonly providers: { kind: string; [more: string]: unknown }[];
  readonly views: { id: string; provider: unknown }[];
  readonly warnings: string[];
  /** What the person was shown, as opposed to what the stub noticed. */
  readonly messages: { kind: string; message: string }[];
  reset(): void;
}

/** The mutable bits of the stubbed workspace a test can arrange. */
export interface StubState {
  workspaceFolders?: unknown[];
  settings?: Record<string, unknown>;
  documents?: unknown[];
  isTrusted?: boolean;
}

/** Install the stub. Safe to call repeatedly. */
export function installStub(): void {
  mkdirSync(stubHome, { recursive: true });
  writeFileSync(
    path.join(stubHome, 'package.json'),
    `${JSON.stringify({ name: 'vscode', version: '0.0.0-stub', main: 'index.cjs' }, undefined, 2)}\n`,
  );
  copyFileSync(stubSource, path.join(stubHome, 'index.cjs'));
}

export async function loadVscode(): Promise<{ recorder: Recorder; state: StubState }> {
  installStub();

  const require = createRequire(path.join(repositoryRoot, 'noop.cjs'));
  const stub = require('vscode') as { __recorder: Recorder; __state: StubState };

  return { recorder: stub.__recorder, state: stub.__state };
}

/** Enough of an ExtensionContext for activation to complete. */
export function fakeContext(): Record<string, unknown> {
  const globalState = new Map<string, unknown>();
  const workspaceStore = new Map<string, unknown>();

  const memento = (store: Map<string, unknown>) => ({
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown) => void store.set(key, value),
    keys: () => [...store.keys()],
    setKeysForSync: () => {},
  });

  return {
    subscriptions: [] as { dispose?: () => void }[],
    globalState: memento(globalState),
    workspaceState: memento(workspaceStore),
    extensionPath: path.join(repositoryRoot, 'packages/extension'),
    extensionUri: { fsPath: path.join(repositoryRoot, 'packages/extension') },
    extensionMode: 2,
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    environmentVariableCollection: { replace() {}, append() {}, prepend() {}, clear() {} },
    asAbsolutePath: (relative: string) => path.join(repositoryRoot, 'packages/extension', relative),
  };
}

/** The extension's manifest, as the Marketplace and VS Code both read it. */
export async function manifest(): Promise<Manifest> {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path.join(repositoryRoot, 'packages/extension/package.json'), 'utf8');
  return JSON.parse(text) as Manifest;
}

export interface Manifest {
  readonly name: string;
  readonly publisher: string;
  readonly main: string;
  readonly icon?: string;
  readonly activationEvents: readonly string[];
  readonly capabilities?: {
    readonly untrustedWorkspaces?: {
      readonly supported: string | boolean;
      readonly description?: string;
      readonly restrictedConfigurations?: readonly string[];
    };
  };
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string; icon?: string }[];
    readonly menus: Record<string, readonly { command?: string; when?: string; group?: string }[]>;
    readonly keybindings?: readonly { command: string; key: string; when?: string }[];
    readonly configuration: {
      readonly properties: Record<string, { default?: unknown; type?: string; scope?: string }>;
    };
    readonly views: Record<string, readonly { id: string; when?: string }[]>;
    readonly viewsWelcome?: readonly { view: string; contents: string }[];
    readonly walkthroughs?: readonly {
      id: string;
      title: string;
      steps: readonly {
        id: string;
        title: string;
        description: string;
        media?: { markdown?: string; image?: string };
        completionEvents?: readonly string[];
      }[];
    }[];
    readonly languages?: readonly { id: string; filenamePatterns?: readonly string[] }[];
  };
}
