// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-project-ui-'));
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
const project = id => page.locator(`.projects>.project[data-project="${id}"]`);
const handle = id => project(id).locator('.project-sort-handle');
const visibleOrder = () => page.locator('.projects>.project').evaluateAll(elements => elements.map(element => element.dataset.project));
const saved = () => page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function expectOrder(ids) {
  await page.waitForFunction(async ids => JSON.stringify((await (await fetch('/api/state')).json()).state.projects.map(project => project.id)) === JSON.stringify(ids),ids);
  await saved();
  assert.deepEqual((await snapshot()).state.projects.map(project => project.id),ids);
}
async function startDrag(id) {
  await handle(id).hover();
  const bounds = await handle(id).boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width/2+8,bounds.y+bounds.height/2,{steps:2});
}
async function moveOver(id,after = false) {
  const bounds = await project(id).boundingBox();
  await page.mouse.move(bounds.x+bounds.width*(after ? .8 : .2),bounds.y+100,{steps:8});
}
async function drag(id,target,after = false) {
  await startDrag(id);await moveOver(target,after);await page.mouse.up();
}
async function collapseAll() {
  const toggle = page.locator('.project.expanded [data-action="toggle"]');
  if (await toggle.count()) await toggle.click();
  assert.equal(await page.locator('.project.expanded').count(),0);
}

