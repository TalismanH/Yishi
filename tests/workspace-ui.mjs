// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-workspace-ui-'));
const server = await createTodoServer({dataDir});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror',error => errors.push(error.message));
page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
const snapshot = async () => (await (await fetch(`${origin}/api/state`)).json());
const saved = () => page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
const card = (status,id) => page.locator(`.column.${status} .task-card[data-task="${id}"]`);
const branch = (status,id) => card(status,id).locator('[data-action="toggle-branch"]');
const bulk = status => page.locator(`.column.${status} [data-action="toggle-column"]`);
const query = () => page.locator('[data-search-query]');
const scope = () => page.locator('[data-search-scope]');
const count = async () => (await page.locator('[data-search-count]').textContent()).match(/\d+/g)?.map(Number) ?? [];
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function expectCount(current,total) {
  await page.waitForFunction(([current,total]) => {
    const numbers=document.querySelector('[data-search-count]')?.textContent.match(/\d+/g)?.map(Number);
    return numbers?.[0] === current && numbers[1] === total;
  },[current,total]);
  assert.deepEqual(await count(),[current,total]);
}
async function expectHit(id,current,total) {
  await expectCount(current,total);
  await page.waitForFunction(id => {
    const hit=document.querySelector('.task-card.search-hit');
    if (!hit || hit.dataset.task !== id) return false;
    const bounds=hit.getBoundingClientRect(), pane=hit.closest('.column-items').getBoundingClientRect();
    return bounds.height > 0 && Math.abs(bounds.top-pane.top) <= 2;
  },id);
  assert.equal(await page.locator('.task-card.search-hit').count(),1);
  assert.equal(await page.locator('.task-card.search-hit.context').count(),0);
}

