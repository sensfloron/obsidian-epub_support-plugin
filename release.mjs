import { execSync } from 'child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const id = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')).id;

const RELEASE_DIR = resolve(ROOT, 'release');
const STAGING_DIR = resolve(RELEASE_DIR, id);

const STATIC_FILES = ['main.js', 'manifest.json', 'styles.css', 'versions.json'];

const wasmFiles = readdirSync(ROOT).filter(f => f.endsWith('.wasm'));
if (wasmFiles.length === 0) {
  console.error('No .wasm files found in root. Run "npm run build" first.');
  process.exit(1);
}

const FILES = [...STATIC_FILES, ...wasmFiles];

// Clean and create staging
if (existsSync(RELEASE_DIR)) rmSync(RELEASE_DIR, { recursive: true });
mkdirSync(STAGING_DIR, { recursive: true });

// Verify required files
console.log('Verifying build artifacts...');
const missing = FILES.filter(f => !existsSync(resolve(ROOT, f)));
if (missing.length > 0) {
  console.error(`Missing files: ${missing.join(', ')}`);
  console.error('Run "npm run build" first.');
  process.exit(1);
}

function zipDirectory(dirPath, zipPath) {
  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Compress-Archive -Path '${dirPath}' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' },
    );
  } else {
    const dirName = dirPath.replace(/\\/g, '/').split('/').pop();
    const parent = resolve(dirPath, '..');
    execSync(`cd "${parent}" && zip -r "${zipPath}" "${dirName}"`, { stdio: 'inherit' });
  }
}

// ── Plugin zip (without fonts) ──
console.log('\nPackaging plugin (without fonts)...');
for (const file of FILES) {
  copyFileSync(resolve(ROOT, file), resolve(STAGING_DIR, file));
  console.log(`  ${file}`);
}

const pluginZip = `${id}-${version}.zip`;
const pluginZipPath = resolve(RELEASE_DIR, pluginZip);
zipDirectory(STAGING_DIR, pluginZipPath);
console.log(`  → ${pluginZipPath}`);

// ── Fonts zip (stable, unversioned) ──
const FONTS_SRC = resolve(ROOT, 'fonts');
if (existsSync(FONTS_SRC)) {
  console.log('\nPackaging fonts (standalone)...');
  const fontsStaging = resolve(RELEASE_DIR, 'fonts');
  cpSync(FONTS_SRC, fontsStaging, { recursive: true });

  const fontsZip = `${id}-fonts.zip`;
  const fontsZipPath = resolve(RELEASE_DIR, fontsZip);
  zipDirectory(fontsStaging, fontsZipPath);
  console.log(`  → ${fontsZipPath}`);
}

console.log('\nDone.');
