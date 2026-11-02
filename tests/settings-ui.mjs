// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-settings-ui-'));
const server = await createTodoServer({dataDir});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(8000);
const errors = [], smileyResponses = [];
page.on('pageerror',error => errors.push(error.message));
page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
page.on('response',response => {if (response.url().endsWith('/vendor/smiley-sans/SmileySans-Oblique.ttf.woff2')) smileyResponses.push(response.status());});
const saved = () => page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
const snapshot = async () => (await (await fetch(`${origin}/api/state`)).json());
const appearance = () => page.evaluate(() => localStorage.getItem('yishi.appearance'));
const font = () => page.locator('[data-setting-font]');
const size = () => page.locator('[data-setting-size]');
const palette = () => page.locator('[data-setting-palette]');
const palettes = ['default','mist','rose','sage','oat','lavender','clay'];
let checks = 0;
function passed(message) {checks++;console.log(`✓ ${message}`);}
async function openSettings() {
  await page.locator('.topbar [data-action="settings"]').click();
  assert.equal(await page.locator('dialog[open] h2').textContent(),'设置');
}
async function closeDialog() {
  await page.locator('dialog .dialog-footer [data-action="close"]').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
}
async function typography() {
  return page.evaluate(() => {
    const computed = selector => getComputedStyle(document.querySelector(selector));
    const root=getComputedStyle(document.documentElement), task=computed('.task-card:not(.context) .task-content'), summary=computed('.overview-content');
    return {font:document.documentElement.dataset.font,variable:root.getPropertyValue('--ui-font-size').trim(),rootSize:parseFloat(root.fontSize),family:root.fontFamily,
      taskSize:parseFloat(task.fontSize),taskFamily:task.fontFamily,summarySize:parseFloat(summary.fontSize),summaryFamily:summary.fontFamily,
      projectSize:parseFloat(computed('.project-name').fontSize),columnSize:parseFloat(computed('.column-heading').fontSize),buttonSize:parseFloat(computed('.nav-item').fontSize),
      codeFamily:computed('.overview-content code').fontFamily,mathFamily:computed('.overview-content .katex').fontFamily};
  });
}
async function expectAppearance(expectedFont,expectedSize) {
  await page.waitForFunction(({font,size}) => document.documentElement.dataset.font === font && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size')) === size,{font:expectedFont,size:expectedSize});
  const actual = await typography();
  assert.equal(actual.rootSize,expectedSize);assert.equal(actual.taskSize,expectedSize);assert.equal(actual.summarySize,expectedSize);
  assert.equal(actual.taskFamily,actual.family);assert.equal(actual.summaryFamily,actual.family);
  if (expectedFont === 'smiley') assert.match(actual.family,/Smiley Sans/);
  else assert.doesNotMatch(actual.family,/Smiley Sans/);
  assert.doesNotMatch(actual.codeFamily,/Smiley Sans/);assert.match(actual.codeFamily,/Consolas|monospace/i);
  assert.match(actual.mathFamily,/KaTeX/);
  return actual;
}
async function expectSmileyLoaded() {
  const result = await page.evaluate(async () => {
    const loaded=await document.fonts.load('14px "Smiley Sans"','一事字体预览');
    await document.fonts.ready;
    return {loaded:loaded.length,checked:document.fonts.check('14px "Smiley Sans"','一事字体预览'),faces:[...document.fonts].filter(face => face.family.replace(/["']/g,'') === 'Smiley Sans').map(face => face.status)};
  });
  assert.ok(result.loaded > 0 && result.checked && result.faces.includes('loaded'),JSON.stringify(result));
  assert.ok(smileyResponses.includes(200),JSON.stringify(smileyResponses));
}
async function colors() {
  return page.evaluate(() => {
    const computed = selector => getComputedStyle(document.querySelector(selector));
    const root = computed(':root'), card = computed('.task-card:not(.context)'), primary = computed('dialog .primary');
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    function luminance(color) {
      context.fillStyle = color;context.fillRect(0,0,1,1);
      const channels = [...context.getImageData(0,0,1,1).data].slice(0,3).map(value => {
        const channel = value/255;
        return channel <= .04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4;
      });
      return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
    }
    function contrast(first,second) {
      const a = luminance(first), b = luminance(second);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }
    return {palette:document.documentElement.dataset.palette,page:root.backgroundColor,topbar:computed('.topbar').backgroundColor,
      project:computed('.project').backgroundColor,card:card.backgroundColor,dialog:computed('dialog').backgroundColor,
      border:computed('.project').borderTopColor,primary:primary.backgroundColor,
      textContrast:contrast(card.color,card.backgroundColor),buttonContrast:contrast(primary.color,primary.backgroundColor)};
  });
}

try {
  const fixture = await snapshot(), createdAt = new Date().toISOString();
  fixture.state.projects = [{id:'settings-preview',name:'字体设置预览',summary:'总体情况字体预览：中文与 English。\n\n代码 `const total = 1`，公式 $E=mc^2$。',createdAt,archivedAt:null,tasks:[
    {id:'settings-task',parentId:null,title:'事项字体预览\n\n普通正文与 `code`。',status:'doing',order:0},
    {id:'settings-child',parentId:'settings-task',title:'待办子事项',status:'todo',order:0},
  ]}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture)})).status,200);
  await page.goto(origin);await saved();
  const before = await snapshot();
  const button = page.locator('.topbar [data-action="settings"]');
  assert.equal((await button.textContent()).trim(),'');assert.equal(await button.locator('svg').count(),1);
  assert.equal(await button.getAttribute('aria-label'),'设置');
  const baseline = await expectAppearance('system',14);
  await page.locator('.topbar [data-action="help"]').click();
  const helpBaseline = await page.locator('.help-content').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.equal(await page.locator('[data-action="reset-close-choice"]').count(),0);await closeDialog();
  await openSettings();
  assert.equal(await font().inputValue(),'system');assert.equal(await size().inputValue(),'14');
  assert.deepEqual((await font().locator('option').evaluateAll(options => options.map(option => option.value))).sort(),['smiley','system']);
  assert.deepEqual(await size().locator('option').evaluateAll(options => options.map(option => Number(option.value))),Array.from({length:13},(_,index) => index+12));
  assert.equal(await page.locator('[data-close-preference],[data-action="reset-close-choice"]').count(),0);
  passed('顶部设置使用纯图标，默认系统字体和14px，字号仅提供12至24px，浏览器模式不显示原生关闭偏好');

  assert.equal(await palette().getAttribute('aria-label'),'颜色配色');
  assert.deepEqual(await palette().locator('option').evaluateAll(options => options.map(option => option.value)),palettes);
  assert.equal(await palette().inputValue(),'default');
  const defaultColors = await colors(), pageColors = new Set();
  assert.equal(defaultColors.page,'rgb(233, 237, 228)');
  assert.equal(defaultColors.card,'rgb(248, 249, 243)');
  assert.equal(defaultColors.primary,'rgb(53, 101, 75)');
  for (const selected of palettes.slice(1)) {
    await palette().selectOption(selected);
    const actual = await colors();
    assert.equal(actual.palette,selected);
    for (const key of ['page','topbar','project','card','dialog','border','primary']) assert.notEqual(actual[key],defaultColors[key],`${selected}: ${key}`);
    assert.ok(actual.textContrast >= 4.5,`${selected}: text contrast ${actual.textContrast}`);
    assert.ok(actual.buttonContrast >= 4.5,`${selected}: button contrast ${actual.buttonContrast}`);
    pageColors.add(actual.page);
    assert.deepEqual(JSON.parse(await appearance()),{font:'system',size:14,palette:selected});
    await page.reload();await saved();await expectAppearance('system',14);await openSettings();
    assert.equal(await palette().inputValue(),selected);assert.deepEqual(await colors(),actual);
  }
  assert.equal(pageColors.size,6);
  await font().selectOption('smiley');await size().selectOption('18');
  assert.deepEqual(JSON.parse(await appearance()),{font:'smiley',size:18,palette:'clay'});
  assert.equal((await colors()).palette,'clay');
  await font().selectOption('system');await size().selectOption('14');await palette().selectOption('default');
  assert.deepEqual(await colors(),defaultColors);assert.deepEqual(await snapshot(),before);
  passed('默认配色保持原样，六套配色同步更新全界面且满足文字对比度，重载保留选择，字体字号切换保留配色且不改业务数据');

  await font().selectOption('smiley');await size().selectOption('18');
  const changed = await expectAppearance('smiley',18);await expectSmileyLoaded();
  assert.deepEqual(JSON.parse(await appearance()),{font:'smiley',size:18,palette:'default'});
  for (const key of ['projectSize','columnSize','buttonSize']) assert.equal(changed[key]-baseline[key],4,key);
  await page.screenshot({path:path.resolve('test-results/settings.png')});
  await closeDialog();
  await page.locator('.column.doing .task-card[data-task="settings-task"] .task-content').click();
  const taskEditor = await page.locator('[data-inline-editor="task"]').evaluate(element => ({size:parseFloat(getComputedStyle(element).fontSize),family:getComputedStyle(element).fontFamily}));
  assert.equal(taskEditor.size,18);assert.equal(taskEditor.family,changed.family);
  await page.locator('[data-inline-editor]').press('Escape');
  await page.locator('.overview-content').click();
  const summaryEditor = await page.locator('[data-inline-editor="summary"]').evaluate(element => ({size:parseFloat(getComputedStyle(element).fontSize),family:getComputedStyle(element).fontFamily}));
  assert.equal(summaryEditor.size,18);assert.equal(summaryEditor.family,changed.family);
  await page.locator('[data-inline-editor]').press('Escape');
  await page.locator('.topbar [data-action="help"]').click();
  assert.equal(await page.locator('.help-content').evaluate(element => parseFloat(getComputedStyle(element).fontSize)),helpBaseline+4);
  await closeDialog();
  assert.deepEqual(await snapshot(),before);
  passed('得意黑真实加载并立即应用，事项/总体情况及编辑器同步，标题按钮帮助按基础字号偏移，代码和公式保留专用字体');

  await page.reload();await saved();await expectAppearance('smiley',18);await expectSmileyLoaded();
  await openSettings();assert.equal(await font().inputValue(),'smiley');assert.equal(await size().inputValue(),'18');
  await page.setViewportSize({width:760,height:900});
  for (const boundary of [12,24]) {
    await size().selectOption(String(boundary));await expectAppearance('smiley',boundary);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await page.locator('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x+bounds.width <= 761,JSON.stringify(bounds));
  }
  await page.setViewportSize({width:420,height:900});
  assert.ok(await page.locator('dialog').evaluate(element => element.scrollWidth <= element.clientWidth));
  const narrowBounds = await page.locator('dialog').boundingBox();
  assert.ok(narrowBounds.x >= 0 && narrowBounds.x+narrowBounds.width <= 421,JSON.stringify(narrowBounds));
  await font().selectOption('system');await expectAppearance('system',24);
  assert.deepEqual(JSON.parse(await appearance()),{font:'system',size:24,palette:'default'});
  await closeDialog();assert.deepEqual(await snapshot(),before);
  await page.setViewportSize({width:1440,height:1000});
  passed('字体和字号重载后保持，12px/24px边界及窄窗口布局正常，切回系统字体即刻生效且不修改业务数据');

  for (const invalid of ['not-json','null','[]',JSON.stringify({font:'unknown',size:14}),... [11,25,14.5,'20'].map(size => JSON.stringify({font:'system',size}))]) {
    await page.evaluate(value => localStorage.setItem('yishi.appearance',value),invalid);
    await page.reload();await saved();await expectAppearance('system',14);
  }
  assert.deepEqual(await snapshot(),before);
  passed('非法JSON、未知字体和越界/非整数字号均回退到有效默认值，不影响工作区');

  for (const invalid of ['unknown',null,7,{},['mist']]) {
    await page.evaluate(value => localStorage.setItem('yishi.appearance',JSON.stringify({font:'smiley',size:18,palette:value})),invalid);
    await page.reload();await saved();await expectAppearance('smiley',18);await openSettings();
    assert.equal(await palette().inputValue(),'default');assert.deepEqual(await colors(),defaultColors);await closeDialog();
  }
  await page.evaluate(() => localStorage.setItem('yishi.appearance',JSON.stringify({font:'smiley',size:18})));
  await page.reload();await saved();await expectAppearance('smiley',18);await openSettings();
  assert.equal(await palette().inputValue(),'default');await palette().selectOption('mist');
  assert.deepEqual(JSON.parse(await appearance()),{font:'smiley',size:18,palette:'mist'});await closeDialog();
  passed('无效配色回退默认并保留有效字体字号，旧版外观偏好兼容且可保存新配色');

  await page.evaluate(() => localStorage.removeItem('yishi.appearance'));
  await page.reload();await saved();await expectAppearance('system',14);
  const storedBeforeFailure = await appearance();
  await page.evaluate(() => {
    window.__settingsOriginalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if (key === 'yishi.appearance') throw new DOMException('Storage unavailable','QuotaExceededError');
      return window.__settingsOriginalSetItem.call(this,key,value);
    };
  });
  await openSettings();await font().selectOption('smiley');await size().selectOption('20');await palette().selectOption('rose');
  await expectAppearance('smiley',20);await expectSmileyLoaded();
  assert.equal((await colors()).palette,'rose');
  assert.equal(await appearance(),storedBeforeFailure);
  await page.evaluate(() => {Storage.prototype.setItem=window.__settingsOriginalSetItem;delete window.__settingsOriginalSetItem;});
  await page.reload();await saved();await expectAppearance('system',14);
  await openSettings();assert.deepEqual(await colors(),defaultColors);await closeDialog();
  assert.deepEqual(await snapshot(),before);assert.deepEqual(errors,[]);
  passed('localStorage写入异常仍应用本次外观设置，未保存的偏好不会伪装为持久化，所有外观调整均不写业务JSON');
  console.log(`Settings UI: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
