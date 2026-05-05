import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CRATE = resolve(ROOT, 'src/lib/epub_parse_module');
const WASM_SRC = resolve(CRATE, 'pkg/epub_parse_module_bg.wasm');
const WASM_DST = resolve(ROOT, 'lib/epub_parse_module/epub_parse_module_bg.wasm');
const args = process.argv.slice(2);

if (args.includes('--copy-only')) {
  copyFileSync(WASM_SRC, WASM_DST);
  console.log('WASM copied to lib/epub_parse_module/');
} else if (args.includes('--watch')) {
  const child = spawn('cargo', [
    'watch',
	'-d' , '3',
	// '--debug',   
	'-i', 'test-data',  
    '-s', 'wasm-pack build --target web --dev && node ../../../build-wasm.mjs --copy-only',
  ], { cwd: CRATE, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
} else {
  const modeFlag = args.includes('--release') ? '--release' : '--dev';
  const result = spawnSync('wasm-pack', [
    'build', '--target', 'web', modeFlag,
  ], { cwd: CRATE, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);

  copyFileSync(WASM_SRC, WASM_DST);
  console.log('WASM copied to lib/epub_parse_module/');
}
