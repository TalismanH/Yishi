import {mountWorkbench} from './workbench.mjs';
import {workspaceRequest, installNativeCloseGuard, installNativeDownloadFeedback} from './transport.mjs';

await mountWorkbench(document.body, {
  request:workspaceRequest, marked:window.marked, renderMathInElement:window.renderMathInElement,
  storage:localStorage, appearanceRoot:document.documentElement, beforeUnload:true,
  onLanguageChange: async language => {
    document.title = language === 'en' ? 'Yishi · Local task workbench' : '一事 · 本地待办';
    if (window.__TAURI__?.core?.invoke) await window.__TAURI__.core.invoke('set_language',{language});
  },
  nativeIntegration:window.__TAURI__ ? async ({toast,getLanguage,...callbacks}) => {
    const disposeDownload = await installNativeDownloadFeedback(toast,undefined,getLanguage);
    try {
      const disposeClose = await installNativeCloseGuard(callbacks);
      return () => {disposeDownload?.();disposeClose?.();};
    } catch (error) {disposeDownload?.();throw error;}
  } : undefined,
});
