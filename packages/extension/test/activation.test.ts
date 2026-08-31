import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { fakeContext, installStub, loadVscode, manifest, type Manifest, type Recorder } from './harness.ts';

/**
 * Does the extension actually wire itself up?
 *
 * The failure this prevents is the worst one an extension has: a command in
 * the palette that reports "command 'plotexcel.x' not found" when pressed.
 * It happens when the manifest and the code disagree, which is invisible to a
 * typechecker — one is JSON — and cannot be caught by reading either file
 * alone.
 */

installStub();

describe('activation', () => {
  let recorder: Recorder;
  let declared: Manifest;
  let context: Record<string, unknown>;

  before(async () => {
    const stub = await loadVscode();
    recorder = stub.recorder;
    recorder.reset();

    stub.state.workspaceFolders = [{ uri: { fsPath: '/tmp/workspace' }, name: 'workspace', index: 0 }];

    declared = await manifest();
    context = fakeContext();

    const extension = (await import('../src/extension.ts')) as {
      activate: (context: unknown) => Promise<void>;
      deactivate: () => void;
    };

    await extension.activate(context);
  });

  it('registers every command the manifest declares', () => {
    const promised = declared.contributes.commands.map((entry) => entry.command).sort();
    const registered = [...recorder.commands.keys()].sort();

    const missing = promised.filter((id) => !registered.includes(id));
    assert.deepEqual(missing, [], 'declared in package.json but never registered — these fail when pressed');
  });

  it('declares every command it registers', () => {
    const promised = declared.contributes.commands.map((entry) => entry.command);
    const undeclared = [...recorder.commands.keys()].filter((id) => !promised.includes(id));

    assert.deepEqual(undeclared, [], 'registered but not in package.json — unreachable from the palette');
  });

  it('registers each command exactly once', () => {
    assert.deepEqual(recorder.warnings.filter((line) => line.includes('registered twice')), []);
  });

  it('sets the context keys the menus are gated on', () => {
    assert.equal(typeof recorder.context.get('plotexcel.hasLayout'), 'boolean');
  });

  it('shows the Explorer menu and the view without needing to be activated first', () => {
    // Both were once gated on `plotexcel.supported`, which activation set at
    // the end of activate(). That was circular: nothing activates the
    // extension while somebody browses the Explorer, so the key did not exist,
    // so the menu stayed hidden — until an unrelated command woke the
    // extension up, after which it appeared for the rest of the session. The
    // reported symptom was "the right-click options only appear once I have
    // run Check My Setup".
    //
    // These two surfaces are the ones a person meets *before* the extension
    // has any reason to be running, so their conditions have to be ones VS
    // Code can answer on its own. Menus that appear only after something has
    // happened — a diff selection, a layout being found — are a different
    // case and may gate on our keys.
    const entrance = [
      ...(declared.contributes.menus['explorer/context'] ?? []).map((entry) => entry.when),
      ...Object.values(declared.contributes.views)
        .flat()
        .map((view) => view.when),
    ];

    for (const when of entrance) {
      assert.doesNotMatch(
        when ?? '',
        /plotexcel\./,
        `"${when}" needs the extension to be running before it can be true`,
      );
    }
  });

  it('registers the editor features', () => {
    const kinds = recorder.providers.map((provider) => provider.kind);

    for (const expected of ['diagnostics', 'completion', 'hover', 'codelens', 'codeactions', 'formatting', 'drop']) {
      assert.ok(kinds.includes(expected), `no ${expected} provider was registered`);
    }
  });

  it('registers the tree view the manifest declares', () => {
    const promised = Object.values(declared.contributes.views).flat().map((view) => view.id);
    const registered = recorder.views.map((view) => view.id);

    for (const id of promised) assert.ok(registered.includes(id), `${id} is declared but never provided`);
  });

  it('puts everything it creates in the subscription list', () => {
    const subscriptions = context['subscriptions'] as unknown[];
    assert.ok(subscriptions.length >= recorder.commands.size, 'a command not in subscriptions leaks on reload');
  });

  it('uses no VS Code API the stub has not been taught', () => {
    // Not a failure of the extension — a gap in the stub. Worth failing on
    // anyway: an untaught call returns a proxy that silently does nothing,
    // and a test that passes for that reason is worse than no test.
    assert.deepEqual(recorder.warnings.filter((line) => line.includes('not implemented')), []);
  });

  it('watches for layout files appearing and disappearing', () => {
    const watchers = recorder.providers.filter((provider) => provider.kind === 'watcher');
    assert.ok(
      watchers.some((watcher) => String(watcher['pattern']).includes('plotexcel.tsv')),
      'without this the palette entries go stale',
    );
  });

  it('deactivates without throwing', async () => {
    const extension = (await import('../src/extension.ts')) as { deactivate: () => void };
    assert.doesNotThrow(() => extension.deactivate());
  });
});
