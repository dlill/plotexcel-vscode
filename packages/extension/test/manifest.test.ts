import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { manifest, repositoryRoot } from './harness.ts';

/**
 * Does the manifest agree with the code?
 *
 * `package.json` is the half of an extension a typechecker cannot see. A menu
 * pointing at a command that no longer exists, a setting the code reads under
 * a different name, a walkthrough linking to a file that was renamed — none of
 * these fail to build, and all of them fail in front of a user.
 *
 * These read both halves and compare them. They need no stub and no host, so
 * they run in milliseconds and there is no excuse not to.
 */

const extensionRoot = path.join(repositoryRoot, 'packages/extension');
const sourceRoot = path.join(extensionRoot, 'src');

const declared = await manifest();
const sources = await collectSources(sourceRoot);
const allSource = sources.map((file) => readFileSync(file, 'utf8')).join('\n');

async function collectSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectSources(full)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }

  return found;
}

const commandIds = new Set(declared.contributes.commands.map((entry) => entry.command));

describe('menus and keybindings', () => {
  it('point only at commands that exist', () => {
    const broken: string[] = [];

    for (const [where, entries] of Object.entries(declared.contributes.menus)) {
      for (const entry of entries) {
        if (entry.command !== undefined && !commandIds.has(entry.command)) broken.push(`${where}: ${entry.command}`);
      }
    }

    for (const binding of declared.contributes.keybindings ?? []) {
      if (!commandIds.has(binding.command)) broken.push(`keybinding ${binding.key}: ${binding.command}`);
    }

    assert.deepEqual(broken, [], 'a menu entry for a command that does not exist simply never appears');
  });

  it('gates every keybinding, so plotExcel does not steal a key globally', () => {
    for (const binding of declared.contributes.keybindings ?? []) {
      assert.ok(binding.when !== undefined && binding.when.length > 0, `${binding.key} has no when clause`);
    }
  });

  it('uses only context keys the extension actually sets', () => {
    // Anything in a when clause that looks like one of ours.
    const used = new Set<string>();

    for (const entries of Object.values(declared.contributes.menus)) {
      for (const entry of entries) {
        for (const match of (entry.when ?? '').matchAll(/plotexcel\.[A-Za-z]+/g)) used.add(match[0]);
      }
    }
    for (const views of Object.values(declared.contributes.views)) {
      for (const view of views) {
        for (const match of (view.when ?? '').matchAll(/plotexcel\.[A-Za-z]+/g)) used.add(match[0]);
      }
    }

    const unset = [...used].filter((key) => !commandIds.has(key) && !allSource.includes(`'${key}'`));
    assert.deepEqual(unset, [], 'a when clause on a key nothing sets is a menu entry that never shows');
  });

  it('gives every command a category, so the palette groups them', () => {
    const uncategorised = declared.contributes.commands
      .filter((entry) => entry.category !== 'plotExcel')
      .map((entry) => entry.command);

    assert.deepEqual(uncategorised, []);
  });
});

describe('settings', () => {
  const properties = declared.contributes.configuration.properties;

  it('declares everything the code reads', () => {
    const read = [...allSource.matchAll(/configuration\.get<[^>]*>\('([A-Za-z]+)'/g)].map((match) => match[1]);
    const missing = read.filter((key) => !(`plotexcel.${key}` in properties));

    assert.deepEqual([...new Set(missing)], [], 'a setting read but not declared can never be changed by anyone');
  });

  it('agrees with the code about the defaults', () => {
    // The fallback passed to `get` is what happens when the manifest is
    // absent; if it disagrees with the declared default, the behaviour
    // changes depending on whether the user has ever touched the setting.
    const mismatched: string[] = [];

    for (const match of allSource.matchAll(/configuration\.get<[^>]*>\('([A-Za-z]+)',\s*([^)]+)\)/g)) {
      const key = `plotexcel.${match[1]}`;
      const declaredDefault = properties[key]?.default;
      const written = (match[2] ?? '').trim().replace(/^'(.*)'$/, '$1');

      if (declaredDefault === undefined) continue;

      const same =
        String(declaredDefault) === written ||
        (typeof declaredDefault === 'string' && declaredDefault === written);

      if (!same) mismatched.push(`${key}: manifest ${JSON.stringify(declaredDefault)}, code ${written}`);
    }

    assert.deepEqual(mismatched, []);
  });

  it('describes every setting', () => {
    for (const [key, value] of Object.entries(properties)) {
      const entry = value as { description?: string; markdownDescription?: string };
      const description = entry.description ?? entry.markdownDescription;

      assert.ok(description !== undefined && description.length > 20, `${key} needs a real description`);
    }
  });

  /**
   * A setting that names a program is a way to run that program. Left at the
   * default `window` scope, any repository could ship a `.vscode/settings.json`
   * pointing `browserPath` at a script in its own tree, and rendering an HTML
   * plot would run it.
   */
  it('keeps settings that name an executable out of workspace reach', () => {
    assert.equal(
      properties['plotexcel.browserPath']?.scope,
      'machine',
      'browserPath is spawned, so a workspace must not be able to set it',
    );
  });

  it('also lists the executable setting as restricted in an untrusted workspace', () => {
    const restricted = declared.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    assert.ok(restricted.includes('plotexcel.browserPath'), 'browserPath should be restricted as well as machine-scoped');
  });

  it('declares no setting that is spawned but still workspace-writable', () => {
    // The guard for the next one of these: anything whose value reaches `run`
    // as a command has to be machine-scoped too.
    const spawnable = Object.entries(properties).filter(([key]) => /path|executable|command|binary/i.test(key));

    for (const [key, value] of spawnable) {
      assert.equal(value.scope, 'machine', `${key} looks like a program path and must be machine-scoped`);
    }
  });
});

