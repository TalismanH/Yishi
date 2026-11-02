import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeCloseGuard } from '../public/transport.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(hooks, {tray = false, hideFailure} = {}) {
  let listener, trayListener, destroyed = 0, hidden = 0, removed = 0;
  const unlisten = () => {};
  const native = { core: {invoke: async command => {
    assert.equal(command,'hide_to_tray');
    if (hideFailure) throw hideFailure;
    hidden += 1;
  }}, window: { getCurrentWindow: () => ({
    onCloseRequested: async handler => { listener = handler; return unlisten; },
    destroy: async () => { destroyed += 1; },
  }) } };
  if (tray) native.event = {listen: async (event, handler) => {
    assert.equal(event,'tray-exit-requested');trayListener = handler;
    return () => {removed += 1;};
  }};
  const dispose = await installNativeCloseGuard(hooks, native);
  if (!tray) assert.equal(dispose, unlisten);
  return {
    get destroyed() { return destroyed; },
    get hidden() { return hidden; },
    get removed() { return removed; },
    dispose,
    trayExit() { return trayListener({payload:null}); },
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      return { event, done: listener(event) };
    },
  };
}

test('browser startup does not install a native close hook', async () => {
  assert.equal(await installNativeCloseGuard({}, undefined), undefined);
});

test('native close flushes the editor and waits for an already-running save', async () => {
  const write = deferred();
  let pending = true, persisted = 0;
  const guard = await setup({
    persistEditor: () => { persisted += 1; return true; },
    save: () => write.promise.then(() => { pending = false; }),
    isPending: () => pending, hasError: () => false,
  });
  const closing = guard.close();
  assert.equal(closing.event.prevented, true);
  assert.equal(guard.destroyed, 0);
  write.resolve();
  await closing.done;
  assert.ok(persisted >= 2);
  assert.equal(guard.destroyed, 1);
});

test('edits entered while save is awaited are flushed before native destruction', async () => {
  const firstWrite = deferred(), writes = [];
  let buffer = 'first', persisted = '', dirty = false;
  const guard = await setup({
    persistEditor: () => {
      if (buffer !== persisted) { persisted = buffer; dirty = true; }
      return true;
    },
    save: async () => {
      if (!dirty) return;
      dirty = false; writes.push(persisted);
      if (writes.length === 1) await firstWrite.promise;
    },
    isPending: () => dirty, hasError: () => false,
  });
  const closing = guard.close();
  buffer = 'second';
  firstWrite.resolve();
  await closing.done;
  assert.deepEqual(writes, ['first', 'second']);
  assert.equal(guard.destroyed, 1);
});

test('save failure or conflict keeps the native window and editing buffer intact', async () => {
  for (const conflict of [false, true]) {
    let dirty = true, failed = conflict;
    const buffer = '# unsaved\n$E=mc^2$';
    const guard = await setup({
      persistEditor: () => true,
      save: async () => { failed = true; },
      isPending: () => dirty, hasError: () => failed,
    });
    const closing = guard.close();
    await closing.done;
    assert.equal(closing.event.prevented, true);
    assert.equal(guard.destroyed, 0);
    assert.equal(dirty, true);
    assert.equal(buffer, '# unsaved\n$E=mc^2$');
  }
});

test('invalid inline edits block native close without discarding the editor', async () => {
  let saved = false;
  const guard = await setup({
    persistEditor: () => false,
    save: async () => { saved = true; },
    isPending: () => true, hasError: () => false,
  });
  const closing = guard.close();
  await closing.done;
  assert.equal(saved, false);
  assert.equal(guard.destroyed, 0);
});

test('an untouched empty draft can be discarded on close while entered invalid content is retained', async () => {
  for (const value of ['', '   ', 'invalid nonempty draft']) {
    const draft = { newTask: {}, value };
    const guard = await setup({
      persistEditor: () => false,
      isEmptyDraft: () => Boolean(draft.newTask && draft.value === ''),
      save: async () => {},
      isPending: () => false, hasError: () => false,
    });
    await guard.close().done;
    assert.equal(guard.destroyed, value === '' ? 1 : 0);
    assert.equal(draft.value, value);
    assert.ok(draft.newTask);
  }
});

