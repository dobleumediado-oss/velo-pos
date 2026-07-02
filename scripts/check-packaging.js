#!/usr/bin/env node
/**
 * check-packaging.js — GUARDIÁN DE EMPAQUETADO (solo lectura)
 *
 * Riesgo #1 al modularizar main.js/database.js: extraer código a un módulo
 * nuevo (ej. lib/x.js) y OLVIDAR agregarlo a package.json → build.files.
 * Resultado: funciona en desarrollo (node lo encuentra) pero la app
 * EMPAQUETADA (asar) NO lo incluye y truena en producción en el cliente.
 * Los tests, el boot smoke y la verificación de integridad corren en modo
 * desarrollo, así que NO detectan este fallo. Este guardián sí.
 *
 * Recorre transitivamente todos los require('./...') del proceso main a
 * partir del entry point (package.json "main") y verifica que cada módulo
 * local resuelto esté cubierto por un patrón include de build.files.
 *
 * Uso:  node scripts/check-packaging.js
 * Exit: 0 = todos los require locales van en el paquete; 1 = falta alguno.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const includes = (pkg.build && pkg.build.files || []).filter(f => typeof f === 'string' && !f.startsWith('!'));

// Convierte un glob simple (*, **, ?) a RegExp anclada a ruta repo-relativa.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const includeRes = includes.map(globToRe);
function isPackaged(relPath) {
  const p = relPath.split(path.sep).join('/');
  return includeRes.some(re => re.test(p));
}

// Resuelve un require local a un archivo real (.js o /index.js).
function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, base + '.js', path.join(base, 'index.js')];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

const entry = path.join(ROOT, pkg.main || 'main.js');
const seen = new Set();
const missing = [];
const unresolved = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[2];
    const resolved = resolveLocal(file, spec);
    if (!resolved) { unresolved.push({ from: path.relative(ROOT, file), spec }); continue; }
    const rel = path.relative(ROOT, resolved);
    // package.json lo empaqueta electron-builder siempre, de forma implícita.
    const isRootPkg = path.basename(resolved) === 'package.json';
    if (!isRootPkg && !isPackaged(rel)) missing.push({ from: path.relative(ROOT, file), rel });
    // Solo tiene sentido seguir requires dentro de módulos .js.
    if (resolved.endsWith('.js')) walk(resolved);
  }
}

walk(entry);

if (unresolved.length) {
  console.error('⚠ require locales que no resuelven a un archivo (revisar):');
  unresolved.forEach(u => console.error(`  - ${u.from} → ${u.spec}`));
}

if (missing.length) {
  console.error('\n✗ MÓDULOS REQUERIDOS QUE NO VAN EN EL PAQUETE (build.files):');
  for (const x of missing) {
    console.error(`  - ${x.rel}  (requerido por ${x.from})`);
  }
  console.error('\n  Agrégalos a package.json → build.files, o la app empaquetada fallará.');
  process.exit(1);
}

console.log(`✓ Empaquetado OK: ${seen.size} módulos del proceso main, todos cubiertos por build.files.`);
process.exit(0);