try {
  const fixture = await snapshot(), createdAt = new Date().toISOString();
  const item = (id,name,archivedAt = null) => ({id,name,summary:'',createdAt,archivedAt,tasks:[]});
  fixture.state.projects = [item('alpha','Project Alpha 工作台'),item('archive-one','归档 Archive One',createdAt),item('beta','研究 Beta   Test'),item('archive-two','归档 Archive Two',createdAt),item('gamma','项目 Gamma 2026')];
  fixture.state.projects[0].summary = '项目排序不得改变总体情况和事项内容。';
  fixture.state.projects[0].tasks = [{id:'alpha-task',parentId:null,title:'保留事项内容',status:'doing',order:0}];
  const original = structuredClone(fixture.state.projects);
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture)})).status,200);
  await page.goto(origin);await saved();await page.mouse.move(0,0);
  assert.deepEqual(await visibleOrder(),['alpha','beta','gamma']);
  assert.equal(await page.locator('.project.expanded').count(),1);
  assert.equal(await page.locator('.project-sort-handle').count(),0);
  const beforeExpanded = await snapshot();
  const rail = await project('beta').boundingBox(), panel = await project('alpha').boundingBox();
  await page.mouse.move(rail.x+rail.width/2,rail.y+100);await page.mouse.down();
  await page.mouse.move(panel.x+20,panel.y+100,{steps:8});await page.mouse.up();
  assert.deepEqual(await snapshot(),beforeExpanded);
  await collapseAll();await page.locator('.brand').click();
  for (const id of ['alpha','beta','gamma']) assert.equal(await handle(id).evaluate(element => getComputedStyle(element).opacity),'0');
  await project('beta').hover();
  assert.equal(await handle('beta').evaluate(element => getComputedStyle(element).opacity),'0');
  const handleBounds = await handle('beta').boundingBox(), projectBounds = await project('beta').boundingBox(), stripBounds = await page.locator('.projects').boundingBox();
  assert.ok(handleBounds.y+handleBounds.height <= projectBounds.y+1);
  assert.ok(handleBounds.y >= stripBounds.y && handleBounds.x >= stripBounds.x);
  await handle('beta').hover();
  assert.equal(await handle('beta').evaluate(element => getComputedStyle(element).opacity),'1');
  await page.mouse.move(0,0);
  assert.equal(await handle('beta').evaluate(element => getComputedStyle(element).opacity),'0');
  await handle('alpha').click();
  assert.equal(await page.locator('.project.expanded').count(),0);
  await page.mouse.move(0,0);
  assert.equal(await handle('alpha').evaluate(element => getComputedStyle(element).opacity),'0');
  passed('任何项目展开时均无排序把手；全部折叠后仅悬停框线上方把手区域或键盘聚焦时显现，悬停整列及鼠标移开均隐藏');

  await page.keyboard.press('Tab');await handle('beta').focus();
  assert.equal(await handle('beta').evaluate(element => getComputedStyle(element).opacity),'1');
  await handle('beta').press('ArrowLeft');
  await expectOrder(['beta','archive-one','alpha','archive-two','gamma']);
  assert.deepEqual(await visibleOrder(),['beta','alpha','gamma']);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.project')?.dataset.project),'beta');
  await handle('beta').press('ArrowRight');
  await expectOrder(['alpha','archive-one','beta','archive-two','gamma']);
  for (const [id,key] of [['alpha','ArrowLeft'],['gamma','ArrowRight']]) {
    const before = await snapshot();await handle(id).focus();await handle(id).press(key);
    assert.deepEqual(await snapshot(),before);
  }
  passed('左右键调整项目顺序并保留把手焦点，首尾边界不改动数据');
  await handle('alpha').click();await page.mouse.move(0,0);
  for (const id of ['alpha','beta','gamma']) assert.equal(await handle(id).evaluate(element => getComputedStyle(element).opacity),'0');

  await drag('gamma','alpha');
  await expectOrder(['gamma','archive-one','alpha','archive-two','beta']);
  assert.deepEqual(await visibleOrder(),['gamma','alpha','beta']);
  assert.equal(await page.locator('.project.expanded').count(),0);
  assert.deepEqual((await snapshot()).state.projects.slice().sort((a,b) => a.id.localeCompare(b.id)),original.slice().sort((a,b) => a.id.localeCompare(b.id)));
  await page.reload();await saved();
  assert.deepEqual(await visibleOrder(),['gamma','alpha','beta']);
  assert.equal(await page.locator('.project-sort-handle').count(),0);
  await collapseAll();
  await drag('alpha','beta',true);
  await expectOrder(['gamma','archive-one','beta','archive-two','alpha']);
  assert.deepEqual(await visibleOrder(),['gamma','beta','alpha']);
  assert.equal(await page.locator('.project.expanded').count(),0);
  passed('全部折叠时可使用上方把手真实拖动排序，持久化后重开保留顺序，不改变项目内容或隐藏归档槽位');

  const beforeCancel = await snapshot();
  await startDrag('gamma');await moveOver('beta',true);await page.keyboard.press('Escape');await page.mouse.up();
  assert.deepEqual(await snapshot(),beforeCancel);
  await startDrag('gamma');await page.mouse.move(400,30,{steps:5});await page.mouse.up();
  assert.deepEqual(await snapshot(),beforeCancel);
  await startDrag('gamma');await page.mouse.up();
  assert.deepEqual(await snapshot(),beforeCancel);
  assert.equal(await page.locator('.project.expanded').count(),0);
  assert.equal(await page.locator('.project-drop-before,.project-drop-after,.dragging').count(),0);
  passed('Esc、项目栏外释放和原位释放均不改变顺序、版本或折叠状态，并清理拖动提示');

  await page.locator('[data-action="view"][data-view="archived"]').click();
  assert.deepEqual(await visibleOrder(),['archive-one','archive-two']);
  assert.equal(await page.locator('.project-sort-handle').count(),0);
  await collapseAll();
  await drag('archive-two','archive-one');
  await expectOrder(['gamma','archive-two','beta','archive-one','alpha']);
  assert.deepEqual(await visibleOrder(),['archive-two','archive-one']);
  await handle('archive-two').focus();await handle('archive-two').press('ArrowRight');
  await expectOrder(['gamma','archive-one','beta','archive-two','alpha']);
  await page.locator('[data-action="view"][data-view="active"]').click();
  assert.deepEqual(await visibleOrder(),['gamma','beta','alpha']);
  assert.equal(await page.locator('.project-sort-handle').count(),0);
  await collapseAll();
  passed('归档视图同样要求全部折叠才可拖动和键盘排序，活动项目顺序及所在槽位保持不变');

  const beforeExpand = await snapshot();
  for (const id of ['gamma','beta','alpha']) {
    await project(id).locator('[data-action="toggle"]').click();
    assert.equal(await page.locator('.project.expanded').count(),1);
    assert.equal(await page.locator('.project-sort-handle').count(),0);
    await project(id).locator('[data-action="toggle"]').focus();await page.keyboard.press('ArrowRight');
    assert.deepEqual(await snapshot(),beforeExpand);
    await collapseAll();
    assert.equal(await page.locator('.project-sort-handle').count(),3);
  }
  passed('展开任意项目后排序入口全部消失，重新全部折叠才恢复，不影响项目数据与顺序');

  const title = project('beta').locator('.project-title');
  const typography = await title.evaluate(element => {
    const style=getComputedStyle(element), walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text=walker.currentNode.textContent, start=text.indexOf('Beta');
      if (start < 0) continue;
      const word=document.createRange(), spaces=document.createRange();
      word.setStart(walker.currentNode,start);word.setEnd(walker.currentNode,start+4);
      spaces.setStart(walker.currentNode,start+4);spaces.setEnd(walker.currentNode,start+7);
      return {mode:style.writingMode,orientation:style.textOrientation,spacing:parseFloat(style.letterSpacing),font:parseFloat(style.fontSize),wordHeight:word.getBoundingClientRect().height,spaceHeight:spaces.getBoundingClientRect().height,width:element.getBoundingClientRect().width};
    }
    throw new Error('Missing English project title');
  });
  assert.equal(typography.mode,'vertical-rl');assert.equal(typography.orientation,'mixed');
  assert.ok(typography.spacing <= 2 && typography.wordHeight < typography.font*4 && typography.spaceHeight < typography.font,JSON.stringify(typography));
  assert.ok(typography.width < 40);
  await page.setViewportSize({width:760,height:900});
  assert.ok(await title.evaluate(element => parseFloat(getComputedStyle(element).letterSpacing) <= 2));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.brand').click();await handle('beta').hover();
  assert.equal(await page.locator('.project-sort-handle').evaluateAll(elements => elements.filter(element => getComputedStyle(element).opacity === '1').length),1);
  await page.screenshot({path:path.resolve('test-results/project-sorting.png')});
  assert.deepEqual(errors,[]);
  passed('折叠标题保留中文竖排，英文单词和连续空格使用紧凑间距，窄窗口无页面横向溢出');
  console.log(`Project UI: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
