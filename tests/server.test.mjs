import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { createTodoServer } from '../server.mjs';

async function start(t, dataDir) {
  const server = await createTodoServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quiet-todo-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const put = (url, payload, headers = {}) => fetch(url + '/api/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
});

test('saves changed state, preserves backup, and retains revision after restart', async t => {
  const dir = await directory(t);
  const { url, server } = await start(t, dir);
  const before = await (await fetch(url + '/api/state')).json();
  const next = structuredClone(before);
  next.state.projects[0].name = '保存后的项目';
  const saved = await put(url, next);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const backup = JSON.parse(await readFile(path.join(dir, 'workspace.json.bak'), 'utf8'));
  assert.deepEqual(backup, before);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const restarted = await start(t, dir);
  const loaded = await (await fetch(restarted.url + '/api/state')).json();
  assert.equal(loaded.state.projects[0].name, '保存后的项目');
  assert.equal(loaded.revision, 1);
});

test('rejects invalid state without changing the saved file', async t => {
  const dir = await directory(t);
  const { url } = await start(t, dir);
  const before = await readFile(path.join(dir, 'workspace.json'), 'utf8');
  const response = await put(url, { state: { version: 1, projects: 'bad' }, revision: 0 });
  assert.equal(response.status, 400);
  assert.equal(await readFile(path.join(dir, 'workspace.json'), 'utf8'), before);
});

test('rejects stale and simultaneous saves instead of losing a newer change', async t => {
  const { url } = await start(t, await directory(t));
  const payload = await (await fetch(url + '/api/state')).json();
  const statuses = await Promise.all([put(url, payload), put(url, payload)]);
  assert.deepEqual(statuses.map(response => response.status).sort(), [200, 409]);
});

test('rejects cross-origin access and non-JSON mutation', async t => {
  const { url } = await start(t, await directory(t));
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    get(url + '/api/state', { headers: { Host: 'example.com' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(url + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});

test('rejects oversized payloads before parsing or saving them', async t => {
  const dir = await directory(t);
  const { url } = await start(t, dir);
  const before = await readFile(path.join(dir, 'workspace.json'), 'utf8');
  const response = await fetch(url + '/api/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(5 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(await readFile(path.join(dir, 'workspace.json'), 'utf8'), before);
});

test('does not overwrite corrupt existing user data', async t => {
  const dir = await directory(t);
  const filename = path.join(dir, 'workspace.json');
  await writeFile(filename, '{broken', 'utf8');
  await assert.rejects(createTodoServer({ dataDir: dir }), /数据文件无法读取/);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});

test('serves only application files and does not expose data or traversal paths', async t => {
  const { url } = await start(t, await directory(t));
  for (const pathname of ['/server.mjs', '/data/workspace.json', '/vendor/%2e%2e/%2e%2e/package.json', '/%E0%A4%A']) {
    const response = await fetch(url + pathname);
    assert.ok([400, 404].includes(response.status), `${pathname}: ${response.status}`);
  }
});
