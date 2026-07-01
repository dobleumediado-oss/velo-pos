#!/usr/bin/env node
/**
 * release-check.js — validación mínima antes de compilar/publicar.
 * No reemplaza QA funcional, pero evita releases con archivos críticos faltantes
 * o secretos rastreados por Git.
 */
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const requiredFiles = [
  'main.js',
  'preload.js',
  'database.js',
  'versioning.js',
  'license.js',
  'src/index.html',
  'src/assets/icon.ico',
  'src/assets/icon.png',
  '.github/workflows/release.yml',
  'build/entitlements.mac.plist',
];

if (!pkg.version) throw new Error('package.json no tiene version');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`Versión inválida: ${pkg.version}. Usa semver, ejemplo 1.10.2`);
}

for (const rel of requiredFiles) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`Archivo crítico faltante: ${rel}`);
}

const filesToCheck = [
  'main.js', 'preload.js', 'database.js', 'versioning.js', 'license.js',
  ...fs.readdirSync(path.join(root, 'src/js')).filter(f => f.endsWith('.js')).map(f => `src/js/${f}`),
  ...fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => `scripts/${f}`),
];

for (const rel of filesToCheck) {
  child_process.execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'inherit' });
}

// Si estamos dentro de un repo Git, evitar publicar secretos o data local por accidente.
try {
  child_process.execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
  const tracked = child_process.execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);

  const dangerous = tracked.filter((f) => {
    const lower = f.toLowerCase();
    return lower === '.env'
      || lower.startsWith('data/')
      || lower.endsWith('.key')
      || lower.endsWith('.pem')
      || lower.endsWith('.p12')
      || lower.includes('vendor-private');
  });

  if (dangerous.length) {
    console.error('Archivos sensibles rastreados por Git:');
    dangerous.forEach(f => console.error(` - ${f}`));
    throw new Error('Quita esos archivos del repo antes de publicar release.');
  }
} catch (e) {
  if (e.message && e.message.includes('Quita esos archivos')) throw e;
  // Si no hay git disponible o no estamos en repo, no bloquear validaciones locales.
}

console.log(`✓ Release check OK para Velo POS v${pkg.version}`);
