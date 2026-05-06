import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const CRATES = [
  {
    crate: resolve(ROOT, 'src/lib/epub_parse_module'),
    wasmSrc: 'pkg/epub_parse_module_bg.wasm',
    dst: resolve(ROOT, 'lib/epub_parse_module/epub_parse_module_bg.wasm'),
  },
  {
    crate: resolve(ROOT, 'src/lib/epub_note_module'),
    wasmSrc: 'pkg/epub_note_module_bg.wasm',
    dst: resolve(ROOT, 'lib/epub_note_module/epub_note_module_bg.wasm'),
  },
];

const args = process.argv.slice(2);

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function copyArtifact(crateDir, wasmSrc, dst) {
  const src = resolve(crateDir, wasmSrc);
  ensureDir(dst);
  copyFileSync(src, dst);
  console.log(`WASM copied to ${dst}`);
}

if (args.includes('--copy-only')) {
  for (const { crate, wasmSrc, dst } of CRATES) {
    copyArtifact(crate, wasmSrc, dst);
  }
} else if (args.includes('--watch')) {
  // Watch only the parse module for now
  const [{ crate }] = CRATES;
  const child = spawn('cargo', [
    'watch',
    '-d', '3',
    '-i', 'test-data',
    '-s', 'wasm-pack build --target web --dev && node ../../../build-wasm.mjs --copy-only',
  ], { cwd: crate, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
} else {
  const modeFlag = args.includes('--release') ? '--release' : '--dev';

  for (const { crate, wasmSrc, dst } of CRATES) {
    console.log(`Building ${crate} ...`);
    const result = spawnSync('wasm-pack', [
      'build', '--target', 'web', modeFlag,
    ], { cwd: crate, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    copyArtifact(crate, wasmSrc, dst);
  }
}
