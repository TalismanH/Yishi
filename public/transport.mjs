import { createInitialState, validateState } from './model.mjs';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

export async function workspaceRequest(method = 'GET', payload) {
  const native = globalThis.window?.__TAURI__;
  if (!native) return fetch('/api/state', method === 'GET' ? undefined : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  try {
    if (method === 'GET') {
      const initialState = createInitialState();
      validateState(initialState);
      return jsonResponse(await native.core.invoke('load_workspace', { initialState }));
    }
    return jsonResponse(await native.core.invoke('save_workspace', JSON.parse(JSON.stringify(payload))));
  } catch (error) {
    let detail = error;
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { detail = null; }
    }
    const status = [400, 409, 413, 500].includes(detail?.status) ? detail.status : 500;
    const message = typeof detail?.message === 'string' && detail.message.trim() ? detail.message : '本地数据操作失败';
    return jsonResponse({ error: message }, status);
  }
}

export async function installNativeDownloadFeedback(notify, native = globalThis.window?.__TAURI__) {
  if (!native) return;
  return native.event.listen('backup-download-finished', ({payload}) => {
    notify(payload.success
      ? payload.path ? `备份已导出至：${payload.path}` : '备份已导出'
      : '备份导出失败，请重试');
  });
}

export async function installNativeCloseGuard({ persistEditor, isEmptyDraft = () => false, save, isPending, hasError, onError, chooseCloseAction }, native = globalThis.window?.__TAURI__) {
  if (!native) return;
  const nativeWindow = native.window.getCurrentWindow();
  let flushing = false;
  const close = async (exit = false) => {
    if (flushing) return;
    flushing = true;
    try {
      const action = exit || !chooseCloseAction ? 'exit' : await chooseCloseAction();
      if (action !== 'exit' && action !== 'hide') return;
      do {
        if (persistEditor() === false && !isEmptyDraft()) return;
        await save();
        if (hasError() || persistEditor() === false && !isEmptyDraft()) return;
      } while (isPending());
      if (action === 'hide') await native.core.invoke('hide_to_tray');
      else await nativeWindow.destroy();
    } catch (error) { onError?.(error); }
    finally { flushing = false; }
  };
  const unlistenClose = await nativeWindow.onCloseRequested(event => {
    event.preventDefault();
    return close();
  });
  if (!native.event?.listen) return unlistenClose;
  try {
    const unlistenTray = await native.event.listen('tray-exit-requested', () => close(true));
    return () => { unlistenClose();unlistenTray(); };
  } catch (error) { unlistenClose();throw error; }
}
