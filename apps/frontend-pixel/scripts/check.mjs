import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './shared.mjs';
let failures = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status) { failures++; console.error(result.stderr); }
    }
  }
}
for (const name of ['js', 'scripts', 'tests']) await walk(resolve(root, name));
if (failures) process.exitCode = 1;
else console.log('JavaScript 模块语法检查通过（不冒充 TypeScript 类型检查）。');
