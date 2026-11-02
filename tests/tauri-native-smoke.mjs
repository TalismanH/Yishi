// Run against a built EXE; PLAYWRIGHT_MODULE may point to an existing installation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createInitialState} from '../public/model.mjs';
import {createTodoServer} from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable = process.env.TAURI_EXE || path.join(root,'src-tauri','target','release','yishi-desktop.exe');
await access(executable);
const modulePath = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const temporary = await mkdtemp(path.join(tmpdir(),'yishi-native-'));
const dataDir = path.join(temporary,'native'), legacyDir = path.join(temporary,'legacy');
const downloads = path.join(temporary,'downloads');
const artifacts = path.join(root,'test-results','native-migration');
await Promise.all([mkdir(legacyDir),mkdir(downloads),mkdir(artifacts,{recursive:true})]);
const initial = createInitialState();
initial.projects.push({...structuredClone(initial.projects[2]),id:'archived-fixture',name:'已归档测试',archivedAt:new Date().toISOString()});
const legacyBytes = `${JSON.stringify({state:initial,revision:17},null,2)}\n`;
await writeFile(path.join(legacyDir,'workspace.json'),legacyBytes);
const failures = [], requests = [], checks = [];
let child, browser, page, cdp, referenceBrowser, referenceServer;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
const exited = process => process.exitCode !== null || process.signalCode !== null;
async function until(predicate,message,timeout=12000) {
  const deadline = Date.now()+timeout;
  while (Date.now()<deadline) {if (await predicate()) return;await pause(80);}
  throw new Error(message);
}
function passed(message) {checks.push(message);console.log(`✓ ${message}`);}
const snapshot = async () => JSON.parse(await readFile(path.join(dataDir,'workspace.json'),'utf8'));
const saved = async () => page.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
const editor = () => page.locator('[data-inline-editor]');
const card = id => page.locator(`.task-card[data-task="${id}"]:not(.context)`);
async function finish(value) {
  if (value !== undefined) await editor().fill(value);
  await editor().press('Control+Enter');
  await page.waitForFunction(() => !document.querySelector('[data-inline-editor]'));
  await saved();
}
async function invoke(command,args) {
  return page.evaluate(({command,args}) => window.__TAURI__.core.invoke(command,args),{command,args});
}
async function replaceState(state) {
  const {revision} = await snapshot();
  await invoke('save_workspace',{state,revision});
  await page.reload();await saved();
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function launch() {
  const debugPort = await port();
  const profile=path.join(temporary,`webview-${debugPort}`);
  await mkdir(path.join(profile,'EBWebView','Default'),{recursive:true});
  // Keep the native download behavior; only its default destination is isolated.
  await writeFile(path.join(profile,'EBWebView','Default','Preferences'),JSON.stringify({download:{default_directory:downloads}}));
  child = spawn(executable,[],{cwd:root,windowsHide:false,detached:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
    TODO_DATA_DIR:dataDir,TODO_LEGACY_DATA_DIR:legacyDir,
    WEBVIEW2_USER_DATA_FOLDER:profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort} --force-device-scale-factor=1`}});
  child.stdout.on('data',chunk => {process.stdout.write(chunk);});
  child.stderr.on('data',chunk => {process.stderr.write(chunk);});
  child.on('error',error => failures.push(error.message));
  await until(async () => {
    if (exited(child)) throw new Error(`Native process exited: ${child.exitCode ?? child.signalCode}`);
    try {return (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).ok;} catch {return false;}
  },'WebView2 CDP endpoint did not start',30000);
  // Playwright otherwise changes native downloads to "deny" when attaching.
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{noDefaults:true});
  await until(() => browser.contexts().some(context => context.pages().some(candidate => /tauri[.:]/.test(candidate.url()))),'Bundled native page did not load');
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => /tauri[.:]/.test(candidate.url()));
  page.setDefaultTimeout(10000);
  page.on('pageerror',error => failures.push(error.message));
  page.on('request',request => {requests.push(request.url());});
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await saved();
}
async function closeNative() {
  const owned = child;
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(error => {
    if (!/Target (?:page|closed)|has been closed/.test(error.message)) throw error;
  });
  await page.locator('[data-close-choice="exit"]').click().catch(error => {
    if (!/Target (?:page|closed)|has been closed/.test(error.message)) throw error;
  });
  await until(() => exited(owned),'Native close did not finish',15000);
  await browser.close().catch(() => {});browser = null;child = null;
}
async function pointerDrag(id,target,{nest=false,ratio=.15,release=true}={}) {
  const handle = card(id).locator('.drag-handle');
  await handle.evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  const start = await handle.boundingBox();
  await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
  await page.mouse.down();
  await page.mouse.move(start.x+start.width/2+8,start.y+start.height/2,{steps:2});
  const destination = nest ? page.locator(`.drop-nest[data-nest="${target}"]`).first() : card(target);
  await destination.evaluate(element => element.scrollIntoView({block:'nearest',inline:'nearest'}));
  const box = await destination.boundingBox();
  await page.mouse.move(box.x+(nest ? box.width/2 : Math.min(25,box.width/2)),box.y+box.height*ratio,{steps:8});
  if (release) {await page.mouse.up();await saved();}
}
async function presentation(surface) {
  await surface.evaluate(async () => {await document.fonts.ready;});
  return surface.evaluate(() => {
    const selectors='.topbar,.brand,.nav-item,.projects,.project,.project-header,.project-title,.project-name,.overview,.overview-header h2,.overview-content,.board,.column,.column-heading,.column-items,.task-card,.task-content,.katex';
    const properties=['fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','writingMode','overflowY'];
    return [...document.querySelectorAll(selectors)].map(element => {
      const style=getComputedStyle(element), box=element.getBoundingClientRect();
      return {tag:element.tagName,className:element.className,text:element.textContent,styles:Object.fromEntries(properties.map(key => [key,style[key]])),box:{x:box.x,y:box.y,width:box.width,height:box.height}};
    });
  });
}
async function compareLegacyPresentation() {
  const referenceDir=path.join(temporary,'reference');await mkdir(referenceDir);
  await writeFile(path.join(referenceDir,'workspace.json'),legacyBytes);
  referenceServer=await createTodoServer({dataDir:referenceDir});
  await new Promise(resolve => referenceServer.listen(0,'127.0.0.1',resolve));
  referenceBrowser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  const reference=await referenceBrowser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  await reference.goto(`http://127.0.0.1:${referenceServer.address().port}`);
  await reference.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await page.mouse.move(0,0);await reference.mouse.move(0,0);
  const native=await presentation(page), legacy=await presentation(reference);
  await page.screenshot({path:path.join(artifacts,'native-initial.png')});
  await reference.screenshot({path:path.join(artifacts,'legacy-initial.png')});
  await writeFile(path.join(artifacts,'presentation.json'),JSON.stringify({native,legacy},null,2));
  assert.equal(native.length,legacy.length);
  for (let index=0;index<native.length;index++) {
    const {box:nativeBox,...nativeAppearance}=native[index],{box:legacyBox,...legacyAppearance}=legacy[index];
    assert.deepEqual(nativeAppearance,legacyAppearance,`Native presentation differs at element ${index}`);
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(nativeBox[key]-legacyBox[key])<1,`Native ${key} differs at element ${index}: ${nativeBox[key]} vs ${legacyBox[key]}`);
  }
  await referenceBrowser.close();referenceBrowser=null;
  await new Promise(resolve => referenceServer.close(resolve));referenceServer=null;
}

try {
  await launch();
  assert.match(page.url(),/^https?:\/\/tauri\.localhost\/?|^tauri:\/\/localhost\/?/);
  assert.ok(await page.evaluate(() => Boolean(window.__TAURI__?.core?.invoke)));
  passed('EXE 使用捆绑页面和原生 IPC，不依赖 Node HTTP 服务');
  assert.deepEqual(await snapshot(),{state:initial,revision:17});
  assert.equal(await readFile(path.join(legacyDir,'workspace.json'),'utf8'),legacyBytes);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'workspace.json.migration.bak'),'utf8')),JSON.parse(legacyBytes));
  passed('首次启动完整复制旧版本数据和修订号，源文件保持不变');
  await compareLegacyPresentation();
  passed('原生与旧 HTTP 版同一数据和视口的文本、字体、颜色、边框及布局一致');
  const projectOrder = () => page.locator('.projects>.project').evaluateAll(elements => elements.map(element => element.id));
  const expectedOrder = initial.projects.filter(project => !project.archivedAt).map(project => `project-${project.id}`);
  assert.deepEqual(await projectOrder(),expectedOrder);
  await page.locator('[data-action="toggle"][data-project="learning"]').click();
  assert.deepEqual(await projectOrder(),expectedOrder);
  assert.equal(await page.locator('.project.expanded').getAttribute('id'),'project-learning');
  await page.locator('[data-action="toggle"][data-project="workspace"]').click();
  assert.deepEqual(await projectOrder(),expectedOrder);
  assert.equal(await page.locator('.project.collapsed .project-title').first().evaluate(element => getComputedStyle(element).writingMode),'vertical-rl');
  passed('展开首个和中间项目时保持横向顺序、单一展开和竖向标题');
  assert.deepEqual(await page.locator('.column').evaluateAll(elements => elements.map(element => element.dataset.column)),['todo','doing','done']);
  assert.deepEqual(await page.locator('.column-heading').allTextContents(),['待办项','进行中','已完成']);
  assert.equal(await page.locator('.column.done [data-action="add-task"]').count(),0);
  assert.equal(await page.locator('.column.todo .task-check').count(),0);
  assert.ok((await page.locator('.overview-header h2,.column-heading').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize))).every(value => value==='16px'));
  passed('三列顺序、标题字号、状态按钮及简洁布局保持一致');
  await page.locator('[data-action="help"]').click();
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.ok((await page.locator('dialog').boundingBox()).width>=600);
  assert.match(await page.locator('dialog').textContent(),/Markdown/);
  assert.equal(await page.locator('dialog input,dialog textarea').count(),0);
  await page.locator('dialog .dialog-footer [data-action="close"]').click();
  passed('帮助窗口宽度和快捷键说明在原生 WebView 中正常显示');
  await page.locator('.overview-content').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await finish('**原生 Markdown**\n\n- 连续编辑\n\n$E=mc^2$\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$');
  assert.equal(await page.locator('.overview strong').textContent(),'原生 Markdown');
  assert.equal(await page.locator('.overview .katex').count(),2);
  await page.evaluate(async () => {await document.fonts.ready;});
  assert.equal(await page.locator('.katex').first().evaluate(element => getComputedStyle(element).fontFamily),'KaTeX_Main, "Times New Roman", serif');
  const fonts = await page.evaluate(() => [...document.fonts].filter(font => font.family.startsWith('KaTeX')).map(font => ({family:font.family,status:font.status})));
  assert.ok(fonts.some(font => font.family==='KaTeX_Main'&&font.status==='loaded'));
  assert.equal(fonts.filter(font => font.status==='error').length,0);
  passed('Markdown 和行内、块级公式直接编辑并加载本地 KaTeX 样式字体');
  await page.locator('[data-action="add-project"]').click();await finish('原生验收');
  const projectId = (await snapshot()).state.projects.find(project => project.name==='原生验收').id;
  const currentProject = async () => (await snapshot()).state.projects.find(project => project.id===projectId);
  await page.locator('.column.todo .add-task').click();
  await editor().fill('一级事项');await editor().press('Enter');
  await editor().fill('二级事项');await editor().press('Tab');await editor().press('Enter');
  await editor().fill('三级事项');await editor().press('Tab');await finish();
  let project = await currentProject();
  assert.equal(project.tasks.length,3);
  const first = project.tasks.find(task => task.parentId===null).id;
  const second = project.tasks.find(task => task.parentId===first).id;
  const third = project.tasks.find(task => task.parentId===second).id;
  assert.equal(await page.locator('dialog[open]').count(),0);
  await card(third).locator('.task-content').click();await editor().press('Shift+Tab');await finish();
  assert.equal((await currentProject()).tasks.find(task => task.id===third).parentId,first);
  await card(third).locator('.task-content').click();await editor().press('Tab');await finish();
  assert.equal((await currentProject()).tasks.find(task => task.id===third).parentId,second);
  passed('连续输入创建三级事项，Tab 和 Shift+Tab 调整层级且无编辑弹窗');
  await page.locator('.column.todo .add-task').click();await finish('目标主事项');
  const target = (await currentProject()).tasks.find(task => task.title==='目标主事项').id;
  await pointerDrag(third,target,{nest:true,ratio:.5});
  assert.equal((await currentProject()).tasks.find(task => task.id===third).parentId,target);
  await pointerDrag(third,second,{nest:true,ratio:.5});
  assert.equal((await currentProject()).tasks.find(task => task.id===third).parentId,second);
  await pointerDrag(first,second,{release:false});
  assert.ok(await card(first).evaluate(element => element.classList.contains('drag-blocked')));
  assert.ok(await card(second).evaluate(element => element.classList.contains('drag-blocked')));
  assert.equal(await page.locator('.drag-blocked.drop-before,.drag-blocked.drop-after,.drag-blocked .drop-nest.over').count(),0);
  await page.keyboard.press('Escape');await page.mouse.up();
  passed('三级事项可独立拖动，父子事项禁止位置不显示有效放置提示');
  const beforeCross = await currentProject();
  const handle = card(first).locator('.drag-handle'), start = await handle.boundingBox();
  await page.mouse.move(start.x+5,start.y+5);await page.mouse.down();await page.mouse.move(start.x+14,start.y+5);
  const doingBox = await page.locator('.column.doing .column-items').boundingBox();
  await page.mouse.move(doingBox.x+30,doingBox.y+30,{steps:8});await page.mouse.up();await saved();
  assert.deepEqual(await currentProject(),beforeCross);
  await card(first).locator('[data-action="status"][data-status="doing"]').click();await saved();
  assert.ok((await currentProject()).tasks.filter(task => [first,second,third].includes(task.id)).every(task => task.status==='doing'));
  await card(first).locator('[data-action="complete"]').click();await saved();
  assert.ok((await currentProject()).tasks.filter(task => [first,second,third].includes(task.id)).every(task => task.status==='done'));
  await card(first).locator('[data-action="complete"]').click();await saved();
  await card(first).locator('[data-action="status"][data-status="todo"]').click();await saved();
  assert.ok((await currentProject()).tasks.filter(task => [first,second,third].includes(task.id)).every(task => task.status==='todo'));
  passed('禁止跨列拖动，状态严格依次切换并连带后代');
  await page.locator('[data-action="delete-project"]').click();
  await page.locator('dialog .secondary[data-action="close"]').click();
  assert.ok(await currentProject());
  await card(first).locator('[data-action="status"][data-status="doing"]').click();await saved();
  await card(first).locator('[data-action="complete"]').click();await saved();
  await card(target).locator('[data-action="status"][data-status="doing"]').click();await saved();
  await card(target).locator('[data-action="complete"]').click();await saved();
  await page.locator('[data-action="archive"]').click();await page.locator('dialog .secondary[data-action="close"]').click();
  assert.equal((await currentProject()).archivedAt,null);
  await page.locator('[data-action="archive"]').click();await page.locator('dialog button[type="submit"]').click();await saved();
  assert.ok((await currentProject()).archivedAt);
  await page.locator('[data-view="archived"]').click();
  await page.locator(`[data-action="toggle"][data-project="${projectId}"]`).click();
  assert.equal(await page.locator('.project.expanded .drag-handle,.project.expanded [data-action="edit-task"]').count(),0);
  await page.locator('[data-action="restore"]').click();await saved();
  assert.equal((await currentProject()).archivedAt,null);
  await page.locator('[data-action="delete-project"]').click();await page.locator('dialog button[type="submit"]').click();await saved();
  assert.equal(await currentProject(),undefined);
  passed('项目删除、归档均需二次确认，取消、归档只读浏览和恢复正常');
  const scrollState = createInitialState(), workspace = scrollState.projects[0];
  scrollState.projects.push(structuredClone(initial.projects.at(-1)));
  workspace.summary='独立滚动';
  workspace.tasks=['todo','doing','done'].flatMap(status => Array.from({length:45},(_,index) => ({id:`${status}-${index}`,parentId:null,title:`${status} 事项 ${index}`,status,order:index})));
  workspace.tasks.push({id:'blocked-root',parentId:null,title:'不能提前完成',status:'doing',order:46},{id:'blocked-child',parentId:'blocked-root',title:'必须先处理待办子事项',status:'todo',order:47});
  await replaceState(scrollState);
  for (const status of ['todo','doing','done']) {
    const pane=page.locator(`.column.${status} .column-items`);
    assert.equal(await pane.evaluate(element => getComputedStyle(element).overflowY),'auto');
    assert.equal(await pane.evaluate(element => getComputedStyle(element).scrollbarWidth),'none');
    await pane.evaluate(element => {element.scrollTop=180;});
  }
  const offsets = () => page.locator('.column-items').evaluateAll(elements => elements.map(element => element.scrollTop));
  assert.deepEqual(await offsets(),[180,180,180]);
  await pointerDrag('todo-20','todo-19');
  const afterDrag = await offsets();assert.equal(afterDrag[1],180);assert.equal(afterDrag[2],180);assert.ok(afterDrag[0]>0);
  passed('三列独立滚动且隐藏滚动条，拖动渲染保留滚动位置');
  await card('blocked-root').locator('[data-action="complete"]').click();
  await page.locator('.pending-attention[data-task="blocked-child"]').waitFor();
  assert.equal((await snapshot()).state.projects[0].tasks.find(task => task.id==='blocked-root').status,'doing');
  await page.waitForFunction(() => {
    const element=document.querySelector('.task-card[data-task="blocked-child"]:not(.context)');
    const pane=element.closest('.column-items').getBoundingClientRect(),box=element.getBoundingClientRect();
    return box.top>=pane.top&&box.bottom<=pane.bottom;
  });
  assert.ok(await card('blocked-child').evaluate(element => {const pane=element.closest('.column-items').getBoundingClientRect(),box=element.getBoundingClientRect();return box.top>=pane.top&&box.bottom<=pane.bottom;}));
  passed('提前完成父事项会定位并高亮待办子事项且不改变状态');
  const exportedState=(await snapshot()).state;
  const existingName=`一事-备份-${new Date().toLocaleDateString('sv-SE')}.json`;
  await writeFile(path.join(downloads,existingName),'existing backup must survive');
  const exportedNames=async () => (await readdir(downloads)).filter(name => name.endsWith('.json')&&name!==existingName);
  let previousFeedback='';
  for(let index=0;index<2;index++) {
    await page.locator('[data-action="export"]').click();
    await until(async () => (await exportedNames()).length===index+1,'原生 WebView 没有保留导出的 JSON 文件');
    await page.waitForFunction(previous => {
      const toast=document.querySelector('#toast.visible');
      return toast?.textContent.startsWith('备份已导出至：')&&toast.textContent!==previous;
    },previousFeedback);
    previousFeedback=await page.locator('#toast').textContent();
    const exportedPath=previousFeedback.slice('备份已导出至：'.length);
    assert.equal(path.dirname(path.resolve(exportedPath)),path.resolve(downloads));
    assert.deepEqual(JSON.parse(await readFile(exportedPath,'utf8')),exportedState);
  }
  for(const exportedFile of await exportedNames()) assert.deepEqual(JSON.parse(await readFile(path.join(downloads,exportedFile),'utf8')),exportedState);
  assert.equal(await readFile(path.join(downloads,existingName),'utf8'),'existing backup must survive');
  await page.screenshot({path:path.join(artifacts,'native-export-feedback.png')});
  passed('原生默认下载导出全部项目并提示真实路径，重复导出自动编号且不覆盖备份');
  const latest=await snapshot();
  const accepted=await invoke('save_workspace',{state:latest.state,revision:latest.revision});
  const conflict=await page.evaluate(async ({state,revision}) => {try {await window.__TAURI__.core.invoke('save_workspace',{state,revision});return null;} catch (error) {return error;}},latest);
  assert.equal(conflict.status,409);assert.ok(conflict.message);
  assert.ok(accepted);
  await page.reload();await saved();
  passed('原生保存拒绝旧修订号，保留版本冲突保护');
  await page.screenshot({path:path.join(artifacts,'native-desktop.png')});
  await page.locator('.overview-content').click();await editor().fill('关闭窗口前最后输入 $x^2$');
  await closeNative();
  assert.equal((await snapshot()).state.projects[0].summary,'关闭窗口前最后输入 $x^2$');
  await launch();
  assert.match(await page.locator('.overview-content').textContent(),/关闭窗口前最后输入/);
  assert.equal(await page.locator('.overview .katex').count(),1);
  assert.equal(await readFile(path.join(legacyDir,'workspace.json'),'utf8'),legacyBytes);
  passed('原生关闭会保存尚未防抖的输入，重启后数据和公式完整恢复');
  assert.deepEqual(requests.filter(url => /\/api\/state(?:$|\?)/.test(url)||/^http:\/\/127\.0\.0\.1:4317/.test(url)),[]);
  assert.deepEqual(failures,[]);
  passed('原生测试期间没有网页服务请求和页面运行错误');
  await closeNative();
} catch(error) {
  failures.push(error.message);
  if (page&&!page.isClosed()) await page.screenshot({path:path.join(artifacts,'native-failure.png')}).catch(() => {});
  throw error;
} finally {
  // Only the process launched above belongs to this test; never stop shared Edge or Node processes.
  if (child&&!exited(child)) {child.kill();await until(() => exited(child),'Owned EXE did not exit').catch(() => {});}
  if (browser) await browser.close().catch(() => {});
  if (referenceBrowser) await referenceBrowser.close().catch(() => {});
  if (referenceServer) await new Promise(resolve => referenceServer.close(resolve));
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify({checks,failures,requests},null,2));
  const relative=path.relative(path.resolve(tmpdir()),path.resolve(temporary));
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Temporary cleanup escaped the OS temp directory');
  await rm(temporary,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
console.log(`Native smoke: ${checks.length} checks passed`);
