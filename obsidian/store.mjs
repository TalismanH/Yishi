import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateState } from '../public/model.mjs';

const WRITE_LIMIT = 5 * 1024 * 1024;
const READ_LIMIT = 64 * 1024 * 1024;

export class StoreError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.status = status;
  }
}

function checkRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new StoreError(400, '无效的数据版本');
}

function encode(value, limit = WRITE_LIMIT) {
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch (cause) { throw new StoreError(400, '数据无法编码为 JSON', { cause }); }
  if (text === undefined) throw new StoreError(400, '数据无法编码为 JSON');
  if (Buffer.byteLength(text, 'utf8') > limit) throw new StoreError(413, `数据超过 ${limit / 1024 / 1024} MB 限制`);
  return text;
}

function readText(filename) {
  const descriptor = openSync(filename, 'r');
  try {
    if (fstatSync(descriptor).size > READ_LIMIT) throw new StoreError(413, '数据文件超过 64 MB 限制');
    const text = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > READ_LIMIT) throw new StoreError(413, '数据文件超过 64 MB 限制');
    return text;
  } finally { closeSync(descriptor); }
}

function parseSnapshot(text) {
  const snapshot = JSON.parse(text);
  validateState(snapshot?.state);
  checkRevision(snapshot.revision);
  return snapshot;
}

export function parseImport(text) {
  if (typeof text !== 'string') throw new StoreError(400, '请选择 JSON 工作区或备份文件');
  if (Buffer.byteLength(text, 'utf8') > READ_LIMIT) throw new StoreError(413, '导入文件超过 64 MB 限制');
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    const snapshot = parsed && Object.hasOwn(parsed, 'state');
    if (snapshot) checkRevision(parsed.revision);
    const state = snapshot ? parsed.state : parsed;
    validateState(state);
    encode({ state, revision: 0 });
    return state;
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new StoreError(400, `导入数据格式有误：${cause.message}`, { cause });
  }
}

function writeNew(filename, text) {
  const descriptor = openSync(filename, 'wx', 0o600);
  let complete = false;
  try {
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) unlinkSync(filename);
  }
}

function atomicWrite(filename, text) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeNew(temporary, text);
    renameSync(temporary, filename);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function storageError(error) {
  return error instanceof StoreError ? error : new StoreError(500, `本地文件操作失败：${error.message}`, { cause: error });
}

export class WorkspaceStore {
  #observed = false;
  #baseText;
  #revision = null;

  constructor(directory, {legacyDirectory} = {}) {
    this.directory = path.resolve(directory);
    this.legacyDirectory = legacyDirectory ? path.resolve(legacyDirectory) : null;
    this.filename = path.join(this.directory, 'workspace.json');
    this.backupPath = this.filename + '.bak';
    this.lockPath = path.join(this.directory, 'workspace.lock');
    this.recoveryPath = path.join(this.directory, `recovery-${randomUUID()}.json`);
  }

