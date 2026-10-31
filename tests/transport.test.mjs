import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceRequest } from '../public/transport.mjs';
import { createInitialState, validateState } from '../public/model.mjs';
import { createTodoServer } from '../server.mjs';

function nativeRuntime(t, invoke) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI__: { core: { invoke } } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Native requests must not use HTTP'); });
}

test('native load invokes load_workspace with a valid initial state and preserves its response', async t => {
  const existing = { state: createInitialState(), revision: 21 };
  existing.state.projects[0].summary = '# 原有正文\n\n$E = mc^2$\n日期：2026-10-31';
  nativeRuntime(t, async (command, args) => {
    assert.equal(command, 'load_workspace');
    validateState(args.initialState);
    assert.deepEqual(Object.keys(args), ['initialState']);
    return existing;
  });
  const response = await workspaceRequest();
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), existing);
});

test('native save preserves the exact payload and snapshots it before asynchronous IO', async t => {
  const payload = { state: createInitialState(), revision: 14 };
  payload.state.projects[0].summary = '## 中文\n- **原样保存**\n\n$$\\frac{a}{b}$$\n';
  payload.state.projects[0].createdAt = '2026-10-31T01:02:03.456Z';
  const expected = structuredClone(payload);
  let received;
  nativeRuntime(t, async (command, args) => {
    assert.equal(command, 'save_workspace');
    received = args;
    await Promise.resolve();
    return { revision: 15 };
  });
  const pending = workspaceRequest('PUT', payload);
  payload.state.projects[0].summary = 'another edit while saving';
  const response = await pending;
  assert.deepEqual(received, expected);
  assert.deepEqual(await response.json(), { revision: 15 });
});

test('native data errors retain HTTP-compatible validation, conflict, size, and disk statuses', async t => {
  let failure;
  nativeRuntime(t, async () => { throw failure; });
  for (const status of [400, 409, 413, 500]) {
    failure = { status, message: `错误 ${status}` };
    const response = await workspaceRequest('PUT', { state: {}, revision: 0 });
    assert.equal(response.ok, false);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: failure.message });
  }
  failure = JSON.stringify({ status: 409, message: '数据版本冲突' });
  const response = await workspaceRequest();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '数据版本冲突' });
});

test('malformed native rejections become safe server errors', async t => {
  let failure;
  nativeRuntime(t, async () => { throw failure; });
  for (failure of ['not json', null, false, 123, { status: 200, message: {} }, { status: 999 }]) {
    const response = await workspaceRequest();
    assert.equal(response.ok, false);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: '本地数据操作失败' });
  }
});

test('browser fallback keeps the original HTTP request shape and works against the real local server', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yishi-transport-'));
  const server = await createTodoServer({ dataDir: dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url, options });
    return originalFetch(new URL(url, origin), options);
  });
  const before = await (await workspaceRequest()).json();
  assert.deepEqual(calls[0], { url: '/api/state', options: undefined });
  before.state.projects[0].summary = '# 本地浏览器\n\n$\\alpha = 1$';
  const response = await workspaceRequest('PUT', before);
  assert.equal(response.ok, true);
  assert.deepEqual(calls[1], { url: '/api/state', options: {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before),
  } });
  const after = await (await workspaceRequest()).json();
  assert.deepEqual(after.state, before.state);
  assert.equal(after.revision, before.revision + 1);
  assert.equal((await workspaceRequest('PUT', before)).status, 409);
});
