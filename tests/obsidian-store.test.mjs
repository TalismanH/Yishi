import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, truncate, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInitialState } from '../public/model.mjs';
import { WorkspaceStore, parseImport } from '../obsidian/store.mjs';

async function migrationSetup(t) {
  const root = await mkdtemp(path.join(tmpdir(),'yishi-folder-migration-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const legacy = path.join(root,'一事'), target = path.join(root,'Yishi');
  const old = new WorkspaceStore(legacy);
  await old.load();
  await old.save({state:createInitialState(),revision:0});
  return {root,legacy,target,old};
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yishi-obsidian-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  return { directory, store, snapshot: await store.load() };
}

const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'));
const rejectsStatus = (promise, status) => assert.rejects(promise, error => error.status === status);

test('migrates the complete old folder without changing source data or revision', async t => {
  const {legacy,target,old} = await migrationSetup(t);
  const current = await old.load();
  const exported = await old.exportState(current.state);
  const recovery = structuredClone(current);
  recovery.state.projects[0].name='';
  old.writeRecovery(recovery);
  await utimes(old.recoveryPath,new Date('2025-01-02T03:04:05Z'),new Date('2025-01-02T03:04:05Z'));
  const source = await readFile(old.filename,'utf8');
  const store = new WorkspaceStore(target,{legacyDirectory:legacy});
  assert.deepEqual(await store.load(),current);
  assert.equal(await readFile(store.filename,'utf8'),source);
  assert.deepEqual(await readJSON(store.backupPath),await readJSON(old.backupPath));
  assert.equal(await readFile(path.join(target,'backups',path.basename(exported)),'utf8'),await readFile(exported,'utf8'));
  assert.deepEqual(await readJSON(path.join(target,path.basename(old.recoveryPath))),recovery);
  assert.ok(Math.abs((await stat(path.join(target,path.basename(old.recoveryPath)))).mtimeMs-(await stat(old.recoveryPath)).mtimeMs)<1);
  assert.equal(await readFile(old.filename,'utf8'),source);
  assert.ok((await readdir(path.join(target,'backups'))).some(name=>name.startsWith('migration-source-')));
  current.state.projects[0].name='New folder edit';
  await store.save(current);
  assert.equal((await new WorkspaceStore(target,{legacyDirectory:legacy}).load()).state.projects[0].name,'New folder edit');
  assert.equal(await readFile(old.filename,'utf8'),source);
  assert.match(path.basename(await store.exportState(current.state)),/^Yishi-backup-/);
});

test('an existing Yishi workspace always wins over legacy data', async t => {
  const {legacy,target} = await migrationSetup(t);
  const store = new WorkspaceStore(target);
  const empty=await store.load();
  assert.deepEqual(await new WorkspaceStore(target,{legacyDirectory:legacy}).load(),empty);
  assert.equal((await readdir(target)).includes('backups'),false);
});

test('busy or corrupt legacy data never creates a replacement workspace', async t => {
  const {legacy,target,old} = await migrationSetup(t);
  const original=await readFile(old.filename,'utf8');
  await writeFile(old.lockPath,'busy');
  await rejectsStatus(new WorkspaceStore(target,{legacyDirectory:legacy}).load(),409);
  await assert.rejects(readFile(path.join(target,'workspace.json')), {code:'ENOENT'});
  assert.equal(await readFile(old.filename,'utf8'),original);
  await rm(old.lockPath);
  await writeFile(old.filename,'{broken');
  const store=new WorkspaceStore(target,{legacyDirectory:legacy});
  await rejectsStatus(store.load(),500);
  await assert.rejects(readFile(store.filename), {code:'ENOENT'});
  await store.importState(JSON.stringify(createInitialState()),null);
  assert.equal(await readFile(old.filename,'utf8'),'{broken');
});

test('a missing target with a backup cannot silently fall back to stale legacy data', async t => {
  const {legacy,target,old} = await migrationSetup(t);
  await mkdir(target);
  const backup=JSON.stringify({state:{version:1,projects:[]},revision:40});
  await writeFile(path.join(target,'workspace.json.bak'),backup);
  const store=new WorkspaceStore(target,{legacyDirectory:legacy});
  await rejectsStatus(store.load(),500);
  await assert.rejects(readFile(store.filename), {code:'ENOENT'});
  assert.equal(await readFile(store.backupPath,'utf8'),backup);
  assert.equal((await old.load()).revision,1);
});

test('migration copy failure preserves both the source and pre-existing target files', async t => {
  const {legacy,target,old} = await migrationSetup(t);
  const current=await old.load();
  await old.exportState(current.state);
  await mkdir(target);
  await writeFile(path.join(target,'backups'),'occupied');
  const store=new WorkspaceStore(target,{legacyDirectory:legacy});
  await rejectsStatus(store.load(),500);
  await assert.rejects(readFile(store.filename), {code:'ENOENT'});
  assert.deepEqual(await old.load(),current);
  assert.equal(await readFile(path.join(target,'backups'),'utf8'),'occupied');
});

test('plugin initializes empty JSON, preserves previous version, and reloads saved data', async t => {
  const { directory, store, snapshot } = await setup(t);
  assert.deepEqual(snapshot, { state: { version: 1, projects: [] }, revision: 0 });
  const state = createInitialState();
  assert.deepEqual(await store.save({ state, revision: 0 }), { revision: 1 });
  assert.deepEqual(await readJSON(store.backupPath), snapshot);
  assert.deepEqual(await new WorkspaceStore(directory).load(), { state, revision: 1 });
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('import accepts original state and disk snapshots but rejects malformed JSON and revisions', () => {
  const state = createInitialState();
  assert.deepEqual(parseImport(JSON.stringify(state)), state);
  assert.deepEqual(parseImport('\uFEFF' + JSON.stringify({ state, revision: 132 })), state);
  for (const input of ['{bad', '{}', JSON.stringify({ state, revision: -1 }), JSON.stringify({ state, revision: 1.5 })]) {
    assert.throws(() => parseImport(input), error => error.status === 400);
  }
});

test('import takes a new local revision and permanent before-import backup without editing the source', async t => {
  const { directory, store, snapshot } = await setup(t);
  const state = createInitialState(), text = JSON.stringify({ state, revision: 700 });
  const source = path.join(directory, 'legacy.json');
  await writeFile(source, text);
  assert.deepEqual(await store.importState(await readFile(source, 'utf8'), 0), { state, revision: 1 });
  const backups = await readdir(path.join(directory, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readJSON(path.join(directory, 'backups', backups[0])), snapshot);
  assert.deepEqual(await readJSON(store.backupPath), snapshot);
  assert.equal(await readFile(source, 'utf8'), text);
  await rejectsStatus(store.importState(JSON.stringify(state), 0), 409);
});

test('stale and concurrent callers cannot overwrite newer changes, and payloads are snapshotted', async t => {
  const { directory, store } = await setup(t);
  const second = new WorkspaceStore(directory);
  await second.load();
  const payload = { state: createInitialState(), revision: 0 };
  const expectedName = payload.state.projects[0].name;
  const writes = [store.save(payload), second.save(payload), store.save(payload)];
  payload.state.projects[0].name = 'mutated later';
  const results = await Promise.allSettled(writes);
  assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 200 : result.reason.status), [200, 409, 409]);
  assert.equal((await readJSON(store.filename)).state.projects[0].name, expectedName);
});

test('independent processes cannot commit the same base revision twice', async t => {
  const { directory, store } = await setup(t);
  const script = `
    const { WorkspaceStore } = await import(process.argv[2]);
    const store = new WorkspaceStore(process.argv[1]);
    const snapshot = await store.load();
    process.on('message', async () => {
      try { await store.save(snapshot); process.send(200); }
      catch (error) { process.send(error.status); }
      process.disconnect();
    });
    process.send('ready');
  `;
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, new URL('../obsidian/store.mjs', import.meta.url).href], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    children.push(child);
    assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
  }
  const completed = children.map(child => once(child, 'message'));
  children.forEach(child => child.send('save'));
  assert.deepEqual((await Promise.all(completed)).map(([status]) => status).sort(), [200, 409]);
  assert.equal((await readJSON(store.filename)).revision, 1);
});

test('same-revision replacement and deleted files are treated as conflicts', async t => {
  const { store } = await setup(t);
  const external = { state: createInitialState(), revision: 0 };
  await writeFile(store.filename, JSON.stringify(external));
  await rejectsStatus(store.save({ state: { version: 1, projects: [] }, revision: 0 }), 409);
  assert.deepEqual(await readJSON(store.filename), external);
  await store.load();
  await rm(store.filename);
  await rejectsStatus(store.save(external), 409);
});

test('invalid state and oversized writes leave data and backups unchanged', async t => {
  const { store } = await setup(t);
  const before = await readFile(store.filename, 'utf8');
  await rejectsStatus(store.save({ state: { version: 1, projects: 'bad' }, revision: 0 }), 400);
  await rejectsStatus(store.save({ state: { version: 1, projects: [], extra: 'x'.repeat(5 * 1024 * 1024) }, revision: 0 }), 413);
  assert.equal(await readFile(store.filename, 'utf8'), before);
  assert.throws(() => parseImport(' '.repeat(64 * 1024 * 1024 + 1)), error => error.status === 413);
});

test('corrupt files are preserved and explicit restore archives the damaged original', async t => {
  const { directory, store } = await setup(t);
  await store.save({ state: createInitialState(), revision: 0 });
  const backup = await readFile(store.backupPath, 'utf8');
  await writeFile(store.filename, '{broken');
  const restarted = new WorkspaceStore(directory);
  await rejectsStatus(restarted.load(), 500);
  assert.equal(await readFile(store.filename, 'utf8'), '{broken');
  assert.equal(await readFile(store.backupPath, 'utf8'), backup);
  const restored = await restarted.restoreBackup(null);
  assert.deepEqual(restored, { state: { version: 1, projects: [] }, revision: 1 });
  const backups = await readdir(path.join(directory, 'backups'));
  assert.equal(await readFile(path.join(directory, 'backups', backups[0]), 'utf8'), '{broken');
  assert.equal(await readFile(store.backupPath, 'utf8'), backup);
});

test('a missing main file with a backup is never silently initialized', async t => {
  const { directory, store } = await setup(t);
  await store.save({ state: createInitialState(), revision: 0 });
  await rm(store.filename);
  const restarted = new WorkspaceStore(directory);
  await rejectsStatus(restarted.load(), 500);
  assert.deepEqual((await restarted.restoreBackup(null)).state, { version: 1, projects: [] });
});

test('recovery never blindly replaces external changes made after a failed load', async t => {
  const { store } = await setup(t);
  await store.save({ state: createInitialState(), revision: 0 });
  await writeFile(store.filename, '{broken');
  await rejectsStatus(store.load(), 500);
  const external = { state: createInitialState(), revision: 10 };
  await writeFile(store.filename, JSON.stringify(external));
  await rejectsStatus(store.restoreBackup(null), 409);
  await rejectsStatus(store.importState(JSON.stringify(external), null), 409);
  assert.deepEqual(await readJSON(store.filename), external);
});

test('explicit backup restore preserves the replaced valid workspace', async t => {
  const { directory, store } = await setup(t);
  const state = createInitialState();
  await store.save({ state, revision: 0 });
  assert.deepEqual(await store.restoreBackup(1), { state: { version: 1, projects: [] }, revision: 2 });
  assert.deepEqual(await readJSON(store.backupPath), { state, revision: 1 });
  assert.equal((await readdir(path.join(directory, 'backups'))).length, 1);
});

test('lock contention and failed backup writes never modify the workspace', async t => {
  const { directory, store, snapshot } = await setup(t);
  await writeFile(store.lockPath, 'foreign-lock');
  await rejectsStatus(store.save(snapshot), 409);
  assert.equal(await readFile(store.lockPath, 'utf8'), 'foreign-lock');
  await rm(store.lockPath);
  await mkdir(store.backupPath);
  await rejectsStatus(store.save({ state: createInitialState(), revision: 0 }), 500);
  assert.deepEqual(await readJSON(store.filename), snapshot);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('exports have unique names and preserve unsavable editing content for rescue', async t => {
  const { store } = await setup(t);
  const state = { version: 1, projects: [], unsavedText: '不能丢失的内容' };
  const first = await store.exportState(state), second = await store.exportState(state);
  assert.notEqual(first, second);
  assert.deepEqual(await readJSON(first), state);
  assert.deepEqual(await readJSON(second), state);
});

test('recovery files remain session-specific, support invalid drafts, and cannot read arbitrary files', async t => {
  const { directory, store } = await setup(t);
  const second = new WorkspaceStore(directory);
  const firstDraft = { state: { version: 1, projects: 'unfinished' }, revision: 0 };
  store.writeRecovery(firstDraft);
  second.writeRecovery({ state: createInitialState(), revision: 1 });
  assert.equal((await store.listRecoveries()).length, 2);
  assert.deepEqual(await store.readRecovery(store.recoveryPath), firstDraft);
  await rejectsStatus(store.readRecovery(store.filename), 400);
  await rejectsStatus(store.readRecovery(path.join(directory, '..', path.basename(store.recoveryPath))), 400);
  store.clearRecovery();
  store.clearRecovery();
  assert.deepEqual((await second.listRecoveries()).map(item => item.path), [second.recoveryPath]);
});

test('large existing files are rejected before loading and are not replaced', async t => {
  const { directory, store } = await setup(t);
  await truncate(store.filename, 64 * 1024 * 1024 + 1);
  await rejectsStatus(new WorkspaceStore(directory).load(), 413);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.lock')), false);
});