describe('the walkthrough', () => {
  const walkthrough = declared.contributes.walkthroughs?.[0];

  it('exists', () => {
    assert.ok(walkthrough, 'the Welcome page entry is how most people meet this');
  });

  it('has the media file each step names', () => {
    for (const step of walkthrough?.steps ?? []) {
      const media = step.media?.markdown ?? step.media?.image;
      if (media === undefined) continue;

      assert.ok(existsSync(path.join(extensionRoot, media)), `${step.id} points at a missing ${media}`);
    }
  });

  it('links only to commands that exist', () => {
    const text = [
      ...(walkthrough?.steps ?? []).map((step) => step.description),
      ...(declared.contributes.viewsWelcome ?? []).map((entry) => entry.contents),
    ].join('\n');

    const broken = [...text.matchAll(/command:([A-Za-z.]+)/g)]
      .map((match) => match[1]!)
      .filter((id) => !commandIds.has(id));

    assert.deepEqual([...new Set(broken)], [], 'a dead link in the walkthrough is the first thing someone clicks');
  });

  it('completes its steps on events that can happen', () => {
    for (const step of walkthrough?.steps ?? []) {
      for (const event of step.completionEvents ?? []) {
        const [kind, value] = event.split(':');

        if (kind === 'onCommand') assert.ok(commandIds.has(value!), `${step.id} waits for a command that does not exist: ${value}`);
        if (kind === 'onSettingChanged') {
          assert.ok(value! in declared.contributes.configuration.properties, `${step.id} waits on an unknown setting`);
        }
      }
    }
  });
});

describe('the package as it ships', () => {
  it('has the files the manifest points at', () => {
    const referenced = [
      declared.icon,
      ...(declared.contributes.languages ?? []).map((language) => (language as { configuration?: string }).configuration),
      ...(declared.contributes.walkthroughs ?? []).flatMap((walkthrough) =>
        walkthrough.steps.map((step) => step.media?.markdown ?? step.media?.image),
      ),
    ].filter((relative): relative is string => relative !== undefined);

    assert.ok(referenced.length >= 7, 'expected the icon, the language configuration and the walkthrough media');

    for (const relative of referenced) {
      assert.ok(existsSync(path.join(extensionRoot, relative)), `${relative} is declared but missing`);
    }
  });

  it('keeps nothing it ships out of the package', () => {
    const ignore = readFileSync(path.join(extensionRoot, '.vscodeignore'), 'utf8');
    const kept = ignore
      .split('\n')
      .filter((line) => line.startsWith('!'))
      .map((line) => line.slice(1).replace(/\/\*\*$/, ''));

    for (const needed of ['media', 'package.json', 'README.md', 'LICENSE']) {
      assert.ok(kept.some((entry) => entry.startsWith(needed)), `${needed} would be excluded from the .vsix`);
    }
  });

  it('activates on something, and not on everything', () => {
    assert.ok(declared.activationEvents.length > 0);
    assert.ok(
      !declared.activationEvents.includes('*'),
      'activating on everything makes every VS Code window slower to start',
    );
  });

  it('bundles to the file the manifest calls main', () => {
    const scripts = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;

    const outfile = /--outfile=(\S+)/.exec(scripts['build'] ?? '')?.[1];
    assert.equal(`./${outfile}`, declared.main, 'the build writes somewhere other than where VS Code will look');
  });
});

describe('the stub', () => {
  it('covers every part of the API the extension uses', () => {
    const stub = require(path.join(extensionRoot, 'test/vscode.cjs')) as Record<string, unknown>;
    const used = new Set([...allSource.matchAll(/vscode\.([A-Z][A-Za-z]*|[a-z]+)\b/g)].map((match) => match[1]!));

    // Type-only names never reach runtime, so a stub does not need them.
    const typesOnly = new Set([
      'TextDocument', 'ExtensionContext', 'WorkspaceFolder', 'StatusBarItem', 'LogOutputChannel',
      'TreeDataProvider', 'Webview', 'CancellationToken', 'TextEditor', 'FileStat', 'Command',
      'CompletionItemProvider', 'HoverProvider', 'CodeLensProvider', 'DocumentDropEditProvider',
      'ProviderResult', 'Event', 'TextDocumentChangeEvent', 'ConfigurationChangeEvent', 'QuickPickItem',
      'DocumentSelector', 'DecorationOptions', 'DataTransferItem', 'MessageItem', 'Progress',
      'CodeActionProvider', 'DocumentFormattingEditProvider', 'CodeActionContext', 'FormattingOptions',
      // Reached as vscode.commands.executeCommand('...') targets, not as API.
      'postMessage', 'open',
    ]);

    const missing = [...used].filter((name) => !(name in stub) && !typesOnly.has(name));
    assert.deepEqual(missing, [], 'the stub returns undefined for these, so any test touching them lies');
  });
});

// `require` is not defined in an ES module; the stub is CommonJS on purpose.
const require = (await import('node:module')).createRequire(import.meta.url);
