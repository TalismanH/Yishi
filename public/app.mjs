import {validateState, depthOf, descendants, moveTask, setTaskStatus, removeTask, progress, canArchive, projectColumn} from './model.mjs';

const icons = {
  check:'<path d="m5 12 4 4L19 6"/>', plus:'<path d="M12 5v14M5 12h14"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8m-10 4h6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', down:'<path d="m5 9 7 7 7-7"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3 2.5c-.5.3-.5 1-.5 1.5m0 3h.01"/>',
  leaf:'<path d="M20 4C6 1 1 12 7 17s16 0 13-13ZM5 20 16 9"/>',
  document:'<path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>', pause:'<path d="M9 5v14M15 5v14"/>',
  undo:'<path d="m9 5-6 6 6 6m-6-6h11a7 7 0 0 1 7 7"/>',
  grip:'<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  branch:'<path d="M6 3v10a4 4 0 0 0 4 4h10m-4-4 4 4-4 4"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = {doing:'进行中',todo:'待办理',done:'已完成'};
const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
let state, revision, activeId, view = 'active', saving = false, dirty = false, saveError = '', conflict = false, dragged = null;
let toastTimer;

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
  element.innerHTML = icon(saveError ? 'undo' : 'check') + (saveError ? escape(saveError) : saving || dirty ? '正在保存…' : '已保存到本机');
  element.title = saveError ? '点击重试；也可先导出备份' : '数据仅保存在这台电脑';
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

function change(operation, message) {
  if (conflict) {toast('另一个窗口已修改数据。请导出当前备份，再重新打开。');return false;}
  const before = structuredClone(state);
  try {operation(); validateState(state);} catch (error) {
    state.projects = before.projects.map(saved => Object.assign(projectById(saved.id) ?? {},saved));
    toast(error.message);return false;
  }
  dirty = true;render();void save();if (message) toast(message);return true;
}

const projectById = id => state.projects.find(project => project.id === id);
const visibleProjects = () => state.projects.filter(project => view === 'archived' ? project.archivedAt : !project.archivedAt);
const taskName = task => task.title.split('\n')[0].replace(/[#*`_$]/g,'').slice(0,35);
function actionButton(action, title, name, attributes = '') {
  return `<button type="button" class="icon-button" data-action="${action}" aria-label="${escape(title)}" title="${escape(title)}" ${attributes}>${icon(name)}</button>`;
}

function taskHTML(node, project, columnStatus) {
  const {task,context,children} = node;
  const level = depthOf(project,task.id);
  const readonly = Boolean(project.archivedAt);
  const attrs = `data-project="${escape(project.id)}" data-task="${escape(task.id)}"`;
  return `<div class="task-group" data-task-group="${escape(task.id)}">
    <article class="task-card ${context ? 'context' : ''} ${!context && task.status === 'done' ? 'completed' : ''}" ${attrs} data-column-status="${columnStatus}" draggable="${!readonly && !context}" aria-label="${escape(taskName(task))}，${level}级事项${context ? '，所属父事项' : ''}">
      <div class="task-main">
        ${context ? icon('branch').replace('<svg ','<svg class="context-icon" ') : `<span class="drag-handle" title="拖动事项及其所有子事项">${icon('grip')}</span><button class="task-check ${task.status === 'done' ? 'checked' : ''}" type="button" data-action="complete" ${attrs} aria-label="${task.status === 'done' ? '重新待办' : '完成事项'}：${escape(taskName(task))}" aria-pressed="${task.status === 'done'}" ${readonly ? 'disabled' : ''}>${task.status === 'done' ? icon('check') : ''}</button>`}
        <div class="task-content markdown" ${!readonly ? `role="button" tabindex="0" data-action="edit-task" ${attrs} aria-label="编辑事项：${escape(taskName(task))}"` : ''}>${markdown(task.title)}</div>
      </div>
      ${!context ? `<div class="task-actions"><span class="level-label">${['','主事项','二级事项','子事项'][level]}</span>${!readonly ? `${task.status !== 'doing' ? actionButton('status','开始办理','play',`${attrs} data-status="doing"`) : actionButton('status','移至待办理','pause',`${attrs} data-status="todo"`)}${task.status === 'done' ? actionButton('status','重新待办','undo',`${attrs} data-status="todo"`) : ''}${level < 3 ? actionButton('add-task','添加子事项','plus',`${attrs} data-parent="${escape(task.id)}" data-status="${task.status}"`) : ''}${actionButton('edit-task','编辑 / 调整层级','more',attrs)}` : ''}</div>` : ''}
      ${!readonly && !context && level < 3 ? `<div class="drop-nest" data-nest="${escape(task.id)}">${icon('branch')} 拖到这里，作为子事项</div>` : ''}
    </article>
    ${children.length ? `<div class="task-children">${children.map(child => taskHTML(child,project,columnStatus)).join('')}</div>` : ''}
  </div>`;
}

function projectHTML(project,index) {
  const expanded = activeId === project.id;
  const stats = progress(project);
  const archived = Boolean(project.archivedAt);
  return `<section class="project ${expanded ? 'expanded' : ''}" id="project-${escape(project.id)}">
    <button type="button" class="project-toggle" data-action="toggle" data-project="${escape(project.id)}" aria-expanded="${expanded}" aria-controls="body-${escape(project.id)}">
      ${icon(expanded ? 'down' : 'chevron').replace('<svg ','<svg class="project-chevron" ')}<span class="project-index">${String(index + 1).padStart(2,'0')}</span><span class="project-title">${escape(project.name)}</span>
      <span class="project-meta"><span class="task-total">${stats.total} 个事项</span><span class="mini-progress"><i style="width:${stats.percent}%"></i></span><span>${stats.done} / ${stats.total}</span></span>
    </button>
    ${expanded ? `<div class="project-body" id="body-${escape(project.id)}">
      <div class="project-toolbar"><span>${archived ? `归档于 ${new Date(project.archivedAt).toLocaleDateString('zh-CN')}` : '留一点专注，给真正重要的事。'}</span><div class="tools">${archived ? `<button class="quiet" data-action="restore" data-project="${escape(project.id)}">${icon('undo')} 恢复项目</button>` : `<button class="quiet" data-action="edit-project" data-project="${escape(project.id)}">${icon('edit')} 编辑项目</button><button class="quiet" data-action="add-task" data-project="${escape(project.id)}" data-status="todo">${icon('plus')} 新增事项</button>`}</div></div>
      <section class="overview"><div><div class="overview-label">${icon('document')} 总体情况 ${!archived ? `<button class="quiet" data-action="edit-summary" data-project="${escape(project.id)}">编辑 ${icon('edit')}</button>` : ''}</div><div class="overview-content markdown" ${!archived ? `role="button" tabindex="0" data-action="edit-summary" data-project="${escape(project.id)}" aria-label="编辑总体情况"` : ''}>${project.summary ? markdown(project.summary) : '<p>写下项目目标、想法，或一条简单的计划…</p>'}</div></div><div class="overview-progress"><div class="progress-caption">项目完成度</div><div class="progress-value">${stats.percent}<span>%</span></div><div class="progress-bar"><i style="width:${stats.percent}%"></i></div><div class="progress-detail">${stats.done} / ${stats.total} 个事项已完成</div></div></section>
      <div class="board" data-board="${escape(project.id)}">${Object.entries(statuses).map(([status,label]) => {
        const nodes = projectColumn(project,status);
        const count = project.tasks.filter(task => task.status === status).length;
        return `<section class="column ${status}" data-column="${status}" data-project="${escape(project.id)}" aria-label="${label}"><div class="column-heading"><span class="status-dot"></span>${label}<span class="column-count">${String(count).padStart(2,'0')}</span>${!archived ? actionButton('add-task',`新增${label}事项`,'plus',`data-project="${escape(project.id)}" data-status="${status}"`) : ''}</div><div class="column-items">${nodes.length ? nodes.map(node => taskHTML(node,project,status)).join('') : `<div class="empty-column">${status === 'done' ? '每一小步，都算数。' : status === 'doing' ? '准备好了，就开始吧。' : '给下一步留一点空间。'}</div>`}</div>${!archived ? `<button class="add-task" data-action="add-task" data-project="${escape(project.id)}" data-status="${status}">${icon('plus')} 添加事项</button>` : ''}</section>`;
      }).join('')}</div>
      <div class="board-footer"><span>${icon(archived ? 'lock' : 'grip')} ${archived ? '已归档 · 恢复项目后可继续编辑' : '拖动调整顺序与层级 · 点击文字编辑 · 支持 Markdown / LaTeX'}</span>${!archived ? `<button class="archive-button" data-action="archive" data-project="${escape(project.id)}" title="所有事项完成后可归档">${icon('archive')} 归档此项目</button>` : ''}</div>
    </div>` : ''}
  </section>`;
}

function render() {
  const projects = visibleProjects();
  const activeCount = state.projects.filter(project => !project.archivedAt).length;
  const archiveCount = state.projects.length - activeCount;
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('check')}</div><div>一事<small>YI SHI</small></div></div>
    <nav class="side-nav" aria-label="主要导航"><button class="nav-item ${view === 'active' ? 'selected' : ''}" data-action="view" data-view="active" title="我的工作台">${icon('grid')}<span>我的工作台</span><span class="number">${String(activeCount).padStart(2,'0')}</span></button><button class="nav-item ${view === 'archived' ? 'selected' : ''}" data-action="view" data-view="archived" title="归档项目">${icon('archive')}<span>归档项目</span><span class="number">${String(archiveCount).padStart(2,'0')}</span></button></nav>
    <div class="side-label">${view === 'archived' ? '已归档' : '我的项目'}${view === 'active' ? actionButton('add-project','新建项目','plus') : ''}</div><nav class="side-projects" aria-label="项目导航">${projects.map(project => `<button class="side-project ${activeId === project.id ? 'current' : ''}" data-action="jump" data-project="${escape(project.id)}"><span class="project-dot"></span><span>${escape(project.name)}</span></button>`).join('')}</nav>
    <div class="sidebar-bottom"><button class="nav-item" data-action="help">${icon('help')}<span>使用指南</span></button><button class="nav-item" data-action="export">${icon('download')}<span>导出备份</span></button><div class="local-note"><span></span>本地存储，安心专注<br>少一点纷扰，多一点完成。</div></div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumbs">${icon('grid')}<span>工作空间</span><span>/</span><b>${view === 'archived' ? '归档项目' : '我的工作台'}</b></div><div class="topbar-right"><button class="save-status" data-save-status data-action="retry"></button><div class="avatar" title="本地工作空间">我</div></div></header>
    <div class="workspace"><div class="page-heading"><div><div class="eyebrow">${view === 'archived' ? 'A PLACE FOR WHAT’S DONE' : 'A LITTLE FOCUS, EVERY DAY'}</div><h1>${view === 'archived' ? '完成的事，也值得留存。' : '把想法，一件件完成。'}</h1><p>${view === 'archived' ? '每一份归档，都是认真走过的痕迹。' : '理清思路，专注当下。让每一个小进展都有迹可循。'}</p></div>${view === 'active' ? `<button class="primary" data-action="add-project">${icon('plus')} 新建项目</button>` : `<button class="secondary" data-action="view" data-view="active">${icon('undo')} 返回工作台</button>`}</div>
    <div class="section-label">${view === 'archived' ? '归档项目' : '我的项目'}<span class="count">${String(projects.length).padStart(2,'0')}</span><span class="line"></span><span class="hint">一次一件事，专注一个项目</span></div>
    ${projects.length ? projects.map(projectHTML).join('') : `<div class="empty-view">${icon(view === 'archived' ? 'archive' : 'leaf')}<h2>${view === 'archived' ? '这里，等待一份圆满。' : '从一件小事开始。'}</h2><p>${view === 'archived' ? '项目所有事项完成后，确认归档即可在这里查看。' : '创建你的第一个项目，把想做的事写下来。'}</p>${view === 'active' ? '<button class="primary" data-action="add-project">新建第一个项目</button>' : ''}</div>`}
    <footer class="workspace-footer"><span class="footer-note">${icon('leaf')} 不必一次做完所有事，先做好眼前这一件。</span><span>一事 · 为专注留白</span></footer></div></main></div>`;
  renderMath(app);saveLabel();
}

function closeDialog() {dialog.close();dialog.innerHTML = '';}
function openDialog(title, body, footer, onSubmit) {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<form id="editor-form"><header class="dialog-header"><h2>${escape(title)}</h2>${actionButton('close','关闭窗口','close')}</header><div class="dialog-body">${body}<div class="dialog-error" role="alert"></div></div><footer class="dialog-footer">${footer}</footer></form>`;
  dialog.showModal();
  dialog.querySelector('form').addEventListener('submit',event => {
    event.preventDefault();
    try {onSubmit?.(new FormData(event.currentTarget));} catch (error) {dialog.querySelector('.dialog-error').textContent = error.message;}
  });
}
const cancelButton = '<button type="button" class="secondary" data-action="close">取消</button>';
const saveButton = '<button type="submit" class="primary">保存</button>';
const textField = (label,name,value,maxLength) => `<label class="field"><span>${label}</span><input name="${name}" value="${escape(value)}" maxlength="${maxLength}" required autocomplete="off"></label>`;
function markdownField(value,name = 'content') {
  return `<label class="field"><span>直接使用 Markdown 和公式语法</span><textarea name="${name}" maxlength="${name === 'summary' ? 100000 : 20000}" placeholder="写下内容…&#10;&#10;行内公式：$E = mc^2$&#10;独立公式：$$\\sum_{i=1}^{n} i$$">${escape(value)}</textarea></label><div class="editor-label"><span>实时预览</span><span>Ctrl + Enter 保存 · Esc 取消</span></div><div class="preview markdown" data-preview></div>`;
}
function bindPreview() {
  const textarea = dialog.querySelector('textarea');
  const preview = dialog.querySelector('[data-preview]');
  if (!textarea || !preview) return;
  const update = () => {preview.innerHTML = textarea.value ? markdown(textarea.value) : '<span style="color:#a4ad98">你的内容会显示在这里。</span>';renderMath(preview);};
  textarea.addEventListener('input',update);update();
}

function editProject(project) {
  openDialog(project ? '编辑项目' : '创建一个新项目',textField('项目名称','name',project?.name ?? '',120) + markdownField(project?.summary ?? '', 'summary'),cancelButton + saveButton,form => {
    const name = form.get('name').trim();
    if (!name) throw new Error('给项目起一个名字吧。');
    if (change(() => {
      if (project) {project.name = name;project.summary = form.get('summary');}
      else {const id = crypto.randomUUID();state.projects.push({id,name,summary:form.get('summary'),createdAt:new Date().toISOString(),archivedAt:null,tasks:[]});activeId = id;view = 'active';}
    },project ? '项目已更新' : '新项目已创建')) closeDialog();
  });bindPreview();
}

function editSummary(project) {
  openDialog('编辑总体情况',markdownField(project.summary,'summary'),cancelButton + saveButton,form => {
    if (change(() => {project.summary = form.get('summary');},'总体情况已保存')) closeDialog();
  });bindPreview();
}

function editTask(project, task, parentId = null, status = 'todo') {
  const excluded = task ? new Set([task.id,...descendants(project,task.id).map(child => child.id)]) : new Set();
  const parents = project.tasks.filter(candidate => !excluded.has(candidate.id) && depthOf(project,candidate.id) < 3);
  const selectedParent = task?.parentId ?? parentId;
  const body = `<div class="field-row"><label class="field"><span>事项状态</span><select name="status">${Object.entries(statuses).map(([value,label]) => `<option value="${value}" ${(task?.status ?? status) === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>所属事项 · 自动确定层级</span><select name="parentId"><option value="">独立主事项</option>${parents.map(candidate => `<option value="${escape(candidate.id)}" ${candidate.id === selectedParent ? 'selected' : ''}>${'　'.repeat(depthOf(project,candidate.id)-1)}${escape(taskName(candidate))}</option>`).join('')}</select></label></div>${markdownField(task?.title ?? '')}<p class="dialog-copy">切换状态或移动层级时，会连同当前事项的所有子事项一起处理。</p>`;
  openDialog(task ? '编辑事项' : parentId ? '添加子事项' : '添加事项',body,(task ? `<button type="button" class="danger" data-action="delete-task" data-project="${escape(project.id)}" data-task="${escape(task.id)}">删除事项</button>` : '') + cancelButton + saveButton,form => {
    const title = form.get('content').trim();
    if (!title) throw new Error('先写一点事项内容吧。');
    const newParent = form.get('parentId') || null;
    if (change(() => {
      if (task) {
        const options = {};
        if (newParent !== task.parentId) options.parentId = newParent;
        if (form.get('status') !== task.status) options.status = form.get('status');
        if (Object.keys(options).length) moveTask(project,task.id,options);
        project.tasks.find(candidate => candidate.id === task.id).title = title;
      } else {
        const siblings = project.tasks.filter(candidate => candidate.parentId === newParent);
        project.tasks.push({id:crypto.randomUUID(),parentId:newParent,title,status:form.get('status'),order:Math.max(-1,...siblings.map(candidate => candidate.order)) + 1});
      }
    },task ? '事项已更新' : '事项已添加')) closeDialog();
  });bindPreview();
}

function confirmArchive(project) {
  const stats = progress(project);
  const allowed = canArchive(project);
  openDialog(allowed ? '将这个项目归档？' : '还有事项等待完成',`<p class="dialog-copy">${allowed ? `「${escape(project.name)}」的 ${stats.total} 个事项已全部完成。归档后将移入“归档项目”，你可以随时查看或恢复。` : stats.total ? `「${escape(project.name)}」还有 ${stats.total - stats.done} 个事项未完成。完成所有事项后，即可归档这个项目。` : '这个项目还没有事项。添加并完成事项后，即可归档。'}</p>`,cancelButton + (allowed ? '<button type="submit" class="primary">确认归档</button>' : ''),() => {
    if (!canArchive(project)) throw new Error('请先完成所有事项。');
    if (change(() => {project.archivedAt = new Date().toISOString();activeId = visibleProjects().find(item => item.id !== project.id)?.id ?? null;},'项目已归档，可在左侧「归档项目」查看')) closeDialog();
  });
}

function exportBackup() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));
  const link = document.createElement('a');link.href = url;link.download = `一事-备份-${new Date().toLocaleDateString('sv-SE')}.json`;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);toast('已导出当前全部项目，包括已归档项目');
}

function help() {
  openDialog('让每一步，都井井有条',`<div class="help"><h3>一个项目，一份专注</h3><p>项目纵向排列，点击名称展开；每次只展开一个。完成全部事项后，点击项目右下角“归档此项目”并再次确认。左侧“归档项目”可浏览或恢复。</p><h3>三种状态，随手切换</h3><table><tr><th>操作</th><th>结果</th></tr><tr><td>点击事项前的方框</td><td>完成事项，再次点击恢复待办</td></tr><tr><td>点击 ▶ 开始</td><td>移至进行中</td></tr><tr><td>点击 Ⅱ 暂停</td><td>移至待办理</td></tr><tr><td>拖动到另一列空白区域</td><td>切换状态，保留原有层级</td></tr></table><h3>像整理思路一样整理事项</h3><p>支持主事项 → 二级事项 → 三级子事项。拖动条目上、下边缘进行同级排序；拖到“作为子事项”区域调整所属事项。拖动和切换状态均带上整棵子事项。编辑窗口的“所属事项”也可调整层级。父事项跨列时以虚线展示归属，不重复计数。</p><h3>只写内容，不被工具打断</h3><p>点击事项文字或总体情况进入编辑。支持 <code># 标题</code>、<code>**强调**</code>、列表、引用、代码和表格。行内公式用 <code>$E=mc^2$</code>，独立公式用 <code>$$\\sum_{i=1}^{n}i$$</code>。Ctrl + Enter 保存；Esc 取消。</p><h3>你的数据，留在本机</h3><p>修改后自动保存，无需联网。左侧“导出备份”可保存全部项目；如果保存失败，请重试或先导出再关闭窗口。关闭前请等待右上角显示“已保存到本机”。</p></div>`,`<button type="button" class="primary" data-action="close">知道了</button>`);
}

async function handleAction(element) {
  const action = element.dataset.action;
  const project = projectById(element.dataset.project);
  const task = project?.tasks.find(item => item.id === element.dataset.task);
  if (project?.archivedAt && !['toggle','jump','restore'].includes(action)) return;
  switch (action) {
    case 'close':closeDialog();break;
    case 'toggle':activeId = activeId === project.id ? null : project.id;render();break;
    case 'jump':activeId = project.id;render();document.getElementById(`project-${project.id}`).scrollIntoView({behavior:'smooth',block:'start'});break;
    case 'view':view = element.dataset.view;activeId = visibleProjects()[0]?.id ?? null;render();window.scrollTo(0,0);break;
    case 'add-project':editProject();break;
    case 'edit-project':editProject(project);break;
    case 'edit-summary':editSummary(project);break;
    case 'add-task':editTask(project,null,element.dataset.parent ?? null,element.dataset.status ?? 'todo');break;
    case 'edit-task':editTask(project,task);break;
    case 'complete':change(() => setTaskStatus(project,task.id,task.status === 'done' ? 'todo' : 'done'),task.status === 'done' ? '事项已重新加入待办理' : '又完成了一件事，做得好。');break;
    case 'status':change(() => setTaskStatus(project,task.id,element.dataset.status),`已移至${statuses[element.dataset.status]}`);break;
    case 'archive':confirmArchive(project);break;
    case 'restore':change(() => {project.archivedAt = null;view = 'active';activeId = project.id;},'项目已恢复到工作台');break;
    case 'delete-task':{
      const count = descendants(project,task.id).length;
      openDialog('删除这个事项？',`<p class="dialog-copy">将删除「${escape(taskName(task))}」${count ? `及其 ${count} 个子事项` : ''}。此操作无法撤销。</p>`,cancelButton + '<button type="submit" class="primary">确认删除</button>',() => {if (change(() => removeTask(project,task.id),'事项已删除')) closeDialog();});break;
    }
    case 'help':help();break;
    case 'export':exportBackup();break;
    case 'retry':if (conflict) exportBackup();else void save();break;
  }
}

document.addEventListener('click',event => {
  if (event.target.closest('.markdown a[href]')) return;
  const element = event.target.closest('[data-action]');
  if (element) {event.preventDefault();void handleAction(element);}
});
document.addEventListener('keydown',event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && dialog.open) {event.preventDefault();dialog.querySelector('form').requestSubmit();}
  else if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-action]')) {event.preventDefault();void handleAction(event.target);}
});
dialog.addEventListener('click',event => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect();if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();}});

