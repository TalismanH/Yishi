// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-ui-'));
const server = await createTodoServer({dataDir});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror',error => errors.push(error.message));
page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function saved() {await page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});}
async function snapshot() {return (await (await fetch(`${origin}/api/state`)).json()).state;}
const editor = () => page.locator('[data-inline-editor]');
const card = id => page.locator(`.task-card[data-task="${id}"]:not(.context)`);
async function finish(content) {
  if (content !== undefined) await editor().fill(content);
  await editor().press('Control+Enter');
  await page.waitForFunction(() => !document.querySelector('[data-inline-editor]'));await saved();
}
async function drag(source,target,ratio = .1,surface = page) {
  const handle = surface.locator(source).first().locator('.drag-handle');
  await handle.scrollIntoViewIfNeeded();
  if (!target.includes('data-nest')) await surface.locator(target).first().scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  await surface.mouse.move(start.x + start.width/2,start.y + start.height/2);
  await surface.mouse.down();
  await surface.mouse.move(start.x + start.width/2 + 8,start.y + start.height/2,{steps:2});
  const box = await surface.locator(target).first().boundingBox();
  await surface.mouse.move(box.x + Math.min(25,box.width/2),box.y + box.height*ratio,{steps:8});
  await surface.mouse.up();
  await surface.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
}

