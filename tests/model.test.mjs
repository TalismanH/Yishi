import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, validateState, descendants, depthOf, moveTask, setTaskStatus, removeTask, progress, canArchive, projectColumn } from '../public/model.mjs';

function fixture() {
  return { id: 'p', name: '项目', summary: '', createdAt: '2026-01-01T00:00:00Z', archivedAt: null,
    tasks: [
      { id: 'a', parentId: null, title: '主事项', status: 'doing', order: 0 },
      { id: 'b', parentId: 'a', title: '二级', status: 'todo', order: 0 },
      { id: 'c', parentId: 'b', title: '三级', status: 'todo', order: 0 },
      { id: 'd', parentId: null, title: '第二组', status: 'done', order: 1 },
      { id: 'e', parentId: 'd', title: '二级', status: 'doing', order: 0 },
    ] };
}

test('seed is valid and demonstrates three hierarchy levels', () => {
  const state = createInitialState();
  assert.equal(validateState(state), state);
  assert.equal(state.projects.length, 3);
  assert.equal(depthOf(state.projects[0], 'drag'), 3);
});

test('moving a root reorders siblings and preserves every descendant status', () => {
  const project = fixture();
  const statuses = project.tasks.map(task => task.status);
  moveTask(project, 'a');
  assert.deepEqual(project.tasks.filter(t => t.parentId === null).sort((a, b) => a.order - b.order).map(t => t.id), ['d', 'a']);
  assert.deepEqual(project.tasks.map(task => task.status), statuses);
  assert.equal(depthOf(project, 'c'), 3);
});

test('moving second-level task preserves its third-level subtree and changes parent', () => {
  const project = fixture();
  moveTask(project, 'b', { parentId: 'd', beforeId: 'e', status: 'todo' });
  assert.equal(project.tasks.find(t => t.id === 'b').parentId, 'd');
  assert.equal(project.tasks.find(t => t.id === 'c').parentId, 'b');
  assert.equal(project.tasks.find(t => t.id === 'b').order, 0);
  assert.equal(project.tasks.find(t => t.id === 'e').order, 1);
  assert.equal(project.tasks.find(t => t.id === 'c').status, 'todo');
});

test('a same-status drag option preserves mixed descendant statuses', () => {
  const project = fixture();
  const statuses = project.tasks.map(task => task.status);
  moveTask(project, 'a', { status: 'doing' });
  assert.deepEqual(project.tasks.map(task => task.status), statuses);
});

test('dragging rejects every cross-status change atomically', () => {
  for (const [id, status] of [['a', 'todo'], ['a', 'done'], ['b', 'doing'], ['b', 'done'], ['d', 'doing'], ['d', 'todo']]) {
    const project = fixture();
    const original = structuredClone(project);
    assert.throws(() => moveTask(project, id, { status }));
    assert.deepEqual(project, original);
  }
});

test('moving a third-level task to the root changes its actual depth', () => {
  const project = fixture();
  moveTask(project, 'c', { parentId: null, beforeId: 'a' });
  assert.equal(depthOf(project, 'c'), 1);
  assert.equal(project.tasks.find(t => t.id === 'c').order, 0);
});

test('cycle, excessive depth, invalid sibling and invalid status moves are atomic', () => {
  for (const options of [{ parentId: 'c' }, { parentId: 'e' }, { beforeId: 'c' }, { status: 'unknown' }]) {
    const project = fixture();
    const original = structuredClone(project);
    assert.throws(() => moveTask(project, 'a', options));
    assert.deepEqual(project, original);
  }
});

test('status shortcut completes a branch but does not change its ancestors', () => {
  const project = fixture();
  setTaskStatus(project, 'b', 'doing');
  setTaskStatus(project, 'b', 'done');
  assert.equal(project.tasks.find(t => t.id === 'a').status, 'doing');
  assert.deepEqual(descendants(project, 'b').map(t => t.status), ['done']);
  assert.equal(project.tasks.find(t => t.id === 'b').status, 'done');
});

