// OBSIDIAN_EXE points to an installed desktop runtime; all data lives in a temporary vault.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInitialState} from '../public/model.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
assert.ok(process.env.OBSIDIAN_EXE, 'Set OBSIDIAN_EXE to the desktop executable');
const directory = await mkdtemp(path.join(tmpdir(), 'yishi-obsidian-'));
const vault = path.join(directory, 'vault'), profile = path.join(directory, 'profile');
const config = path.join(vault, '.obsidian'), data = path.join(vault, '一事');
await Promise.all([mkdir(config, {recursive: true}), mkdir(profile), mkdir(data, {recursive: true})]);
if (process.env.OBSIDIAN_ASAR) await cp(process.env.OBSIDIAN_ASAR, path.join(profile, path.basename(process.env.OBSIDIAN_ASAR)));
await cp(path.resolve('dist/yishi'), path.join(config, 'plugins/yishi'), {recursive: true});
const seed = createInitialState();
seed.projects[0].summary = '# Obsidian 验证\n\n公式 $x^2 + y^2 = z^2$\n\n- 列表\n普通段落';
await Promise.all([
  writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({vaults: {'0123456789abcdef': {path: vault, ts: Date.now(), open: true}}, cli: true})),
  writeFile(path.join(config, 'community-plugins.json'), '["yishi"]'),
  writeFile(path.join(config, 'app.json'), '{"communityPluginEnabled":true}'),
  writeFile(path.join(data, 'workspace.json'), JSON.stringify({state: seed, revision: 0})),
  writeFile(path.join(vault, '宿主笔记.md'), '# 普通笔记\n\n宿主样式与快捷键验证。'),
]);
let browser, child, checks = 0;
const errors = [];
const passed = message => {checks++; console.log(`✓ ${message}`);};
const disk = async () => JSON.parse(await readFile(path.join(data, 'workspace.json'), 'utf8'));
try {
  child = spawn(process.env.OBSIDIAN_EXE, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-sandbox'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Obsidian debugging endpoint did not start')), 30000);
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    const inspect = chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {clearTimeout(timeout); resolve(match[1]);}
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.bringToFront();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.app?.plugins, null, {timeout: 30000});
  const trust = page.getByRole('button', {name: /信任仓库作者并启用插件|Trust author and enable plugins/});
  await trust.click();
  await page.waitForFunction(() => window.app?.plugins?.plugins?.yishi, null, {timeout: 30000});
  async function confirmImport() {
    // Obsidian can place a Modal in its separate settings window.
    const button = (await Promise.all(context.pages().map(async window => {
      const candidate = window.getByRole('button', {name: '备份并导入', exact: true});
      return await candidate.count() ? candidate : null;
    }))).find(Boolean);
    assert.ok(button, 'Import confirmation is visible in an Obsidian window');
    await button.click();
    await button.waitFor({state: 'detached'});
  }
  await page.evaluate(async () => {await app.plugins.plugins.yishi.openWorkbench();});
  const root = page.locator('.yishi-workbench');
  const saved = () => root.locator('[data-save-status][data-state="saved"]').waitFor({state: 'attached'});
  await saved();
  assert.equal(await root.locator('.column').count(), 3);
  assert.ok(await root.locator('.katex').count());
  const size = await root.boundingBox();
  assert.ok(size.width > 300 && size.height > 300);
  assert.equal(await root.locator('.shell').evaluate(element => Math.round(element.getBoundingClientRect().height)), Math.round(size.height));
  assert.equal(await root.evaluate(element => getComputedStyle(element).fontSize), '14px');
  assert.ok(await root.locator('.project-body').evaluate(element => parseFloat(getComputedStyle(element).paddingLeft) >= 16));
  passed('真实 Obsidian 加载插件、三列工作台、公式和容器高度正确');

  const firstTask = seed.projects[0].tasks.find(task => task.parentId === null && task.status === 'todo');
  const task = () => root.locator(`.task-card[data-task="${firstTask.id}"]:not(.context) .task-content`);
  const regressions = [];
  const selectGeometry = () => root.locator('select').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return {label:element.getAttribute('aria-label'),height:element.clientHeight,
      required:parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)};
  }));
  await root.locator('[data-action="settings"]').click();
  for (const control of await selectGeometry()) if (control.height+1 < control.required) regressions.push(`Select clips text: ${control.label}`);
  await root.locator('.dialog-footer [data-action="close"]').click();
  await task().click();
  const inline = root.locator('[data-inline-editor]');
  await inline.fill('alpha beta gamma');
  await inline.evaluate(element => element.setSelectionRange(6,10));
  await inline.press('Control+b');
  if (await inline.inputValue() !== 'alpha **beta** gamma') regressions.push('Obsidian intercepted Ctrl+B');
  assert.deepEqual(regressions, []);
  await inline.press('Control+b');
  assert.equal(await inline.inputValue(), 'alpha beta gamma');
  await inline.evaluate(element => element.setSelectionRange(0,0));
  await inline.press('Control+b');
  assert.equal(await inline.inputValue(), '****alpha beta gamma');
  await inline.press('Control+b');
  assert.equal(await inline.inputValue(), 'alpha beta gamma');
  await inline.press('Control+Enter');
  await root.locator('.overview-content').click();
  const summary = root.locator('[data-inline-editor="summary"]');
  await summary.fill('总体情况加粗');
  await summary.evaluate(element => element.setSelectionRange(0,4));
  await summary.press('Control+b');
  assert.equal(await summary.inputValue(), '**总体情况**加粗');
  await summary.press('Control+b');
  assert.equal(await summary.inputValue(), '总体情况加粗');
  await summary.fill(seed.projects[0].summary);
  await summary.press('Control+Enter');
  await task().focus();
  await task().press('Control+f');
  assert.equal(await root.locator('[data-search-query]').count(), 1);
  await root.locator('[data-search-query]').press('Escape');
  passed('物理 Ctrl+B 在正文和总体情况中加粗、取消和插入标记，Ctrl+F 正常');

  await page.evaluate(async () => {
    const leaf=app.workspace.getLeaf('tab');
    await leaf.openFile(app.vault.getFileByPath('宿主笔记.md'));
    leaf.view.editor.setValue('host bold');
    leaf.view.editor.setSelection({line:0,ch:0},{line:0,ch:4});
    leaf.view.editor.focus();
  });
  await page.keyboard.press('Control+b');
  assert.equal(await page.evaluate(() => app.workspace.activeEditor.editor.getValue()), '**host** bold');
  await page.evaluate(async () => {await app.plugins.plugins.yishi.openWorkbench();});
  passed('切换普通 Markdown 笔记后 Ctrl+B 仍由宿主处理');

  await task().focus();
  await task().press('Control+p');
  const paletteInput = (await Promise.all(context.pages().map(async window => {
    const input=window.locator('.prompt-input');
    return await input.count() ? input : null;
  }))).find(Boolean);
  assert.ok(paletteInput, 'Workbench key scope must preserve the host command palette');
  await paletteInput.press('Escape');
  await paletteInput.waitFor({state:'detached'});
  passed('工作台内 Ctrl+P 仍可打开宿主命令面板');

  await task().click();
  await root.locator('[data-inline-editor]').fill('插件内保存测试 **加粗**');
  await root.locator('[data-inline-editor]').press('Control+Enter');
  await root.locator('[data-inline-editor]').waitFor({state:'detached'});
  await saved();
  assert.equal((await disk()).state.projects[0].tasks.find(task => task.id === firstTask.id).title, '插件内保存测试 **加粗**');
  assert.ok((await readdir(data)).includes('workspace.json.bak'));
  passed('编辑写入 JSON 并保留上一有效版本');

  await task().focus();
  await task().press('Control+Shift+Enter');
  await saved();
  assert.equal((await disk()).state.projects[0].tasks.find(task => task.id === firstTask.id).status, 'doing');
  await task().press('Control+Shift+Enter');
  await saved();
  assert.equal((await disk()).state.projects[0].tasks.find(task => task.id === firstTask.id).status, 'todo');
  await root.locator('.column.todo .add-task').click();
  await inline.fill('连续输入回归');
  await inline.press('Enter');
  assert.equal(await inline.inputValue(), '');
  await inline.press('Tab');
  await inline.fill('下级事项回归');
  await inline.press('Escape');
  await saved();
  const keyboardTasks=(await disk()).state.projects[0].tasks;
  assert.equal(keyboardTasks.find(task => task.title==='下级事项回归').parentId, keyboardTasks.find(task => task.title==='连续输入回归').id);
  passed('Ctrl+Enter、状态切换、连续 Enter、Tab 层级和 Esc 完成编辑仍正常');

  await task().click();
  await root.locator('[data-inline-editor]').fill('关闭前尚未防抖保存的内容');
  await page.evaluate(() => app.plugins.disablePlugin('yishi'));
  assert.ok((await readdir(data)).some(name => name.startsWith('recovery-')));
  await page.evaluate(() => app.plugins.enablePlugin('yishi'));
  await page.evaluate(async () => {await app.plugins.plugins.yishi.openWorkbench();});
  await saved();
  assert.equal(await root.count(), 1);
  const recoveries = (await readdir(data)).filter(name => name.startsWith('recovery-'));
  const recovery = JSON.parse(await readFile(path.join(data, recoveries[0]), 'utf8'));
  assert.equal(recovery.state.projects[0].tasks.find(task => task.id === firstTask.id).title, '关闭前尚未防抖保存的内容');
  passed('输入立即保留恢复副本，禁用并重新启用插件可正常重建视图');

  await page.bringToFront();
  await page.evaluate(async text => {await app.plugins.plugins.yishi.importText(text, '恢复测试');}, JSON.stringify(recovery));
  await confirmImport();
  await saved();
  assert.equal((await disk()).state.projects[0].tasks.find(task => task.id === firstTask.id).title, '关闭前尚未防抖保存的内容');
  assert.ok((await readdir(path.join(data, 'backups'))).some(name => name.startsWith('导入前备份')));
  passed('恢复副本可确认导入，覆盖前另存永久备份');

  const external = await disk();
  external.state.projects[0].summary = '外部同步修改，revision 不变';
  await writeFile(path.join(data, 'workspace.json'), JSON.stringify(external));
  await task().click();
  await root.locator('[data-inline-editor]').fill('冲突窗口中必须保留的编辑');
  await root.locator('[data-inline-editor]').press('Control+Enter');
  await root.locator('[data-save-status][data-state="error"]').waitFor({state: 'attached'});
  assert.deepEqual(await disk(), external);
  await page.evaluate(async () => {await (await app.plugins.plugins.yishi.openWorkbench()).reload();});
  await saved();
  assert.match(await root.locator('.overview-content').textContent(), /外部同步修改/);
  const exports = await readdir(path.join(data, 'backups'));
  const conflictExport = await Promise.all(exports.filter(name => name.startsWith('一事-备份')).map(name => readFile(path.join(data, 'backups', name), 'utf8')));
  assert.ok(conflictExport.some(text => text.includes('冲突窗口中必须保留的编辑')));
  passed('同 revision 外部修改触发冲突，重载前自动导出冲突中的编辑');

  const pure = structuredClone(seed);
  pure.projects[0].name = '纯 state 导入';
  await page.evaluate(async text => {await app.plugins.plugins.yishi.importText(text, '旧版 JSON 导出');}, JSON.stringify(pure));
  await confirmImport();
  await saved();
  assert.deepEqual((await disk()).state, pure);
  passed('原版纯 state JSON 可完整导入');

  await page.evaluate(() => app.plugins.plugins.yishi.restoreBackup());
  await confirmImport();
  await saved();
  assert.deepEqual((await disk()).state, external.state);
  passed('上一版本备份可恢复，当前文件同样先备份');

  const before = await disk();
  const reloadView = async () => page.evaluate(async () => {await (await app.plugins.plugins.yishi.openWorkbench()).reload();});
  await reloadView(); await saved();
  await root.locator('[data-action="settings"]').click();
  for (const family of ['system','smiley']) {
    await root.locator('[data-setting-font]').selectOption(family);
    for (const fontSize of ['12','14','24']) {
      await root.locator('[data-setting-size]').selectOption(fontSize);
      await page.evaluate(() => document.fonts.ready);
      for (const control of await selectGeometry()) assert.ok(control.height+1 >= control.required, `${family} ${fontSize}px: ${control.label} is clipped`);
    }
  }
  passed('设置下拉文字在两种字体及 12/14/24px 下均完整显示');
  await root.locator('[data-setting-font]').selectOption('smiley');
  await root.locator('[data-setting-size]').selectOption('18');
  await root.locator('[data-setting-palette]').selectOption('mist');
  await root.locator('.dialog-footer [data-action="close"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), undefined);
  assert.equal(await root.getAttribute('data-palette'), 'mist');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await root.evaluate(element => element.ownerDocument.fonts.check('18px "Smiley Sans"')), true);
  await reloadView(); await saved();
  assert.equal(await root.getAttribute('data-font'), 'smiley');
  assert.ok(await task().evaluate(element => element.clientWidth > 90), 'Task controls must leave readable text width in a narrow view');
  assert.deepEqual(await disk(), before);
  passed('字体离线加载，外观设置重开保留且不修改根文档或任务数据');

  await root.evaluate(element => {element.style.width = '280px';});
  assert.ok(await root.locator('.topbar [data-action="add-project"]').evaluate(button => {
    const parent = button.closest('.yishi-workbench').getBoundingClientRect(), rect = button.getBoundingClientRect();
    return rect.left >= parent.left && rect.right <= parent.right;
  }), 'All toolbar actions remain reachable in narrow desktop splits');
  await root.evaluate(element => {element.style.width = '';});
  passed('280px 桌面分栏中顶栏按钮仍全部可用');

  await mkdir('test-results', {recursive: true});
  await page.screenshot({path: 'test-results/obsidian-workbench.png'});
  assert.deepEqual(errors, []);
  console.log(`Obsidian UI: ${checks} checks passed; ${await page.title()}`);
} catch (error) {
  if (browser) {
    const windows = browser.contexts().flatMap(context => context.pages());
    if (windows[0]) {
      await mkdir('test-results', {recursive: true});
      await windows[0].screenshot({path: 'test-results/obsidian-failure.png'}).catch(() => {});
      console.error(await windows[0].evaluate(() => ({url: location.href, body: document.body.innerText.slice(0,1500), plugin: !!window.app?.plugins?.plugins?.yishi,
        styles: ['.yishi-workbench','.project-body','.task-content','.board'].map(selector => {const element = document.querySelector(selector);if (!element) return {};const style = getComputedStyle(element);return {selector,font: style.font,padding: style.padding,gap: style.gap,display: style.display};})})).catch(() => ({})));
      console.error('Page errors', errors);
    }
  }
  throw error;
} finally {
  if (browser?.isConnected()) {
    const session = await browser.newBrowserCDPSession();
    await Promise.race([session.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
    await browser.close();
  }
  if (child?.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 300});
}