test('invalid content typed into an empty draft while save is pending blocks close', async () => {
  const write = deferred();
  let value = '';
  const guard = await setup({
    persistEditor: () => false,
    isEmptyDraft: () => value === '',
    save: () => write.promise,
    isPending: () => false, hasError: () => false,
  });
  const closing = guard.close();
  value = '   ';
  write.resolve();
  await closing.done;
  assert.equal(guard.destroyed, 0);
  assert.equal(value, '   ');
});

test('repeated close requests share the active flush and destroy the native window once', async () => {
  const write = deferred();
  let saves = 0;
  const guard = await setup({
    persistEditor: () => true,
    save: () => { saves += 1; return write.promise; },
    isPending: () => false, hasError: () => false,
  });
  const first = guard.close(), second = guard.close();
  assert.equal(first.event.prevented, true);
  assert.equal(second.event.prevented, true);
  write.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(saves, 1);
  assert.equal(guard.destroyed, 1);
});

test('unexpected native close errors preserve the window and reach the existing error handler', async () => {
  const failure = new Error('permission failure');
  let shown;
  const guard = await setup({
    persistEditor: () => true,
    save: async () => { throw failure; },
    isPending: () => false, hasError: () => false, onError: error => { shown = error; },
  });
  await guard.close().done;
  assert.equal(guard.destroyed, 0);
  assert.equal(shown, failure);
});

test('minimize to tray waits for saved content and leaves the window alive', async () => {
  const write = deferred();
  let saved = false;
  const guard = await setup({
    chooseCloseAction: async () => 'hide', persistEditor: () => true,
    save: async () => {await write.promise;saved = true;},
    isPending: () => !saved, hasError: () => false,
  });
  const closing = guard.close();
  assert.equal(closing.event.prevented,true);
  assert.equal(guard.hidden,0);assert.equal(guard.destroyed,0);
  write.resolve();await closing.done;
  assert.equal(saved,true);assert.equal(guard.hidden,1);assert.equal(guard.destroyed,0);
});

test('canceling the close choice keeps the editor and window untouched', async () => {
  let persisted = 0, saved = 0;
  const guard = await setup({
    chooseCloseAction: async () => 'cancel', persistEditor: () => {persisted += 1;return true;},
    save: async () => {saved += 1;}, isPending: () => false, hasError: () => false,
  });
  await guard.close().done;
  assert.equal(persisted,0);assert.equal(saved,0);assert.equal(guard.hidden,0);assert.equal(guard.destroyed,0);
});

test('failed saves or invalid edits never hide the window', async () => {
  for (const invalid of [false,true]) {
    const guard = await setup({
      chooseCloseAction: async () => 'hide', persistEditor: () => !invalid,
      save: async () => {}, isPending: () => false, hasError: () => !invalid,
    });
    await guard.close().done;
    assert.equal(guard.hidden,0);assert.equal(guard.destroyed,0);
  }
});

test('tray failures reach the existing error handler without destroying the window', async () => {
  const failure = new Error('tray unavailable');let shown;
  const guard = await setup({
    chooseCloseAction: async () => 'hide', persistEditor: () => true,
    save: async () => {}, isPending: () => false, hasError: () => false,
    onError: error => {shown = error;},
  },{hideFailure:failure});
  await guard.close().done;
  assert.equal(shown,failure);assert.equal(guard.hidden,0);assert.equal(guard.destroyed,0);
});

test('tray exit bypasses the close choice and still saves before destruction', async () => {
  let saved = false, choices = 0;
  const guard = await setup({
    chooseCloseAction: async () => {choices += 1;return 'hide';}, persistEditor: () => true,
    save: async () => {saved = true;}, isPending: () => false, hasError: () => false,
  },{tray:true});
  await guard.trayExit();
  assert.equal(choices,0);assert.equal(saved,true);assert.equal(guard.hidden,0);assert.equal(guard.destroyed,1);
  guard.dispose();assert.equal(guard.removed,1);
});

test('tray exit retains the window when persistence or saving fails', async () => {
  for (const invalid of [false,true]) {
    const guard = await setup({
      persistEditor: () => !invalid, save: async () => {},
      isPending: () => false, hasError: () => !invalid,
    },{tray:true});
    await guard.trayExit();assert.equal(guard.hidden,0);assert.equal(guard.destroyed,0);
  }
});
