#!/usr/bin/env node
/**
 * Crea y publica un tag anotado vX.Y.Z usando la versión de package.json.
 * Uso:
 *   npm run tag
 */
const { execSync } = require('child_process');
const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));

const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Versión inválida: ${version}`);
}
const tag = `v${version}`;

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (status) {
  console.error('Hay cambios sin commitear. Haz commit antes de crear el tag.');
  process.exit(1);
}

const existing = execSync('git tag --list ' + tag, { encoding: 'utf8' }).trim();
if (existing) {
  console.error(`El tag ${tag} ya existe localmente.`);
  process.exit(1);
}

run(`git tag -a ${tag} -m "Velo POS ${version}"`);
run(`git push origin ${tag}`);
console.log(`✓ Tag ${tag} publicado. GitHub Actions debe crear el release si el workflow está instalado.`);
