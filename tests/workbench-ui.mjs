// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTodoServer} from '../server.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(),'yishi-workbench-'));
const server = await createTodoServer({dataDir});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, checks = 0;
const passed = message => {checks++;console.log(`✓ ${message}`);};

try {
  browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
  const page = await browser.newPage({viewport:{width:1600,height:1000}});
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.route(`${origin}/workbench-harness`,route => route.fulfill({contentType:'text/html',body:`<!doctype html>
    <html><head><meta charset="UTF-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/vendor/katex.min.css">
    <style>body{padding:12px} .test-surfaces{display:flex;gap:12px;height:820px;margin-top:12px} .test-surfaces>main{min-width:0;flex:1;overflow:hidden} .test-surfaces .shell{height:100%}</style>
    <script defer src="/vendor/marked.umd.js"></script><script defer src="/vendor/katex.min.js"></script><script defer src="/vendor/contrib/auto-render.min.js"></script>
    </head><body><button id="outside-action" data-action="add-project">外部按钮</button><input id="outside-input" aria-label="外部输入框">
    <div class="test-surfaces"><main id="one" tabindex="-1"></main><main id="two" tabindex="-1"></main></div></body></html>`}));
  await page.goto(`${origin}/workbench-harness`);
  await page.waitForFunction(() => window.marked && window.renderMathInElement);
  await page.evaluate(async () => {
    const {mountWorkbench} = await import('/workbench.mjs');
    window.hosts = {};
    window.controllers = {};
    window.outsideKeys = [];
    document.addEventListener('keydown',event => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') window.outsideKeys.push({target:event.target.id,prevented:event.defaultPrevented});
    });
    window.mount = async name => {
      const host = window.hosts[name] ??= {
        saved:{state:{version:1,projects:[{id:`project-${name}`,name:`项目 ${name}`,summary:'总体情况',createdAt:'2026-01-01T00:00:00.000Z',archivedAt:null,tasks:[{id:`task-${name}`,parentId:null,title:`事项 ${name}`,status:'todo',order:0}]}]},revision:0},
        saves:0,recovery:[],errors:[],exports:[],waiters:[],blocked:false,fail:false,failRecovery:false,
      };
      const preferences = new Map();
      host.options = {
        marked:window.marked,renderMathInElement:window.renderMathInElement,
        storage:{getItem:key => preferences.get(key) ?? null,setItem:(key,value) => preferences.set(key,value)},
        request:async (method = 'GET',payload) => {
          if (method === 'GET') return new Response(JSON.stringify(host.saved));
          payload = structuredClone(payload);
          if (host.blocked) await new Promise(resolve => host.waiters.push(resolve));
          if (host.fail) return new Response('{}',{status:500});
          if (payload.revision !== host.saved.revision) return new Response('{}',{status:409});
          host.saved = {state:payload.state,revision:payload.revision+1};host.saves++;
          return new Response(JSON.stringify({revision:host.saved.revision}));
        },
        onRecovery:snapshot => {
          if (host.failRecovery) throw new Error('测试恢复副本写入失败');
          host.recovery.push(structuredClone(snapshot));
        },
        onError:error => host.errors.push(error.message),
        exportBackup:state => host.exports.push(structuredClone(state)),
      };
      window.controllers[name] = await mountWorkbench(document.getElementById(name),host.options);
    };
    await window.mount('one');await window.mount('two');
    window.scopeResults = [];
    // Model a host keymap running before DOM listeners, without stopping bubbling so duplicate handling is observable.
    document.addEventListener('keydown',event => {
      const handled = window.controllers.one.handleKeydown(event);
      if (handled) event.preventDefault();
      window.scopeResults.push({key:event.key,handled});
    },true);
  });
  const root = name => page.locator(`#${name}`);
  const editor = name => root(name).locator('[data-inline-editor]');
  const task = name => root(name).locator('.task-card:not(.context) .task-content').first();

  assert.equal((await task('one').textContent()).trim(),'事项 one');
  assert.equal((await task('two').textContent()).trim(),'事项 two');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-font-size')),'');
  assert.equal(await root('one').evaluate(element => element.style.getPropertyValue('--ui-font-size')),'14px');
  passed('两个工作台独立挂载，外观变量只写入各自容器');

  await page.locator('#outside-action').click();
  await page.locator('#outside-input').press('Control+f');
  assert.deepEqual(await page.evaluate(() => window.outsideKeys),[{target:'outside-input',prevented:false}]);
  assert.deepEqual(await page.evaluate(() => Object.values(window.controllers).map(controller => controller.getSnapshot().state.projects.length)),[1,1]);
  await root('one').focus();await root('one').press('Control+f');
  assert.equal(await root('one').locator('.task-search').count(),1);
  assert.equal(await root('two').locator('.task-search').count(),0);
  assert.equal(await page.evaluate(() => window.outsideKeys.length),1);
  await root('one').locator('[data-search-query]').press('Escape');
  passed('容器外快捷键和 data-action 不受影响，容器内搜索只作用于活动工作台');

  await task('one').click();await editor('one').fill('加粗文本');
  await editor('one').evaluate(input => input.setSelectionRange(0,2));
  await editor('one').press('Control+b');
  const formatted = await editor('one').evaluate(input => ({value:input.value,start:input.selectionStart,end:input.selectionEnd}));
  assert.deepEqual(formatted,{value:'**加粗**文本',start:2,end:4});
  await editor('one').press('Control+b');
  assert.equal(await editor('one').inputValue(),'加粗文本');
  await editor('one').fill('正文');
  await editor('one').evaluate(input => input.setSelectionRange(1,1));await editor('one').press('Control+b');
  assert.equal(await editor('one').inputValue(),'正****文');
  assert.deepEqual(await editor('one').evaluate(input => [input.selectionStart,input.selectionEnd]),[3,3]);
  await editor('one').press('Control+b');assert.equal(await editor('one').inputValue(),'正文');
  await editor('one').fill('**正文**');
  await editor('one').evaluate(input => input.select());await editor('one').press('Control+b');
  assert.equal(await editor('one').inputValue(),'正文');
  passed('宿主捕获与 DOM 冒泡复用同一键盘逻辑，加粗支持添加、取消及空选区，同一事件不会切换两次');

  await editor('one').fill('宿主处理后仍结束编辑');
  await editor('one').evaluate(input => {
    const event = new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true});
    event.preventDefault();input.dispatchEvent(event);
  });
  assert.equal(await editor('one').count(),0);
  await page.waitForFunction(() => window.hosts.one.saved.state.projects[0].tasks[0].title === '宿主处理后仍结束编辑');
  await task('one').click();await editor('one').fill('正文');
  passed('宿主先 preventDefault 的 Ctrl+Enter 仍结束编辑并保存正文');

  await editor('one').evaluate(input => {
    input.select();input.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}));
  });
  assert.equal(await editor('one').inputValue(),'正文');
  await editor('one').fill('事项 one');await editor('one').press('Control+Enter');
  await root('one').locator('.overview-content').click();await editor('one').fill('总结');
  await editor('one').evaluate(input => input.select());await editor('one').press('Control+b');
  assert.equal(await editor('one').inputValue(),'**总结**');
  await editor('one').press('Control+f');
  assert.equal(await root('one').locator('.task-search').count(),1);
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].summary),'**总结**');
  await root('one').locator('[data-search-query]').press('Escape');
  passed('宿主键盘范围保留中文组合输入，总体情况支持加粗，Ctrl+F 先保存正文');

  await root('one').locator('.project-name').click();
  const nameBeforeBold = await editor('one').inputValue();
  await editor('one').press('Control+b');
  assert.equal(await editor('one').inputValue(),nameBeforeBold);
  assert.equal(await page.evaluate(() => window.scopeResults.findLast(item => item.key === 'b').handled),false);
  await editor('one').press('Control+Enter');
  await page.locator('#outside-input').focus();
  await page.locator('#outside-input').press('Control+b');await page.locator('#outside-input').press('Control+f');
  assert.deepEqual(await page.evaluate(() => ['b','f'].map(key => window.scopeResults.findLast(item => item.key === key).handled)),[false,false]);
  assert.equal(await root('one').locator('.task-search').count(),0);
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),true);
  passed('项目名称不执行正文加粗，容器外键盘事件返回未处理以交还宿主');

  await root('one').locator('.column.todo .add-task').click();await editor('one').fill('键盘子事项');
  const keyboardTask = await editor('one').evaluate(input => input.closest('.task-card').dataset.task);
  await editor('one').press('Tab');
  assert.equal(await page.evaluate(id => window.controllers.one.getSnapshot().state.projects[0].tasks.find(task => task.id === id).parentId,keyboardTask),'task-one');
  await editor('one').press('Shift+Tab');
  assert.equal(await page.evaluate(id => window.controllers.one.getSnapshot().state.projects[0].tasks.find(task => task.id === id).parentId,keyboardTask),null);
  await editor('one').press('Control+Shift+Enter');
  assert.equal(await page.evaluate(id => window.controllers.one.getSnapshot().state.projects[0].tasks.find(task => task.id === id).status,keyboardTask),'doing');
  const keyboardCard = root('one').locator(`.task-card[data-task="${keyboardTask}"]:not(.context)`);
  await keyboardCard.locator('.task-content').press('Control+Shift+Enter');
  assert.equal(await page.evaluate(id => window.controllers.one.getSnapshot().state.projects[0].tasks.find(task => task.id === id).status,keyboardTask),'todo');
  passed('宿主捕获阶段保留 Tab/Shift+Tab 调整层级及 Ctrl+Shift+Enter 双向状态切换');

  await keyboardCard.locator('.drag-handle').press('ArrowUp');
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].tasks.toSorted((a,b) => a.order-b.order)[0].id),keyboardTask);
  await keyboardCard.locator('.drag-handle').press('ArrowDown');
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].tasks.toSorted((a,b) => a.order-b.order)[0].id),'task-one');
  await keyboardCard.locator('.task-content').press('Enter');await editor('one').press('Enter');
  assert.equal(await editor('one').inputValue(),'');
  await editor('one').press('Escape');assert.equal(await editor('one').count(),0);
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].tasks.length),2);
  await keyboardCard.locator('[data-action="delete-task"]').click();await root('one').locator('dialog button[type="submit"]').click();
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),true);
  assert.equal(await root('one').evaluate(element => {
    const event = new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true});
    element.dispatchEvent(event);return event.defaultPrevented;
  }),false);
  assert.equal(await page.evaluate(() => window.scopeResults.findLast(item => item.key === 'p').handled),false);
  passed('宿主捕获阶段保留方向键、Enter 连续输入和 Escape 退出，未使用的 Ctrl+P 不被消费');

  await page.evaluate(() => {window.hosts.one.blocked = true;window.hosts.one.recovery = [];});
  await task('one').click();
  await editor('one').fill('立即保留的输入');
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1).state.projects[0].tasks[0].title),'立即保留的输入');
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects[0].tasks[0].title),'事项 one');
  passed('输入事件立即产生恢复快照，不等待自动保存或异步写入');

  await editor('one').press('Control+Enter');
  await page.waitForFunction(() => window.hosts.one.waiters.length === 1);
  await task('one').click();await editor('one').fill('保存等待期间的最新输入');
  await page.evaluate(() => {
    window.flushResult = undefined;
    window.flushPromise = window.controllers.one.flush().then(result => {window.flushResult = result;});
  });
  assert.equal(await page.evaluate(() => window.flushResult),undefined);
  await page.evaluate(() => {window.hosts.one.blocked = false;window.hosts.one.waiters.splice(0).forEach(resolve => resolve());});
  await page.waitForFunction(() => window.flushResult === true);
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects[0].tasks[0].title),'保存等待期间的最新输入');
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1)),null);
  assert.equal((await task('two').textContent()).trim(),'事项 two');
  assert.equal(await page.evaluate(() => window.hosts.two.saves),0);
  passed('flush 等待在途保存并提交最新编辑，成功后清除恢复副本，另一个容器数据保持不变');

  await page.evaluate(() => {window.hosts.one.fail = true;});
  await editor('one').fill('磁盘失败后仍须保留');
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),false);
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].tasks[0].title),'磁盘失败后仍须保留');
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1).state.projects[0].tasks[0].title),'磁盘失败后仍须保留');
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects[0].tasks[0].title),'保存等待期间的最新输入');
  passed('保存失败时 flush 返回 false，磁盘内容不变且未保存文本仍可从快照与恢复副本取回');

  await root('one').locator('[data-action="export"]').click();
  assert.equal(await page.evaluate(() => window.hosts.one.exports.at(-1).projects[0].tasks[0].title),'磁盘失败后仍须保留');
  assert.equal(await page.evaluate(() => window.hosts.two.exports.length),0);
  passed('宿主导出回调包含失败后的最新文本且不会调用其他工作台');

  await root('one').locator('.project-name').click();await editor('one').fill('   ');
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].name),'   ');
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1).state.projects[0].name),'   ');
  await editor('one').fill('');
  assert.equal(await page.evaluate(() => window.controllers.one.getSnapshot().state.projects[0].name),'');
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1).state.projects[0].name),'');
  passed('无效项目名的空白原文和空字符串也保留在恢复快照中');

  await page.evaluate(() => {window.hosts.one.fail = false;window.hosts.one.failRecovery = true;});
  await editor('one').fill('恢复错误后的有效名称');
  assert.ok((await page.evaluate(() => window.hosts.one.errors)).includes('测试恢复副本写入失败'));
  assert.match(await root('one').locator('#toast').textContent(),/无法保存编辑恢复副本/);
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),true);
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects[0].name),'恢复错误后的有效名称');
  await page.evaluate(() => {window.hosts.one.failRecovery = false;});
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),true);
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1)),null);
  passed('恢复副本写入错误明确提示并通知宿主，主数据仍可保存，恢复后可清除旧副本');

  await editor('one').fill('销毁前最后的输入');
  const savesBeforeDestroy = await page.evaluate(() => {
    const count = window.hosts.one.saves;
    window.controllers.one.destroy();
    return count;
  });
  assert.equal(await root('one').evaluate(element => element.childElementCount),0);
  assert.equal(await page.evaluate(() => window.hosts.one.recovery.at(-1).state.projects[0].name),'销毁前最后的输入');
  await root('one').evaluate(element => {element.innerHTML = '<button data-action="add-project">销毁后的按钮</button>';});
  await root('one').locator('button').click();
  await page.waitForTimeout(550);
  assert.equal(await page.evaluate(() => window.hosts.one.saves),savesBeforeDestroy);
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects[0].name),'恢复错误后的有效名称');
  await root('two').focus();await root('two').press('Control+f');
  assert.equal(await root('two').locator('.task-search').count(),1);
  passed('销毁保留最后恢复快照并移除事件和自动保存计时器，另一个工作台仍可操作');

  await page.evaluate(async () => {document.getElementById('one').replaceChildren();await window.mount('one');});
  assert.equal(await root('one').locator('.project-name').textContent(),'恢复错误后的有效名称');
  await root('one').locator('[data-action="add-project"]').click();
  await editor('one').fill('重新挂载后的项目');await editor('one').press('Control+Enter');
  assert.equal(await page.evaluate(() => window.controllers.one.flush()),true);
  assert.equal(await page.evaluate(() => window.hosts.one.saved.state.projects.length),2);
  assert.equal(await page.evaluate(() => window.hosts.two.saved.state.projects.length),1);
  assert.equal(await root('one').locator('.shell').count(),1);
  passed('重新挂载读取持久化数据且一次操作只执行一次，容器之间继续隔离');

  await page.evaluate(() => {window.controllers.one.destroy();window.controllers.two.destroy();});
  await page.locator('#outside-input').press('Control+f');
  assert.equal(await page.evaluate(() => window.outsideKeys.at(-1).prevented),false);
  assert.deepEqual(errors,[]);
  passed('全部销毁后宿主快捷键保持正常，整个挂载生命周期没有脚本错误');
  console.log(`Workbench UI: ${checks} checks passed`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('yishi-workbench-'));
  await rm(dataDir,{recursive:true,force:true});
}
