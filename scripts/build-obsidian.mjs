import {build, transform} from 'esbuild';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'yishi');
await mkdir(output, {recursive: true});
const notices = ['public/vendor/MARKED-LICENSE.md', 'public/vendor/KATEX-LICENSE', 'public/vendor/fonts/OFL.txt', 'public/vendor/smiley-sans/LICENSE'];
const thirdPartyLicenses = notices.map(filename => filename + '\n\n' + readFileSync(path.join(root, filename), 'utf8')).join('\n\n');
const licenseHeader = '/*!\nYishi — Apache-2.0\n\n' + readFileSync(path.join(root, 'LICENSE'), 'utf8') + '\n\n' + thirdPartyLicenses + '\n*/\n';

await build({
  absWorkingDir: root,
  entryPoints: ['obsidian/main.mjs'],
  outfile: path.join(output, 'main.js'),
  bundle: true, format: 'cjs', platform: 'node', target: 'es2021',
  banner: {js: licenseHeader},
  external: ['obsidian', 'electron'],
  plugins: [{
    name: 'vendored-commonjs',
    setup(builder) {
      builder.onResolve({filter: /public\/vendor\/.*\.js$/}, args => ({path: path.relative(root, path.resolve(args.resolveDir, args.path)).split(path.sep).join('/') + '.cjs', namespace: 'vendor'}));
      builder.onResolve({filter: /^katex$/, namespace: 'vendor'}, () => ({path: 'public/vendor/katex.min.js.cjs', namespace: 'vendor'}));
      builder.onLoad({filter: /\.cjs$/, namespace: 'vendor'}, args => ({contents: readFileSync(path.join(root, args.path.slice(0, -4)), 'utf8'), loader: 'js'}));
    },
  }],
});

function inlineFonts(css, directory) {
  return css.replace(/src:[^;}]+/g, source => {
    const font = source.match(/url\(["']?([^"')]+\.woff2)["']?\)/);
    if (!font) return source;
    const filename = font[1].startsWith('/') ? path.join(root, 'public', font[1]) : path.join(directory, font[1]);
    return `src:url("data:font/woff2;base64,${readFileSync(filename).toString('base64')}") format("woff2")`;
  });
}
let css = inlineFonts(readFileSync(path.join(root, 'public/vendor/katex.min.css'), 'utf8'), path.join(root, 'public/vendor'))
  + '\n' + inlineFonts(readFileSync(path.join(root, 'public/style.css'), 'utf8'), path.join(root, 'public'));
const fonts = [];
const animations = [];
css = css.replace(/@font-face\s*\{[^}]*\}/g, rule => {fonts.push(rule); return '';})
  .replace(/:root/g, '&').replace(/(^|[}\n])body\s*\{/g, (_, boundary) => boundary + '&{')
  .replace(/@media\s*\(max-width:/g, '@container(max-width:')
  .replace(/@keyframes pending-attention/g, '@keyframes yishi-pending-attention')
  .replace(/animation:pending-attention/g, 'animation:yishi-pending-attention')
  .replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, rule => {animations.push(rule); return '';});
const styles = [...fonts, ...animations].join('\n') + '\n.yishi-workbench {\n' + css + '\n}\n'
  + readFileSync(path.join(root, 'obsidian/styles.css'), 'utf8');
const compiled = await transform(styles, {loader: 'css', target: 'chrome100', minify: true});
await writeFile(path.join(output, 'styles.css'), licenseHeader + compiled.code);
await copyFile(path.join(root, 'obsidian/manifest.json'), path.join(output, 'manifest.json'));
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
await writeFile(path.join(output, 'THIRD-PARTY-LICENSES.txt'), thirdPartyLicenses);
console.log(`Obsidian plugin built: ${output}`);
