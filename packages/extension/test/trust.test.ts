import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { installStub, loadVscode, type Recorder, type StubState } from './harness.ts';

/**
 * Nothing starts a process in a folder nobody has vouched for.
 *
 * Rendering runs LibreOffice, PowerShell and a headless browser over files the
 * workspace chose, and a layout file is a list of paths naming them. Cloning a
 * repository and opening it must not be enough to cause any of that, so the
 * question these tests ask is not "was a warning shown" but "was there ever
 * anything to run".
 */

installStub();

describe('an untrusted folder', () => {
  let recorder: Recorder;
  let state: StubState;
  let machine: typeof import('../src/machine.ts');

  before(async () => {
    const stub = await loadVscode();
    recorder = stub.recorder;
    state = stub.state;
    machine = await import('../src/machine.ts');
  });

  it('hands the pipeline no tools at all', async () => {
    state.isTrusted = false;
    const { tools } = await machine.machine();

    // Not "the renderer is undefined" — there is nothing on the object. A tool
    // that cannot be reached cannot be started.
    assert.deepEqual(tools, {}, 'an untrusted folder must not assemble a renderer, a converter or a revision reader');
  });

  it('reports every capability as unavailable, and says why', async () => {
    state.isTrusted = false;
    const { report } = await machine.machine();

    assert.deepEqual(
      report.map((entry) => entry.status),
      ['missing', 'missing', 'missing', 'missing'],
    );
    for (const entry of report) {
      assert.match(entry.advice ?? '', /not trusted/, `${entry.capability} should explain the reason`);
    }
  });

  it('stops a command that would render, and offers the way out', async () => {
    state.isTrusted = false;
    recorder.messages.length = 0;

    assert.equal(await machine.requireTrust(), false);

    const [shown] = recorder.messages;
    assert.equal(shown?.kind, 'warning');
    assert.match(shown?.message ?? '', /not trusted/);
  });

  it('leaves the render command with nothing to do', async () => {
    state.isTrusted = false;
    recorder.messages.length = 0;

    const { renderCommand } = await import('../src/commands/render.ts');
    await renderCommand();

    // It returned at the gate: the only thing that happened was being told.
    assert.equal(recorder.messages.length, 1);
    assert.match(recorder.messages[0]?.message ?? '', /not trusted/);
  });
});

describe('a trusted folder', () => {
  let recorder: Recorder;
  let state: StubState;
  let machine: typeof import('../src/machine.ts');

  before(async () => {
    const stub = await loadVscode();
    recorder = stub.recorder;
    state = stub.state;
    machine = await import('../src/machine.ts');
  });

  it('is the ordinary case, and says nothing about trust', async () => {
    state.isTrusted = true;
    recorder.messages.length = 0;

    assert.equal(machine.isTrusted(), true);
    assert.equal(await machine.requireTrust(), true);
    assert.deepEqual(recorder.messages, [], 'a trusted folder should not be interrupted');
  });

  it('counts a host with no notion of trust as trusted', async () => {
    // `workspace.isTrusted` is absent on hosts predating workspace trust.
    // Reading it as "untrusted" there would disable the extension entirely.
    state.isTrusted = undefined;
    assert.equal(machine.isTrusted(), true);
  });
});
