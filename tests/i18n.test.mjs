import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLanguage, readLanguage, translate, translateMarkup, localizeError} from '../public/i18n.mjs';

test('language defaults preserve old appearance settings and reject unknown languages', () => {
  assert.equal(readLanguage({getItem:()=>'{broken'}),'zh');
  assert.equal(readLanguage({getItem:()=>'{"font":"smiley"}'}),'zh');
  assert.equal(readLanguage({getItem:()=>'{"language":"en"}'}),'en');
  assert.equal(normalizeLanguage('fr'),'zh');
  assert.equal(translate('en','设置'),'Settings');
  assert.equal(translate('zh','设置'),'设置');
});

test('UI template translation never translates interpolated project or task content', () => {
  const userText='设置 项目 删除事项 **私人内容**';
  assert.equal(translateMarkup('en',['<button title="设置">设置</button><p>','</p>'],[userText]), '<button title="Settings">Settings</button><p>'+userText+'</p>');
  assert.equal(translateMarkup('en',['<h3>项目与事项</h3>'],[]),'<h3>Projects and tasks</h3>');
  assert.equal(translateMarkup('zh',['<h3>项目与事项</h3>'],[]),'<h3>项目与事项</h3>');
});

test('known validation and nested storage errors follow the selected language', () => {
  assert.equal(localizeError('事项最多支持三级','en'),'Tasks support at most three levels.');
  assert.equal(localizeError('数据格式有误：事项状态不正确','en'),'Invalid data: Invalid task status.');
  assert.equal(localizeError('Invalid task status.','zh'),'事项状态不正确');
  assert.equal(localizeError('数据超过 5 MB 限制','en'),'Data exceeds the 5 MB limit.');
  assert.equal(localizeError('ENOENT: preserved user path','en'),'ENOENT: preserved user path');
});