  #withLock(directory, operation) {
    let descriptor;
    const lockPath = path.join(directory, 'workspace.lock');
    try {
      mkdirSync(directory, { recursive: true });
      try { descriptor = openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new StoreError(409, '工作区正在写入或存在遗留锁。请关闭其他一事窗口；确认没有程序使用后移除 workspace.lock 再重试。');
        throw error;
      }
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      // Synchronous transactions serialize callers in this process; the lock protects other plugin instances.
      return operation();
    } catch (error) { throw storageError(error); }
    finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        unlinkSync(lockPath);
      }
    }
  }

  #transaction(operation) {return this.#withLock(this.directory, operation);}

  #migrateLegacy() {
    const directory = this.legacyDirectory;
    if (!directory || directory === this.directory || !existsSync(path.join(directory, 'workspace.json'))) return;
    this.#withLock(directory, () => {
      if (lstatSync(directory).isSymbolicLink() || lstatSync(path.join(directory,'workspace.json')).isSymbolicLink()) throw new StoreError(400, '旧工作区含非普通数据文件，迁移已停止。');
      if (lstatSync(directory).isSymbolicLink() || lstatSync(path.join(directory,'workspace.json')).isSymbolicLink()) throw new StoreError(400, '旧工作区含非普通数据文件，迁移已停止。');
      const original = readText(path.join(directory, 'workspace.json'));
      try {parseSnapshot(original);}
      catch (cause) {throw new StoreError(500, '旧工作区无法读取，原目录已保留，请选择有效备份导入。', {cause});}
      const copies = [];
      function collect(relative) {
        const filename = path.join(directory, relative);
        const stat = lstatSync(filename);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new StoreError(400, '旧工作区含非普通数据文件，迁移已停止。');
        copies.push({relative, text:readText(filename), atime:stat.atime, mtime:stat.mtime});
      }
      if (existsSync(path.join(directory, 'workspace.json.bak'))) collect('workspace.json.bak');
      for (const name of readdirSync(directory)) if (/^recovery-[\da-f-]+\.json$/.test(name)) collect(name);
      const backups = path.join(directory, 'backups');
      if (existsSync(backups)) {
        if (lstatSync(backups).isSymbolicLink() || !lstatSync(backups).isDirectory()) throw new StoreError(400, '旧备份目录无法安全读取，原文件已保留。');
        for (const name of readdirSync(backups)) if (name.endsWith('.json')) collect(path.join('backups',name));
      }
      for (const copy of copies) {
        let target = path.join(this.directory, copy.relative);
        mkdirSync(path.dirname(target), {recursive:true});
        if (existsSync(target)) {
          if (readText(target) === copy.text) continue;
          // Preserve unrelated/pre-existing destination files as well as the old copy.
          target = copy.relative.startsWith('recovery-')
            ? path.join(this.directory, `recovery-${randomUUID()}.json`)
            : path.join(this.directory, 'backups', `legacy-${randomUUID()}.json`);
          mkdirSync(path.dirname(target), {recursive:true});
        }
        writeNew(target,copy.text);
        if (readText(target) !== copy.text) throw new StoreError(500, '迁移副本校验失败，原目录已保留。');
        utimesSync(target,copy.atime,copy.mtime);
      }
      this.#archive(original,'migration-source');
      if (existsSync(this.filename) || readText(path.join(directory,'workspace.json')) !== original) {
        throw new StoreError(409, '迁移期间数据发生变化，已保留两处文件，请重新打开工作台。');
      }
      atomicWrite(this.filename,original);
      if (readText(this.filename) !== original) throw new StoreError(500, '迁移副本校验失败，原目录已保留。');
    });
  }

  async load() {
    return this.#transaction(() => {
      let text;
      try { text = readText(this.filename); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (this.#observed || existsSync(this.backupPath)) {
          this.#baseText = null;
          this.#revision = null;
          this.#observed = true;
          throw new StoreError(500, '工作区文件缺失，已有数据未被重置；请导入备份或恢复上一版本。');
        }
        try {this.#migrateLegacy();}
        catch (error) {
          if (!existsSync(this.filename)) {this.#observed = true;this.#baseText = null;this.#revision = null;}
          throw error;
        }
        if (existsSync(this.filename)) text = readText(this.filename);
        else {
          text = encode({ state: { version: 1, projects: [] }, revision: 0 });
          atomicWrite(this.filename, text);
        }
      }
      this.#baseText = text;
      this.#revision = null;
      this.#observed = true;
      try {
        const snapshot = parseSnapshot(text);
        this.#revision = snapshot.revision;
        return snapshot;
      } catch (cause) {
        throw new StoreError(500, '数据文件无法读取，已保留原文件；请导入备份或恢复上一版本。', { cause });
      }
    });
  }

  #current(expectedRevision) {
    if (!this.#observed) throw new StoreError(409, '请先重新打开工作台再保存');
    let text;
    try { text = readText(this.filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; text = null; }
    if (text !== this.#baseText || expectedRevision !== this.#revision) {
      throw new StoreError(409, '数据已在其他窗口或同步程序中更新，请先导出当前备份，再重新打开工作台。');
    }
    if (this.#revision === null) return { text, snapshot: null };
    return { text, snapshot: parseSnapshot(text) };
  }

  #archive(text, prefix) {
    const directory = path.join(this.directory, 'backups');
    mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    writeNew(filename, text);
    return filename;
  }

  #replace(state, expectedRevision, archivePrefix) {
    const current = this.#current(expectedRevision);
    const revision = (current.snapshot?.revision ?? 0) + 1;
    checkRevision(revision);
    const next = { state, revision };
    const text = encode(next);
    if (archivePrefix && current.text !== null) this.#archive(current.text, archivePrefix);
    if (current.snapshot) atomicWrite(this.backupPath, current.text);
    // shortcut: external sync tools do not honor this lock; cross-device merging needs a separate protocol.
    let latest;
    try { latest = readText(this.filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; latest = null; }
    if (latest !== current.text) throw new StoreError(409, '保存期间检测到外部修改，原文件已保留，请先导出当前备份。');
    atomicWrite(this.filename, text);
    this.#baseText = text;
    this.#revision = revision;
    return next;
  }

  async save(payload) {
    let snapshot;
    try {
      snapshot = JSON.parse(encode(payload));
      validateState(snapshot.state);
      checkRevision(snapshot.revision);
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(400, `数据格式有误：${cause.message}`, { cause });
    }
    return this.#transaction(() => ({ revision: this.#replace(snapshot.state, snapshot.revision).revision }));
  }

  async importState(text, expectedRevision) {
    const state = parseImport(text);
    if (expectedRevision !== null) checkRevision(expectedRevision);
    return this.#transaction(() => this.#replace(state, expectedRevision, 'before-import'));
  }

  async restoreBackup(expectedRevision) {
    if (expectedRevision !== null) checkRevision(expectedRevision);
    return this.#transaction(() => {
      let state;
      try { state = parseSnapshot(readText(this.backupPath)).state; }
      catch (cause) { throw new StoreError(500, '上一版本备份无法读取，未修改现有文件。', { cause }); }
      return this.#replace(state, expectedRevision, 'before-restore');
    });
  }

  async exportState(state) {
    const text = encode(state, READ_LIMIT);
    try { return this.#archive(text, 'Yishi-backup'); }
    catch (error) { throw storageError(error); }
  }

  writeRecovery(snapshot) {
    const text = encode(snapshot, READ_LIMIT);
    try {
      mkdirSync(this.directory, { recursive: true });
      atomicWrite(this.recoveryPath, text);
    } catch (error) { throw storageError(error); }
  }

  clearRecovery() {
    try { unlinkSync(this.recoveryPath); }
    catch (error) { if (error.code !== 'ENOENT') throw storageError(error); }
  }

  async listRecoveries() {
    try {
      return readdirSync(this.directory).filter(name => /^recovery-[\da-f-]+\.json$/.test(name)).flatMap(name => {
        const filename = path.join(this.directory, name), stat = lstatSync(filename);
        return stat.isFile() ? [{ path: filename, modifiedAt: stat.mtime.toISOString() }] : [];
      }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch (error) { if (error.code === 'ENOENT') return []; throw storageError(error); }
  }

  async readRecovery(filename) {
    if (path.dirname(path.resolve(filename)) !== this.directory || !/^recovery-[\da-f-]+\.json$/.test(path.basename(filename))) {
      throw new StoreError(400, '恢复文件不在当前工作区内');
    }
    try {
      if (!lstatSync(filename).isFile()) throw new StoreError(400, '恢复文件不是普通文件');
      return JSON.parse(readText(filename));
    } catch (error) { throw storageError(error); }
  }
}
