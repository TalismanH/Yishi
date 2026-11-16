import {mountWorkbench} from './workbench.mjs';
import {workspaceRequest, installNativeCloseGuard, installNativeDownloadFeedback} from './transport.mjs';

await mountWorkbench(document.body, {
  request:workspaceRequest, marked:window.marked, renderMathInElement:window.renderMathInElement,
  storage:localStorage, appearanceRoot:document.documentElement, beforeUnload:true,
  nativeIntegration:window.__TAURI__ ? async ({toast,...callbacks}) => {
    const disposeDownload = await installNativeDownloadFeedback(toast);
    try {
      const disposeClose = await installNativeCloseGuard(callbacks);
      return () => {disposeDownload?.();disposeClose?.();};
    } catch (error) {disposeDownload?.();throw error;}
  } : undefined,
});
