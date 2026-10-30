# 一事 · 桌面待办

一个在本机运行的简洁待办软件。使用已安装的 Microsoft Edge 打开独立应用窗口，Node.js 提供本地文件保存；不需要安装 npm 依赖，也不需要登录。

## 启动

Windows 需要 **Node.js 22 或更新版本**，以及 Microsoft Edge。双击 `start.cmd`；也可以运行 `npm start`。请保留服务控制台，按 `Ctrl+C` 停止服务。默认地址为 `http://127.0.0.1:4317`，服务仅监听本机。

这是 Edge 应用窗口版本，尚未打包为独立 `.exe` 安装包。没有 Edge 时会回退到浏览器，并显示访问地址。服务运行期间再次双击 `start.cmd` 会重新打开已有工作台；关闭应用窗口后，本地服务仍在控制台运行。

## 使用

- 左侧项目名竖排显示，每次只展开一个项目。顶部切换「项目」「归档」，加号新建项目，项目标题旁的归档图标用于归档当前项目。
- 三列从左到右为「待办项」「进行中」「已完成」。已完成事项不显示新增按钮。
- 直接点击项目名、总体情况或事项正文编辑，离开编辑区域即渲染；输入会自动保存。Markdown 和 LaTeX 语法保持不变。
- 新事项从待办开始。事项内 Enter 新增同级事项，Shift+Enter 换行，Tab 降低层级，Shift+Tab 提升层级；空白新增事项也可以先调整层级再输入。Ctrl+Enter 或 Esc 结束编辑，最多三级。
- 状态只允许 待办 ↔ 进行中 ↔ 已完成。待办用开始按钮；进行中可勾选完成或退回待办；已完成只能恢复到进行中。父事项操作会检查整个子树，任何子事项跳过状态时整次操作均被拒绝。
- 通过事项左侧把手拖动，各层级都可在同列调整顺序与层级，带上所有子事项并保留各自状态；不同状态列之间不能拖动。拖到条目边缘排序，拖到分支图标区域设为子事项；Esc 取消拖动。把手获得焦点时，↑↓可调整同级顺序。
- 项目所有事项完成后可归档，归档仍需二次确认。归档窗口可浏览或恢复，顶部图标可导出全部项目。
- 项目标题右侧的删除按钮会要求再次确认；确认后删除整个项目及其事项。归档项目同样可以删除。
- 输入自动保存，仅出错时显示重试图标。拖动、排序等操作后保留当前滚动位置。

## 数据与恢复

数据保存在程序目录下的 `data/workspace.json`，内容为 `{ state, revision }`。每次保存前会把上一个有效版本复制到 `data/workspace.json.bak`，再用临时文件替换主文件。复制整个 `data` 文件夹可以手动备份，导出的 JSON 可作为额外备份。

数据损坏时程序会停止并保留原文件，不会自动覆盖。恢复时先停止服务，备份当前文件，再将有效的 `.bak` 复制为 `workspace.json`。不要同时运行多个服务进程写同一数据目录。多窗口发生保存版本冲突时，需要刷新后再操作。

可用环境变量 `TODO_PORT` 更换端口，`TODO_DATA_DIR` 更换数据目录。首次运行提供示例项目，随后只读取已保存的数据。

## 验证

```text
npm test
npm run check
node server.mjs --no-open
```

Markdown 和公式渲染资源随程序保存在 `public/vendor`，正常使用不需要联网。本版本不包含账号、云同步或安装包自动更新。

预览见 [界面截图](preview.png)。界面代码位于 `public/app.mjs` / `public/style.css`，三级事项规则位于 `public/model.mjs`，本地窗口与文件保存位于 `server.mjs`。使用 Node 标准库与系统 Edge，无需安装应用依赖，也无需构建步骤。

如环境中已有 Playwright，可运行额外的真实浏览器检查（不影响普通启动）：

```powershell
# 指向现有 Playwright 的 index.mjs；已能直接导入 playwright 时无需设置
$env:PLAYWRIGHT_MODULE = 'C:\path\to\playwright\index.mjs'
node tests/ui-smoke.mjs
```

浏览器检查使用临时数据目录，不修改实际工作台。Markdown 使用 [Marked](https://marked.js.org/)，公式使用 [KaTeX 0.16.11](https://katex.org/docs/browser.html)，均随程序离线分发；对应许可证保存在 `public/vendor/MARKED-LICENSE.md` 与 `public/vendor/KATEX-LICENSE`。原始 HTML 按安全标签白名单过滤，不支持外部图片或脚本。
