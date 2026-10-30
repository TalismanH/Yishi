const STATUS_ORDER = ['todo', 'doing', 'done'];
const STATUSES = new Set(STATUS_ORDER);

function requireTask(project, id) {
  const task = project.tasks.find(task => task.id === id);
  if (!task) throw new Error('事项不存在');
  return task;
}

function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new Error(`${label}格式不正确`);
  }
}

export function depthOf(project, id) {
  let task = requireTask(project, id);
  const visited = new Set();
  let depth = 0;
  while (task) {
    if (visited.has(task.id)) throw new Error('事项层级不能形成循环');
    visited.add(task.id);
    depth += 1;
    task = task.parentId === null ? null : requireTask(project, task.parentId);
  }
  return depth;
}

export function descendants(project, id) {
  requireTask(project, id);
  const ids = new Set([id]);
  const result = [];
  let parents = [id];
  while (parents.length) {
    const children = project.tasks.filter(task => parents.includes(task.parentId) && !ids.has(task.id));
    children.forEach(task => ids.add(task.id));
    result.push(...children);
    parents = children.map(task => task.id);
  }
  return result;
}

export function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.projects) || state.projects.length > 1000) {
    throw new Error('工作区格式不正确');
  }
  const projectIds = new Set();
  for (const project of state.projects) {
    if (!project || typeof project !== 'object') throw new Error('项目格式不正确');
    text(project.id, 100, '项目编号');
    if (projectIds.has(project.id)) throw new Error('项目编号不能重复');
    projectIds.add(project.id);
    text(project.name, 120, '项目名称');
    text(project.summary, 100000, '项目总体情况', true);
    if (typeof project.createdAt !== 'string' || !Number.isFinite(Date.parse(project.createdAt))) {
      throw new Error('项目创建时间不正确');
    }
    if (project.archivedAt !== null && (typeof project.archivedAt !== 'string' || !Number.isFinite(Date.parse(project.archivedAt)))) {
      throw new Error('项目归档时间不正确');
    }
    if (!Array.isArray(project.tasks) || project.tasks.length > 10000) throw new Error('事项列表格式不正确');
    const ids = new Set();
    for (const task of project.tasks) {
      if (!task || typeof task !== 'object') throw new Error('事项格式不正确');
      text(task.id, 100, '事项编号');
      if (ids.has(task.id)) throw new Error('事项编号不能重复');
      ids.add(task.id);
      text(task.title, 20000, '事项内容');
      if (task.parentId !== null) text(task.parentId, 100, '父事项编号');
      if (!STATUSES.has(task.status)) throw new Error('事项状态不正确');
      if (!Number.isSafeInteger(task.order) || task.order < 0) throw new Error('事项排序不正确');
    }
    for (const task of project.tasks) {
      if (depthOf(project, task.id) > 3) throw new Error('事项最多支持三级');
    }
  }
  return state;
}

export function setTaskStatus(project, id, status) {
  if (!STATUSES.has(status)) throw new Error('事项状态不正确');
  const branch = [requireTask(project, id), ...descendants(project, id)];
  const target = STATUS_ORDER.indexOf(status);
  if (branch.some(item => !STATUSES.has(item.status) || Math.abs(STATUS_ORDER.indexOf(item.status) - target) > 1)) {
    throw new Error('请按「待办理 ↔ 进行中 ↔ 已完成」逐步切换，子事项也不能跳级');
  }
  for (const item of branch) item.status = status;
}

export function removeTask(project, id) {
  const ids = new Set([requireTask(project, id).id, ...descendants(project, id).map(task => task.id)]);
  project.tasks = project.tasks.filter(task => !ids.has(task.id));
}

