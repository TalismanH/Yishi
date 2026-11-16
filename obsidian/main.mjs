import {normalizeLanguage, readLanguage, translate, localizeError} from '../public/i18n.mjs';
import {Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, FileSystemAdapter, Scope} from 'obsidian';
import {shell} from 'electron';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import marked from '../public/vendor/marked.umd.js';
import renderMathInElement from '../public/vendor/contrib/auto-render.min.js';
import {mountWorkbench} from '../public/workbench.mjs';
import {WorkspaceStore, parseImport} from './store.mjs';

const VIEW_TYPE = 'yishi-workbench';

class ConfirmImport extends Modal {
  constructor(plugin, name, state, apply) {
    super(plugin.app);
    this.plugin = plugin;
    this.fileLabel = name;
    this.importedState = state;
    this.apply = apply;
  }
  onOpen() {
    this.setTitle(this.plugin.t("导入一事数据","Import Yishi data"));
    this.contentEl.createEl('p', {text: this.fileLabel});
    const tasks = this.importedState.projects.reduce((total, project) => total + project.tasks.length, 0);
    this.contentEl.createEl('p', {text: this.plugin.t(`${this.importedState.projects.length} 个项目，${tasks} 个事项。当前工作台将被替换，替换前的数据会单独备份。`,`${this.importedState.projects.length} projects, ${tasks} tasks. This replaces the current workspace after creating a separate backup.`)});
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(this.plugin.t("取消","Cancel")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(this.plugin.t("备份并导入","Back up and import")).setCta().onClick(async () => {
        button.setDisabled(true);
        try {await this.apply(); this.close();}
        catch (error) {this.plugin.notify(error.message); button.setDisabled(false);}
      }));
  }
  onClose() {this.contentEl.empty();}
}

class RecoveryModal extends Modal {
  constructor(plugin) {super(plugin.app); this.plugin = plugin;}
  async onOpen() {
    this.setTitle(this.plugin.t("未保存内容","Unsaved edits"));
    try {
      const files = await this.plugin.store.listRecoveries();
      if (!files.length) this.contentEl.createEl('p', {text: this.plugin.t("没有需要恢复的内容。","There are no recovery copies.")});
      for (const file of files) {
        new Setting(this.contentEl).setName(new Date(file.modifiedAt).toLocaleString(this.plugin.language==='en'?'en-US':'zh-CN'))
          .addButton(button => button.setButtonText(this.plugin.t("导入","Import")).onClick(async () => {
            try {
              const snapshot = await this.plugin.store.readRecovery(file.path);
              await this.plugin.importText(JSON.stringify(snapshot), path.basename(file.path));
              this.close();
            } catch (error) {this.plugin.notify(`恢复内容未通过校验，原文件已保留：${error.message}`);}
          }));
      }
      new Setting(this.contentEl).addButton(button => button.setButtonText(this.plugin.t("打开数据文件夹","Open data folder")).onClick(() => this.plugin.openFolder()));
    } catch (error) {this.plugin.notify(error.message);}
  }
  onClose() {this.contentEl.empty();}
}

class WorkbenchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = new WorkspaceStore(plugin.dataDirectory,{legacyDirectory:plugin.legacyDirectory});
    this.controller = null;
    this.closed = false;
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, event => {
      if (!this.closed && this.controller?.handleKeydown(event)) return false;
      // An undefined result lets the wildcard defer unhandled keys to the parent scope.
    });
  }
  getViewType() {return VIEW_TYPE;}
  getDisplayText() {return this.plugin.t('一事','Yishi');}
  getIcon() {return 'list-checks';}
  async onOpen() {
    this.closed = false;
    this.actions = [
      ['file-input','导入 JSON','Import JSON',() => this.plugin.pickImport()],
      ['refresh-cw','重新加载磁盘数据','Reload from disk',() => this.reload()],
      ['history','未保存内容','Unsaved edits',() => new RecoveryModal(this.plugin).open()],
    ].map(([icon,zh,en,callback]) => ({element:this.addAction(icon,this.plugin.t(zh,en),callback),zh,en}));
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
      onError: error => this.plugin.notify(error.message),
      onLanguageChange: language => this.plugin.refreshLanguage(language),
    });
    if (this.closed) {controller.destroy(); return;}
    this.controller = controller;
    this.plugin.controllers.add(controller);
  }
  updateLabels() {
    for (const {element,zh,en} of this.actions ?? []) element.setAttribute('aria-label',this.plugin.t(zh,en));
    void this.leaf.setViewState(this.leaf.getViewState()).catch(error => this.plugin.notify(error.message));
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
    } catch (error) {this.plugin.notify(error.message);}
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
      if (this.controller && !await this.controller.flush()) this.plugin.notify(this.plugin.t("未保存内容已留在恢复文件中，可从一事设置恢复。","Unsaved edits are kept in recovery files. Open Yishi settings to recover them."));
    } finally {this.dispose();}
  }
}

