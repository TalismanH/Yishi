import http from 'node:http';
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInitialState, validateState } from './public/model.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const bodyLimit = 5 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

export async function createTodoServer({ dataDir = path.join(root, 'data') } = {}) {
  await mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'workspace.json');
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(filename, 'utf8'));
    validateState(snapshot.state);
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('无效的数据版本');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`数据文件无法读取，已保留原文件，请检查 ${filename}`, { cause: error });
    snapshot = { state: createInitialState(), revision: 0 };
    validateState(snapshot.state);
    await writeFile(filename + '.tmp', JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(filename + '.tmp', filename);
  }
  let writes = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Yishi-App', '1');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        return send(403, { error: '拒绝非本机窗口的请求' });
      }
      const pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
      if (pathname === '/api/state') {
        if (request.method === 'GET') return send(200, snapshot);
        if (request.method !== 'PUT') return send(405, { error: '不支持的请求方法' });
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return send(415, { error: '需要 JSON 数据' });
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > bodyLimit) return send(413, { error: '数据超过 5 MB 限制' });
          chunks.push(chunk);
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          validateState(payload.state);
          if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error('无效的数据版本');
        } catch (error) {
          return send(400, { error: `数据格式有误：${error.message}` });
        }
        const write = writes.then(async () => {
          if (payload.revision !== snapshot.revision) return send(409, { error: '数据已在其他窗口更新，请刷新后重试' });
          const next = { state: payload.state, revision: snapshot.revision + 1 };
          await writeFile(filename + '.tmp', JSON.stringify(next, null, 2), 'utf8');
          await copyFile(filename, filename + '.bak');
          await rename(filename + '.tmp', filename);
          snapshot = next;
          send(200, { revision: snapshot.revision });
        });
        writes = write.catch(() => {});
        await write;
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: '不支持的请求方法' });
      const staticPath = pathname === '/' ? '/index.html' : pathname;
      const allowed = ['/index.html', '/app.mjs', '/model.mjs', '/style.css'].includes(staticPath)
        || /^\/vendor\/[a-zA-Z0-9_./-]+$/.test(staticPath);
      const filenameToServe = path.resolve(publicDir, '.' + staticPath);
      if (!allowed || !filenameToServe.startsWith(publicDir + path.sep) || staticPath.split('/').includes('..')) return send(404, { error: '文件不存在' });
      let content;
      try { content = await readFile(filenameToServe); }
      catch (error) {
        if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return send(404, { error: '文件不存在' });
        throw error;
      }
      response.writeHead(200, { 'Content-Type': mime[path.extname(staticPath)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error instanceof URIError) return send(400, { error: '无效的文件路径' });
      console.error('本地服务错误：', error);
      if (!response.headersSent) send(500, { error: '保存失败，原数据已保留，请检查磁盘空间和文件权限' });
      else response.end();
    }
  });
  return server;
}

function openWindow(url, dataDir) {
  const edge = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
    .filter(Boolean).map(base => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync);
  if (edge) {
    const child = spawn(edge, [`--app=${url}`, '--window-size=1440,1000', `--user-data-dir=${path.join(dataDir, 'browser-profile')}`, '--no-first-run'], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.on('error', error => console.error(`窗口启动失败，请手动打开 ${url}：${error.message}`));
    child.unref();
  } else {
    console.log(`未找到 Microsoft Edge，请在浏览器打开：${url}`);
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.TODO_PORT || 4317);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TODO_PORT 必须是 1–65535 之间的整数');
    const dataDir = path.resolve(process.env.TODO_DATA_DIR || path.join(root, 'data'));
    const server = await createTodoServer({ dataDir });
    server.on('error', async error => {
      if (error.code === 'EADDRINUSE' && !process.argv.includes('--no-open')) {
        try {
          const url = `http://127.0.0.1:${port}`;
          const response = await fetch(url + '/api/state', { signal: AbortSignal.timeout(1500) });
          if (response.ok && response.headers.get('X-Yishi-App') === '1') {
            console.log('已打开正在运行的一事工作台。');
            openWindow(url, dataDir);
            return;
          }
        } catch {}
      }
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请检查是否已经启动，或设置 TODO_PORT 使用其他端口。` : error.message);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`待办工作台已启动：${url}\n数据位置：${dataDir}\n请保留此窗口；按 Ctrl+C 退出。`);
      if (!process.argv.includes('--no-open')) openWindow(url, dataDir);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
