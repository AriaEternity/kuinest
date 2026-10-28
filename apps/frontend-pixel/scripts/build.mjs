import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, buildShared } from './shared.mjs';
const output = resolve(root, 'dist');
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'assets', 'css', 'js']) await cp(resolve(root, name), resolve(output, name), { recursive: true });
await buildShared(resolve(output, 'shared'));
console.log('已构建 dist：静态页面与当前共享合同/客户端，无运行时后端文件。');
