// Bundles src/main.js into one self-contained dist/index.html
// (and docs/index.html, the published copy, unless --dev).
// Refuses to write a page whose script does not parse.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const minify = !process.argv.includes('--dev');

const result = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  minify,
  write: false,
  target: 'es2020',
  loader: { '.glsl': 'text' },
});
const js = result.outputFiles[0].text;

// Parse check: a page that does not parse is never written.
new vm.Script(js, { filename: 'bundle.js' });
if (js.includes('</script')) throw new Error('bundle contains </script and would break the page');

const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
if (!html.includes('/*CSS*/') || !html.includes('/*JS*/')) throw new Error('index.html is missing its slots');
const out = html.replace('/*CSS*/', () => css).replace('/*JS*/', () => js);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), out);
console.log(`dist/index.html  ${(out.length / 1024).toFixed(1)} KB  (${minify ? 'minified' : 'dev'})`);
// The release build is also what GitHub Pages serves, from docs/ on the main branch.
if (minify) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/index.html'), out);
  fs.writeFileSync(path.join(root, 'docs/.nojekyll'), '');
  console.log('docs/index.html  (published copy)');
}