class YishiSettings extends PluginSettingTab {
  constructor(app, plugin) {super(app, plugin); this.plugin = plugin;}
  display() {
    const {containerEl, plugin} = this;
    containerEl.empty();
    new Setting(containerEl).setName(plugin.t('语言','Language')).addDropdown(dropdown => dropdown
      .addOption('zh','中文').addOption('en','English').setValue(plugin.language)
      .onChange(async language => {
        try {await plugin.setLanguage(language);this.display();}
        catch (error) {plugin.notify(error.message);dropdown.setValue(plugin.language);}
      }));
    new Setting(containerEl).setName(this.plugin.t("工作台","Workbench")).addButton(button => button.setButtonText(this.plugin.t("打开一事","Open Yishi")).onClick(() => plugin.openWorkbench()));
    new Setting(containerEl).setName(this.plugin.t("导入 JSON","Import JSON")).setDesc(this.plugin.t("兼容原桌面版工作区文件与导出的备份。导入前自动备份当前数据。","Import a workspace or exported JSON backup. Current data is backed up before replacement."))
      .addButton(button => button.setButtonText(this.plugin.t("选择文件","Choose file")).onClick(() => plugin.pickImport()));
    new Setting(containerEl).setName(this.plugin.t("导出备份","Export backup")).addButton(button => button.setButtonText(this.plugin.t("导出","Export")).onClick(() => plugin.exportCurrent()));
    new Setting(containerEl).setName(this.plugin.t("恢复上一版","Restore previous version")).setDesc(this.plugin.t("从 workspace.json.bak 恢复；恢复前会另存当前文件。","Restore workspace.json.bak. The current file is backed up first."))
      .addButton(button => button.setButtonText(this.plugin.t("恢复","Restore")).onClick(() => plugin.restoreBackup()));
    new Setting(containerEl).setName(this.plugin.t("未保存内容","Unsaved edits")).setDesc(this.plugin.t("查看关闭视图或保存失败时保留的恢复副本。","Review recovery copies kept when editing was interrupted or saving failed."))
      .addButton(button => button.setButtonText(this.plugin.t("查看","View")).onClick(() => new RecoveryModal(plugin).open()));
    new Setting(containerEl).setName(this.plugin.t("数据文件夹","Data folder")).setDesc(plugin.dataDirectory)
      .addButton(button => button.setButtonText(this.plugin.t("打开","Open")).onClick(() => plugin.openFolder()));
  }
}

