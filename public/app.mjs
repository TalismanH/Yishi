import {validateState, depthOf, descendants, moveTask, setTaskStatus, removeTask, progress, canArchive, projectColumn} from './model.mjs';

const icons = {
  check:'<path d="m5 12 4 4L19 6"/>', plus:'<path d="M12 5v14M5 12h14"/>',
  archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8m-10 4h6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', down:'<path d="m5 9 7 7 7-7"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>', pause:'<path d="M9 5v14M15 5v14"/>',
  undo:'<path d="m9 5-6 6 6 6m-6-6h11a7 7 0 0 1 7 7"/>',
  grip:'<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  branch:'<path d="M6 3v10a4 4 0 0 0 4 4h10m-4-4 4 4-4 4"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {todo:'待办项',doing:'进行中',done:'已完成'};
const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
let state, revision, activeId, view = 'active', saving = false, dirty = false, saveError = '', conflict = false, dragged = null;
let toastTimer, pendingTimer, ignoreDragClick = false;

// Build Markdown through a strict element/attribute allowlist before inserting it.
function markdown(source) {
  const formulas = [];
  const protectedSource = source.replace(/(```[\s\S]*?```|`[^`\n]+`)|(\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\s)[^$\n]+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g, (match, code, math) => {
    if (code) return code;
    return `YISHIFORMULA${formulas.push(math) - 1}END`;
  });
  const raw = marked.parse(protectedSource, {breaks:true,gfm:true});
  const template = document.createElement('template');
  template.innerHTML = raw;
  const allowed = new Set(['P','BR','STRONG','EM','DEL','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','HR','A','TABLE','THEAD','TBODY','TR','TD','TH']);
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!allowed.has(element.tagName)) {element.replaceWith(document.createTextNode(element.textContent)); continue;}
    const href = element.getAttribute('href');
    for (const attr of [...element.attributes]) element.removeAttribute(attr.name);
    if (element.tagName === 'A' && href && /^https?:\/\//i.test(href)) {
      element.setAttribute('href',href); element.setAttribute('target','_blank'); element.setAttribute('rel','noopener noreferrer');
    }
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) walker.currentNode.textContent = walker.currentNode.textContent.replace(/YISHIFORMULA(\d+)END/g, (_, n) => formulas[n] ?? '');
  return template.innerHTML;
}

function renderMath(root) {
  renderMathInElement(root, {delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false,strict:'ignore',maxExpand:1000});
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'),3500);
}

function saveLabel() {
  const element = document.querySelector('[data-save-status]');
  if (!element) return;
  element.classList.toggle('error', Boolean(saveError));
  element.dataset.state = saveError ? 'error' : saving || dirty ? 'saving' : 'saved';
  element.hidden = !saveError;
  element.innerHTML = saveError ? icon('undo') : '';
  element.title = saveError;
  element.setAttribute('aria-label',saveError || '重试保存');
}

async function save() {
  if (saving || conflict || !dirty) return;
  saving = true; saveError = ''; saveLabel();
  try {
    while (dirty) {
      dirty = false;
      const response = await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,revision})});
      if (response.status === 409) {
        conflict = true;
        throw new Error('数据版本冲突，请先导出备份');
      }
      if (!response.ok) throw new Error('保存失败，点击重试');
      revision = (await response.json()).revision;
    }
  } catch (error) {
    dirty = true; saveError = error.message;
    toast(error.message);
  } finally {saving = false;saveLabel();}
}

function change(operation, rerender = true) {
  if (conflict) {toast('另一个窗口已修改数据。请导出当前备份，再重新打开。');return false;}
  const before = structuredClone(state);
  try {operation(); validateState(state);} catch (error) {
    state.projects = before.projects.map(saved => Object.assign(projectById(saved.id) ?? {},saved));
    toast(error.message);return false;
  }
  dirty = true;if (rerender) render();void save();return true;
}

const projectById = id => state.projects.find(project => project.id === id);
const visibleProjects = () => state.projects.filter(project => view === 'archived' ? project.archivedAt : !project.archivedAt);
const taskName = task => task.title.split('\n')[0].replace(/[#*`_$]/g,'').slice(0,35);
function actionButton(action, title, name, attributes = '') {
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${escape(title)}" title="${escape(title)}" ${attributes}>${icon(name)}</button>`;
}

function editable(type, project, value, taskId = '') {
  const className = type === 'task' ? 'task-content' : type === 'summary' ? 'overview-content' : 'project-name';
  const attrs = `data-project="${escape(project.id)}" ${taskId ? `data-task="${escape(taskId)}"` : ''}`;
  const action = type === 'task' ? 'edit-task' : type === 'summary' ? 'edit-summary' : 'edit-name';
  const label = type === 'task' ? '编辑事项' : type === 'summary' ? '编辑总体情况' : '编辑项目名称';
  return `<div class="${className} ${type !== 'name' ? 'markdown' : ''}" ${!project.archivedAt ? `data-action="${action}" role="button" tabindex="0" aria-label="${label}"` : ''} ${attrs}>${type === 'name' ? escape(value) : markdown(value)}</div>`;
}

function taskHTML(node, project, status) {
  const {task, context, children} = node;
  const level = depthOf(project, task.id), readonly = Boolean(project.archivedAt);
  const attrs = `data-project="${escape(project.id)}" data-task="${escape(task.id)}"`;
  return `<div class="task-group" data-task-group="${escape(task.id)}">
    <article class="task-card ${context ? 'context' : ''} ${task.status === 'done' && !context ? 'completed' : ''}" ${attrs} data-column-status="${status}">
      <div class="task-main">${context ? icon('branch') : `${!readonly ? `<span class="drag-handle" role="button" tabindex="0" aria-label="拖动事项：${escape(taskName(task))}" title="拖动；↑↓调整顺序">${icon('grip')}</span>` : ''}${task.status !== 'todo' ? `<button type="button" class="task-check ${task.status === 'done' ? 'checked' : ''}" data-action="complete" ${attrs} aria-label="${task.status === 'done' ? '恢复进行中' : '完成事项'}" title="${task.status === 'done' ? '恢复进行中' : '完成事项'}" ${readonly ? 'disabled' : ''}>${task.status === 'done' ? icon('check') : ''}</button>` : ''}`}${editable('task',project,task.title,task.id)}</div>
      ${!context && !readonly ? `<div class="task-actions">${task.status === 'todo' ? actionButton('status','开始办理','play',`${attrs} data-status="doing"`) : task.status === 'doing' ? actionButton('status','移回待办','pause',`${attrs} data-status="todo"`) : ''}${level < 3 && task.status !== 'done' ? actionButton('add-task','新增子事项','plus',`${attrs} data-parent="${escape(task.id)}"`) : ''}${task.parentId !== null ? actionButton('outdent','提升一级','branch',attrs) : ''}${actionButton('delete-task','删除事项','close',attrs)}</div>` : ''}
      ${!readonly && !context && level < 3 ? `<div class="drop-nest" data-nest="${escape(task.id)}" aria-label="作为子事项" title="作为子事项">${icon('branch')}</div>` : ''}
    </article>${children.length ? `<div class="task-children">${children.map(child => taskHTML(child,project,status)).join('')}</div>` : ''}
  </div>`;
}

function projectHTML(project) {
  const id = escape(project.id);
  if (activeId !== project.id) return `<section class="project collapsed" id="project-${id}"><button class="project-toggle" data-action="toggle" data-project="${id}" aria-expanded="false" title="${escape(project.name)}">${icon('chevron')}<span class="project-title">${escape(project.name)}</span></button></section>`;
  const stats = progress(project);
  const draft = editing?.newTask && editing.projectId === project.id ? editing.newTask : null;
  const before = draft && project.tasks.find(task => task.id === editing.beforeId);
  const display = draft ? {...project,tasks:[...project.tasks,{...draft,order:before ? before.order - 0.5 : draft.order}]} : project;
  return `<section class="project expanded" id="project-${id}">
    <header class="project-header">${actionButton('toggle','收起项目','down',`data-project="${id}" aria-expanded="true"`)}${editable('name',project,project.name)}<div class="project-tools">${project.archivedAt ? `<button class="plain-button" data-action="restore" data-project="${id}">${icon('undo')} 恢复项目</button>` : actionButton('archive','归档','archive',`data-project="${id}"`)}${actionButton('delete-project','删除项目','trash',`data-project="${id}"`)}</div></header>
    <div class="project-body"><section class="overview"><div class="overview-header"><h2>总体情况</h2><span class="progress-value" aria-label="完成度">${stats.percent}%</span></div>${editable('summary',project,project.summary)}</section>
    <div class="board" data-board="${id}">${Object.entries(statuses).map(([status,label]) => `<section class="column ${status}" data-column="${status}" data-project="${id}" aria-label="${label}"><h2 class="column-heading"><span class="status-dot"></span>${label}</h2><div class="column-items" tabindex="0" role="region" aria-label="${label}列表">${projectColumn(display,status).map(node => taskHTML(node,display,status)).join('')}${!project.archivedAt && status === 'todo' ? `<button class="add-task" data-action="add-task" data-project="${id}" aria-label="新增待办" title="新增待办">${icon('plus')}</button>` : ''}</div></section>`).join('')}</div></div>
  </section>`;
}

function render() {
  const previous = app.querySelector('.project.expanded');
  const body = previous?.querySelector('.project-body');
  const scroll = {top:body?.scrollTop ?? 0,left:body?.scrollLeft ?? 0,strip:app.querySelector('.projects')?.scrollLeft ?? 0,overview:previous?.querySelector('.overview')?.scrollTop ?? 0};
  const columnScroll = new Map([...(previous?.querySelectorAll('.column-items') ?? [])].map(element => [element.parentElement.dataset.column,{top:element.scrollTop,left:element.scrollLeft}]));
  const projects = visibleProjects();
  app.innerHTML = `<div class="shell"><header class="topbar"><strong class="brand">一事</strong><nav aria-label="项目窗口"><button class="nav-item ${view === 'active' ? 'selected' : ''}" data-action="view" data-view="active">项目</button><button class="nav-item ${view === 'archived' ? 'selected' : ''}" data-action="view" data-view="archived">归档</button></nav><div class="topbar-actions"><button class="icon-button save-status" data-save-status data-action="retry"></button>${actionButton('help','帮助','help')}${actionButton('export','导出备份','download')}${view === 'active' ? actionButton('add-project','新建项目','plus') : ''}</div></header><main class="projects" aria-label="${view === 'active' ? '项目' : '归档'}">${projects.map(projectHTML).join('')}</main></div>`;
  renderMath(app);saveLabel();
  const current = app.querySelector('.project.expanded');
  if (previous && previous.id === current?.id) {
    const nextBody = current.querySelector('.project-body');
    nextBody.scrollTop = scroll.top;nextBody.scrollLeft = scroll.left;
    current.querySelector('.overview').scrollTop = scroll.overview;
    current.querySelectorAll('.column-items').forEach(element => {
      const position = columnScroll.get(element.parentElement.dataset.column);
      if (position) {element.scrollTop = position.top;element.scrollLeft = position.left;}
    });
  }
  app.querySelector('.projects').scrollLeft = scroll.strip;
  if (editing?.newTask) mountEditor(app.querySelector(`.task-card[data-task="${CSS.escape(editing.taskId)}"] .task-content`));
}

let editing = null, editTimer;
function fitEditor(input) {
  if (input.tagName === 'TEXTAREA') {input.style.height = '0';input.style.height = `${input.scrollHeight}px`;}
}
function mountEditor(element) {
  editing.element = element;
  const input = document.createElement(editing.type === 'name' ? 'input' : 'textarea');
  input.dataset.inlineEditor = editing.type;
  input.setAttribute('aria-label',editing.type === 'task' ? '事项正文' : editing.type === 'summary' ? '总体情况正文' : '项目名称');
  input.maxLength = editing.type === 'name' ? 120 : editing.type === 'summary' ? 100000 : 20000;
  input.value = editing.value;input.spellcheck = false;
  element.classList.add('editing');element.replaceChildren(input);
  input.focus();input.setSelectionRange(input.value.length,input.value.length);fitEditor(input);
}
function beginEditor(type, project, taskId = null) {
  if (finishEditor() === false) return;
  if (conflict) {toast('数据版本冲突，请先导出备份');return;}
  if (project.archivedAt) return;
  const value = type === 'name' ? project.name : type === 'summary' ? project.summary : project.tasks.find(task => task.id === taskId).title;
  editing = {type,projectId:project.id,taskId,value,newTask:null};
  const root = document.getElementById(`project-${project.id}`);
  mountEditor(root.querySelector(type === 'name' ? '.project-name' : type === 'summary' ? '.overview-content' : `.task-card[data-task="${CSS.escape(taskId)}"]:not(.context) .task-content`));
}
function persistEditor() {
  clearTimeout(editTimer);
  if (!editing) return true;
  const edit = editing, project = projectById(edit.projectId);
  const value = edit.type === 'name' ? edit.value.trim() : edit.value;
  if (!value.trim() && edit.type !== 'summary') return !edit.newTask;
  const task = project.tasks.find(task => task.id === edit.taskId);
  const previous = edit.type === 'name' ? project.name : edit.type === 'summary' ? project.summary : task?.title;
  if (value === previous) return true;
  const okay = change(() => {
    if (edit.type === 'name') project.name = value;
    else if (edit.type === 'summary') project.summary = value;
    else if (edit.newTask) {
      project.tasks.push({...edit.newTask,title:value});
      if (edit.beforeId) moveTask(project,edit.taskId,{beforeId:edit.beforeId});
    } else project.tasks.find(task => task.id === edit.taskId).title = value;
  },false);
  if (okay) edit.newTask = null;
  return okay;
}
function finishEditor() {
  if (!editing) return;
  const edit = editing;
  if (!persistEditor() && edit.value.trim()) return false;
  editing = null;clearTimeout(editTimer);
  if (edit.newTask) {edit.element.closest('.task-group').remove();return;}
  const project = projectById(edit.projectId);
  const value = edit.type === 'name' ? project.name : edit.type === 'summary' ? project.summary : project.tasks.find(task => task.id === edit.taskId)?.title;
  edit.element.classList.remove('editing');edit.element.innerHTML = edit.type === 'name' ? escape(value) : markdown(value ?? '');renderMath(edit.element);
  if (edit.type === 'task') app.querySelectorAll(`.task-card[data-task="${CSS.escape(edit.taskId)}"] .task-content`).forEach(element => {
    if (element !== edit.element) {element.innerHTML = markdown(value ?? '');renderMath(element);}
  });
}
function addTask(project, parentId = null, beforeId = null, value = '') {
  if (finishEditor() === false || conflict) return;
  const siblings = project.tasks.filter(task => task.parentId === parentId);
  const draft = {id:crypto.randomUUID(),parentId,title:value,status:'todo',order:Math.max(-1,...siblings.map(task => task.order))+1};
  editing = {type:'task',projectId:project.id,taskId:draft.id,value,newTask:draft,beforeId};
  render();
}
function reshapeTask(project, taskId, outdent) {
  const draft = editing?.newTask?.id === taskId ? editing.newTask : null;
  const source = draft ? {...project,tasks:[...project.tasks,{...draft,title:'新增事项'}]} : project;
  if (draft && editing.beforeId) moveTask(source,taskId,{beforeId:editing.beforeId});
  const task = source.tasks.find(task => task.id === taskId);
  if (!task) return;
  let parentId;
  if (outdent) {
    if (task.parentId === null) {if (!draft) beginEditor('task',project,taskId);return;}
    parentId = source.tasks.find(item => item.id === task.parentId).parentId;
  } else {
    const siblings = source.tasks.filter(item => item.parentId === task.parentId && item.status === task.status).sort((a,b) => a.order-b.order);
    parentId = siblings[siblings.findIndex(item => item.id === taskId)-1]?.id;
    if (!parentId) {if (!draft) beginEditor('task',project,taskId);return;}
  }
  if (draft) {
    try {
      moveTask(source,taskId,{parentId});
      editing.newTask = {...source.tasks.find(item => item.id === taskId),title:editing.value,order:Math.max(-1,...project.tasks.filter(item => item.parentId === parentId).map(item => item.order))+1};
      editing.beforeId = null;editing.element = null;render();
    } catch (error) {toast(error.message);}
    return;
  }
  change(() => moveTask(project,taskId,{parentId}));
  beginEditor('task',project,taskId);
}

function closeDialog() {dialog.close();dialog.innerHTML = '';}
function showHelp() {
  dialog.innerHTML = `<header class="dialog-header"><h2>帮助</h2>${actionButton('close','关闭','close')}</header><div class="help-content">
    <h3>软件说明</h3><p>每次展开一个项目。点击项目名、总体情况或事项正文直接编辑，离开编辑区后自动保存并渲染。正文支持 Markdown，行内公式用 <code>$...$</code>，独立公式用 <code>$$...$$</code>。</p>
    <p>事项最多三级，状态依次为待办项 ↔ 进行中 ↔ 已完成。使用条目按钮切换状态；左侧把手可调整同列顺序与层级，拖动父事项会携带全部子事项。</p>
    <p>全部事项完成后可归档。归档、删除均需确认；下载按钮可导出全部项目备份。</p>
    <h3>快捷键</h3><table><tbody>
      <tr><th scope="row"><kbd>Enter</kbd></th><td>编辑事项时新增同级事项</td></tr>
      <tr><th scope="row"><kbd>Shift + Enter</kbd></th><td>在当前事项内换行</td></tr>
      <tr><th scope="row"><kbd>Tab</kbd></th><td>降低层级，空白新增项也适用</td></tr>
      <tr><th scope="row"><kbd>Shift + Tab</kbd></th><td>提升层级</td></tr>
      <tr><th scope="row"><kbd>Ctrl + Enter</kbd></th><td>结束编辑并渲染</td></tr>
      <tr><th scope="row"><kbd>Esc</kbd></th><td>结束编辑、取消拖动或关闭弹框</td></tr>
      <tr><th scope="row"><kbd>↑ / ↓</kbd></th><td>先点击事项左侧六点图标，再按上下键排序</td></tr>
      <tr><th scope="row"><kbd>Enter / 空格</kbd></th><td>点击左侧六点图标后，进入正文编辑</td></tr>
    </tbody></table><p>同级指同一列、同一父事项下的条目。只有一个同级条目，或已到首尾时，对应方向不会继续移动。</p></div><footer class="dialog-footer"><button class="primary" data-action="close">关闭</button></footer>`;
  dialog.showModal();
}
function confirmAction(title, body, button, operation) {
  dialog.innerHTML = `<form><header class="dialog-header"><h2>${escape(title)}</h2>${actionButton('close','关闭','close')}</header><p class="dialog-copy">${body}</p><footer class="dialog-footer"><button type="button" class="secondary" data-action="close">取消</button>${button ? `<button type="submit" class="primary">${button}</button>` : ''}</footer></form>`;
  dialog.showModal();dialog.querySelector('form').addEventListener('submit',event => {event.preventDefault();operation();});
}
function exportBackup() {
  const exported = structuredClone(state);
  if (editing) {
    const project = exported.projects.find(project => project.id === editing.projectId);
    if (editing.type === 'summary') project.summary = editing.value;
    else if (editing.value.trim()) {
      if (editing.type === 'name') project.name = editing.value.trim();
      else if (editing.newTask) project.tasks.push({...editing.newTask,title:editing.value});
      else project.tasks.find(task => task.id === editing.taskId).title = editing.value;
    }
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}));
  const link = document.createElement('a');link.href = url;link.download = `一事-备份-${new Date().toLocaleDateString('sv-SE')}.json`;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
}
function revealPendingChildren(project,id) {
  const ids = new Set(descendants(project,id).filter(task => task.status === 'todo').map(task => task.id));
  if (!ids.size) return false;
  const cards = [...app.querySelectorAll('.column.todo .task-card:not(.context)')].filter(card => ids.has(card.dataset.task));
  if (!cards.length) return false;
  clearTimeout(pendingTimer);
  app.querySelectorAll('.pending-attention').forEach(card => card.classList.remove('pending-attention'));
  void app.offsetWidth;
  cards.forEach(card => card.classList.add('pending-attention'));
  cards[0].scrollIntoView({block:'center',inline:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  cards[0].querySelector('.task-content').focus({preventScroll:true});
  pendingTimer = setTimeout(() => cards.forEach(card => card.classList.remove('pending-attention')),2400);
  return true;
}
function handleAction(element) {
  const action = element.dataset.action, project = projectById(element.dataset.project);
  const task = project?.tasks.find(task => task.id === element.dataset.task);
  if (project?.archivedAt && !['toggle','restore','delete-project'].includes(action)) return;
  switch (action) {
    case 'close':closeDialog();break;
    case 'toggle':activeId = activeId === project.id ? null : project.id;render();break;
    case 'view':view = element.dataset.view;activeId = visibleProjects()[0]?.id ?? null;render();break;
    case 'add-project':{
      const id = crypto.randomUUID();
      if (change(() => {state.projects.push({id,name:'新项目',summary:'',archivedAt:null,createdAt:new Date().toISOString(),tasks:[]});view = 'active';activeId = id;})) {
        beginEditor('name',projectById(id));editing.element.querySelector('input').select();
      }break;
    }
    case 'edit-name':beginEditor('name',project);break;
    case 'edit-summary':beginEditor('summary',project);break;
    case 'edit-task':beginEditor('task',project,task.id);break;
    case 'add-task':addTask(project,element.dataset.parent ?? null);break;
    case 'complete':
      if (task.status === 'doing' && revealPendingChildren(project,task.id)) break;
      change(() => setTaskStatus(project,task.id,task.status === 'done' ? 'doing' : 'done'));break;
    case 'status':change(() => setTaskStatus(project,task.id,element.dataset.status));break;
    case 'outdent':reshapeTask(project,task.id,true);break;
    case 'archive':{
      const allowed = canArchive(project);
      confirmAction(allowed ? '归档项目？' : '项目尚未完成',allowed ? `归档「${escape(project.name)}」？` : '请先完成所有事项。',allowed ? '确认归档' : '',() => {
        if (change(() => {if (!canArchive(project)) throw new Error('请先完成所有事项');project.archivedAt = new Date().toISOString();activeId = visibleProjects()[0]?.id ?? null;})) closeDialog();
      });break;
    }
    case 'restore':change(() => {project.archivedAt = null;view = 'active';activeId = project.id;});break;
    case 'delete-project':{
      confirmAction('删除项目？',`删除「${escape(project.name)}」及其 ${project.tasks.length} 个事项？此操作无法撤销。`,'确认删除',() => {
        if (change(() => {state.projects = state.projects.filter(item => item.id !== project.id);activeId = visibleProjects()[0]?.id ?? null;})) closeDialog();
      });break;
    }
    case 'delete-task':{
      const count = descendants(project,task.id).length;
      confirmAction('删除事项？',`删除「${escape(taskName(task))}」${count ? `及其 ${count} 个子事项` : ''}？`,'确认删除',() => {if (change(() => removeTask(project,task.id))) closeDialog();});break;
    }
    case 'help':showHelp();break;
    case 'export':exportBackup();break;
    case 'retry':if (conflict) exportBackup();else void save();break;
  }
}
document.addEventListener('click',event => {
  if (ignoreDragClick) {event.preventDefault();return;}
  if (event.target.closest('[data-inline-editor]') || event.target.closest('.markdown a[href]')) return;
  const element = event.target.closest('[data-action]');
  if (finishEditor() === false && !['export','retry'].includes(element?.dataset.action)) return;
  if (element) {event.preventDefault();handleAction(element);}
});
document.addEventListener('input',event => {
  if (!event.target.matches('[data-inline-editor]') || !editing) return;
  editing.value = event.target.value;fitEditor(event.target);
  clearTimeout(editTimer);editTimer = setTimeout(persistEditor,450);
});
document.addEventListener('focusout',event => {
  if (event.target.matches('[data-inline-editor]') && editing?.element?.contains(event.target)) finishEditor();
});
document.addEventListener('keydown',event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape' && dragged) {event.preventDefault();clearDrag();return;}
  const handle = event.target.closest('.drag-handle');
  if (handle) {
    const card = handle.closest('.task-card'), project = projectById(card.dataset.project), task = project.tasks.find(task => task.id === card.dataset.task);
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();beginEditor('task',project,task.id);return;}
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (finishEditor() === false) return;
      const siblings = project.tasks.filter(item => item.parentId === task.parentId && item.status === task.status).sort((a,b) => a.order-b.order), index = siblings.findIndex(item => item.id === task.id);
      if (event.key === 'ArrowUp' && index === 0 || event.key === 'ArrowDown' && index === siblings.length-1) return;
      change(() => moveTask(project,task.id,{beforeId:event.key === 'ArrowUp' ? siblings[index-1].id : siblings[index+2]?.id}));
      app.querySelector(`.task-card[data-task="${CSS.escape(task.id)}"]:not(.context) .drag-handle`)?.focus();return;
    }
  }
  if (event.target.matches('[data-inline-editor]') && editing) {
    if (event.key === 'Escape' || event.key === 'Enter' && (editing.type === 'name' || event.ctrlKey || event.metaKey)) {event.preventDefault();finishEditor();return;}
    if (editing.type !== 'task') return;
    if (conflict && (event.key === 'Tab' || event.key === 'Enter' && !event.shiftKey)) {event.preventDefault();toast('数据版本冲突，请先导出备份');return;}
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const edit = editing, project = projectById(edit.projectId), cursor = event.target.selectionStart;
      const head = edit.value.slice(0,cursor), tail = edit.value.slice(event.target.selectionEnd);
      const parentId = edit.newTask?.parentId ?? project.tasks.find(task => task.id === edit.taskId)?.parentId ?? null;
      if (!head.trim() && !edit.newTask) {finishEditor();addTask(project,parentId,edit.taskId);return;}
      edit.value = head;finishEditor();
      const siblings = project.tasks.filter(task => task.parentId === parentId).sort((a,b) => a.order-b.order);
      addTask(project,parentId,siblings[siblings.findIndex(task => task.id === edit.taskId)+1]?.id,tail);return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();const edit = editing, project = projectById(edit.projectId);
      if (!edit.newTask || edit.value.trim()) {if (finishEditor() === false) return;}
      reshapeTask(project,edit.taskId,event.shiftKey);return;
    }
  } else if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-action]')) {event.preventDefault();handleAction(event.target);}
});
function clearDropIndicators() {
  app.querySelectorAll('.drag-over,.drop-before,.drop-after,.over').forEach(element => element.classList.remove('drag-over','drop-before','drop-after','over'));
}
function clearDrag() {
  const previous = dragged;dragged = null;
  if (previous?.frame) cancelAnimationFrame(previous.frame);
  if (previous?.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
  app.classList.remove('is-dragging');
  app.querySelectorAll('.dragging,.drag-blocked').forEach(element => element.classList.remove('dragging','drag-blocked'));
  clearDropIndicators();
}
function dragTarget(x,y) {
  const target = document.elementFromPoint(x,y);
  const column = target?.closest('[data-column]');
  if (!dragged || column?.dataset.project !== dragged.projectId || column.dataset.column !== dragged.status) return null;
  const group = target.closest('[data-task-group]');
  if (group && dragged.blockedIds.has(group.dataset.taskGroup)) return null;
  const nest = target.closest('[data-nest]'), card = target.closest('.task-card');
  if (card?.dataset.task === dragged.id) return null;
  if (nest) return {element:nest,kind:'over',options:{parentId:nest.dataset.nest}};
  if (!card) return {element:column,kind:'drag-over',options:{}};
  const project = projectById(dragged.projectId), task = project.tasks.find(task => task.id === card.dataset.task);
  const rect = card.getBoundingClientRect();
  const before = y < rect.top + rect.height/2;
  const siblings = project.tasks.filter(item => item.parentId === task.parentId && item.id !== dragged.id).sort((a,b) => a.order-b.order);
  return {element:card,kind:before ? 'drop-before' : 'drop-after',options:{parentId:task.parentId,beforeId:before ? task.id : siblings[siblings.findIndex(item => item.id === task.id)+1]?.id}};
}
function updateDragTarget() {
  clearDropIndicators();
  const target = dragTarget(dragged.x,dragged.y);
  target?.element.classList.add(target.kind);
}
function scrollDrag() {
  if (!dragged?.active) return;
  const body = dragged.handle.closest('.column-items'), rect = body.getBoundingClientRect();
  if (dragged.x >= rect.left && dragged.x <= rect.right) body.scrollTop += dragged.y < rect.top+28 ? -12 : dragged.y > rect.bottom-28 ? 12 : 0;
  const projects = app.querySelector('.projects'), bounds = projects.getBoundingClientRect();
  projects.scrollLeft += dragged.x < bounds.left+24 ? -12 : dragged.x > bounds.right-24 ? 12 : 0;
  updateDragTarget();dragged.frame = requestAnimationFrame(scrollDrag);
}
document.addEventListener('pointerdown',event => {
  const handle = event.target.closest('.drag-handle');
  if (!handle || event.button !== 0 || !event.isPrimary || dialog.open || conflict) return;
  event.preventDefault();
  if (finishEditor() === false || !handle.isConnected) return;
  handle.focus({preventScroll:true});
  const card = handle.closest('.task-card');
  const blockedIds = new Set([card.dataset.task,...descendants(projectById(card.dataset.project),card.dataset.task).map(task => task.id)]);
  dragged = {id:card.dataset.task,projectId:card.dataset.project,status:card.dataset.columnStatus,blockedIds,handle,pointerId:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,active:false};
  app.querySelectorAll('.task-card').forEach(element => {if (blockedIds.has(element.dataset.task)) element.classList.add('drag-blocked');});
  handle.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove',event => {
  if (!dragged || event.pointerId !== dragged.pointerId) return;
  dragged.x = event.clientX;dragged.y = event.clientY;
  if (!dragged.active && Math.hypot(dragged.x-dragged.startX,dragged.y-dragged.startY) < 5) return;
  event.preventDefault();
  if (!dragged.active) {
    dragged.active = true;dragged.handle.closest('.task-card').classList.add('dragging');app.classList.add('is-dragging');scrollDrag();
  }
  updateDragTarget();
});
document.addEventListener('pointerup',event => {
  if (!dragged || event.pointerId !== dragged.pointerId) return;
  const {id,projectId,active} = dragged;
  const target = active ? dragTarget(event.clientX,event.clientY) : null;
  clearDrag();
  if (!active) return;
  event.preventDefault();ignoreDragClick = true;setTimeout(() => {ignoreDragClick = false;},0);
  if (target) change(() => moveTask(projectById(projectId),id,target.options));
});
for (const name of ['pointercancel','lostpointercapture']) document.addEventListener(name,event => {if (event.pointerId === dragged?.pointerId) clearDrag();});
window.addEventListener('blur',clearDrag);
window.addEventListener('beforeunload',event => {persistEditor();if (dirty || saving) {event.preventDefault();event.returnValue = '';}});
try {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('无法读取本地数据');
  const data = await response.json();validateState(data.state);
  state = data.state;revision = data.revision;activeId = visibleProjects()[0]?.id ?? null;render();
} catch (error) {
  app.innerHTML = `<div class="load-error" role="alert">${escape(error.message)}</div>`;
}
