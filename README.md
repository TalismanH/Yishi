# 一事 · 桌面待办

一个在本机运行的 Tauri 2 桌面待办软件。界面、Markdown/公式和事项操作沿用原版，数据由 Rust 直接保存，无需登录、Node.js 服务或 Edge 应用窗口。

## 桌面版启动

构建后可直接运行 `src-tauri/target/release/yishi-desktop.exe`，或安装 `src-tauri/target/release/bundle/nsis` 中的安装包。双击 `start.cmd` 会优先打开已构建的 exe；尚未构建时启动开发模式。正式版不需要安装 Node.js、Rust 或 Visual Studio，只需要 Windows 的 WebView2 Runtime。

界面资源与字体随 exe 内嵌，不启动本地 HTTP 服务。关闭窗口前会等待编辑内容保存；保存失败或版本冲突时保留窗口和编辑内容。

## 开发与打包

开发机需要 Node.js 22+、Rust 1.89+ 的 MSVC 工具链、Microsoft C++ Build Tools、Windows SDK 和 WebView2。安装依赖后运行：

```text
npm install
npm run tauri:dev
```

`npm start` 与上述开发命令相同，使用内嵌资源和原生数据接口，不占用 `4317` 端口。修改前端资源后重新启动开发命令；发布给用户的 exe 和安装包需要重新构建：

```text
npm run tauri:build
```

该命令生成 Windows x64 exe 和中文 NSIS 安装包。安装包尚未配置代码签名或自动更新。

```text
npm run tauri:check
```

上面的命令检查 Rust 工程。项目启动器会自动发现 Visual Studio，通过 `VsDevCmd.bat` 为子进程加载 x64 编译环境，并补齐 Cargo 路径；普通终端无需手动打开开发者命令行。该设置仅作用于此次开发命令，不修改系统或用户环境变量。

## 使用

- 左侧项目名竖排显示，每次只展开一个项目。顶部切换「项目」「归档」，加号新建项目，项目标题旁的归档图标用于归档当前项目。
- 三列从左到右为「待办项」「进行中」「已完成」。已完成事项不显示新增按钮。
- 直接点击项目名、总体情况或事项正文编辑，离开编辑区域即渲染；输入会自动保存。Markdown 和 LaTeX 语法保持不变。
- 总体情况和事项正文中，Ctrl+B 加粗选中文字，再按一次取消；未选中文字时插入加粗标记。总体情况的分点后，顶格普通行退出列表；显式缩进的续行和嵌套列表仍保留。
- 一级、二级事项的定位按钮会滚动并闪烁高亮其他列中的同一事项（包括虚线条目）；其他列没有该事项时跳过，不改变事项状态。
- 新事项从待办开始。事项内 Enter 新增同级事项，Shift+Enter 换行，Tab 降低层级，Shift+Tab 提升层级；空白新增事项也可以先调整层级再输入。Ctrl+Enter 或 Esc 结束编辑，最多三级。
- 状态只允许 待办 ↔ 进行中 ↔ 已完成。待办用开始按钮；进行中可勾选完成或退回待办；已完成只能恢复到进行中。父事项操作会检查整个子树，任何子事项跳过状态时整次操作均被拒绝。
- 通过事项左侧把手拖动，各层级都可在同列调整顺序与层级，带上所有子事项并保留各自状态；不同状态列之间不能拖动。拖到条目边缘排序，拖到分支图标区域设为子事项；Esc 取消拖动。把手获得焦点时，↑↓可调整同级顺序。
- 项目所有事项完成后可归档，归档仍需二次确认。归档窗口可浏览或恢复，顶部图标可导出全部项目。
- 桌面版导出完成后会短暂显示实际保存路径；默认保存到系统下载目录，同名备份自动编号，失败时显示错误提示。
- 项目标题右侧的删除按钮会要求再次确认；确认后删除整个项目及其事项。归档项目同样可以删除。
- 输入自动保存，仅出错时显示重试图标。拖动、排序等操作后保留当前滚动位置。

## 数据与恢复

桌面版数据保存在 `%APPDATA%/com.hzh.yishi/workspace.json`，内容仍为 `{ state, revision }`。每次保存前保留上一个有效版本为 `workspace.json.bak`，再用已同步到磁盘的临时文件原子替换。可复制整个数据目录手动备份，导出的 JSON 格式保持不变。

首次启动且桌面数据不存在时，会查找旧版 `data/workspace.json`：开发模式查找本项目目录；发布版查找 exe 所在目录和启动目录。找到后复制到新位置，并保留 `workspace.json.migration.bak`，不修改旧文件。首次迁移后，两版的数据各自保存；继续使用前请关闭旧版，避免在两个副本中分别编辑。

若旧数据放在其他目录，首次启动前设置 `TODO_LEGACY_DATA_DIR` 为包含旧 `workspace.json` 的目录。已存在桌面数据时不会重复导入。`TODO_DATA_DIR` 可指定原生数据目录；显式指定时默认不导入旧数据，适合隔离测试。

损坏文件不会被自动覆盖；恢复前关闭所有窗口、备份当前文件，再将有效 `.bak` 复制为 `workspace.json`。多窗口写入由系统文件锁和版本检查保护，冲突窗口保留未保存内容，可先导出备份，再重新打开。

旧浏览器版本仍可用 `npm run start:web` 启动，保留用于兼容和回归对照；它继续使用项目 `data` 目录，与原生版互不代写。`TODO_PORT` 仅对该旧服务生效。

## 验证

```text
npm test
npm run check
npm run tauri:test
npm run tauri:check
```

Markdown 和公式渲染资源随程序保存在 `public/vendor`，正常使用不需要联网。本版本不包含账号、云同步或安装包自动更新。

预览见 [界面截图](preview.png)。界面代码位于 `public/app.mjs` / `public/style.css`，三级事项规则位于 `public/model.mjs`；`public/transport.mjs` 适配原生 IPC 与旧 HTTP 接口，`src-tauri/src` 负责桌面窗口和原生文件保存。

如环境中已有 Playwright，可运行额外的真实浏览器检查（不影响普通启动）：

```powershell
# 指向现有 Playwright 的 index.mjs；已能直接导入 playwright 时无需设置
$env:PLAYWRIGHT_MODULE = 'C:\path\to\playwright\index.mjs'
node tests/ui-smoke.mjs
node tests/tauri-native-smoke.mjs
```

浏览器检查使用临时数据目录，不修改实际工作台。Markdown 使用 [Marked](https://marked.js.org/)，公式使用 [KaTeX 0.16.11](https://katex.org/docs/browser.html)，均随程序离线分发；对应许可证保存在 `public/vendor/MARKED-LICENSE.md` 与 `public/vendor/KATEX-LICENSE`。原始 HTML 按安全标签白名单过滤，不支持外部图片或脚本。
