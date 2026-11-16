import {Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, FileSystemAdapter, Scope} from 'obsidian';
import {shell} from 'electron';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import marked from '../public/vendor/marked.umd.js';
import renderMathInElement from '../public/vendor/contrib/auto-render.min.js';
import {mountWorkbench} from '../public/workbench.mjs';
import {WorkspaceStore, parseImport} from './store.mjs';

const VIEW_TYPE = 'yishi-workbench';
const notify = message => new Notice(message, 7000);

class ConfirmImport extends Modal {
  constructor(app, name, state, apply) {
    super(app);
    this.fileLabel = name;
    this.importedState = state;
    this.apply = apply;
  }
  onOpen() {
    this.setTitle('导入一事数据');
    this.contentEl.createEl('p', {text: this.fileLabel});
    const tasks = this.importedState.projects.reduce((total, project) => total + project.tasks.length, 0);
    this.contentEl.createEl('p', {text: `${this.importedState.projects.length} 个项目，${tasks} 个事项。当前工作台将被替换，替换前的数据会单独备份。`});
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('备份并导入').setCta().onClick(async () => {
        button.setDisabled(true);
        try {await this.apply(); this.close();}
        catch (error) {notify(error.message); button.setDisabled(false);}
      }));
  }
  onClose() {this.contentEl.empty();}
}

class RecoveryModal extends Modal {
  constructor(plugin) {super(plugin.app); this.plugin = plugin;}
  async onOpen() {
    this.setTitle('未保存内容');
    try {
      const files = await this.plugin.store.listRecoveries();
      if (!files.length) this.contentEl.createEl('p', {text: '没有需要恢复的内容。'});
      for (const file of files) {
        new Setting(this.contentEl).setName(new Date(file.modifiedAt).toLocaleString())
          .addButton(button => button.setButtonText('导入').onClick(async () => {
            try {
              const snapshot = await this.plugin.store.readRecovery(file.path);
              await this.plugin.importText(JSON.stringify(snapshot), path.basename(file.path));
              this.close();
            } catch (error) {notify(`恢复内容未通过校验，原文件已保留：${error.message}`);}
          }));
      }
      new Setting(this.contentEl).addButton(button => button.setButtonText('打开数据文件夹').onClick(() => this.plugin.openFolder()));
    } catch (error) {notify(error.message);}
  }
  onClose() {this.contentEl.empty();}
}

class WorkbenchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = new WorkspaceStore(plugin.dataDirectory);
    this.controller = null;
    this.closed = false;
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, event => {
      if (!this.closed && this.controller?.handleKeydown(event)) return false;
      // An undefined result lets the wildcard defer unhandled keys to the parent scope.
    });
  }
  getViewType() {return VIEW_TYPE;}
  getDisplayText() {return '一事';}
  getIcon() {return 'list-checks';}
  async onOpen() {
    this.closed = false;
    this.addAction('file-input', '导入 JSON', () => this.plugin.pickImport());
    this.addAction('refresh-cw', '重新加载磁盘数据', () => this.reload());
    this.addAction('history', '未保存内容', () => new RecoveryModal(this.plugin).open());
    this.contentEl.addClass('yishi-workbench');
    this.contentEl.onWindowMigrated(() => {if (!this.closed) void this.reload();});
    await this.mount();
  }
  async mount() {
    this.contentEl.empty();
    const controller = await mountWorkbench(this.contentEl, {
      request: async (method = 'GET', payload) => {
        try {
          const result = method === 'GET' ? await this.store.load() : await this.store.save(payload);
          return {ok: true, status: 200, json: async () => result};
        } catch (error) {
          return {ok: false, status: error.status ?? 500, json: async () => ({error: error.message})};
        }
      },
      marked, renderMathInElement,
      storage: this.plugin.appearanceStorage,
      exportBackup: state => this.plugin.exportState(state),
      onRecovery: snapshot => snapshot ? this.store.writeRecovery(snapshot) : this.store.clearRecovery(),
      onError: error => notify(error.message),
    });
    if (this.closed) {controller.destroy(); return;}
    this.controller = controller;
    this.plugin.controllers.add(controller);
  }
  async reload() {
    if (this.reloading || this.closed) return;
    this.reloading = true;
    try {
      if (this.controller) {
        if (!await this.controller.flush()) {
          const snapshot = this.controller.getSnapshot();
          if (snapshot) await this.plugin.exportState(snapshot.state);
        }
        this.dispose();
      }
      await this.mount();
    } catch (error) {notify(error.message);}
    finally {this.reloading = false;}
  }
  dispose() {
    if (!this.controller) return;
    this.plugin.controllers.delete(this.controller);
    this.controller.destroy();
    this.controller = null;
  }
  async onClose() {
    this.closed = true;
    try {
      if (this.controller && !await this.controller.flush()) notify('未保存内容已留在恢复文件中，可从一事设置恢复。');
    } finally {this.dispose();}
  }
}