function clearDropIndicators() {
  app.querySelectorAll('.drag-over,.drop-before,.drop-after,.over').forEach(element => element.classList.remove('drag-over','drop-before','drop-after','over'));
}
document.addEventListener('dragstart',event => {
  const card = event.target.closest('.task-card[draggable="true"]');
  if (!card || dialog.open || conflict) {event.preventDefault();return;}
  dragged = {id:card.dataset.task,projectId:card.dataset.project};
  event.dataTransfer.setData('text/plain',dragged.id);event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');app.classList.add('is-dragging');
});
document.addEventListener('dragover',event => {
  if (!dragged) return;
  const column = event.target.closest('[data-column]');
  if (!column || column.dataset.project !== dragged.projectId) return;
  event.preventDefault();event.dataTransfer.dropEffect = 'move';clearDropIndicators();
  const nest = event.target.closest('[data-nest]');
  const card = event.target.closest('.task-card');
  if (!nest && card?.dataset.task === dragged.id) return;
  if (nest) nest.classList.add('over');
  else if (card && card.dataset.task !== dragged.id) {const rect = card.getBoundingClientRect();card.classList.add(event.clientY < rect.top + rect.height/2 ? 'drop-before' : 'drop-after');}
  else column.classList.add('drag-over');
});
document.addEventListener('drop',event => {
  if (!dragged) return;
  const column = event.target.closest('[data-column]');
  if (!column || column.dataset.project !== dragged.projectId) return;
  event.preventDefault();
  const project = projectById(dragged.projectId);
  const options = {status:column.dataset.column};
  const nest = event.target.closest('[data-nest]');
  const card = event.target.closest('.task-card');
  if (!nest && card?.dataset.task === dragged.id) {
    dragged = null;app.classList.remove('is-dragging');
    app.querySelectorAll('.dragging').forEach(item => item.classList.remove('dragging'));clearDropIndicators();return;
  }
  if (nest) options.parentId = nest.dataset.nest;
  else if (card && card.dataset.task !== dragged.id) {
    const target = project.tasks.find(task => task.id === card.dataset.task);
    options.parentId = target.parentId;
    const rect = card.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height/2) options.beforeId = target.id;
    else {
      const siblings = project.tasks.filter(task => task.parentId === target.parentId && task.id !== dragged.id).sort((a,b) => a.order-b.order);
      options.beforeId = siblings[siblings.findIndex(task => task.id === target.id)+1]?.id;
    }
  }
  const id = dragged.id;dragged = null;app.classList.remove('is-dragging');clearDropIndicators();
  change(() => moveTask(project,id,options),'事项及其子事项已移动');
});
document.addEventListener('dragend',() => {dragged = null;app.classList.remove('is-dragging');app.querySelectorAll('.dragging').forEach(card => card.classList.remove('dragging'));clearDropIndicators();});
window.addEventListener('beforeunload',event => {if (dirty || saving) {event.preventDefault();event.returnValue = '';}});

try {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('暂时无法读取本地数据');
  const data = await response.json();validateState(data.state);
  state = data.state;revision = data.revision;activeId = visibleProjects()[0]?.id ?? null;render();
} catch (error) {
  app.innerHTML = `<div class="empty-view">${icon('document')}<h2>工作台暂时没有打开</h2><p>${escape(error.message)}<br>请确认本地服务正在运行，然后重新打开 start.cmd。原有数据不会被覆盖。</p></div>`;
}