test('status shortcuts allow every adjacent transition in both directions', () => {
  const project = fixture();
  for (const status of ['doing', 'done', 'doing', 'todo']) {
    setTaskStatus(project, 'b', status);
    assert.equal(project.tasks.find(task => task.id === 'b').status, status);
    assert.equal(project.tasks.find(task => task.id === 'c').status, status);
  }
});

test('todo and done shortcuts cannot skip directly between each other', () => {
  for (const [id, status] of [['b', 'done'], ['d', 'todo']]) {
    const project = fixture();
    const original = structuredClone(project);
    assert.throws(() => setTaskStatus(project, id, status));
    assert.deepEqual(project, original);
  }
});

test('a mixed subtree cannot skip a descendant state and leaves the entire branch unchanged', () => {
  for (const status of ['done', 'todo']) {
    const project = fixture();
    if (status === 'todo') project.tasks.find(task => task.id === 'b').status = 'done';
    const original = structuredClone(project);
    assert.throws(() => setTaskStatus(project, 'a', status));
    assert.deepEqual(project, original);
  }
});

test('same-state nodes are allowed while other subtree nodes move one adjacent step', () => {
  const project = fixture();
  setTaskStatus(project, 'a', 'doing');
  assert.deepEqual([project.tasks[0], ...descendants(project, 'a')].map(task => task.status), ['doing', 'doing', 'doing']);
  const original = structuredClone(project);
  setTaskStatus(project, 'a', 'doing');
  assert.deepEqual(project, original);
});

test('deleting a branch removes all descendants and preserves other groups', () => {
  const project = fixture();
  removeTask(project, 'a');
  assert.deepEqual(project.tasks.map(t => t.id), ['d', 'e']);
});

test('columns include ancestor context and preserve hierarchy without duplicate parents', () => {
  const project = fixture();
  const nodes = projectColumn(project, 'todo');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].task.id, 'a');
  assert.equal(nodes[0].context, true);
  assert.equal(nodes[0].children[0].task.id, 'b');
  assert.equal(nodes[0].children[0].context, false);
  assert.equal(nodes[0].children[0].children[0].task.id, 'c');
  assert.deepEqual(projectColumn(project, 'done').map(n => n.task.id), ['d']);
});

test('progress counts actual tasks and archive requires a nonempty completed project', () => {
  const project = fixture();
  assert.deepEqual(progress(project), { total: 5, done: 1, percent: 20 });
  assert.equal(canArchive(project), false);
  setTaskStatus(project, 'a', 'doing');
  setTaskStatus(project, 'a', 'done');
  setTaskStatus(project, 'd', 'done');
  assert.equal(canArchive(project), true);
  project.tasks = [];
  assert.deepEqual(progress(project), { total: 0, done: 0, percent: 0 });
  assert.equal(canArchive(project), false);
});

test('validation rejects duplicate IDs, orphan parents, cycles and fourth levels', () => {
  const mutations = [
    p => p.tasks.push({ ...p.tasks[0] }),
    p => { p.tasks[1].parentId = 'missing'; },
    p => { p.tasks[0].parentId = 'c'; },
    p => { p.tasks[4].parentId = 'c'; },
    p => { p.tasks[0].status = 'bad'; },
    p => { p.tasks[0].order = -1; },
    p => { p.tasks[0].title = ' '; },
  ];
  for (const mutate of mutations) {
    const project = fixture();
    mutate(project);
    assert.throws(() => validateState({ version: 1, projects: [project] }));
  }
});

test('validation rejects malformed project data and unsupported document versions', () => {
  assert.throws(() => validateState({ version: 2, projects: [] }));
  const project = fixture();
  assert.throws(() => validateState({ version: 1, projects: [project, project] }));
  project.archivedAt = 'not a date';
  assert.throws(() => validateState({ version: 1, projects: [project] }));
});