export default class YishiPlugin extends Plugin {
  t(zh,en) {return translate(this.language,zh,en);}
  notify(message) {return new Notice(localizeError(message,this.language),7000);}
  registerCommands() {
    for (const id of this.commandIds ?? []) this.removeCommand(id);
    this.commandIds = ['open','import','export','reload','recover'];
    this.addCommand({id:'open',name:this.t('打开工作台','Open workbench'),callback:() => this.openWorkbench()});
    this.addCommand({id:'import',name:this.t('导入 JSON','Import JSON'),callback:() => this.pickImport()});
    this.addCommand({id:'export',name:this.t('导出备份','Export backup'),callback:() => this.exportCurrent()});
    this.addCommand({id:'reload',name:this.t('重新加载磁盘数据','Reload from disk'),callback:async () => (await this.openWorkbench()).reload()});
    this.addCommand({id:'recover',name:this.t('查看未保存内容','Review unsaved edits'),callback:() => new RecoveryModal(this).open()});
  }
  refreshLanguage(value) {
    const language = normalizeLanguage(value);
    if (language === this.language) return;
    this.language = language;
    this.registerCommands();
    this.ribbon?.setAttribute('aria-label',this.t('打开一事','Open Yishi'));
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof WorkbenchView) leaf.view.updateLabels();
    if (this.settingTab?.containerEl.isConnected && this.settingTab.containerEl.offsetParent) this.settingTab.display();
  }
  async setLanguage(value) {
    const language = normalizeLanguage(value);
    for (const controller of this.controllers) if (!await controller.flush()) throw new Error(this.t('当前编辑无法保存，请先导出备份。','Current edits could not be saved. Export a backup first.'));
    let appearance = {};
    try {const value=JSON.parse(this.settings['yishi.appearance'] ?? '{}');if(value && typeof value==='object' && !Array.isArray(value)) appearance=value;} catch {}
    this.appearanceStorage.setItem('yishi.appearance',JSON.stringify({...appearance,language}));
    await this.settingsWrites;
    for (const controller of this.controllers) await controller.setLanguage(language);
  }
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error(this.t("一事目前仅支持桌面本地 Vault。","Yishi currently supports desktop local vaults only."));
    this.dataDirectory = path.join(this.app.vault.adapter.getBasePath(), 'Yishi');
    this.legacyDirectory = path.join(this.app.vault.adapter.getBasePath(), '一事');
    this.store = new WorkspaceStore(this.dataDirectory,{legacyDirectory:this.legacyDirectory});
    this.controllers = new Set();
    this.settings = (await this.loadData()) ?? {};
    this.settingsWrites = Promise.resolve();
    this.appearanceStorage = {
      getItem: key => this.settings[key] ?? null,
      setItem: (key, value) => {
        if (this.settings[key] === value) return;
        this.settings[key] = value;
        const snapshot = structuredClone(this.settings);
        this.settingsWrites = this.settingsWrites.catch(() => {}).then(() => this.saveData(snapshot));
        this.settingsWrites.catch(error => this.notify(`外观设置保存失败：${error.message}`));
        this.refreshLanguage(readLanguage(this.appearanceStorage));
      },
    };
    this.language = readLanguage(this.appearanceStorage);
    this.registerView(VIEW_TYPE, leaf => new WorkbenchView(leaf, this));
    this.ribbon = this.addRibbonIcon('list-checks', this.t("打开一事","Open Yishi"), () => this.openWorkbench());
    this.registerCommands();
    this.settingTab = new YishiSettings(this.app,this);
    this.addSettingTab(this.settingTab);
    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      try {await this.store.load();if ((await this.store.listRecoveries()).length) this.notify(this.t("一事发现未保存的恢复副本，可在一事设置中查看。","Yishi found recovery copies. Review them in Yishi settings."));}
      catch (error) {this.notify(error.message);}
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
        if (file.size > 64 * 1024 * 1024) throw new Error(this.t("导入文件超过 64 MB 限制。","The import file exceeds the 64 MB limit."));
        await this.importText(await file.text(), file.name);
      } catch (error) {this.notify(error.message);}
    }, {once: true});
    input.click();
  }
  async importText(text, name) {
    const state = parseImport(text);
    const view = await this.openWorkbench();
    if (view.controller?.getSnapshot() && !await view.controller.flush()) {
      throw new Error(this.t("当前内容尚未保存，请先导出备份并重新加载磁盘数据。","Current edits could not be saved. Export a backup and reload from disk before importing."));
    }
    const revision = view.controller?.getSnapshot()?.revision ?? null;
    const confirmation = new ConfirmImport(this, name, state, async () => {
      await view.store.importState(text, revision);
      view.dispose();
      await view.mount();
      this.notify(this.t("导入完成，原数据已备份。","Import completed. Previous data was backed up."));
    });
    confirmation.open();
    return confirmation;
  }
  async exportState(state) {
    const filename = await this.store.exportState(state);
    this.notify(`备份已导出至：${filename}`);
    return filename;
  }
  async exportCurrent() {
    try {
      const view = await this.openWorkbench();
      const snapshot = view.controller?.getSnapshot();
      if (!snapshot) throw new Error(this.t("工作区无法读取，请先检查数据文件或恢复备份。","The workspace could not be read. Check the data file or restore a backup."));
      await this.exportState(snapshot.state);
    } catch (error) {this.notify(error.message);}
  }
  async restoreBackup() {
    try {await this.importText(await readFile(this.store.backupPath, 'utf8'), this.t("上一版备份","Previous version"));}
    catch (error) {this.notify(`无法恢复备份：${error.message}`);}
  }
  async openFolder() {
    const error = await shell.openPath(this.dataDirectory);
    if (error) this.notify(error);
  }
}
