import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const directory=await mkdtemp(path.join(tmpdir(),'yishi-language-'));
const server=await createTodoServer({dataDir:directory});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(10000);
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const snapshot=async()=>await(await fetch(origin+'/api/state')).json();
const saved=()=>page.locator('[data-save-status][data-state=saved]').waitFor({state:'attached'});
let checks=0;
const passed=message=>{checks++;console.log('✓ '+message);};
try {
  const initial=await snapshot();
  initial.state.projects=[{id:'literal',name:'用户的设置 Project',summary:'**用户的帮助**',createdAt:new Date().toISOString(),archivedAt:null,tasks:[{id:'task',parentId:null,title:'用户的归档 Task',status:'todo',order:0}]}];
  await fetch(origin+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(initial)});
  const before=await snapshot();
  await page.goto(origin);await saved();
  assert.equal(await page.locator('[data-view=active]').textContent(),'项目');
  await page.locator('[data-action=settings]').click();
  await page.locator('[data-setting-language]').selectOption('en');
  await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  assert.equal(await page.locator('[data-view=active]').textContent(),'Projects');
  assert.deepEqual(await page.locator('.column-heading>span.status-dot').evaluateAll(elements=>elements.map(e=>e.parentElement.textContent.trim())),['To do','Doing','Done']);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.title(),'Yishi · Local task workbench');
  assert.deepEqual(await snapshot(),before);
  passed('English updates navigation, columns, settings and accessibility without translating task data');

  for(const font of ['system','smiley']) {
    await page.locator('[data-setting-font]').selectOption(font);
    for(const size of ['12','24']) {
      await page.locator('[data-setting-size]').selectOption(size);
      await page.evaluate(()=>document.fonts.ready);
      const controls=await page.locator('.setting-row select').evaluateAll(elements=>elements.map(e=>{const s=getComputedStyle(e);return {height:e.clientHeight,need:(parseFloat(s.lineHeight)||parseFloat(s.fontSize)*1.2)+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),right:e.getBoundingClientRect().right,dialog:e.closest('dialog').getBoundingClientRect().right};}));
      for(const control of controls) {assert.ok(control.height+1>=control.need,JSON.stringify(control));assert.ok(control.right<=control.dialog);}
    }
  }
  await page.locator('[data-setting-font]').selectOption('system');
  await page.locator('[data-setting-size]').selectOption('14');
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  passed('English settings remain readable at 12/24px in both fonts');

  await page.locator('[data-action=help]').click();
  assert.equal(await page.locator('dialog').getAttribute('class'),'dialog-help');
  assert.doesNotMatch(await page.locator('.help-content').innerText(),/\p{Script=Han}/u);
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  await page.locator('[data-action=archive]').click();
  assert.equal(await page.locator('dialog h2').textContent(),'Project is incomplete');
  assert.equal(await page.locator('.dialog-copy').textContent(),'Complete all tasks first.');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  passed('Help and confirmation dialogs are fully localized');

  await page.locator('.task-content').click();
  const editor=page.locator('[data-inline-editor]');
  await editor.evaluate(e=>e.setSelectionRange(0,2));
  await editor.press('Control+b');
  assert.equal(await editor.inputValue(),'**用户**的归档 Task');
  await editor.press('Control+b');
  await editor.press('Control+Enter');await saved();
  assert.deepEqual(await snapshot(),before);
  passed('English mode preserves bold keyboard behavior and user text');

  await page.reload();await saved();
  assert.equal(await page.locator('[data-view=active]').textContent(),'Projects');
  await page.route('**/api/state',route=>route.request().method()==='PUT'?route.fulfill({status:409,contentType:'application/json',body:'{"error":"数据已更新"}'}):route.continue());
  await page.locator('.task-content').click();
  await editor.fill('Conflict buffer');await editor.press('Control+Enter');
  await page.locator('[data-save-status][data-state=error]').waitFor({state:'attached'});
  assert.match(await page.locator('#toast').textContent(),/Data conflict/);
  assert.deepEqual(await snapshot(),before);
  await page.unroute('**/api/state');
  await page.reload();await saved();
  await page.locator('[data-action=settings]').click();
  await page.locator('[data-setting-language]').selectOption('zh');
  await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
  await page.reload();await saved();
  assert.equal(await page.locator('[data-view=active]').textContent(),'项目');
  assert.deepEqual(await snapshot(),before);
  passed('Language persists across reloads and conflict messages are localized');
  assert.deepEqual(errors,[]);
  console.log(`Language UI: ${checks} checks passed`);
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