export function moveTask(project, id, options = {}) {
  const original = requireTask(project, id);
  if (options.status !== undefined && options.status !== original.status) {
    throw new Error('拖动不能改变事项状态，请使用状态按钮');
  }
  const parentId = options.parentId === undefined ? original.parentId : options.parentId;
  const branchIds = new Set([id, ...descendants(project, id).map(task => task.id)]);
  if (branchIds.has(parentId)) throw new Error('不能移入自己或自己的子事项');
  if (parentId !== null) requireTask(project, parentId);
  const next = { ...project, tasks: project.tasks.map(task => ({ ...task })) };
  const moving = requireTask(next, id);
  moving.parentId = parentId;
  const siblings = next.tasks.filter(task => task.parentId === parentId && task.id !== id)
    .sort((a, b) => a.order - b.order);
  let index = siblings.length;
  if (options.beforeId !== undefined && options.beforeId !== null) {
    index = siblings.findIndex(task => task.id === options.beforeId);
    if (index === -1) throw new Error('目标位置必须是同层的其他事项');
  }
  siblings.splice(index, 0, moving);
  siblings.forEach((task, order) => { task.order = order; });
  validateState({ version: 1, projects: [next] });
  project.tasks = next.tasks;
}

export function progress(project) {
  const total = project.tasks.length;
  const done = project.tasks.filter(task => task.status === 'done').length;
  return { done, total, percent: total ? Math.round(done / total * 100) : 0 };
}

export function canArchive(project) {
  const { done, total } = progress(project);
  return total > 0 && done === total;
}

export function projectColumn(project, status) {
  if (!STATUSES.has(status)) throw new Error('事项状态不正确');
  const children = new Map();
  for (const task of project.tasks) {
    if (!children.has(task.parentId)) children.set(task.parentId, []);
    children.get(task.parentId).push(task);
  }
  function nodes(parentId) {
    return (children.get(parentId) || []).slice().sort((a, b) => a.order - b.order).flatMap(task => {
      const nested = nodes(task.id);
      return task.status === status || nested.length
        ? [{ task, context: task.status !== status, children: nested }]
        : [];
    });
  }
  return nodes(null);
}

export function createInitialState() {
  const createdAt = new Date().toISOString();
  const task = (id, title, status, order, parentId = null) => ({ id, title, status, order, parentId });
  return {
    version: 1,
    projects: [
      {
        id: 'workspace', name: '个人工作台', createdAt, archivedAt: null,
        summary: '把想法落到每一个小步骤。这个工作台，用来安排本周值得投入的事情。\n\n- **本周目标**：完成桌面待办应用的第一个版本\n- **工作节奏**：一次专注一件事，给重要的事情留一点空间\n\n完成率：$P = \\frac{N_{done}}{N_{total}} \\times 100\\%$。',
        tasks: [
          task('design', '梳理产品体验', 'doing', 0),
          task('layout', '确定项目与看板布局', 'done', 0, 'design'),
          task('interaction', '完善事项交互细节', 'doing', 1, 'design'),
          task('drag', '验证三级事项拖动', 'doing', 0, 'interaction'),
          task('status', '让状态切换更顺手', 'todo', 1, 'interaction'),
          task('notes', '整理本周的灵感与笔记', 'doing', 1),
          task('review', '每周回顾与下周计划', 'todo', 2),
          task('reading', '读完一篇收藏的文章', 'todo', 3),
          task('formula', '记录一个公式：$E = mc^2$', 'todo', 0, 'reading'),
          task('research', '收集同类产品参考', 'done', 4),
          task('scope', '写下第一版的功能范围', 'done', 5),
        ],
      },
      {
        id: 'learning', name: '学习与阅读', summary: '记录那些值得慢慢理解的知识。', createdAt, archivedAt: null,
        tasks: [task('learn-list', '整理阅读清单', 'todo', 0), task('learn-note', '写一页学习笔记', 'todo', 1)],
      },
      {
        id: 'life', name: '生活小事', summary: '给日常留一点秩序，也留一点空白。', createdAt, archivedAt: null,
        tasks: [task('life-desk', '整理书桌', 'done', 0), task('life-walk', '周末去公园走走', 'todo', 1)],
      },
    ],
  };
}
