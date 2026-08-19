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
  'src/assets/velo-tech-icon.ico',
  'src/assets/velo-tech-icon.png',
  '.github/workflows/release.yml',
  'build/entitlements.mac.plist',
  'build/electron-builder-terminal.js',
  'build/electron-builder-tech.js',
  'build/electron-builder-server.js',
  'build/electron-builder-tech-server.js',
  'build/windows-service/prepare-winsw.js',
  'build/windows-service/install-service.ps1',
  'build/windows-service/installer.nsh',
  'build/windows-service/installer-tech.nsh',
  'build/windows-service/server-edition.json',
  'build/windows-service/server-edition-tech.json',
];

if (!pkg.version) throw new Error('package.json no tiene version');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`Versión inválida: ${pkg.version}. Usa semver, ejemplo 1.10.2`);
}

for (const rel of requiredFiles) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`Archivo crítico faltante: ${rel}`);
}

// Las cuatro ediciones deben conservar identidad, artefacto y canal propios.
// Una colisión aquí puede actualizar clientes con el vertical equivocado.
const editionExpectations = [
  ['build/electron-builder-terminal.js', 'do.velopos.app', 'Velo POS', 'latest', 'Velo-POS-Terminal-Setup-${version}.${ext}'],
  ['build/electron-builder-tech.js', 'do.velotechpos.app', 'Velo Tech POS', 'latest-tech', 'Velo-Tech-POS-Setup-${version}.${ext}'],
  ['build/electron-builder-server.js', 'do.velopos.app', 'Velo POS', 'server', 'Velo-POS-Server-Setup-${version}.${ext}'],
  ['build/electron-builder-tech-server.js', 'do.velotechpos.server', 'Velo Tech POS Server', 'server-tech', 'Velo-Tech-POS-Server-Setup-${version}.${ext}'],
];

const seenChannels = new Set();
const seenArtifacts = new Set();
for (const [rel, appId, productName, channel, artifactName] of editionExpectations) {
  const config = require(path.join(root, rel));
  const actualAppId = config.appId || pkg.build.appId;
  const actualProductName = config.productName || pkg.build.productName;
  if (actualAppId !== appId || actualProductName !== productName
      || config.publish?.channel !== channel || config.artifactName !== artifactName) {
    throw new Error(`Identidad de release incorrecta en ${rel}`);
  }
  if (seenChannels.has(channel)) throw new Error(`Canal de actualización duplicado: ${channel}`);
  if (seenArtifacts.has(artifactName)) throw new Error(`Artefacto de release duplicado: ${artifactName}`);
  seenChannels.add(channel);
  seenArtifacts.add(artifactName);
}

const filesToCheck = [
  'main.js', 'preload.js', 'database.js', 'versioning.js', 'license.js',
  ...(fs.existsSync(path.join(root, 'src/main'))
    ? fs.readdirSync(path.join(root, 'src/main')).filter(f => f.endsWith('.js')).map(f => `src/main/${f}`)
    : []),
  ...fs.readdirSync(path.join(root, 'src/js')).filter(f => f.endsWith('.js')).map(f => `src/js/${f}`),
  ...fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.js')).map(f => `scripts/${f}`),
  'build/electron-builder-terminal.js',
  'build/electron-builder-tech.js',
  'build/electron-builder-server.js',
  'build/electron-builder-tech-server.js',
  'build/windows-service/prepare-winsw.js',
];

for (const rel of filesToCheck) {
  child_process.execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'inherit' });
}

// Verificar que todo módulo local que requiere el proceso main esté incluido
// en build.files (evita "funciona en dev, truena empaquetado" al modularizar).
child_process.execFileSync(process.execPath, [path.join(root, 'scripts/check-packaging.js')], { stdio: 'inherit' });

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
