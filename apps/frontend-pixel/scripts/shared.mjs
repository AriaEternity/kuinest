// 只读取共享源码，使用工程已有 TypeScript；不修改后端或另存业务实现。
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const backend = resolve(process.env.KUINEST_ROOT || resolve(root, '../..'));
export const ts = createRequire(resolve(backend, 'package.json'))('typescript');
export async function sharedSource(path) {
  if (!/^\/(contracts|chat-client)\/(?:[a-z-]+\/)*[a-z-]+\.js$/.test(path)) throw new Error('共享模块路径无效');
  const file = resolve(backend, 'packages', path.slice(1).replace('/', '/src/').replace(/\.js$/, '.ts'));
  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('共享模块编译失败');
  return result.outputText;
}
export async function buildShared(destination) {
  async function walk(packageName, directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(packageName, file);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const tail = relative(resolve(backend, 'packages', packageName, 'src'), file).replaceAll('\\', '/').replace(/\.ts$/, '.js');
        const output = resolve(destination, packageName, tail);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, await sharedSource('/' + packageName + '/' + tail));
      }
    }
  }
  for (const name of ['contracts', 'chat-client']) await walk(name, resolve(backend, 'packages', name, 'src'));
}
