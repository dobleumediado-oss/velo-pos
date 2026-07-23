'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const VERSION = '2.12.0';
const URL = `https://github.com/winsw/winsw/releases/download/v${VERSION}/WinSW-x64.exe`;
const SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';
const DEST = path.join(__dirname, 'vendor', 'WinSW-x64.exe');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, destination, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('Demasiadas redirecciones al descargar WinSW'));
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Velo-POS-build' },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(download(response.headers.location, destination, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`WinSW respondió HTTP ${response.statusCode}`));
      }
      const temp = `${destination}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const output = fs.createWriteStream(temp, { mode: 0o644 });
      response.pipe(output);
      output.on('finish', () => {
        output.close();
        try {
          if (digest(temp) !== SHA256) throw new Error('Checksum SHA-256 de WinSW inválido');
          fs.renameSync(temp, destination);
          resolve();
        } catch (error) {
          try { fs.unlinkSync(temp); } catch {}
          reject(error);
        }
      });
      output.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(DEST) && digest(DEST) === SHA256) {
    console.log(`WinSW v${VERSION} verificado.`);
    return;
  }
  await download(URL, DEST);
  console.log(`WinSW v${VERSION} descargado y verificado: ${DEST}`);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
