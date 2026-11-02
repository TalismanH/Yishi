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
  await handle.evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  const start = await handle.boundingBox();
  await surface.mouse.move(start.x + start.width/2,start.y + start.height/2);
  await surface.mouse.down();
  await surface.mouse.move(start.x + start.width/2 + 8,start.y + start.height/2,{steps:2});
  await surface.locator(target).first().evaluate(element => element.scrollIntoView({block:'nearest',inline:'nearest'}));
  const box = await surface.locator(target).first().boundingBox();
  await surface.mouse.move(box.x + Math.min(25,box.width/2),box.y + box.height*ratio,{steps:8});
  await surface.mouse.up();
  await surface.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
}

try {
  await page.goto(origin);await saved();
  const expectedProjectOrder = (await snapshot()).projects.filter(project => !project.archivedAt).map(project => `project-${project.id}`);
  const projectOrder = () => page.locator('.projects>.project').evaluateAll(elements => elements.map(element => element.id));
  assert.deepEqual(await projectOrder(),expectedProjectOrder);
  passed('初始展开项目保持项目原有横向顺序');
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
  for (const status of ['todo','doing','done']) {
    const region = page.locator(`.column.${status} .column-items`);
    assert.equal(await region.getAttribute('role'),'region');
    assert.equal(await region.getAttribute('tabindex'),'0');
    assert.match(await region.getAttribute('aria-label'),/列表/);
    assert.equal(await region.evaluate(element => getComputedStyle(element).overflowY),'auto');
    assert.equal(await region.evaluate(element => getComputedStyle(element).scrollbarWidth),'none');
    assert.equal(await region.evaluate(element => getComputedStyle(element,'::-webkit-scrollbar').display),'none');
  }
  passed('三列事项均为可聚焦的独立滚动区域，隐藏滚动条');
  assert.equal(await page.locator('.overview-header h2').evaluate(element => getComputedStyle(element).fontSize),'16px');
  assert.ok((await page.locator('.column-heading').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize))).every(size => size === '16px'));
  passed('总体情况和三列标题统一提高到16px');

  for (const id of ['design','interaction']) {
    const actualSize = await card(id).boundingBox();
    const ghosts = page.locator(`.task-card.context[data-task="${id}"]`);
    assert.ok(await ghosts.count() > 0);
    for (const ghost of await ghosts.all()) {
      const ghostSize = await ghost.boundingBox();
      assert.ok(Math.abs(ghostSize.width-actualSize.width) < 1);
      assert.ok(Math.abs(ghostSize.height-actualSize.height) < 1);
      assert.equal(await ghost.evaluate(element => getComputedStyle(element).borderTopStyle),'dashed');
    }
  }
  passed('各层级虚线父事项框与对应普通事项框等宽等高，保留虚线样式');

  const beforeHelp = await snapshot();
  const help = page.locator('.topbar [data-action="help"]');
  assert.equal((await help.textContent()).trim(),'');
  assert.equal(await help.evaluate(element => element.nextElementSibling?.dataset.action),'export');
  assert.equal(await help.locator('svg circle').count(),1);
  await help.click();
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.equal(await page.locator('dialog input,dialog textarea').count(),0);
  const shortcuts = (await page.locator('dialog table').textContent()).replace(/\s/g,'');
  for (const key of ['Ctrl+B','Enter','Shift+Enter','Tab','Shift+Tab','Ctrl+Enter','Esc','↑','↓']) assert.ok(shortcuts.includes(key));
  assert.ok(!shortcuts.includes('←') && !shortcuts.includes('→'));
  assert.ok((await page.locator('dialog').boundingBox()).width >= 800);
  await page.screenshot({path:path.resolve('test-results/help-window.png')});
  assert.match(await page.locator('dialog').textContent(),/Markdown/);
  await page.locator('dialog [data-action="close"]').last().click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await help.click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert.deepEqual(await snapshot(),beforeHelp);
  passed('导出左侧的圆形说明图标提供只读操作说明和快捷键表，可按钮或Esc关闭');
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

  for (const id of ['learning','life','workspace']) {
    await page.locator(`[data-action="toggle"][data-project="${id}"]`).click();
    assert.equal(await page.locator('.project.expanded').count(),1);
    assert.equal(await page.locator('.project.expanded').getAttribute('id'),`project-${id}`);
    assert.deepEqual(await projectOrder(),expectedProjectOrder);
    const panels = await page.locator('.projects>.project').evaluateAll(elements => elements.map(element => ({expanded:element.classList.contains('expanded'),left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right})));
    const expandedIndex = panels.findIndex(panel => panel.expanded), expanded = panels[expandedIndex];
    assert.ok(panels.slice(0,expandedIndex).every(panel => panel.right <= expanded.left+1));
    assert.ok(panels.slice(expandedIndex+1).every(panel => panel.left >= expanded.right-1));
  }
  await page.locator('[data-action="toggle"][data-project="workspace"]').click();
  assert.equal(await page.locator('.project.expanded').count(),0);
  assert.deepEqual(await projectOrder(),expectedProjectOrder);
  await page.locator('[data-action="toggle"][data-project="workspace"]').click();
  passed('首中尾项目在原位展开或收起，左右项目顺序不变且同时最多展开一个');

  await page.locator('[data-action="edit-summary"]').first().click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  await editor().fill('## 测试总览\n\n**Markdown** 与 $\\frac{a_1}{b^2}$\n\n$$\\sum_{i=1}^{n} i$$\n\n<script>window.bad=true</script>\n<a href="javascript:alert(1)" onclick="window.bad=true">不安全链接</a>');
  await page.locator('.column-heading').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-inline-editor]'));await saved();
  assert.ok(await page.locator('.overview .katex').count() >= 2);
  assert.equal(await page.locator('.overview script,.overview [onclick],.overview a[href^="javascript:"]').count(),0);
  assert.equal(await page.evaluate(() => Boolean(window.bad)),false);
  passed('总体情况原位编辑、失焦后渲染 Markdown/公式并过滤危险 HTML');

  await page.locator('[data-action="edit-summary"]').click();
  await editor().fill('前文 加粗 后文');
  await editor().evaluate(element => element.setSelectionRange(3,5));
  await editor().press('Control+b');
  assert.equal(await editor().inputValue(),'前文 **加粗** 后文');
  assert.deepEqual(await editor().evaluate(element => [element.selectionStart,element.selectionEnd]),[5,7]);
  await editor().press('Control+b');
  assert.equal(await editor().inputValue(),'前文 加粗 后文');
  await editor().press('Control+b');await finish();
  assert.equal(await page.locator('.overview strong').textContent(),'加粗');
  assert.equal((await snapshot()).projects[0].summary,'前文 **加粗** 后文');
  await page.locator('[data-action="edit-summary"]').click();
  await editor().fill('');await editor().press('Control+b');
  assert.equal(await editor().inputValue(),'****');
  assert.deepEqual(await editor().evaluate(element => [element.selectionStart,element.selectionEnd]),[2,2]);
  await page.keyboard.insertText('加');
  await finish();
  assert.equal(await page.locator('.overview strong').textContent(),'加');
  await card('notes').locator('.task-content').click();
  const originalNote = await editor().inputValue();
  await editor().press('Control+a');await editor().press('Control+b');await finish();
  assert.equal(await card('notes').locator('strong').textContent(),originalNote);
  await card('notes').locator('.task-content').click();
  await editor().press('Control+a');await editor().press('Control+b');
  assert.equal(await editor().inputValue(),originalNote);
  await editor().fill('x'.repeat(20000));await editor().press('Control+a');await editor().press('Control+b');
  assert.equal(await editor().inputValue(),'x'.repeat(20000));
  await finish(originalNote);
  passed('总体情况和事项 Ctrl+B 支持选区加粗、重复取消、空选区输入，并遵守字数上限及自动保存');

  for (const type of ['summary','task']) {
    await (type === 'summary' ? page.locator('[data-action="edit-summary"]') : card('notes').locator('.task-content')).click();
    await editor().fill('拖选第一行内容\n拖选第二行内容');
    const box = await editor().boundingBox();
    await page.mouse.move(box.x+5,box.y+8);await page.mouse.down();
    await page.mouse.move(box.x+box.width+20,box.y+box.height-5,{steps:8});await page.mouse.up();
    assert.equal(await editor().count(),1);
    const selection = await editor().evaluate(element => [element.selectionStart,element.selectionEnd]);
    assert.ok(selection[1] > selection[0],`${type} selection: ${selection}`);
    await editor().press('Control+b');
    assert.ok((await editor().inputValue()).includes('**'));
    if (type === 'task') await editor().fill(originalNote);
    await page.locator('.column-heading').first().click();
    assert.equal(await editor().count(),0);await saved();
  }
  passed('总体情况和事项拖选到文本框外保留编辑与选区，后续独立点击仍正常结束编辑');

  const listMarkdown = '- 第一项\n普通行不缩进\n- 第二项\n- 第三项\n  这是明确缩进的续行\n  - 嵌套项目\n\n```text\n- 代码中的分点\n代码中的下一行\n```\n\n    - 缩进代码\n    代码续行\n\n公式 $x^2$';
  await page.locator('[data-action="edit-summary"]').click();await finish(listMarkdown);
  const overviewMarkup = () => page.locator('.overview-content').evaluate(element => ({
    plain:[...element.querySelectorAll(':scope > p')].map(paragraph => paragraph.textContent),
    items:[...element.querySelectorAll(':scope > ul > li')].map(item => item.textContent),
    nested:element.querySelector('ul ul li')?.textContent,
    code:[...element.querySelectorAll('pre code')].map(code => code.textContent),
  }));
  const listResult = await overviewMarkup();
  assert.ok(listResult.plain.includes('普通行不缩进'));
  assert.equal(listResult.items[0],'第一项');
  assert.ok(listResult.items.some(item => item.includes('第三项') && item.includes('这是明确缩进的续行')));
  assert.equal(listResult.nested,'嵌套项目');
  assert.deepEqual(listResult.code,['- 代码中的分点\n代码中的下一行\n','- 缩进代码\n代码续行\n']);
  assert.equal(await page.locator('.overview .katex').count(),1);
  assert.equal((await snapshot()).projects[0].summary,listMarkdown);
  await page.reload();await saved();
  assert.deepEqual(await overviewMarkup(),listResult);
  assert.equal((await snapshot()).projects[0].summary,listMarkdown);
  passed('分点后的顶格普通行退出列表，连续列表、明确缩进、嵌套、代码与公式保留，重开与原文保存一致');

  async function clickSummaryText(surface, selector, text) {
    const target = surface.locator(selector).filter({hasText:text}).last();
    await target.evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
    const point = await target.evaluate((element,text) => {
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const offset=walker.currentNode.textContent.indexOf(text);
        if (offset < 0) continue;
        const range=document.createRange();range.setStart(walker.currentNode,offset);range.setEnd(walker.currentNode,offset+1);
        const rect=range.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      }
      throw new Error(`Missing rendered text: ${text}`);
    },text);
    await surface.mouse.click(point.x,point.y);
    return point;
  }
  for (const [selector,text] of [['.overview-content > p','普通行不缩进'],['.overview-content ul ul li','嵌套项目'],['.overview-content pre code','代码中的下一行']]) {
    await clickSummaryText(page,selector,text);
    const position = await editor().evaluate(element => ({cursor:element.selectionStart,value:element.value}));
    const start = listMarkdown.lastIndexOf('\n',listMarkdown.indexOf(text))+1;
    const end = listMarkdown.indexOf('\n',listMarkdown.indexOf(text));
    assert.ok(position.cursor >= start && position.cursor <= (end < 0 ? listMarkdown.length : end),JSON.stringify({text,...position}));
    await finish();
  }
  passed('总体情况点击普通行、嵌套列表和代码行，编辑光标落在对应源行');

  const wrappedText = `${'wrapped words for the overview '.repeat(30)}WRAPTARGET ${'后续文字'.repeat(20)}`;
  const clickSource = `## 点击标题\n\n重复的 **文字**\n\n重复的 **文字**\n\n- 重复条目\n- 重复条目\n\n${wrappedText}`;
  await page.locator('[data-action="edit-summary"]').click();await finish(clickSource);
  for (const [selector,text] of [['.overview-content h2','点击标题'],['.overview-content strong','文字'],['.overview-content li','重复条目'],['.overview-content p','WRAPTARGET']]) {
    const point = await clickSummaryText(page,selector,text);
    const cursor = await editor().evaluate(element => element.selectionStart);
    const expected = text === '文字' ? clickSource.lastIndexOf('**文字**')+2 : clickSource.lastIndexOf(text), start = clickSource.lastIndexOf('\n',expected)+1;
    const end = clickSource.indexOf('\n',expected);
    assert.ok(cursor >= start && cursor <= (end < 0 ? clickSource.length : end),JSON.stringify({text,cursor,start,end}));
    if (text === 'WRAPTARGET') {
      assert.ok(Math.abs(cursor-expected) <= 1,JSON.stringify({cursor,expected}));
      const caretTop = await editor().evaluate(element => {
        const style=getComputedStyle(element), mirror=document.createElement('div');
        for (const key of ['font','lineHeight','letterSpacing','tabSize','overflowWrap','padding','boxSizing']) mirror.style[key]=style[key];
        Object.assign(mirror.style,{position:'absolute',left:'-10000px',top:'0',width:`${element.clientWidth}px`,whiteSpace:'pre-wrap'});
        mirror.textContent=element.value.slice(0,element.selectionStart);
        const marker=document.createElement('span');marker.textContent=element.value.slice(element.selectionStart);mirror.append(marker);document.body.append(mirror);
        const top=element.getBoundingClientRect().top+marker.offsetTop;mirror.remove();return top;
      });
      assert.ok(Math.abs(caretTop-point.y) < 26,JSON.stringify({caretTop,point}));
    }
    await finish();
  }
  passed('总体情况标题、重复段落/列表和软换行均映射到点击源行，软换行光标保持可见');

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
  const emptyTodo = await page.locator('.column.todo').evaluate(element => {
    const items = element.querySelector('.column-items').getBoundingClientRect(), add = element.querySelector('.add-task').getBoundingClientRect();
    return {itemsHeight:items.height,itemsTop:items.top,addTop:add.top};
  });
  assert.ok(Math.abs(emptyTodo.addTop-emptyTodo.itemsTop) < 1);
  passed('待办项为空时新增框紧接列表起点，不保留36px空白');

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
  const addDimensions = await page.locator('.column.todo .add-task').boundingBox(), rootDimensions = await card(root).boundingBox(), lastDimensions = await card(third).boundingBox();
  assert.ok(Math.abs(addDimensions.width-rootDimensions.width) < 1);
  assert.ok(Math.abs(addDimensions.height-rootDimensions.height) < 1);
  assert.ok(Math.abs(addDimensions.y-lastDimensions.y-lastDimensions.height-10) < 1);
  passed('新增框与单行主事项等宽等高，有事项时保持10px行距');
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
  await card(thirdB).locator('.drag-handle').click();
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.task-card')?.dataset.task),thirdB);
  assert.equal(await card(thirdB).locator('.drag-handle').evaluate(element => getComputedStyle(element).outlineStyle),'solid');
  await page.keyboard.press('ArrowDown');await saved();
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === thirdB).order > created.tasks.find(task => task.id === third).order);
  assert.deepEqual(created.tasks.map(({id,parentId,status}) => ({id,parentId,status})),beforeKeyboard.tasks.map(({id,parentId,status}) => ({id,parentId,status})));
  await page.keyboard.press('ArrowUp');await saved();
  created = await currentProject();
  assert.ok(created.tasks.find(task => task.id === thirdB).order < created.tasks.find(task => task.id === third).order);
  assert.deepEqual(created.tasks.map(({id,parentId,status}) => ({id,parentId,status})),beforeKeyboard.tasks.map(({id,parentId,status}) => ({id,parentId,status})));
  passed('鼠标点击三级事项把手后可连续用上下键排序，不改变所属事项或状态');

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

  const beforeBlockedDrag = await currentProject();
  const blockedIds = [root,second,third,secondB,thirdB,thirdC];
  await card(root).locator('.drag-handle').scrollIntoViewIfNeeded();
  const blockedStart = await card(root).locator('.drag-handle').boundingBox();
  await page.mouse.move(blockedStart.x+blockedStart.width/2,blockedStart.y+blockedStart.height/2);
  await page.mouse.down();
  await page.mouse.move(blockedStart.x+blockedStart.width/2+8,blockedStart.y+blockedStart.height/2,{steps:2});
  assert.equal(await page.locator('.is-dragging').count(),1);
  for (const id of blockedIds) assert.equal(await card(id).locator('.drop-nest').isVisible(),false);
  const dropHints = () => page.locator('.drop-before,.drop-after,.over,.column.drag-over').count();
  for (const id of [root,second,third]) {
    const rect = await card(id).boundingBox();
    await page.mouse.move(rect.x+15,rect.y+rect.height*.1,{steps:4});
    assert.equal(await dropHints(),0);
  }
  const groupGap = await card(second).boundingBox();
  await page.mouse.move(groupGap.x+3,groupGap.y+groupGap.height+5,{steps:4});
  assert.equal(await dropHints(),0);
  const validDrop = await card(rootB).boundingBox();
  await page.mouse.move(validDrop.x+25,validDrop.y+validDrop.height*.1,{steps:5});
  assert.equal(await card(rootB).evaluate(element => element.classList.contains('drop-before')),true);
  assert.equal(await card(rootB).locator('.drop-nest').isVisible(),true);
  const invalidDrop = await card(secondB).boundingBox();
  await page.mouse.move(invalidDrop.x+15,invalidDrop.y+invalidDrop.height*.9,{steps:5});
  assert.equal(await dropHints(),0);
  await page.mouse.up();await saved();
  assert.deepEqual(await currentProject(),beforeBlockedDrag);
  assert.equal(await page.locator('.is-dragging,.drag-blocked,.drop-before,.drop-after,.over,.column.drag-over').count(),0);
  passed('拖动自身子树隐藏无效落点和列提示，其他落点正常提示，子树内释放不改数据');

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
  scrollFixture.state.projects = [...Array.from({length:18},(_,index) => ({id:`scroll-rail-${index}`,name:`项目 ${index}`,summary:'',createdAt,archivedAt:null,tasks:[]})),{id:'scroll-project',name:'长项目',summary:'滚动位置测试',createdAt,archivedAt:null,tasks:Array.from({length:55},(_,index) => ({id:`scroll-task-${index}`,parentId:null,title:`滚动事项 ${index}`,status:'todo',order:index}))}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(scrollFixture)})).status,200);
  await lastPage.setViewportSize({width:760,height:900});
  await lastPage.reload();
  await lastPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await lastPage.locator('[data-action="toggle"][data-project="scroll-project"]').click();
  await lastPage.locator('.projects').evaluate(element => {element.scrollLeft = element.scrollWidth-element.clientWidth-30;});
  await lastPage.locator('.task-card[data-task="scroll-task-36"] .drag-handle').evaluate(element => {
    const body = element.closest('.column-items'), taskRect = element.getBoundingClientRect(), bodyRect = body.getBoundingClientRect();
    body.scrollTop += taskRect.top+taskRect.height/2-bodyRect.top-bodyRect.height/2;
  });
  const scrollPosition = () => lastPage.evaluate(() => {
    const body = document.querySelector('.column.todo .column-items'), strip = document.querySelector('.projects');
    return {top:body.scrollTop,left:body.scrollLeft,strip:strip.scrollLeft,height:body.scrollHeight,viewport:body.clientHeight};
  });
  const beforeScrollDrop = await scrollPosition();
  assert.ok(beforeScrollDrop.height > beforeScrollDrop.viewport*2 && beforeScrollDrop.top > 300 && beforeScrollDrop.strip > 100);
  await drag('.task-card[data-task="scroll-task-36"]:not(.context)','.task-card[data-task="scroll-task-35"]:not(.context)',.1,lastPage);
  const scrollProject = (await snapshot()).projects.find(project => project.id === 'scroll-project');
  assert.ok(scrollProject.tasks.find(task => task.id === 'scroll-task-36').order < scrollProject.tasks.find(task => task.id === 'scroll-task-35').order);
  const afterScrollDrop = await scrollPosition();
  assert.ok(Math.abs(afterScrollDrop.top-beforeScrollDrop.top) < 1,JSON.stringify({beforeScrollDrop,afterScrollDrop}));
  assert.equal(afterScrollDrop.left,beforeScrollDrop.left);
  assert.equal(afterScrollDrop.strip,beforeScrollDrop.strip);
  passed('长列表下方真实拖动后保留独立列纵向位置和项目栏横向位置');

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

  const independent = await (await fetch(`${origin}/api/state`)).json();
  const fillTasks = ['todo','doing','done'].flatMap(status => Array.from({length:40},(_,order) => ({id:`${status}-fill-${order}`,parentId:null,title:`${status} 事项 ${order}`,status,order})));
  independent.state.projects = [{id:'independent',name:'独立滚动检查',summary:Array.from({length:65},(_,i) => `总体情况第 ${i+1} 段。`).join('\n\n'),createdAt,archivedAt:null,tasks:[...fillTasks,
    {id:'focus-parent',parentId:null,title:'有待办子事项的主事项',status:'doing',order:100},
    {id:'focus-second',parentId:'focus-parent',title:'有待办子事项的二级事项',status:'doing',order:0},
    {id:'focus-first',parentId:'focus-second',title:'第一个待办子事项',status:'todo',order:0},
    {id:'focus-next',parentId:'focus-second',title:'第二个待办子事项',status:'todo',order:1},
    {id:'focus-done',parentId:'focus-second',title:'已经完成的子事项',status:'done',order:2},
    {id:'focus-direct',parentId:'focus-parent',title:'直接待办子事项',status:'todo',order:1},
    {id:'ready-parent',parentId:null,title:'可完成的主事项',status:'doing',order:101},
    {id:'ready-child',parentId:'ready-parent',title:'可完成的二级事项',status:'doing',order:0},
    {id:'ready-leaf',parentId:'ready-child',title:'可完成的三级事项',status:'doing',order:0},
  ]}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(independent)})).status,200);
  const panesPage = await browser.newPage({viewport:{width:1440,height:1000}});
  panesPage.on('pageerror',error => errors.push(error.message));
  await panesPage.emulateMedia({reducedMotion:'no-preference'});
  await panesPage.goto(origin);
  await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  const pane = status => panesPage.locator(`.column.${status} .column-items`);
  const attention = () => panesPage.locator('.pending-attention').evaluateAll(elements => elements.map(element => element.dataset.task));
  const panePositions = () => panesPage.evaluate(() => Object.fromEntries([...document.querySelectorAll('.column-items')].map(element => [element.parentElement.dataset.column,element.scrollTop]).concat([['overview',document.querySelector('.overview-content').scrollTop]])));
  const overviewHeaderTop = await panesPage.locator('.overview-header').evaluate(element => element.getBoundingClientRect().top);
  const beforeOverviewWheel = await panePositions();
  const firstParagraphTop = await panesPage.locator('.overview-content p').first().evaluate(element => element.getBoundingClientRect().top);
  await panesPage.locator('.overview-content').hover();await panesPage.mouse.wheel(0,360);
  await panesPage.waitForFunction(top => Math.abs(document.querySelector('.overview-content').scrollTop-top-360) < 1,beforeOverviewWheel.overview);
  assert.equal(await panesPage.locator('.overview-header').evaluate(element => element.getBoundingClientRect().top),overviewHeaderTop);
  assert.equal(await panesPage.locator('.overview').evaluate(element => element.scrollTop),0);
  assert.ok(Math.abs(await panesPage.locator('.overview-content p').first().evaluate(element => element.getBoundingClientRect().top)-firstParagraphTop+360) < 1);
  for (const status of ['todo','doing','done']) assert.equal((await panePositions())[status],beforeOverviewWheel[status]);
  passed('长总体情况只滚动正文，标题及完成度固定，三列事项不随之滚动');
  await panesPage.locator('.overview-content').evaluate(element => {element.scrollTop=400;});
  const clickedSummaryPoint = await clickSummaryText(panesPage,'.overview-content p','总体情况第 30 段');
  const summaryEditor = panesPage.locator('[data-inline-editor="summary"]');
  await summaryEditor.waitFor();
  const clickedSummaryLine = await summaryEditor.evaluate(element => {
    const cursor=element.selectionStart,start=element.value.lastIndexOf('\n',cursor-1)+1,end=element.value.indexOf('\n',cursor);
    const lineTop=element.getBoundingClientRect().top+element.value.slice(0,start).split('\n').length*parseFloat(getComputedStyle(element).lineHeight);
    return {text:element.value.slice(start,end < 0 ? undefined : end),lineTop};
  });
  assert.equal(clickedSummaryLine.text,'总体情况第 30 段。');
  assert.ok(Math.abs(clickedSummaryLine.lineTop-clickedSummaryPoint.y) < 36,JSON.stringify({clickedSummaryLine,clickedSummaryPoint}));
  await summaryEditor.evaluate(element => {
    const cursor=element.value.indexOf('总体情况第 30 段'), pane=element.closest('.overview-content');
    element.setSelectionRange(cursor,cursor);
    const lines=element.value.slice(0,cursor).split('\n').length-1;
    pane.scrollTop += element.getBoundingClientRect().top-pane.getBoundingClientRect().top+lines*parseFloat(getComputedStyle(element).lineHeight)-pane.clientHeight/2;
  });
  const beforeSummaryTyping = (await panePositions()).overview;
  assert.ok(beforeSummaryTyping > 500);
  await panesPage.keyboard.insertText('修改');
  assert.ok(Math.abs((await panePositions()).overview-beforeSummaryTyping) < 1);
  await summaryEditor.press('Backspace');
  assert.ok(Math.abs((await panePositions()).overview-beforeSummaryTyping) < 1);
  await panesPage.waitForFunction(async () => (await (await fetch('/api/state')).json()).state.projects[0].summary.includes('修总体情况第 30 段'));
  assert.ok(Math.abs((await panePositions()).overview-beforeSummaryTyping) < 1);
  await summaryEditor.press('Control+Enter');
  await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  assert.equal(await panesPage.locator('.overview-header').evaluate(element => element.getBoundingClientRect().top),overviewHeaderTop);
  passed('长总体情况进入编辑、连续输入、删除和自动保存均保持当前滚动位置');
  await panesPage.locator('.overview-content').evaluate(element => {element.scrollTop=100;});
  for (const parentId of ['focus-parent','focus-second']) {
    const add = panesPage.locator(`.column.doing .task-card[data-task="${parentId}"] [data-action="add-task"]`);
    await add.evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
    await pane('todo').evaluate(element => {element.scrollTop=0;});
    const beforeAdd = await panePositions(), beforeAddState = await (await fetch(`${origin}/api/state`)).json();
    await add.click();
    const draftEditor = panesPage.locator('.column.todo [data-inline-editor="task"]');
    await draftEditor.waitFor();
    await draftEditor.fill('立即输入');await draftEditor.fill('');
    await panesPage.waitForFunction(() => {
      const input=document.querySelector('.column.todo [data-inline-editor="task"]'), card=input.closest('.task-card'), pane=card.closest('.column-items');
      return Math.abs(card.getBoundingClientRect().top-pane.getBoundingClientRect().top) <= 2;
    });
    assert.equal(await draftEditor.evaluate(element => element === document.activeElement),true);
    const afterAdd = await panePositions();
    assert.ok(afterAdd.todo > 1000);
    for (const other of ['doing','done','overview']) assert.equal(afterAdd[other],beforeAdd[other]);
    assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeAddState);
    const insertedId = await draftEditor.evaluate(element => element.closest('.task-card').dataset.task);
    await draftEditor.fill('连续新增滚动检查');
    const beforeEnter = await panePositions();
    await draftEditor.press('Enter');
    const afterEnter = await panePositions();
    assert.ok(Math.abs(afterEnter.todo-beforeEnter.todo) < 1,JSON.stringify({beforeEnter,afterEnter}));
    assert.ok(await draftEditor.evaluate(element => {
      const card=element.closest('.task-card'), pane=card.closest('.column-items'), a=card.getBoundingClientRect(), b=pane.getBoundingClientRect();
      return a.top > b.top+20 && a.bottom <= b.bottom+1;
    }));
    for (const other of ['doing','done','overview']) assert.equal(afterEnter[other],beforeEnter[other]);
    await panesPage.locator(`.column.todo .task-card[data-task="${insertedId}"] [data-action="delete-task"]`).click();
    await panesPage.locator('dialog button[type="submit"]').click();
    await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
    assert.deepEqual((await (await fetch(`${origin}/api/state`)).json()).state,beforeAddState.state);
  }
  passed('进行中点击新增会置顶待办编辑框，随后在待办按Enter新增保持可见且不置顶，其他区域不动');
  for (const status of ['todo','doing','done']) await pane(status).evaluate(element => {element.scrollTop=0;});
  for (const status of ['todo','doing','done']) {
    const view = await pane(status).evaluate(element => ({content:element.scrollHeight,viewport:element.clientHeight}));
    assert.ok(view.content > view.viewport*2);
    const beforeWheel = await panePositions();
    const headingTop = await panesPage.locator(`.column.${status} .column-heading`).evaluate(element => element.getBoundingClientRect().top);
    await pane(status).hover();await panesPage.mouse.wheel(0,360);
    await panesPage.waitForFunction(({status,top}) => Math.abs(document.querySelector(`.column.${status} .column-items`).scrollTop-top-360) < 1,{status,top:beforeWheel[status]});
    const afterWheel = await panePositions();
    for (const other of ['todo','doing','done','overview'].filter(other => other !== status)) assert.equal(afterWheel[other],beforeWheel[other]);
    assert.equal(await panesPage.locator(`.column.${status} .column-heading`).evaluate(element => element.getBoundingClientRect().top),headingTop);
    assert.equal(await pane(status).evaluate(element => element.offsetWidth-element.clientWidth),0);
  }
  passed('三列长列表可分别用滚轮滚动，标题固定、无滚动条且不带动其他列或总体情况');

  await panesPage.locator('.task-card[data-task="todo-fill-20"] .drag-handle').evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  const beforeAllDrop = await panePositions();
  await drag('.task-card[data-task="todo-fill-20"]','.task-card[data-task="todo-fill-19"]',.1,panesPage);
  assert.deepEqual(await panePositions(),beforeAllDrop);
  assert.ok((await snapshot()).projects[0].tasks.find(task => task.id === 'todo-fill-20').order < (await snapshot()).projects[0].tasks.find(task => task.id === 'todo-fill-19').order);
  passed('某列拖动重绘后同时保留三列与总体情况各自的滚动位置');

  const beforeEdge = await (await fetch(`${origin}/api/state`)).json();
  const edgePositions = await panePositions();
  const handleBox = await panesPage.locator('.task-card[data-task="todo-fill-20"] .drag-handle').boundingBox();
  await panesPage.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await panesPage.mouse.down();
  await panesPage.mouse.move(handleBox.x+handleBox.width/2+8,handleBox.y+handleBox.height/2,{steps:2});
  const edgeBox = await pane('todo').boundingBox();
  await panesPage.mouse.move(edgeBox.x+25,edgeBox.y+edgeBox.height-4,{steps:3});
  await panesPage.waitForFunction(top => document.querySelector('.column.todo .column-items').scrollTop > top+36,edgePositions.todo);
  await panesPage.keyboard.press('Escape');await panesPage.mouse.up();
  const afterEdge = await panePositions();
  for (const status of ['doing','done','overview']) assert.equal(afterEdge[status],edgePositions[status]);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeEdge);
  passed('拖动到列边缘只自动滚动该列，取消拖动后数据保持不变');

  const located = () => panesPage.locator('.pending-attention').evaluateAll(elements => elements.map(element => ({id:element.dataset.task,column:element.dataset.columnStatus})));
  const locate = (status,id) => panesPage.locator(`.column.${status} .task-card[data-task="${id}"] [data-action="locate-task"]`);
  const waitAtTop = (status,id) => panesPage.waitForFunction(({status,id}) => {
    const card=document.querySelector(`.column.${status} .task-card[data-task="${id}"]`), pane=card.closest('.column-items');
    const a=card.getBoundingClientRect(), b=pane.getBoundingClientRect();
    return Math.abs(a.top-b.top) <= 2;
  },{status,id});
  assert.equal(await panesPage.locator('.task-card[data-task="focus-first"] [data-action="locate-task"]').count(),0);
  assert.equal(await panesPage.locator('.task-card[data-task="focus-parent"] [data-action="locate-task"]').count(),3);
  assert.equal(await panesPage.locator('.task-card[data-task="focus-second"] [data-action="locate-task"]').count(),3);
  const beforeLocate = await (await fetch(`${origin}/api/state`)).json();
  await locate('doing','focus-parent').evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  for (const status of ['todo','done']) await pane(status).evaluate(element => {element.scrollTop=0;});
  const beforeLocatePositions = await panePositions();
  await locate('doing','focus-parent').click();
  assert.deepEqual(await located(),[{id:'focus-parent',column:'todo'},{id:'focus-parent',column:'done'}]);
  await Promise.all(['todo','done'].map(status => waitAtTop(status,'focus-parent')));
  const afterLocatePositions = await panePositions();
  for (const status of ['todo','done']) assert.ok(afterLocatePositions[status] > 1000);
  for (const status of ['doing','overview']) assert.equal(afterLocatePositions[status],beforeLocatePositions[status]);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeLocate);
  await panesPage.waitForFunction(() => document.querySelector('.pending-attention')?.getAnimations()[0]?.startTime != null);
  const locatePulse = await panesPage.locator('.pending-attention').first().evaluate(element => element.getAnimations()[0].startTime);
  await locate('doing','focus-parent').click();
  await panesPage.waitForFunction(first => document.querySelector('.pending-attention')?.getAnimations()[0]?.startTime > first,locatePulse);
  await panesPage.waitForFunction(() => !document.querySelector('.pending-attention'),null,{timeout:4000});
  passed('一级定位按钮将其他两列同一事项对齐列顶端并闪烁，源列与总体情况不动，重复点击重启且不修改数据');

  await panesPage.emulateMedia({reducedMotion:'reduce'});
  await locate('todo','focus-second').evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  for (const status of ['doing','done']) await pane(status).evaluate(element => {element.scrollTop=0;});
  const beforeContextLocate = await panePositions();
  await locate('todo','focus-second').click();
  assert.deepEqual(await located(),[{id:'focus-second',column:'doing'},{id:'focus-second',column:'done'}]);
  await Promise.all(['doing','done'].map(status => waitAtTop(status,'focus-second')));
  assert.equal(await panesPage.locator('.pending-attention').first().evaluate(element => getComputedStyle(element).animationName),'none');
  const afterContextLocate = await panePositions();
  for (const status of ['doing','done']) assert.ok(afterContextLocate[status] > 1000);
  for (const status of ['todo','overview']) assert.equal(afterContextLocate[status],beforeContextLocate[status]);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeLocate);
  await locate('todo','focus-parent').focus();
  await locate('todo','focus-second').hover();
  await panesPage.screenshot({path:path.resolve('test-results/feature-locate.png')});
  await locate('doing','doing-fill-2').click();
  assert.deepEqual(await located(),[]);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeLocate);
  await panesPage.emulateMedia({reducedMotion:'no-preference'});
  passed('二级虚线事项也能定位，减少动态效果时静态高亮，其他列无同一事项时不改变数据');

  await pane('todo').evaluate(element => {element.scrollTop=0;});
  await panesPage.locator('.column.doing .task-card[data-task="focus-parent"] [data-action="complete"]').evaluate(element => element.scrollIntoView({block:'center',inline:'nearest'}));
  const beforeFocus = await (await fetch(`${origin}/api/state`)).json();
  const beforeFocusPositions = await panePositions();
  await panesPage.locator('.column.doing .task-card[data-task="focus-parent"] [data-action="complete"]').click();
  assert.deepEqual(await attention(),['focus-first','focus-next','focus-direct']);
  assert.equal(await panesPage.locator('.pending-attention.context').count(),0);
  await waitAtTop('todo','focus-first');
  const focusedPositions = await panePositions();
  assert.ok(focusedPositions.todo > 1000);
  for (const status of ['doing','done','overview']) assert.equal(focusedPositions[status],beforeFocusPositions[status]);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeFocus);
  assert.equal(await panesPage.locator('.pending-attention').first().evaluate(element => getComputedStyle(element).animationName),'pending-attention');
  passed('一级事项完成被待办子事项阻止时，只定位相关待办项并高亮全部关联条目，不改变状态或版本');

  await panesPage.waitForFunction(() => document.querySelector('.pending-attention')?.getAnimations()[0]?.startTime != null);
  const firstPulse = await panesPage.locator('.pending-attention').first().evaluate(element => element.getAnimations()[0].startTime);
  await panesPage.locator('.column.doing .task-card[data-task="focus-parent"] [data-action="complete"]').click();
  await panesPage.waitForFunction(first => document.querySelector('.pending-attention')?.getAnimations()[0]?.startTime > first,firstPulse);
  await panesPage.waitForFunction(() => !document.querySelector('.pending-attention'),null,{timeout:4000});
  passed('重复点击会重启高亮，短暂提示结束后自动清除');

  await panesPage.emulateMedia({reducedMotion:'reduce'});
  await pane('todo').evaluate(element => {element.scrollTop=0;});
  await panesPage.locator('.column.doing .task-card[data-task="focus-second"] [data-action="complete"]').click();
  assert.deepEqual(await attention(),['focus-first','focus-next']);
  await waitAtTop('todo','focus-first');
  assert.equal(await panesPage.locator('.pending-attention').first().evaluate(element => getComputedStyle(element).animationName),'none');
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeFocus);
  passed('二级事项只定位自己的待办子事项，减少动态效果模式使用静态高亮');

  await panesPage.locator('.column.doing .task-card[data-task="doing-fill-5"] [data-action="complete"]').click();
  await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  assert.equal((await snapshot()).projects[0].tasks.find(task => task.id === 'doing-fill-5').status,'done');
  await panesPage.locator('.column.doing .task-card[data-task="ready-parent"] [data-action="complete"]').click();
  await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  for (const id of ['ready-parent','ready-child','ready-leaf']) assert.equal((await snapshot()).projects[0].tasks.find(task => task.id === id).status,'done');
  passed('无待办后代的普通事项和完整分支仍能正常完成');
  const shortFixture = await (await fetch(`${origin}/api/state`)).json();
  shortFixture.state.projects = [{id:'short-columns',name:'短列顶端定位检查',summary:'保持总体情况不动',createdAt,archivedAt:null,tasks:[
    {id:'short-first',parentId:null,title:'首个父事项',status:'doing',order:0},
    {id:'short-first-todo',parentId:'short-first',title:'首个待办子事项',status:'todo',order:0},
    {id:'short-first-done',parentId:'short-first',title:'首个已完成子事项',status:'done',order:1},
    {id:'short-last',parentId:null,title:'末尾父事项',status:'doing',order:1},
    {id:'short-last-todo',parentId:'short-last',title:'末尾待办子事项',status:'todo',order:0},
    {id:'short-last-done',parentId:'short-last',title:'末尾已完成子事项',status:'done',order:1},
  ]}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(shortFixture)})).status,200);
  await panesPage.reload();
  await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  const beforeShortLocate = await (await fetch(`${origin}/api/state`)).json();
  assert.ok(await pane('todo').evaluate(element => element.scrollHeight <= element.clientHeight+1));
  const shortSpacing = new Map();
  for (const id of ['short-first','short-last','short-first','short-last']) {
    const before = await panePositions();
    await locate('doing',id).click();
    await Promise.all(['todo','done'].map(status => waitAtTop(status,id)));
    assert.deepEqual(await located(),[{id,column:'todo'},{id,column:'done'}]);
    const after = await panePositions();
    for (const status of ['doing','overview']) assert.equal(after[status],before[status]);
    const spacing = await panesPage.locator('.column.todo .column-items,.column.done .column-items').evaluateAll(elements => elements.map(element => [element.scrollHeight,element.scrollTop]));
    if (shortSpacing.has(id)) assert.deepEqual(spacing,shortSpacing.get(id));
    else shortSpacing.set(id,spacing);
    assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeShortLocate);
  }
  await panesPage.locator('.column.doing .task-card[data-task="short-first"] [data-action="complete"]').click();
  await waitAtTop('todo','short-first-todo');
  assert.deepEqual(await attention(),['short-first-todo']);
  assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(),beforeShortLocate);
  const layoutFixture = await (await fetch(`${origin}/api/state`)).json();
  layoutFixture.state.projects = [{id:'card-layout',name:'事项布局检查',summary:'',createdAt,archivedAt:null,tasks:[
    ...['todo','doing','done'].map((status,order) => ({id:`layout-${status}`,parentId:null,title:'第一行\n\n第二行\n\n第三行',status,order})),
    {id:'layout-child',parentId:'layout-doing',title:'二级事项\n\n第二行',status:'todo',order:0},
  ]}];
  assert.equal((await fetch(`${origin}/api/state`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(layoutFixture)})).status,200);
  await panesPage.reload();await panesPage.locator('[data-save-status][data-state="saved"]').waitFor({state:'attached'});
  await panesPage.mouse.move(0,0);
  const layout = await panesPage.locator('.task-card').evaluateAll(cards => cards.map(card => {
    const rect=card.getBoundingClientRect(), root=card.parentElement.parentElement.classList.contains('column-items');
    return {root,border:getComputedStyle(card).borderTopWidth,color:getComputedStyle(card).borderTopColor,offsets:[...card.querySelectorAll('button,.drag-handle')].map(button => {
      const bounds=button.getBoundingClientRect();return bounds.top+bounds.height/2-rect.top-rect.height/2;
    })};
  }));
  assert.ok(layout.some(card => card.root) && layout.some(card => !card.root));
  for (const card of layout) {
    assert.equal(card.border,card.root ? '2px' : '1px');
    if (card.root) assert.equal(card.color,'rgb(189, 203, 177)');
    assert.ok(card.offsets.every(offset => Math.abs(offset) < 1),JSON.stringify(card));
  }
  await panesPage.locator('.column.todo .task-card[data-task="layout-todo"]').hover();
  assert.deepEqual(await panesPage.locator('.column.todo .task-card[data-task="layout-todo"]').evaluate(element => [getComputedStyle(element).borderTopWidth,getComputedStyle(element).borderTopColor]),['2px','rgb(189, 203, 177)']);
  await panesPage.screenshot({path:path.resolve('test-results/task-card-layout.png')});
  passed('一级事项及虚线框边框加粗，多行事项内的操作按钮、完成框和拖动把手均上下居中');
  assert.deepEqual(errors,[]);await panesPage.close();
  passed('短列首尾事项及完成检查均对齐列顶端，重复定位不累积空白，源列和总体情况及数据版本保持不变');
  console.log(`UI smoke: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