class YishiSettings extends PluginSettingTab {
  constructor(app, plugin) {super(app, plugin); this.plugin = plugin;}
  display() {
    const {containerEl, plugin} = this;
    containerEl.empty();
    new Setting(containerEl).setName('工作台').addButton(button => button.setButtonText('打开一事').onClick(() => plugin.openWorkbench()));
    new Setting(containerEl).setName('导入 JSON').setDesc('兼容原桌面版工作区文件与导出的备份。导入前自动备份当前数据。')
      .addButton(button => button.setButtonText('选择文件').onClick(() => plugin.pickImport()));
    new Setting(containerEl).setName('导出备份').addButton(button => button.setButtonText('导出').onClick(() => plugin.exportCurrent()));
    new Setting(containerEl).setName('恢复上一版').setDesc('从 workspace.json.bak 恢复；恢复前会另存当前文件。')
      .addButton(button => button.setButtonText('恢复').onClick(() => plugin.restoreBackup()));
    new Setting(containerEl).setName('未保存内容').setDesc('查看关闭视图或保存失败时保留的恢复副本。')
      .addButton(button => button.setButtonText('查看').onClick(() => new RecoveryModal(plugin).open()));
    new Setting(containerEl).setName('数据文件夹').setDesc(plugin.dataDirectory)
      .addButton(button => button.setButtonText('打开').onClick(() => plugin.openFolder()));
  }
}

export default class YishiPlugin extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error('一事目前仅支持桌面本地 Vault。');
    this.dataDirectory = path.join(this.app.vault.adapter.getBasePath(), '一事');
    this.store = new WorkspaceStore(this.dataDirectory);
    this.controllers = new Set();
    this.settings = (await this.loadData()) ?? {};
    this.settingsWrites = Promise.resolve();
    this.appearanceStorage = {
      getItem: key => this.settings[key] ?? null,
      setItem: (key, value) => {
        this.settings[key] = value;
        const snapshot = structuredClone(this.settings);
        this.settingsWrites = this.settingsWrites.catch(() => {}).then(() => this.saveData(snapshot));
        this.settingsWrites.catch(error => notify(`外观设置保存失败：${error.message}`));
      },
    };
    this.registerView(VIEW_TYPE, leaf => new WorkbenchView(leaf, this));
    this.addRibbonIcon('list-checks', '打开一事', () => this.openWorkbench());
    this.addCommand({id: 'open', name: '打开工作台', callback: () => this.openWorkbench()});
    this.addCommand({id: 'import', name: '导入 JSON', callback: () => this.pickImport()});
    this.addCommand({id: 'export', name: '导出备份', callback: () => this.exportCurrent()});
    this.addCommand({id: 'reload', name: '重新加载磁盘数据', callback: async () => (await this.openWorkbench()).reload()});
    this.addCommand({id: 'recover', name: '查看未保存内容', callback: () => new RecoveryModal(this).open()});
    this.addSettingTab(new YishiSettings(this.app, this));
    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      try {if ((await this.store.listRecoveries()).length) notify('一事发现未保存的恢复副本，可在一事设置中查看。');}
      catch (error) {notify(error.message);}
    });
  }
  onunload() {
    this.unloaded = true;
    // Input changes already have a synchronous recovery copy; unloading cannot await disk saves.
    for (const controller of this.controllers) controller.destroy();
    this.controllers.clear();
  }
  async openWorkbench() {
    const {workspace} = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({type: VIEW_TYPE, active: true});
    }
    await workspace.revealLeaf(leaf);
    return leaf.view;
  }
  pickImport() {
    const input = activeDocument.createElement('input');
    input.type = 'file'; input.accept = '.json,.bak,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 64 * 1024 * 1024) throw new Error('导入文件超过 64 MB 限制。');
        await this.importText(await file.text(), file.name);
      } catch (error) {notify(error.message);}
    }, {once: true});
    input.click();
  }
  async importText(text, name) {
    const state = parseImport(text);
    const view = await this.openWorkbench();
    if (view.controller?.getSnapshot() && !await view.controller.flush()) {
      throw new Error('当前内容尚未保存，请先导出备份并重新加载磁盘数据。');
    }
    const revision = view.controller?.getSnapshot()?.revision ?? null;
    const confirmation = new ConfirmImport(this.app, name, state, async () => {
      await view.store.importState(text, revision);
      view.dispose();
      await view.mount();
      notify('导入完成，原数据已备份。');
    });
    confirmation.open();
    return confirmation;
  }
  async exportState(state) {
    const filename = await this.store.exportState(state);
    notify(`备份已导出至：${filename}`);
    return filename;
  }
  async exportCurrent() {
    try {
      const view = await this.openWorkbench();
      const snapshot = view.controller?.getSnapshot();
      if (!snapshot) throw new Error('工作区无法读取，请先检查数据文件或恢复备份。');
      await this.exportState(snapshot.state);
    } catch (error) {notify(error.message);}
  }
  async restoreBackup() {
    try {await this.importText(await readFile(this.store.backupPath, 'utf8'), '上一版备份');}
    catch (error) {notify(`无法恢复备份：${error.message}`);}
  }
  async openFolder() {
    const error = await shell.openPath(this.dataDirectory);
    if (error) notify(error);
  }
}
