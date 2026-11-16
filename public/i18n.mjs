export const normalizeLanguage = value => value === 'en' ? 'en' : 'zh';

export function readLanguage(storage) {
  try {return normalizeLanguage(JSON.parse(storage.getItem('yishi.appearance') ?? '{}')?.language);}
  catch {return 'zh';}
}

const ui = {
  '一事':'Yishi','待办项':'To do','进行中':'Doing','已完成':'Done','项目':'Projects','归档':'Archive',
  '默认配色':'Default','莫兰迪 · 雾蓝':'Morandi · Mist','莫兰迪 · 豆沙':'Morandi · Rose','莫兰迪 · 鼠尾草':'Morandi · Sage',
  '莫兰迪 · 燕麦':'Morandi · Oat','莫兰迪 · 灰紫':'Morandi · Lavender','莫兰迪 · 陶土':'Morandi · Clay',
  '重试保存':'Retry save','空事项':'Empty task','编辑事项':'Edit task','编辑总体情况':'Edit summary','编辑项目名称':'Edit project name',
  '展开子事项':'Expand subtasks','收起子事项':'Collapse subtasks','恢复进行中':'Move back to Doing','完成事项':'Complete task',
  '定位其他列中的同一事项':'Locate this task in other columns','开始办理':'Start task','移回待办':'Move back to To do',
  '新增子事项':'Add subtask','删除事项':'Delete task','作为子事项':'Nest as a subtask','收起本列所有子事项':'Collapse all subtasks',
  '展开本列所有子事项':'Expand all subtasks','新增待办':'Add task','拖动事项：':'Move task: ','拖动；↑↓调整顺序':'Drag; use ↑↓ to reorder',
  '排序项目：':'Reorder project: ','拖动调整项目顺序':'Drag to reorder projects','收起项目':'Collapse project','恢复项目':'Restore project',
  '删除项目':'Delete project','展开总体情况':'Expand summary','收起总体情况':'Collapse summary','总体情况':'Summary','完成度':'Progress',
  '事项搜索':'Task search','搜索事项':'Search tasks','搜索范围':'Search scope','全部':'All','上一个匹配事项':'Previous match',
  '下一个匹配事项':'Next match','关闭搜索':'Close search','项目窗口':'Project views','设置':'Settings','帮助':'Help','导出备份':'Export backup',
  '新建项目':'New project','事项正文':'Task text','总体情况正文':'Summary text','项目名称':'Project name','列表':' list',
  '关闭':'Close','语言':'Language','颜色配色':'Color palette','界面字体':'Interface font','系统默认':'System default','得意黑':'Smiley Sans',
  '字号':'Text size','关闭方式':'Close action','最小化到托盘':'Minimize to tray','退出软件':'Exit','每次询问':'Ask every time',
  '重置关闭选择':'Reset close preference','关闭一事':'Close Yishi','记住本次选择':'Remember this choice','取消':'Cancel',
  '项目与事项':'Projects and tasks','折叠、定位与搜索':'Folding, navigation, and search','文本与备份':'Text and backups','快捷键':'Keyboard shortcuts',
  '点击项目名、总体情况或事项正文即可编辑。输入自动保存，离开编辑区后渲染。每次只展开一个项目；全部项目折叠后，将鼠标移至项目栏上方，拖动出现的把手调整顺序。':'Click a project name, summary, or task to edit it. Changes save automatically and render when editing ends. One project is expanded at a time. Collapse all projects, then drag the handles above their headers to reorder them.',
  '事项最多三级，状态按「待办项 ↔ 进行中 ↔ 已完成」逐步切换。拖动左侧把手可在同列排序，也可在待办和进行中之间拖到分支图标下，成为子事项。拖动会保留事项状态，并带上全部子事项。项目全部事项完成后可归档，归档和删除均需确认。':'Tasks support three levels and move between adjacent statuses: To do, Doing, and Done. Drag a handle to reorder a task or drop it on a branch target to nest it. Moving a task preserves the status of every descendant. Projects can be archived when all tasks are complete. Archive and delete actions require confirmation.',
  '事项框外的箭头展开或收起子事项，列标题旁的箭头批量控制本列层级；总体情况可单独折叠。定位按钮会展开其他列的对应事项，并在列顶端高亮。':'Arrows beside tasks expand or collapse subtasks; column arrows control all branches in that column. The summary folds independently. Locate buttons reveal the same task in other columns and highlight it at the top.',
  'Ctrl+F 打开当前项目的搜索栏。可按列筛选、查看匹配事项数，用上下按钮或 Enter / Shift+Enter 循环跳转；点击 × 或按 Esc 关闭搜索。':'Ctrl+F opens search for the current project. Filter by status and cycle through matches with the arrow buttons or Enter / Shift+Enter. Click × or press Esc to close search.',
  '正文支持 Markdown 和公式：行内公式用 <code>$...$</code>，独立公式用 <code>$$...$$</code>。总体情况的分点后，顶格普通行退出列表，缩进续行保留在列表内。':'Text supports Markdown and math: use <code>$...$</code> for inline math and <code>$$...$$</code> for display math. In summaries, an unindented line after a list starts a paragraph; indented continuation lines remain in the list.',
  '顶栏下载按钮导出全部项目。设置中可切换配色、字体并调整字号。':'The download button exports all projects. Settings control the language, color palette, font, and text size.',
  '记住关闭方式后，也可在设置中重置关闭选择。':'You can reset a remembered close action in Settings.',
  '加粗或取消加粗选中文字；无选区时插入加粗标记':'Toggle bold for selected text, or insert bold markers at the cursor',
  '打开当前项目的事项搜索':'Search the current project','保存完整正文并新增空白同级事项。搜索时跳到下一项':'Save the task and start its next sibling; advance to the next search match',
  '编辑事项时换行，搜索时跳到上一项':'Insert a newline, or move to the previous search match',
  '降低 / 提升事项层级，最多三级；空白新增项也适用':'Demote / promote a task, up to three levels; also works for empty drafts',
  '结束编辑并渲染':'Finish editing and render','保存事项正文并在待办和进行中之间切换':'Save the task and toggle between To do and Doing',
  '结束编辑、关闭搜索或弹窗、取消拖动':'Finish editing, close search or a dialog, or cancel dragging',
  '聚焦事项左侧把手后，调整同列、同一父事项下的顺序':'With a task handle focused, reorder siblings in the same column',
  '聚焦事项左侧把手后，进入正文编辑':'With a task handle focused, edit its text','Enter / 空格':'Enter / Space',
  '新项目':'New project','归档项目？':'Archive project?','项目尚未完成':'Project is incomplete','请先完成所有事项。':'Complete all tasks first.',
  '确认归档':'Archive','删除项目？':'Delete project?','确认删除':'Delete','删除事项？':'Delete task?',
};

