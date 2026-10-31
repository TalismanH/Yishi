import {execFileSync, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseWindowsEnvironment(output, base = {}) {
  const environment = Object.fromEntries(Object.entries(base).map(([key,value]) => [key.toUpperCase(),value]));
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals > 0) environment[line.slice(0,equals).toUpperCase()] = line.slice(equals+1);
  }
  return environment;
}

export function createTauriEnvironment(base = process.env) {
  let environment = process.platform === 'win32' ? parseWindowsEnvironment('',base) : {...base};
  if (process.platform === 'win32') {
    const vswhere = path.join(environment['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
    if (!existsSync(vswhere)) throw new Error('未找到 Visual Studio 安装查询工具，请安装带 C++ 桌面开发组件的 Visual Studio');
    let installation;
    try {
      installation = execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath','-utf8'],{env:environment,encoding:'utf8',windowsHide:true,timeout:30000}).replace(/^\uFEFF/,'').trim();
    } catch {
      throw new Error('无法查询 Visual Studio C++ 开发环境');
    }
    const devCommand = path.join(installation,'Common7','Tools','VsDevCmd.bat');
    if (!installation || !existsSync(devCommand)) throw new Error('未找到完整的 Visual Studio C++ 开发工具，请在安装器中补齐 C++ 桌面开发组件');
    try {
      const output = execFileSync(environment.COMSPEC || 'cmd.exe',['/d','/s','/c',`chcp 65001 >nul && call "${devCommand}" -no_logo -arch=x64 -host_arch=x64 >nul && set`],{env:environment,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,windowsVerbatimArguments:true});
      environment = parseWindowsEnvironment(output,environment);
    } catch {
      throw new Error('无法加载 Visual Studio x64 编译环境，请确认 Windows SDK 与 C++ 工具已完整安装');
    }
    if (!environment.LIB || !environment.INCLUDE || !environment.WINDOWSSDKDIR) throw new Error('Visual Studio 未提供完整的 LIB、INCLUDE 或 Windows SDK 配置');
  }
  const cargoBin = path.join(environment.CARGO_HOME || path.join(environment.USERPROFILE || homedir(),'.cargo'),'bin');
  environment.PATH = [cargoBin,...(environment.PATH || '').split(path.delimiter).filter(entry => entry.toLowerCase() !== cargoBin.toLowerCase())].join(path.delimiter);
  return environment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), environment = createTauriEnvironment();
    const cargo = ['check','test'].includes(args[0]);
    const cli = path.join(root,'node_modules','@tauri-apps','cli','tauri.js');
    if (!cargo && !existsSync(cli)) throw new Error('未安装项目 Tauri CLI，请先运行 npm install');
    const child = spawn(cargo ? 'cargo' : process.execPath,cargo ? [args[0],'--manifest-path',path.join(root,'src-tauri','Cargo.toml'),...args.slice(1)] : [cli,...args],{cwd:root,env:environment,stdio:'inherit',windowsHide:args[0] !== 'dev'});
    child.once('error',error => {console.error(`无法启动开发工具（${error.code || '未知错误'}），请确认 Rust 与项目依赖已安装`);process.exitCode=1;});
    child.once('exit',code => {process.exitCode=code ?? 1;});
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
