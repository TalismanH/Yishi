// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-close-choice-'));
const server = await createTodoServer({dataDir});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror',error => errors.push(error.message));
page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
await page.addInitScript(() => {
  const runtime = {hidden:0,destroyed:0,prevented:0,listeners:{},closeListener:null,pendingClose:null};
  window.__closeTest = runtime;
  window.__TAURI__ = {
    core:{invoke:async (command,args) => {
      if (command === 'hide_to_tray') {runtime.hidden++;return;}
      if (command !== 'load_workspace' && command !== 'save_workspace') throw new Error(`Unexpected native command: ${command}`);
      const response = await fetch('/api/state',command === 'load_workspace' ? undefined : {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
      const payload = await response.json();
      if (!response.ok) throw {status:response.status,message:payload.error};
      return payload;
    }},
    event:{listen:async (event,listener) => {runtime.listeners[event]=listener;return () => {delete runtime.listeners[event];};}},
    window:{getCurrentWindow:() => ({
      onCloseRequested:async listener => {runtime.closeListener=listener;return () => {runtime.closeListener=null;};},
      destroy:async () => {runtime.destroyed++;},
    })},
  };
  runtime.requestClose = () => runtime.closeListener({preventDefault(){runtime.prevented++;}});
  runtime.trayExit = () => runtime.listeners['tray-exit-requested']({payload:null});
});
const preference = () => page.evaluate(() => localStorage.getItem('yishi.closeAction'));
const counts = () => page.evaluate(() => ({hidden:window.__closeTest.hidden,destroyed:window.__closeTest.destroyed}));
const remember = () => page.locator('[data-remember-close]');
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function ready() {
  await page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await page.waitForFunction(() => Boolean(window.__closeTest.closeListener && window.__closeTest.listeners['tray-exit-requested']));
}
async function startClose() {
  await page.evaluate(() => {window.__closeTest.pendingClose=window.__closeTest.requestClose();});
}
async function closeDone() {
  await page.evaluate(() => window.__closeTest.pendingClose);
}
async function choose(action,checked) {
  await remember().waitFor();
  if (checked !== undefined) await remember().setChecked(checked);
  await page.locator(`[data-close-choice="${action}"]`).click();
  await closeDone();
  assert.equal(await page.locator('dialog[open]').count(),0);
}
async function resetViaSettings() {
  await page.locator('.topbar [data-action="help"]').click();
  assert.equal(await page.locator('dialog [data-action="reset-close-choice"]').count(),0);
  await page.locator('dialog .dialog-footer [data-action="close"]').click();
  await page.locator('.topbar [data-action="settings"]').click();
  assert.equal(await page.locator('dialog h2').textContent(),'设置');
  assert.match(await page.locator('[data-close-preference]').textContent(),/最小化到托盘|退出软件/);
  const reset = page.locator('dialog [data-action="reset-close-choice"]');
  assert.equal(await reset.count(),1);assert.equal(await reset.isEnabled(),true);
  await reset.click();
  assert.equal(await preference(),null);assert.equal(await reset.isDisabled(),true);
  assert.match(await page.locator('[data-close-preference]').textContent(),/每次询问/);
  await page.locator('dialog .dialog-footer [data-action="close"]').click();
}

try {
  await page.goto(origin);await ready();
  const initial = await (await fetch(`${origin}/api/state`)).json();
  await startClose();await remember().waitFor();
  assert.equal(await remember().isChecked(),true);
  assert.match(await page.locator('dialog').textContent(),/记住本次选择/);
  await page.screenshot({path:path.resolve('test-results/close-choice.png')});
  await choose('cancel');
  assert.deepEqual(await counts(),{hidden:0,destroyed:0});assert.equal(await preference(),null);
  await startClose();await remember().waitFor();await page.keyboard.press('Escape');await closeDone();
  assert.equal(await preference(),null);assert.deepEqual(await counts(),{hidden:0,destroyed:0});
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),initial);
  passed('关闭弹窗默认勾选记住选择，取消和 Esc 不记录偏好、不隐藏或退出，也不修改工作区');

  await startClose();await choose('hide',false);
  assert.deepEqual(await counts(),{hidden:1,destroyed:0});assert.equal(await preference(),null);
  await startClose();assert.equal(await remember().isChecked(),true);await choose('cancel');
  await startClose();await choose('exit',false);
  assert.deepEqual(await counts(),{hidden:1,destroyed:1});assert.equal(await preference(),null);
  await startClose();await choose('cancel');
  passed('取消勾选后，托盘和退出仍执行本次动作，下次关闭继续询问');

  await startClose();await choose('hide');
  assert.equal(await preference(),'hide');assert.deepEqual(await counts(),{hidden:2,destroyed:1});
  await startClose();await closeDone();
  assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await counts(),{hidden:3,destroyed:1});
  await page.reload();await ready();
  assert.equal(await preference(),'hide');
  await startClose();await closeDone();
  assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await counts(),{hidden:1,destroyed:0});
  passed('勾选记住托盘后，后续关闭及页面重载均直接最小化到托盘');

  const edited = page.locator('.column.doing .task-card:not(.context) .task-content').first();
  const taskId = await edited.getAttribute('data-task');
  await edited.click();await page.locator('[data-inline-editor="task"]').fill('托盘退出前保存的内容');
  await page.evaluate(() => window.__closeTest.trayExit());
  assert.deepEqual(await counts(),{hidden:1,destroyed:1});assert.equal(await preference(),'hide');
  assert.equal(await page.locator('dialog[open]').count(),0);
  const afterTrayExit = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(afterTrayExit.state.projects[0].tasks.find(task => task.id === taskId).title,'托盘退出前保存的内容');
  passed('托盘退出事件跳过已记住的托盘偏好，先保存编辑再真正退出，且不改写偏好');

  await resetViaSettings();
  await startClose();assert.equal(await remember().isChecked(),true);await choose('exit');
  assert.equal(await preference(),'exit');assert.deepEqual(await counts(),{hidden:1,destroyed:2});
  await startClose();await closeDone();
  assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await counts(),{hidden:1,destroyed:3});
  await page.reload();await ready();
  await startClose();await closeDone();
  assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await counts(),{hidden:0,destroyed:1});
  assert.equal(await preference(),'exit');
  await resetViaSettings();await startClose();await choose('cancel');
  passed('关闭选择重置已移至设置，帮助中不再显示；记住退出后下一次及重载后直接退出，重置后恢复询问');

  for (const invalid of ['unknown','true','{"action":"hide"}']) {
    await page.evaluate(value => localStorage.setItem('yishi.closeAction',value),invalid);
    const before = await counts();await startClose();assert.equal(await remember().isChecked(),true);await choose('cancel');
    assert.deepEqual(await counts(),before);assert.equal(await preference(),invalid);
  }
  await page.evaluate(() => localStorage.removeItem('yishi.closeAction'));
  passed('非法存储偏好被忽略，仍显示关闭选择，取消不会覆盖原值');

  await page.evaluate(() => {
    window.__originalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if (key === 'yishi.closeAction') throw new DOMException('Storage unavailable','QuotaExceededError');
      return window.__originalSetItem.call(this,key,value);
    };
  });
  await startClose();await choose('hide');
  assert.deepEqual(await counts(),{hidden:1,destroyed:1});assert.equal(await preference(),null);
  await page.evaluate(() => {Storage.prototype.setItem=window.__originalSetItem;delete window.__originalSetItem;});
  await startClose();await choose('cancel');
  assert.deepEqual(errors,[]);
  passed('localStorage 写入失败不会阻塞当前关闭动作，也不会错误记住下一次偏好');
  console.log(`Close choice UI: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