try {
  await page.goto(origin);await saved();
  assert.equal((await page.locator('nav [data-action="view"][data-view="archived"]').textContent()).trim(),'归档');
  assert.equal((await page.locator('.project-header [data-action="archive"]').textContent()).trim(),'');
  assert.equal((await page.locator('.topbar [data-action="add-project"]').textContent()).trim(),'');
  assert.equal(await page.locator('.topbar [data-action="add-project"]').getAttribute('aria-label'),'新建项目');
  assert.equal(await page.locator('.topbar [data-action="add-project"]').getAttribute('title'),'新建项目');
  assert.equal(await page.locator('[data-save-status]').isVisible(),false);
  passed('导航仅显示归档，归档和新建项目为图标，正常保存状态不占用界面');
  assert.deepEqual(await page.locator('.column').evaluateAll(columns => columns.map(column => column.dataset.column)),['todo','doing','done']);
  assert.equal((await page.locator('.column.todo .column-heading').textContent()).trim(),'待办项');
  assert.equal(await page.locator('.column.done [data-action="add-task"]').count(),0);
  passed('列顺序为待办项、进行中、已完成，已完成事项没有新增按钮');
  assert.equal(await page.locator('.project.expanded').count(),1);
  const rails = await page.locator('.project.collapsed').evaluateAll(elements => elements.map(element => ({
    width:element.getBoundingClientRect().width,top:element.getBoundingClientRect().top,height:element.getBoundingClientRect().height,
    writingMode:getComputedStyle(element.querySelector('.project-title')).writingMode,
  })));
  assert.equal(rails.length,2);
  assert.ok(rails.every(rail => rail.width <= 80 && rail.height > 500 && rail.writingMode === 'vertical-rl'));
  assert.equal(rails[0].top,rails[1].top);
  assert.equal(await page.locator('.katex').count(),2);
  passed('项目折叠为全高竖排窄栏，展开区保留三列和公式');

  assert.equal(await page.locator('.sidebar,.page-heading,.eyebrow,.local-note,.level-label,.board-footer,.workspace-footer,.editor-label').count(),0);
  assert.equal(await page.getByText('把想法，一件件完成。',{exact:true}).count(),0);
  assert.equal((await page.locator('[data-save-status]').textContent()).trim(),'');
  passed('删除标语、备注、重复导航与编辑说明，保存状态仅保留图标');

  await page.locator('[data-action="toggle"][data-project="learning"]').click();
  assert.equal(await page.locator('.project.expanded').count(),1);
  assert.equal(await page.locator('.project.expanded').getAttribute('id'),'project-learning');
  await page.locator('[data-action="toggle"][data-project="workspace"]').click();
  passed('切换竖排项目始终只展开一个');

  await page.locator('[data-action="edit-summary"]').first().click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await editor().fill('## 测试总览\n\n**Markdown** 与 $\\frac{a_1}{b^2}$\n\n$$\\sum_{i=1}^{n} i$$\n\n<script>window.bad=true</script>\n<a href="javascript:alert(1)" onclick="window.bad=true">不安全链接</a>');
  await page.locator('.column-heading').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-inline-editor]'));await saved();
  assert.ok(await page.locator('.overview .katex').count() >= 2);
  assert.equal(await page.locator('.overview script,.overview [onclick],.overview a[href^="javascript:"]').count(),0);
  assert.equal(await page.evaluate(() => Boolean(window.bad)),false);
  passed('总体情况原位编辑、失焦后渲染 Markdown/公式并过滤危险 HTML');

  assert.equal(await page.locator('.column.todo .task-check').count(),0);
  assert.equal(await page.locator('.column.done [data-action="status"][data-status="todo"]').count(),0);
  assert.equal(await page.locator('.column.doing .add-task,.column.done .add-task').count(),0);
  let before = (await snapshot()).projects[0];
  await card('design').locator('[data-action="complete"]').click();await saved();
  assert.deepEqual((await snapshot()).projects[0],before);
  passed('待办没有完成框，且父事项不能让待办子事项跳过进行中');

  await card('reading').locator('[data-action="status"][data-status="doing"]').click();await saved();
  let project = (await snapshot()).projects[0];
  assert.equal(project.tasks.find(task => task.id === 'reading').status,'doing');
  assert.equal(project.tasks.find(task => task.id === 'formula').status,'doing');
  await card('reading').locator('[data-action="complete"]').click();await saved();
  assert.equal((await snapshot()).projects[0].tasks.find(task => task.id === 'reading').status,'done');
  await card('reading').locator('[data-action="complete"]').click();await saved();
  assert.equal((await snapshot()).projects[0].tasks.find(task => task.id === 'reading').status,'doing');
  await card('reading').locator('[data-action="status"][data-status="todo"]').click();await saved();
  assert.equal((await snapshot()).projects[0].tasks.find(task => task.id === 'formula').status,'todo');
  passed('快捷操作严格遵守待办 → 进行中 → 已完成及反向逐级切换');

  before = (await snapshot()).projects[0];
  await drag('.task-card[data-task="interaction"]:not(.context)','.column[data-column="done"] .column-heading');
  assert.deepEqual((await snapshot()).projects[0],before);
  await drag('.task-card[data-task="reading"]:not(.context)','.column.doing .column-heading');
  assert.deepEqual((await snapshot()).projects[0],before);
  passed('真实指针跨状态拖动被拒绝，不改变状态、层级或顺序');

  await drag('.task-card[data-task="reading"]:not(.context)','.task-card[data-task="review"]:not(.context)');
  project = (await snapshot()).projects[0];
  assert.ok(project.tasks.find(task => task.id === 'reading').order < project.tasks.find(task => task.id === 'review').order);
  before = structuredClone(project.tasks.map(({id,status}) => ({id,status})));
  await drag('.task-card[data-task="review"]:not(.context)','[data-nest="reading"]');
  project = (await snapshot()).projects[0];
  assert.equal(project.tasks.find(task => task.id === 'review').parentId,'reading');
  assert.deepEqual(project.tasks.map(({id,status}) => ({id,status})),before);
  passed('同列拖动可排序或调整层级，始终保留每个事项的状态');

  const readingOrder = project.tasks.find(task => task.id === 'reading').order;
  await card('reading').locator('.task-content').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await finish('**阅读记录** $a_1^2$');
  project = (await snapshot()).projects[0];
  assert.equal(project.tasks.find(task => task.id === 'reading').order,readingOrder);
  assert.equal(await card('reading').locator('.katex').count(),1);
  passed('已有事项直接原位修改并渲染，编辑正文不改变排序');

  await page.locator('[data-action="archive"]').click();
  assert.equal(await page.locator('dialog button[type="submit"]').count(),0);
  await page.locator('dialog [data-action="close"]').last().click();
  passed('未完成项目不能归档');

  await page.locator('[data-action="add-project"]').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await finish('验收项目');
  let created = (await snapshot()).projects.find(item => item.name === '验收项目');
  assert.ok(created);
  const projectId = created.id;
  const currentProject = async () => (await snapshot()).projects.find(item => item.id === projectId);
  passed('新增项目直接在标题处输入，不弹窗');

  await page.locator('.column.todo .add-task').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await editor().fill('验收主事项');await editor().press('Enter');
  await editor().fill('验收二级事项');await editor().press('Tab');
  await editor().press('Enter');
  await editor().fill('验收三级事项');await editor().press('Tab');
  await saved();
  const beforeComposition = (await currentProject()).tasks.length;
  await editor().dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});
  assert.equal(await editor().count(),1);
  assert.equal((await currentProject()).tasks.length,beforeComposition);
  await editor().press('Shift+Enter');await editor().pressSequentially('$E=mc^2$');await finish();
  created = await currentProject();
  const root = created.tasks.find(task => task.parentId === null).id;
  const second = created.tasks.find(task => task.parentId === root).id;
  const third = created.tasks.find(task => task.parentId === second).id;
  assert.equal(created.tasks.length,3);
  assert.ok(created.tasks.every(task => task.status === 'todo'));
  assert.match(created.tasks.find(task => task.id === third).title,/\n\$E=mc\^2\$/);
  assert.equal(await card(third).locator('.katex').count(),1);
  assert.equal(await card(third).locator('[data-action="add-task"]').count(),0);
  passed('Enter 连续输入，Tab 创建三级层次，Shift+Enter 换行；中文组合输入不拆分事项');

  const beforeBlankIndent = await currentProject();
  const blankParent = () => editor().evaluate(element => element.closest('.task-group').parentElement.closest('.task-group')?.dataset.taskGroup ?? null);
  await page.locator('.column.todo .add-task').click();
  await editor().press('Shift+Tab');
  assert.equal(await blankParent(),null);
  await editor().press('Tab');
  assert.equal(await blankParent(),root);
  await editor().press('Tab');
  assert.equal(await blankParent(),second);
  await editor().press('Tab');
  assert.equal(await editor().count(),1);
  assert.equal(await blankParent(),second);
  await editor().press('Shift+Tab');
  assert.equal(await blankParent(),root);
  await editor().press('Shift+Tab');
  assert.equal(await blankParent(),null);
  assert.deepEqual(await currentProject(),beforeBlankIndent);
  await editor().press('Tab');await editor().press('Tab');await finish('先缩进再输入的三级事项');
  const blankIndented = (await currentProject()).tasks.find(task => task.title === '先缩进再输入的三级事项');
  assert.equal(blankIndented.parentId,second);
  assert.equal((await currentProject()).tasks.length,beforeBlankIndent.tasks.length+1);
  await card(blankIndented.id).locator('[data-action="delete-task"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();
  passed('空白事项可先缩进或提升再输入，最多三级，期间不持久化空白条目');

  await card(third).locator('.task-content').click();await editor().press('Shift+Tab');await finish();
  assert.equal((await currentProject()).tasks.find(task => task.id === third).parentId,root);
  await card(third).locator('.task-content').click();await editor().press('Tab');await finish();
  assert.equal((await currentProject()).tasks.find(task => task.id === third).parentId,second);
  passed('Shift+Tab 提升层级，Tab 可恢复原有三级结构');

  await card(third).locator('.task-content').click();await editor().press('Enter');
  await editor().fill('不能成为第四级');await editor().press('Tab');await finish();
  created = await currentProject();
  const fourth = created.tasks.find(task => task.title === '不能成为第四级');
  assert.ok(fourth);assert.equal(fourth.parentId,second);
  await card(fourth.id).locator('[data-action="delete-task"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();
  passed('第四级缩进被拒绝，删除仍需确认');

  const taskCount = (await currentProject()).tasks.length;
  await page.locator('.column.todo .add-task').click();
  await page.locator('.column-heading').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-inline-editor]'));await saved();
  assert.equal((await currentProject()).tasks.length,taskCount);
  passed('空白新增事项在失焦后丢弃，不污染已保存的数据');

  await card(second).locator('[data-action="add-task"]').click();await finish('另一个三级事项');
  const thirdB = (await currentProject()).tasks.find(task => task.title === '另一个三级事项').id;
  await drag(`.task-card[data-task="${thirdB}"]:not(.context)`,`.task-card[data-task="${third}"]:not(.context)`);
  created = await currentProject();
  assert.equal(created.tasks.find(task => task.id === thirdB).parentId,second);
  assert.ok(created.tasks.find(task => task.id === thirdB).order < created.tasks.find(task => task.id === third).order);
  passed('非首个三级事项可从拖动手柄调整同级顺序');

  const beforeKeyboard = await currentProject();
  await card(thirdB).locator('.drag-handle').focus();
  await page.keyboard.press('ArrowDown');await saved();
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === thirdB).order > created.tasks.find(task => task.id === third).order);
  assert.deepEqual(created.tasks.map(({id,parentId,status}) => ({id,parentId,status})),beforeKeyboard.tasks.map(({id,parentId,status}) => ({id,parentId,status})));
  await page.keyboard.press('ArrowUp');await saved();
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === thirdB).order < created.tasks.find(task => task.id === third).order);
  assert.deepEqual(created.tasks.map(({id,parentId,status}) => ({id,parentId,status})),beforeKeyboard.tasks.map(({id,parentId,status}) => ({id,parentId,status})));
  passed('三级拖动手柄支持键盘上下排序，不改变所属事项或状态');

  const beforeCancelDrag = await currentProject();
  const cancelStart = await card(thirdB).locator('.drag-handle').boundingBox();
  await page.mouse.move(cancelStart.x + cancelStart.width/2,cancelStart.y + cancelStart.height/2);
  await page.mouse.down();
  await page.mouse.move(cancelStart.x + cancelStart.width/2 + 8,cancelStart.y + cancelStart.height/2,{steps:2});
  const cancelTarget = await card(third).boundingBox();
  await page.mouse.move(cancelTarget.x + 25,cancelTarget.y + cancelTarget.height*.9,{steps:5});
  assert.equal(await page.locator('.is-dragging').count(),1);
  await page.keyboard.press('Escape');await page.mouse.up();await saved();
  assert.deepEqual(await currentProject(),beforeCancelDrag);
  assert.equal(await page.locator('.is-dragging,.dragging,.drop-before,.drop-after,.over').count(),0);
  await drag(`.task-card[data-task="${thirdB}"]:not(.context)`,`.task-card[data-task="${third}"]:not(.context)`,.9);
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === thirdB).order > created.tasks.find(task => task.id === third).order);
  assert.equal(await page.locator('.is-dragging').count(),0);
  passed('Esc 取消活动拖动不修改数据，清理指示后仍可正常再次拖动');

  await card(root).locator('[data-action="add-task"]').click();await finish('第二个二级事项');
  const secondB = (await currentProject()).tasks.find(task => task.title === '第二个二级事项').id;
  await card(secondB).locator('[data-action="add-task"]').click();await finish('另一个分支的三级事项');
  const thirdC = (await currentProject()).tasks.find(task => task.title === '另一个分支的三级事项').id;
  await drag(`.task-card[data-task="${secondB}"]:not(.context)`,`.task-card[data-task="${second}"]:not(.context)`);
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === secondB).order < created.tasks.find(task => task.id === second).order);
  assert.equal(created.tasks.find(task => task.id === thirdC).parentId,secondB);
  await drag(`.task-card[data-task="${thirdB}"]:not(.context)`,`[data-nest="${secondB}"]`,.5);
  assert.equal((await currentProject()).tasks.find(task => task.id === thirdB).parentId,secondB);
  passed('非首个二级事项拖动携带子树，三级事项可调整所属分支');

  await page.locator('.column.todo .add-task').click();await finish('第二个主事项');
  const rootB = (await currentProject()).tasks.find(task => task.title === '第二个主事项').id;
  await card(rootB).locator('[data-action="add-task"]').click();await finish('第二个主事项的子事项');
  const rootBChild = (await currentProject()).tasks.find(task => task.title === '第二个主事项的子事项').id;
  await drag(`.task-card[data-task="${rootB}"]:not(.context)`,`.task-card[data-task="${root}"]:not(.context)`);
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === rootB).order < created.tasks.find(task => task.id === root).order);
  assert.equal(created.tasks.find(task => task.id === rootBChild).parentId,rootB);
  assert.ok(created.tasks.every(task => task.status === 'todo'));
  passed('非首个一级事项可拖动，并保留所有子事项与状态');

  await card(thirdB).locator('.task-content').click();
  await editor().fill('拖动前正在编辑的三级正文');
  await drag(`.task-card[data-task="${thirdB}"]:not(.context)`,`.task-card[data-task="${thirdC}"]:not(.context)`);
  created = await currentProject();
  assert.equal(created.tasks.find(task => task.id === thirdB).title,'拖动前正在编辑的三级正文');
  assert.ok(created.tasks.find(task => task.id === thirdB).order < created.tasks.find(task => task.id === thirdC).order);
  assert.equal(await editor().count(),0);
  passed('三级正文编辑中可直接拖动手柄，先保存编辑且拖动后不误开编辑器');

  for (const id of [rootB,secondB]) {
    await card(id).locator('[data-action="delete-task"]').click();
    await page.locator('dialog button[type="submit"]').click();await saved();
  }
  assert.equal((await currentProject()).tasks.length,3);
  const beforeCancelProject = await currentProject();
  await page.locator('[data-action="delete-project"]').click();
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.deepEqual(await currentProject(),beforeCancelProject);
  await page.locator('dialog .secondary[data-action="close"]').click();
  assert.deepEqual(await currentProject(),beforeCancelProject);
  passed('项目删除必须二次确认，取消后项目及全部事项保持原样');

  await card(root).locator('[data-action="status"][data-status="doing"]').click();await saved();
  await card(root).locator('[data-action="complete"]').click();await saved();
  await page.locator('[data-action="archive"]').click();
  await page.locator('dialog .secondary[data-action="close"]').click();
  assert.equal((await currentProject()).archivedAt,null);
  await page.locator('[data-action="archive"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();
  assert.ok((await currentProject()).archivedAt);
  await page.locator('[data-action="view"][data-view="archived"]').click();
  assert.equal(await page.locator('.project.expanded .task-card').count(),3);
  assert.equal(await page.locator('.drag-handle,.task-content[data-action="edit-task"]').count(),0);
  await page.reload();await saved();
  await page.locator('[data-action="view"][data-view="archived"]').click();
  assert.ok(await page.locator('.project-name').filter({hasText:'验收项目'}).count());
  await page.locator('[data-action="restore"]').click();await saved();
  assert.equal((await currentProject()).archivedAt,null);
  passed('归档取消、二次确认、只读浏览、重开保留和恢复完整通过');

  await page.locator('[data-action="add-project"]').click();await finish('删除验收');
  const deleteId = (await snapshot()).projects.find(item => item.name === '删除验收').id;
  await page.locator('.column.todo .add-task').click();await finish('随项目删除的事项');
  const beforeDelete = await snapshot();
  await page.locator('[data-action="delete-project"]').click();
  assert.deepEqual(await snapshot(),beforeDelete);
  await page.locator('dialog button[type="submit"]').click();await saved();
  assert.deepEqual((await snapshot()).projects,beforeDelete.projects.filter(item => item.id !== deleteId));
  await page.reload();await saved();
  assert.equal((await snapshot()).projects.some(item => item.id === deleteId),false);
  passed('确认删除只移除指定项目及其全部事项，重开后仍保持删除');

  await page.locator('[data-action="add-project"]').click();await finish('归档删除验收');
  const archiveDeleteId = (await snapshot()).projects.find(item => item.name === '归档删除验收').id;
  await page.locator('.column.todo .add-task').click();await finish('归档后删除的事项');
  const archiveDeleteTask = (await snapshot()).projects.find(item => item.id === archiveDeleteId).tasks[0].id;
  await card(archiveDeleteTask).locator('[data-action="status"][data-status="doing"]').click();await saved();
  await card(archiveDeleteTask).locator('[data-action="complete"]').click();await saved();
  assert.equal(await page.locator('.column.done [data-action="add-task"]').count(),0);
  await page.locator('[data-action="archive"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();
  await page.locator('[data-action="view"][data-view="archived"]').click();
  await page.locator('[data-action="delete-project"]').click();
  assert.ok((await snapshot()).projects.some(item => item.id === archiveDeleteId));
  await page.locator('dialog button[type="submit"]').click();await saved();
  assert.equal((await snapshot()).projects.some(item => item.id === archiveDeleteId),false);
  assert.equal(await page.locator('.project').count(),0);
  await page.locator('[data-action="view"][data-view="active"]').click();
  await page.locator(`[data-action="toggle"][data-project="${projectId}"]`).click();
  passed('已归档项目也可二次确认删除，已完成条目始终没有新增按钮');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export"]').click();
  assert.match((await downloadPromise).suggestedFilename(),/一事-备份-.*\.json/);
  passed('全部项目仍可导出 JSON 备份');

  await card(root).locator('[data-action="complete"]').click();await saved();
  await page.route('**/api/state',route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"disk unavailable"}'}),{times:1});
  await card(root).locator('[data-action="complete"]').click();
  await page.locator('[data-save-status][data-state="error"]').waitFor();
  assert.equal((await currentProject()).tasks.find(task => task.id === root).status,'doing');
  assert.equal(await page.locator(`.column.done .task-card[data-task="${root}"]`).count(),1);
  await page.locator('[data-save-status]').click();await saved();
  assert.equal((await currentProject()).tasks.find(task => task.id === root).status,'done');
  const expectedError = errors.findIndex(message => message.includes('503'));
  assert.ok(expectedError >= 0);errors.splice(expectedError,1);
  passed('保存失败时保留内容，重试后完整写入');

  let releaseSave, saveStarted;
  const gate = new Promise(resolve => {releaseSave = resolve;});
  const started = new Promise(resolve => {saveStarted = resolve;});
  await page.route('**/api/state',async route => {saveStarted();await gate;await route.continue();},{times:1});
  await card(root).locator('[data-action="complete"]').click();await started;
  await card(third).locator('[data-action="complete"]').click();
  releaseSave();await saved();created = await currentProject();
  assert.equal(created.tasks.find(task => task.id === root).status,'doing');
  assert.equal(created.tasks.find(task => task.id === third).status,'done');
  passed('连续操作在前次保存等待期间也不会丢失最后的修改');

  const exactMarkdown = '    indented code\n\ntext  \nnext';
  await card(third).locator('.task-content').click();await finish(exactMarkdown);
  assert.equal((await currentProject()).tasks.find(task => task.id === third).title,exactMarkdown);
  assert.equal(await card(third).locator('pre code').count(),1);
  passed('Markdown 首行缩进与行尾双空格按原文保存并正确渲染');

  await card(third).locator('.task-content').click();
  const remote = await (await fetch(`${origin}/api/state`)).json();
  const advanced = await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(remote)});
  assert.equal(advanced.status,200);
  await editor().fill('发生冲突时的原位内容');
  await page.locator('[data-save-status][data-state="error"]').waitFor();
  await editor().fill('发生冲突后继续输入的最新内容 $x^2$');
  const conflictDownload = page.waitForEvent('download');
  await page.locator('[data-action="export"]').click();
  const exported = JSON.parse(await readFile(await (await conflictDownload).path(),'utf8'));
  assert.equal(exported.projects.find(item => item.id === projectId).tasks.find(task => task.id === third).title,'发生冲突后继续输入的最新内容 $x^2$');
  assert.equal(await editor().inputValue(),'发生冲突后继续输入的最新内容 $x^2$');
  assert.equal((await currentProject()).tasks.find(task => task.id === third).title,exactMarkdown);
  const expectedConflict = errors.findIndex(message => message.includes('409'));
  assert.ok(expectedConflict >= 0);errors.splice(expectedConflict,1);
  passed('版本冲突保留原位输入，备份包含冲突后继续输入的最新内容');

  await page.setViewportSize({width:760,height:900});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('.project.expanded').count(),1);
  passed('窄窗口保持单项目展开，页面无横向溢出');
  assert.deepEqual(errors,[]);
  passed('浏览器没有脚本错误、资源错误或 CSP 违规');

  const lastSnapshot = await (await fetch(`${origin}/api/state`)).json();
  lastSnapshot.state.projects = [lastSnapshot.state.projects[0]];
  const replace = await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(lastSnapshot)});
  assert.equal(replace.status,200);
  const lastPage = await browser.newPage({viewport:{width:1440,height:1000}});
  lastPage.on('pageerror',error => errors.push(error.message));
  await lastPage.goto(origin);
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await lastPage.locator('[data-action="delete-project"]').click();
  await lastPage.locator('dialog button[type="submit"]').click();
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  assert.equal((await snapshot()).projects.length,0);
  assert.equal(await lastPage.locator('.project').count(),0);
  await lastPage.locator('[data-action="add-project"]').click();
  await lastPage.locator('[data-inline-editor]').fill('重新开始');
  await lastPage.locator('[data-inline-editor]').press('Control+Enter');
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  assert.equal((await snapshot()).projects[0].name,'重新开始');
  assert.deepEqual(errors,[]);
  passed('删除最后一个项目后可从空工作台重新创建项目');

  const scrollFixture = await (await fetch(`${origin}/api/state`)).json();
  const createdAt = new Date().toISOString();
  scrollFixture.state.projects = [{id:'scroll-project',name:'长项目',summary:'滚动位置测试',createdAt,archivedAt:null,tasks:Array.from({length:55},(_,index) => ({id:`scroll-task-${index}`,parentId:null,title:`滚动事项 ${index}`,status:'todo',order:index}))},...Array.from({length:18},(_,index) => ({id:`scroll-rail-${index}`,name:`项目 ${index}`,summary:'',createdAt,archivedAt:null,tasks:[]}))];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(scrollFixture)})).status,200);
  await lastPage.setViewportSize({width:760,height:900});
  await lastPage.reload();
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await lastPage.locator('.projects').evaluate(element => {element.scrollLeft = element.scrollWidth-element.clientWidth-30;});
  await lastPage.locator('.task-card[data-task="scroll-task-36"]').evaluate(element => {
    const body = element.closest('.project-body'), taskRect = element.getBoundingClientRect(), bodyRect = body.getBoundingClientRect();
    body.scrollTop += taskRect.top-bodyRect.top-bodyRect.height/2;
  });
  const scrollPosition = () => lastPage.evaluate(() => {
    const body = document.querySelector('.project-body'), strip = document.querySelector('.projects');
    return {top:body.scrollTop,left:body.scrollLeft,strip:strip.scrollLeft,height:body.scrollHeight,viewport:body.clientHeight};
  });
  const beforeScrollDrop = await scrollPosition();
  assert.ok(beforeScrollDrop.height > beforeScrollDrop.viewport*2 && beforeScrollDrop.top > 300 && beforeScrollDrop.strip > 100);
  await drag('.task-card[data-task="scroll-task-36"]:not(.context)','.task-card[data-task="scroll-task-35"]:not(.context)',.1,lastPage);
  const scrollProject = (await snapshot()).projects.find(project => project.id === 'scroll-project');
  assert.ok(scrollProject.tasks.find(task => task.id === 'scroll-task-36').order < scrollProject.tasks.find(task => task.id === 'scroll-task-35').order);
  const afterScrollDrop = await scrollPosition();
  assert.ok(Math.abs(afterScrollDrop.top-beforeScrollDrop.top) < 1);
  assert.equal(afterScrollDrop.left,beforeScrollDrop.left);
  assert.equal(afterScrollDrop.strip,beforeScrollDrop.strip);
  passed('长项目下方真实拖动后保留项目纵向位置和窄窗口项目栏横向位置');

  await lastPage.locator('.task-card[data-task="scroll-task-36"] .task-content').click();
  const beforeScrollSave = await scrollPosition();
  await lastPage.locator('[data-inline-editor]').fill('滚动后编辑');
  await lastPage.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.projects.find(project => project.id === 'scroll-project').tasks.find(task => task.id === 'scroll-task-36').title === '滚动后编辑');
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  const afterScrollSave = await scrollPosition();
  assert.ok(Math.abs(afterScrollSave.top-beforeScrollSave.top) < 1);
  assert.equal(afterScrollSave.strip,beforeScrollSave.strip);
  await lastPage.locator('[data-inline-editor]').press('Control+Enter');
  assert.ok(Math.abs((await scrollPosition()).top-beforeScrollSave.top) < 1);
  assert.equal((await scrollPosition()).strip,beforeScrollSave.strip);
  await lastPage.close();
  passed('拖动后的原位自动保存和结束编辑均保持当前滚动位置');
  console.log(`UI smoke: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
