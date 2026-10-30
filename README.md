# 一事 · 桌面待办

一个在本机运行的简洁待办软件。使用已安装的 Microsoft Edge 打开独立应用窗口，Node.js 提供本地文件保存；不需要安装 npm 依赖，也不需要登录。

## 启动

Windows 需要 **Node.js 22 或更新版本**，以及 Microsoft Edge。双击 `start.cmd`；也可以运行 `npm start`。请保留服务控制台，按 `Ctrl+C` 停止服务。默认地址为 `http://127.0.0.1:4317`，服务仅监听本机。

这是 Edge 应用窗口版本，尚未打包为独立 `.exe` 安装包。没有 Edge 时会回退到浏览器，并显示访问地址。服务运行期间再次双击 `start.cmd` 会重新打开已有工作台；关闭应用窗口后，本地服务仍在控制台运行。

## 使用

- 项目纵向排列，每次仅展开一个。总体情况与事项正文支持 Markdown、行内 `$...$` 和块级 `$$...$$` 数学公式；直接编辑源文本，没有文字格式按钮。
- 事项最多三级。拖动父事项会带上整棵子事项，跨状态移动会同时更新其子事项；单独移动子事项后保留其所属父事项上下文。拖动到目标条目的上方或下方调整顺序，缩进区域用于归入目标事项。
- 通过完成方框以及开始、待办、重新打开等快捷操作在“进行中”“待办理”“已完成”之间切换。
- 所有事项完成后可以归档，归档前会再次确认。点击“归档项目”切换归档浏览界面，可恢复归档项目。
- 可导出 JSON 备份。操作会自动保存；保存失败时界面会提示，避免在未保存时关闭窗口。

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
