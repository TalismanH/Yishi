import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeDownloadFeedback} from '../public/transport.mjs';

test('browser export does not install a native download listener', async () => {
  assert.equal(await installNativeDownloadFeedback(() => {}, undefined), undefined);
});

test('native export reports the actual completed file path', async () => {
  const messages = [];
  let callback;
  const unlisten = () => {};
  const native = {event:{listen:async (name,listener) => {
    assert.equal(name,'backup-download-finished');
    callback = listener;
    return unlisten;
  }}};
  assert.equal(await installNativeDownloadFeedback(message => messages.push(message),native),unlisten);
  callback({payload:{success:true,path:'C:\\Users\\测试\\Downloads\\一事-备份-2026-10-31 (2).json'}});
  assert.deepEqual(messages,['备份已导出至：C:\\Users\\测试\\Downloads\\一事-备份-2026-10-31 (2).json']);
});

test('failed exports never report success or an old destination', async () => {
  let callback;
  const messages = [];
  await installNativeDownloadFeedback(message => messages.push(message),{event:{listen:async (_,listener) => {callback=listener;}}});
  callback({payload:{success:false,path:null}});
  callback({payload:{success:false,path:'C:\\Downloads\\old.json'}});
  callback({payload:{success:true,path:null}});
  assert.deepEqual(messages,['备份导出失败，请重试','备份导出失败，请重试','备份已导出']);
});
