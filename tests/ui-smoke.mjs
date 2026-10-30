// Run with PLAYWRIGHT_MODULE set to an existing Playwright installation; no app dependency.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
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
const errors = [];
page.on('pageerror',error => errors.push(error.message));
page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function saved() {await page.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent.includes('已保存到本机'));}
async function snapshot() {return (await (await fetch(`${origin}/api/state`)).json()).state;}
async function submit(content) {await page.locator('dialog textarea').fill(content);await page.locator('dialog button[type="submit"]').click();await page.waitForFunction(() => !document.querySelector('dialog').open);await saved();}
async function drag(selector,target,ratio = .1) {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(selector).first().dispatchEvent('dragstart',{dataTransfer:transfer});
  const box = await page.locator(target).first().boundingBox();
  await page.locator(target).first().dispatchEvent('dragover',{dataTransfer:transfer,clientY:box.y + box.height*ratio});
  await page.locator(target).first().dispatchEvent('drop',{dataTransfer:transfer,clientY:box.y + box.height*ratio});
  await saved();
}

try {
  await page.goto(origin);
  await page.getByRole('heading',{name:'把想法，一件件完成。'}).waitFor();
  await saved();
  assert.equal(await page.locator('.project.expanded').count(),1);
  assert.equal(await page.locator('.katex').count(),2);
  passed('初始三列、三级事项及离线公式正常显示');
  await page.locator('[data-action="toggle"][data-project="learning"]').click();
  assert.equal(await page.locator('.project.expanded').count(),1);
  assert.equal(await page.locator('.project.expanded').getAttribute('id'),'project-learning');
  await page.locator('[data-action="toggle"][data-project="workspace"]').click();
  passed('纵向项目切换始终只展开一个');

  await page.locator('[data-action="edit-summary"]').first().click();
  await submit('## 测试总览\n\n**Markdown** 与 $\\frac{a_1}{b^2}$\n\n$$\\sum_{i=1}^{n} i$$\n\n<script>window.bad=true</script>\n<a href="javascript:alert(1)" onclick="window.bad=true">不安全链接</a>');
  assert.ok(await page.locator('.overview .katex').count() >= 2);
  assert.equal(await page.locator('.overview script,.overview [onclick],.overview a[href^="javascript:"]').count(),0);
  assert.equal(await page.evaluate(() => Boolean(window.bad)),false);
  passed('Markdown/上下标/分式/独立公式预览与保存，并过滤危险 HTML');

  await drag('.task-card[data-task="interaction"][draggable="true"]','.column[data-column="done"] .column-heading');
  let project = (await snapshot()).projects[0];
  for (const id of ['interaction','drag','status']) assert.equal(project.tasks.find(task => task.id === id).status,'done');
  assert.equal(project.tasks.find(task => task.id === 'drag').parentId,'interaction');
  assert.equal(project.tasks.find(task => task.id === 'interaction').parentId,'design');
  assert.equal(project.tasks.find(task => task.id === 'design').status,'doing');
  assert.equal(await page.locator('.column.done .task-card.context[data-task="design"]').count(),1);
  passed('二级事项跨列拖动携带所有子事项，并保留父级归属');

  await drag('.task-card[data-task="reading"][draggable="true"]','.task-card[data-task="review"][draggable="true"]');
  project = (await snapshot()).projects[0];
  assert.ok(project.tasks.find(task => task.id === 'reading').order < project.tasks.find(task => task.id === 'review').order);
  passed('拖动到条目边缘调整同级顺序');
  await drag('.task-card[data-task="notes"][draggable="true"]','[data-nest="reading"]');
  project = (await snapshot()).projects[0];
  assert.equal(project.tasks.find(task => task.id === 'notes').parentId,'reading');
  passed('拖动到子事项区域正确调整父级');

  await page.locator('.task-card[data-task="design"][draggable="true"] [data-action="complete"]').click();
  await saved();project = (await snapshot()).projects[0];
  for (const id of ['design','layout','interaction','drag','status']) assert.equal(project.tasks.find(task => task.id === id).status,'done');
  await page.locator('.task-card[data-task="design"][draggable="true"] [data-action="status"][data-status="doing"]').click();
  await saved();project = (await snapshot()).projects[0];
  assert.equal(project.tasks.find(task => task.id === 'drag').status,'doing');
  passed('完成与重新开始快捷操作作用于整棵子事项');

  await page.locator('[data-action="archive"]').click();
  assert.equal(await page.locator('dialog button[type="submit"]').count(),0);
  await page.locator('dialog [data-action="close"]').last().click();
  passed('未完成项目不能归档');

  await page.locator('.page-heading [data-action="add-project"]').click();
  await page.locator('dialog input[name="name"]').fill('验收项目');
  await submit('本地自动保存验收。');
  let created = (await snapshot()).projects.find(item => item.name === '验收项目');
  assert.ok(created);
  const projectId = created.id;
  await page.locator('.column.todo .add-task').click();await submit('验收主事项 $E=mc^2$');
  created = (await snapshot()).projects.find(item => item.id === projectId);
  const root = created.tasks[0].id;
  await page.locator(`.task-card[data-task="${root}"] [data-action="add-task"]`).click();await submit('验收二级事项');
  created = (await snapshot()).projects.find(item => item.id === projectId);
  const second = created.tasks.find(task => task.parentId === root).id;
  await page.locator(`.task-card[data-task="${second}"] [data-action="add-task"]`).click();await submit('验收三级子事项');
  created = (await snapshot()).projects.find(item => item.id === projectId);
  const third = created.tasks.find(task => task.parentId === second).id;
  assert.equal(await page.locator(`.task-card[data-task="${third}"] [data-action="add-task"]`).count(),0);
  passed('新建项目与三级事项，三级不提供继续添加子级入口');

  await page.locator('.column.todo .add-task').click();await submit('另一个独立事项');
  created = (await snapshot()).projects.find(item => item.id === projectId);
  const extra = created.tasks.find(task => task.id !== root && task.parentId === null).id;
  const rootOrder = created.tasks.find(task => task.id === root).order;
  await page.locator(`.task-card[data-task="${root}"] .task-content`).click();
  await page.locator('dialog select[name="parentId"]').selectOption(extra);
  await page.locator('dialog button[type="submit"]').click();
  assert.equal(await page.locator('dialog').evaluate(element => element.open),true);
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).tasks.find(task => task.id === root).parentId,null);
  await page.locator('dialog select[name="parentId"]').selectOption('');
  await submit('更新后的主事项');
  created = (await snapshot()).projects.find(item => item.id === projectId);
  assert.equal(created.tasks.find(task => task.id === root).title,'更新后的主事项');
  assert.equal(created.tasks.find(task => task.id === root).order,rootOrder);
  passed('拒绝超出三级的移动后仍可继续编辑，修改文字不改变排序');

  const beforeSelfDrop = JSON.stringify(created.tasks);
  await drag(`.task-card[data-task="${root}"]`,`.task-card[data-task="${root}"]`);
  assert.equal(JSON.stringify((await snapshot()).projects.find(item => item.id === projectId).tasks),beforeSelfDrop);
  passed('拖动后放回自身不会改变层级、顺序或子事项状态');

  await page.locator(`.task-card[data-task="${extra}"] .task-content`).click();
  await page.locator('dialog [data-action="delete-task"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();

  await page.locator(`.task-card[data-task="${root}"] [data-action="complete"]`).click();await saved();
  await page.locator('[data-action="archive"]').click();
  await page.locator('dialog .secondary[data-action="close"]').click();
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).archivedAt,null);
  await page.locator('[data-action="archive"]').click();
  await page.locator('dialog button[type="submit"]').click();await saved();
  assert.ok((await snapshot()).projects.find(item => item.id === projectId).archivedAt);
  await page.locator('[data-action="view"][data-view="archived"]').click();
  await page.getByRole('heading',{name:'完成的事，也值得留存。'}).waitFor();
  assert.equal(await page.locator('.project.expanded .task-card').count(),3);
  assert.equal(await page.locator('.task-card[draggable="true"]').count(),0);
  await page.reload();
  await page.locator('[data-action="view"][data-view="archived"]').click();
  assert.ok(await page.locator('.project-title').filter({hasText:'验收项目'}).count());
  await page.locator('[data-action="restore"]').click();await saved();
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).archivedAt,null);
  passed('归档取消/再次确认/只读浏览/重开保留/恢复完整通过');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export"]').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(),/一事-备份-.*\.json/);
  passed('全部项目可导出 JSON 备份');

  await page.locator(`.task-card[data-task="${root}"]`).dragTo(page.locator('.column.doing .column-heading'));
  await saved();
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).tasks.find(task => task.id === third).status,'doing');
  passed('原生鼠标拖动可跨列移动整棵三级事项');

  await page.route('**/api/state',route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"disk unavailable"}'}),{times:1});
  await page.locator(`.task-card[data-task="${root}"] [data-action="complete"]`).click();
  await page.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent.includes('保存失败'));
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).tasks.find(task => task.id === root).status,'doing');
  assert.equal(await page.locator(`.column.done .task-card[data-task="${root}"][draggable="true"]`).count(),1);
  await page.locator('[data-save-status]').click();await saved();
  assert.equal((await snapshot()).projects.find(item => item.id === projectId).tasks.find(task => task.id === root).status,'done');
  const expectedError = errors.findIndex(message => message.includes('503'));
  assert.ok(expectedError >= 0);errors.splice(expectedError,1);
  passed('保存失败保留界面内容，点击重试后成功写入');

  let releaseSave, saveStarted;
  const gate = new Promise(resolve => {releaseSave = resolve;});
  const started = new Promise(resolve => {saveStarted = resolve;});
  await page.route('**/api/state',async route => {saveStarted();await gate;await route.continue();},{times:1});
  await page.locator(`.task-card[data-task="${root}"] [data-action="status"][data-status="doing"]`).click();
  await started;
  await page.locator(`.task-card[data-task="${third}"] [data-action="complete"]`).click();
  releaseSave();await saved();
  created = (await snapshot()).projects.find(item => item.id === projectId);
  assert.equal(created.tasks.find(task => task.id === root).status,'doing');
  assert.equal(created.tasks.find(task => task.id === third).status,'done');
  passed('前次保存尚未完成时连续修改，最后一次操作也能完整持久化');

  await page.setViewportSize({width:760,height:900});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  passed('窄窗口中页面无横向溢出，看板可单独横向滚动');
  assert.deepEqual(errors,[]);
  passed('浏览器无脚本错误、资源错误或 CSP 违规');
  console.log(`UI smoke: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
