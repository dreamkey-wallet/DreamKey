/* Compile a small local TypeScript dependency graph, preserving src layout. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

module.exports = function compileTsFixture(relative, outputRoot, replacements = {}) {
  const projectRoot = path.resolve(__dirname, '..');
  const sourceRoot = path.join(projectRoot, 'src');
  const emitted = new Set();
  function compile(input) {
    if (emitted.has(input)) return;
    const fromSource = path.relative(sourceRoot, input);
    if (fromSource.startsWith('..') || path.isAbsolute(fromSource)) throw new Error('Fixture dependency leaves src');
    emitted.add(input);
    let code = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    for (const match of code.matchAll(/require\("(\.[^"]+)"\)/g)) {
      const imported = path.resolve(path.dirname(input), match[1].replace(/\.js$/, '.ts'));
      compile(imported);
    }
    code = code.replace(/require\("([^"]+)"\)/g, (expression, name) => {
      const replacement = replacements[name] ?? (name === 'ethers' ? require.resolve('ethers') : undefined);
      return replacement ? `require(${JSON.stringify(replacement)})` : expression;
    });
    const destination = path.join(outputRoot, fromSource.replace(/\.tsx?$/, '.js'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, code);
    return destination;
  }
  return compile(path.resolve(projectRoot, relative));
};
