import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createTauriEnvironment, parseWindowsEnvironment} from '../scripts/tauri.mjs';

test('Windows environment capture preserves equals in values and canonicalizes PATH',() => {
  const environment = parseWindowsEnvironment('Path=C:\\Windows\r\nPATH=C:\\Tools\r\nVALUE=a=b=c\r\n=C:=C:\\folder\r\n',{Path:'old',UNCHANGED:'kept'});
  assert.equal(environment.PATH,'C:\\Tools');
  assert.equal(environment.VALUE,'a=b=c');
  assert.equal(environment.UNCHANGED,'kept');
  assert.equal(Object.keys(environment).filter(key => key.toUpperCase() === 'PATH').length,1);
  assert.equal(Object.keys(environment).some(key => key.startsWith('=')),false);
});

test('loads a usable Windows SDK library environment without changing the parent process',{skip:process.platform !== 'win32'},() => {
  const originalLib = process.env.LIB, originalInclude = process.env.INCLUDE;
  const environment = createTauriEnvironment({...process.env,TAURI_ENV_PROBE:'目录=测试'});
  const libraries = environment.LIB.split(';');
  assert.ok(libraries.some(directory => existsSync(path.join(directory,'kernel32.lib'))),'kernel32.lib must be available to the linker');
  assert.ok(libraries.some(directory => existsSync(path.join(directory,'ucrt.lib'))),'ucrt.lib must be available to the linker');
  assert.ok(environment.INCLUDE.split(';').some(directory => existsSync(path.join(directory,'Windows.h'))));
  assert.ok(environment.WINDOWSSDKDIR);
  assert.ok(existsSync(path.join(environment.PATH.split(';')[0],'cargo.exe')));
  assert.equal(Object.keys(environment).filter(key => key.toUpperCase() === 'PATH').length,1);
  assert.equal(environment.TAURI_ENV_PROBE,'目录=测试');
  assert.equal(process.env.LIB === originalLib,true);
  assert.equal(process.env.INCLUDE === originalInclude,true);
});