export const translate = (language, chinese, english = ui[chinese] ?? chinese) => normalizeLanguage(language) === 'en' ? english : chinese;
const uiPattern = new RegExp(Object.keys(ui).sort((a,b) => b.length-a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'), 'g');

// Only translate authored template segments; interpolated task content is never inspected.
export function translateMarkup(language, strings, values) {
  return strings.map((text,index) => (normalizeLanguage(language) === 'en' ? text.replace(uiPattern, key => ui[key]) : text) + (index < values.length ? values[index] : '')).join('');
}

const errors = {
  '事项不存在':'Task not found.',
  '父事项不存在':'Parent task not found.',
  '项目不存在':'Project not found.',
  '工作区格式不正确':'Invalid workspace format.',
  '项目格式不正确':'Invalid project format.',
  '项目编号格式不正确':'Invalid project ID.',
  '项目名称格式不正确':'Invalid project name.',
  '项目总体情况格式不正确':'Invalid project summary.',
  '项目编号不能重复':'Project IDs must be unique.',
  '项目创建时间不正确':'Invalid project creation time.',
  '项目归档时间不正确':'Invalid project archive time.',
  '事项列表格式不正确':'Invalid task list.',
  '事项格式不正确':'Invalid task format.',
  '事项编号格式不正确':'Invalid task ID.',
  '事项内容格式不正确':'Invalid task text.',
  '父事项编号格式不正确':'Invalid parent task ID.',
  '事项编号不能重复':'Task IDs must be unique.',
  '事项状态不正确':'Invalid task status.',
  '事项排序不正确':'Invalid task order.',
  '事项层级不能形成循环':'Task hierarchy cannot contain a cycle.',
  '事项最多支持三级':'Tasks support at most three levels.',
  '只能在当前项目列表中排序':'Projects can only be reordered within the current list.',
  '请按「待办理 ↔ 进行中 ↔ 已完成」逐步切换，子事项也不能跳级':'Move between adjacent statuses: To do, Doing, and Done. Subtasks cannot skip a status either.',
  '拖动不能改变事项状态，请使用状态按钮':'Dragging cannot change task status. Use the status buttons.',
  '不能移入自己或自己的子事项':'A task cannot be moved into itself or its descendants.',
  '待办项和进行中的事项不能拖入已完成事项下':'To do and Doing tasks cannot be moved under completed tasks.',
  '目标位置必须是同层的其他事项':'The destination must be another task at the same level.',
  '数据版本冲突，请先导出备份':'Data conflict. Export a backup before reloading.',
  '保存失败，点击重试':'Save failed. Click to retry.',
  '另一个窗口已修改数据。请导出当前备份，再重新打开。':'Another window changed this workspace. Export your current backup, then reopen it.',
  '请先创建项目':'Create a project first.',
  '请先填写事项正文':'Enter task text first.',
  '请先完成所有事项':'Complete all tasks first.',
  '无法记住关闭方式，本次仍继续执行':'The close preference could not be saved. This action will still continue.',
  '下次关闭时将重新询问':'You will be asked again the next time you close the window.',
  '无法重置关闭方式，请重试':'Could not reset the close preference. Please retry.',
  '无法记住外观设置，本次修改仍然生效':'Appearance preferences could not be saved. Your changes still apply for this session.',
  '正文已达到字数上限':'The text has reached its length limit.',
  '无法读取本地数据':'Could not read local data.',
  '本地数据操作失败':'Local data operation failed.',
  '本地数据读写失败，原数据已保留，请检查磁盘空间和文件权限':'Local data could not be read or written. Original data is preserved. Check free disk space and file permissions.',
  '工作区无法序列化':'The workspace could not be encoded.',
  '无效的数据版本':'Invalid data revision.',
  '工作区尚未加载，请重新打开':'The workspace has not loaded. Please reopen it.',
  '数据版本已达上限':'The data revision has reached its limit.',
  '本地数据文件过大，已保留原文件':'The local data file is too large. The original file is preserved.',
  '数据文件无法读取，已保留原文件，请从备份恢复':'The data file could not be read. The original is preserved; restore a backup.',
  '数据已在其他窗口更新，请刷新后重试':'Data changed in another window. Reload before retrying.',
  '无法确认窗口来源':'Could not verify the window origin.',
  '拒绝非主窗口的数据请求':'Data requests from other windows are not allowed.',
  '本地数据读取任务失败，原文件已保留':'The local read operation failed. The original file is preserved.',
  '本地数据保存任务失败，原文件已保留':'The local save operation failed. The original file is preserved.',
  '托盘图标不可用，窗口保持打开':'The tray icon is unavailable. The window remains open.',
  '无法隐藏到托盘，请重试':'Could not minimize to the tray. Please retry.',
  '无法切换界面语言，请重试':'Could not change the interface language. Please retry.',
  '数据无法编码为 JSON':'Data could not be encoded as JSON.',
  '数据文件超过 64 MB 限制':'The data file exceeds the 64 MB limit.',
  '请选择 JSON 工作区或备份文件':'Choose a JSON workspace or backup file.',
  '导入文件超过 64 MB 限制':'The import file exceeds the 64 MB limit.',
  '工作区正在写入或存在遗留锁。请关闭其他一事窗口；确认没有程序使用后移除 workspace.lock 再重试。':'The workspace is being written or has a stale lock. Close other Yishi windows; remove workspace.lock only after confirming no instance is using it.',
  '工作区文件缺失，已有数据未被重置；请导入备份或恢复上一版本。':'The workspace file is missing. Existing data has not been reset; import a backup or restore the previous version.',
  '数据文件无法读取，已保留原文件；请导入备份或恢复上一版本。':'The data file could not be read. The original is preserved; import a backup or restore the previous version.',
  '请先重新打开工作台再保存':'Reopen the workbench before saving.',
  '数据已在其他窗口或同步程序中更新，请先导出当前备份，再重新打开工作台。':'Another window or sync tool updated the data. Export your current backup before reopening the workbench.',
  '保存期间检测到外部修改，原文件已保留，请先导出当前备份。':'An external change was detected while saving. The original is preserved; export your current backup.',
  '上一版本备份无法读取，未修改现有文件。':'The previous backup could not be read. Existing files were not changed.',
  '恢复文件不在当前工作区内':'The recovery file is outside this workspace.',
  '恢复文件不是普通文件':'The recovery file is not a regular file.',
  '旧工作区无法读取，原目录已保留，请选择有效备份导入。':'The old workspace could not be read. Its original folder is preserved; import a valid backup.',
  '旧工作区含非普通数据文件，迁移已停止。':'The old workspace contains non-regular data files. Migration stopped.',
  '旧备份目录无法安全读取，原文件已保留。':'The old backup folder could not be safely read. Original files are preserved.',
  '迁移副本校验失败，原目录已保留。':'Migration copy verification failed. The original folder is preserved.',
  '迁移期间数据发生变化，已保留两处文件，请重新打开工作台。':'Data changed during migration. Both locations are preserved; reopen the workbench.',
  '无法更新窗口和托盘语言':'Unable to update the window and tray language',
  'Unsupported interface language':'不支持的界面语言',
};

export function localizeError(message, language) {
  const text = String(message ?? '');
  if (normalizeLanguage(language) === 'zh') {
    if (text === 'Unsupported interface language') return errors[text];
    return Object.entries(errors).find(([key, value]) => key !== 'Unsupported interface language' && value === text)?.[0] ?? text;
  }
  if (text === 'Unsupported interface language') return text;
  if (errors[text]) return errors[text];
  const size = text.match(/^数据超过 (\d+) MB 限制$/);
  if (size) return `Data exceeds the ${size[1]} MB limit.`;
  for (const [prefix, english] of [
    ['无法保存编辑恢复副本：','Could not save the edit recovery copy: '],
    ['数据格式有误：','Invalid data: '],
    ['导入数据格式有误：','Invalid import data: '],
    ['本地文件操作失败：','Local file operation failed: '],
    ['外观设置保存失败：','Appearance settings could not be saved: '],
    ['恢复内容未通过校验，原文件已保留：','Recovery data is invalid. The original file is preserved: '],
    ['无法恢复备份：','Could not restore the backup: '],
    ['备份已导出至：','Backup exported to: '],
  ]) if (text.startsWith(prefix)) return english + localizeError(text.slice(prefix.length), language);
  return text;
}