try {
  const fixture = await snapshot(), createdAt = new Date().toISOString();
  const task = (id,title,status,order,parentId = null) => ({id,title,status,order,parentId});
  const literal = '<img src=x onerror=window.workspaceXss=true>';
  fixture.state.projects = [{id:'workspace-tests',name:'层级与搜索',summary:Array.from({length:40},(_,index) => `总体情况第 ${index+1} 段。`).join('\n\n'),createdAt,archivedAt:null,tasks:[
    ...['todo','doing','done'].flatMap(status => Array.from({length:20},(_,index) => task(`${status}-fill-${index}`,`${status} filler ${index}`,status,index))),
    task('literal',`特殊内容 ${literal}`,'todo',70),
    task('todo-root','另一棵待办分支','todo',80),
    task('todo-second','另一个二级事项','todo',0,'todo-root'),
    task('todo-peer','同级二级事项','todo',1,'todo-root'),
    task('todo-leaf','另一个三级事项','todo',0,'todo-second'),
    task('shared-root','父分支 Needle','doing',100),
    task('shared-second','二级 Needle','doing',0,'shared-root'),
    task('todo-target','NEEDLE 待办目标','todo',0,'shared-second'),
    task('doing-target','Needle normal','doing',1,'shared-second'),
    task('done-target','Needle normal','done',2,'shared-second'),
    task('done-direct','直接完成子事项','done',1,'shared-root'),
  ]},{id:'other-project',name:'其他项目',summary:'',createdAt,archivedAt:null,tasks:[
    task('other-needle','Needle 不属于当前项目','todo',0),
    task('other-child','其他项目的子事项','todo',0,'other-needle'),
  ]}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture)})).status,200);
  await page.goto(origin);await saved();
  await page.emulateMedia({reducedMotion:'reduce'});
  const beforeUi = await snapshot();

  for (const status of ['todo','doing','done']) {
    const branches = page.locator(`.column.${status} [data-action="toggle-branch"]`);
    assert.ok(await branches.count() >= 2);
    assert.ok((await branches.evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')))).every(value => value === 'false'));
    assert.equal(await bulk(status).getAttribute('aria-expanded'),'false');
    assert.equal(await card(status,'shared-root').isVisible(),true);
    assert.equal(await card(status,'shared-second').isVisible(),false);
  }
  await page.locator('[data-action="toggle"][data-project="other-project"]').click();
  assert.equal(await card('todo','other-needle').isVisible(),true);
  assert.equal(await branch('todo','other-needle').getAttribute('aria-expanded'),'false');
  assert.equal(await card('todo','other-child').isVisible(),false);
  await page.locator('[data-action="toggle"][data-project="workspace-tests"]').click();
  assert.deepEqual(await snapshot(),beforeUi);
  passed('启动时三列分支均默认折叠，首次展开其他项目也只显示一级事项');

  await bulk('todo').click();
  await branch('doing','shared-root').click();
  for (const [parent,peer] of [['todo-root','todo-fill-0'],['todo-second','todo-peer']]) {
    const button = await branch('todo',parent).boundingBox(), box = await card('todo',parent).boundingBox();
    const text = await card('todo',parent).locator('.task-content').boundingBox(), peerText = await card('todo',peer).locator('.task-content').boundingBox();
    const pane = await page.locator('.column.todo .column-items').boundingBox();
    assert.ok(button.x+button.width <= box.x && button.x >= pane.x);
    assert.ok(Math.abs(button.y+button.height/2-box.y-box.height/2) < 1);
    assert.ok(Math.abs(text.x-peerText.x) < 1);
  }
  passed('一级和二级折叠按钮位于方框左外侧且不被裁切，有无子事项的同级正文保持对齐');
  await branch('todo','todo-root').hover();
  await page.screenshot({path:path.resolve('test-results/task-fold-outside.png')});

  assert.equal(await branch('todo','shared-root').getAttribute('aria-expanded'),'true');
  assert.equal(await card('todo','todo-target').isVisible(),true);
  await branch('todo','shared-root').click();
  assert.equal(await branch('todo','shared-root').getAttribute('aria-expanded'),'false');
  assert.equal(await card('todo','shared-second').isVisible(),false);
  assert.equal(await card('todo','todo-target').isVisible(),false);
  assert.equal(await card('doing','shared-second').isVisible(),true);
  await branch('todo','shared-root').click();
  await branch('todo','shared-second').click();
  assert.equal(await card('todo','shared-second').isVisible(),true);
  assert.equal(await card('todo','todo-target').isVisible(),false);
  assert.equal(await card('todo','todo-target').locator('[data-action="toggle-branch"]').count(),0);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('一级和二级分支可分别折叠，其他列的同一事项不受影响，三级叶子没有无效折叠入口');

  await bulk('todo').click();
  assert.ok((await page.locator('.column.todo [data-action="toggle-branch"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')))).every(value => value === 'false'));
  for (const item of await page.locator('.column.todo .column-items > .task-group > .task-card').all()) assert.equal(await item.isVisible(),true);
  assert.equal(await branch('doing','shared-root').getAttribute('aria-expanded'),'true');
  await bulk('todo').click();
  assert.ok((await page.locator('.column.todo [data-action="toggle-branch"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')))).every(value => value === 'true'));
  assert.equal(await card('todo','todo-target').isVisible(),true);
  assert.equal(await card('todo','todo-leaf').isVisible(),true);
  await page.locator('[data-action="toggle-overview"]').click();
  assert.equal(await page.locator('.overview-content').isVisible(),false);
  assert.equal(await page.locator('.overview-header').isVisible(),true);
  await page.locator('[data-action="toggle-overview"]').click();
  assert.equal(await page.locator('.overview-content').isVisible(),true);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('列按钮批量收起或展开所有层级且保留一级事项，总体情况可独立折叠，操作不写入业务数据');

  await bulk('todo').click();
  await card('doing','shared-second').locator('[data-action="locate-task"]').click();
  assert.equal(await card('todo','shared-second').isVisible(),true);
  await card('doing','shared-root').locator('[data-action="complete"]').click();
  assert.equal(await card('todo','todo-target').isVisible(),true);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('原有跨列定位和完成检查也会展开隐藏的祖先分支，保持事项状态与版本不变');

  for (const status of ['todo','done']) if (await bulk(status).getAttribute('aria-expanded') === 'true') await bulk(status).click();
  await branch('doing','shared-root').click();
  await card('doing','shared-root').locator('[data-action="locate-task"]').click();
  for (const status of ['todo','done']) {
    assert.equal(await branch(status,'shared-root').getAttribute('aria-expanded'),'true');
    assert.equal(await card(status,'shared-second').isVisible(),true);
  }
  assert.equal(await branch('doing','shared-root').getAttribute('aria-expanded'),'false');
  await branch('doing','shared-root').click();
  for (const status of ['todo','done']) await bulk(status).click();
  await card('doing','shared-second').locator('[data-action="locate-task"]').click();
  for (const status of ['todo','done']) {
    assert.equal(await branch(status,'shared-root').getAttribute('aria-expanded'),'true');
    assert.equal(await branch(status,'shared-second').getAttribute('aria-expanded'),'true');
  }
  assert.equal(await card('todo','todo-target').isVisible(),true);
  assert.equal(await card('done','done-target').isVisible(),true);
  assert.equal(await branch('todo','todo-root').getAttribute('aria-expanded'),'false');
  assert.deepEqual(await snapshot(),beforeUi);
  passed('定位一级或二级事项会展开其他两列的对应事项及祖先，不改变来源列折叠状态、无关分支或业务数据');

  assert.equal(await page.locator('.task-search').isVisible(),false);
  await page.keyboard.press('Control+f');await query().waitFor();
  assert.equal(await query().evaluate(element => document.activeElement === element),true);
  assert.equal(await page.locator('.task-search').evaluate(element => {
    const overview=document.querySelector('.overview'), board=document.querySelector('.board');
    return Boolean(overview.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(element.compareDocumentPosition(board)&Node.DOCUMENT_POSITION_FOLLOWING);
  }),true);
  assert.deepEqual((await scope().locator('option').evaluateAll(options => options.map(option => option.value))).sort(),['all','doing','done','todo']);
  await expectCount(0,0);
  const composing = await query().elementHandle();
  await composing.evaluate(element => {element.value='特';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'特'}));});
  assert.equal(await composing.evaluate(element => element.isConnected),true);
  await composing.evaluate(element => {element.value='特殊';element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'特殊'}));});
  await expectHit('literal',1,1);
  await composing.dispose();
  await query().fill('needle');
  const expected = ['todo-target','shared-root','shared-second','doing-target','done-target'];
  await expectHit(expected[0],1,5);
  for (let index=1;index<expected.length;index++) {
    await page.locator('[data-action="search-next"]').click();await expectHit(expected[index],index+1,5);
  }
  await page.locator('[data-action="search-next"]').click();await expectHit(expected[0],1,5);
  await page.locator('[data-action="search-prev"]').click();await expectHit(expected[4],5,5);
  await query().press('Enter');await expectHit(expected[0],1,5);
  await query().press('Shift+Enter');await expectHit(expected[4],5,5);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('Ctrl+F 在总体情况下方显示搜索栏，按视觉顺序计数实际事项，按钮和 Enter/Shift+Enter 可循环上下定位');

  await scope().selectOption('doing');await expectHit('shared-root',1,3);
  await scope().selectOption('done');await expectHit('done-target',1,1);
  await scope().selectOption('todo');await expectHit('todo-target',1,1);
  await bulk('todo').click();
  assert.equal(await card('todo','todo-target').isVisible(),false);
  await query().fill('NEEDLE 待办目标');await expectHit('todo-target',1,1);
  assert.equal(await branch('todo','shared-root').getAttribute('aria-expanded'),'true');
  assert.equal(await branch('todo','shared-second').getAttribute('aria-expanded'),'true');
  assert.equal(await card('todo','todo-target').isVisible(),true);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('搜索范围正确区分三列，不重复计算虚线父事项，跳转折叠目标时自动展开祖先并对齐列顶端');

  await scope().selectOption('all');await query().fill('没有任何事项会包含这段内容');await expectCount(0,0);
  assert.equal(await page.locator('.task-card.search-hit').count(),0);
  await query().fill('');await expectCount(0,0);
  await query().fill(literal);await expectHit('literal',1,1);
  assert.equal(await query().inputValue(),literal);
  assert.equal(await page.locator('.task-search img,.task-search [onerror]').count(),0);
  assert.equal(await page.evaluate(() => Boolean(window.workspaceXss)),false);
  await page.keyboard.press('Control+f');
  assert.equal(await query().inputValue(),literal);
  assert.deepEqual(await query().evaluate(element => [element.selectionStart,element.selectionEnd]),[0,literal.length]);
  await page.locator('[data-action="close-search"]').click();
  assert.equal(await page.locator('.task-search').isVisible(),false);
  await page.keyboard.press('Control+f');await query().waitFor();await query().press('Escape');
  assert.equal(await page.locator('.task-search').isVisible(),false);
  assert.deepEqual(await snapshot(),beforeUi);
  passed('空查询和无命中正确显示零结果，特殊 HTML 字符按文字处理，重复 Ctrl+F 选中查询，关闭按钮和 Esc 隐藏搜索栏');

  await page.locator('.project.expanded > .project-header [data-action="toggle"]').click();
  assert.equal(await page.locator('.project.expanded').count(),0);
  await page.keyboard.press('Control+f');await query().waitFor();
  assert.equal(await page.locator('.project.expanded').getAttribute('data-project'),'workspace-tests');
  await page.locator('[data-action="close-search"]').click();
  await card('doing','doing-fill-0').locator('.task-content').click();
  await page.locator('[data-inline-editor="task"]').fill('doing filler 0 needle edited');
  await page.keyboard.press('Control+f');await query().waitFor();
  assert.equal(await page.locator('[data-inline-editor]').count(),0);
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.projects[0].tasks.find(task => task.id === 'doing-fill-0').title === 'doing filler 0 needle edited');
  await saved();await query().fill('needle');await expectHit('todo-target',1,6);
  const afterEditing = await snapshot(), expectedState = structuredClone(beforeUi.state);
  expectedState.projects[0].tasks.find(task => task.id === 'doing-fill-0').title = 'doing filler 0 needle edited';
  assert.deepEqual(afterEditing.state,expectedState);
  await page.screenshot({path:path.resolve('test-results/workspace-search.png')});
  assert.deepEqual(errors,[]);
  passed('项目全部折叠时 Ctrl+F 自动展开首个项目，编辑中打开搜索先保存正文且只搜索当前项目');
  console.log(`Workspace UI: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
