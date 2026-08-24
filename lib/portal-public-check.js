'use strict';

const https = require('https');
const { isAllowedPortalBaseUrl } = require('./url-safe');

function _networkDetail(error) {
  const code = String(error?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'El dominio todavía no resuelve por DNS';
  if (code === 'ECONNREFUSED') return 'El Funnel público rechazó la conexión';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'El Funnel público no respondió a tiempo';
  if (/CERT|TLS|SSL/i.test(code)) return 'La conexión HTTPS no superó la validación TLS';
  return String(error?.message || 'No se pudo conectar con la URL pública');
}

// Se ejecuta exclusivamente bajo una acción manual del usuario desde main.
// La allowlist se vuelve a validar justo antes de hacer la única salida a red.
function checkPublicPortalAccess(baseUrl, { timeoutMs = 8000, requestImpl = https.request } = {}) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!isAllowedPortalBaseUrl(value)) {
    return Promise.reject(new Error('Configura primero una URL pública HTTPS válida de Tailscale Funnel'));
  }
  const target = new URL('/health', `${value}/`);
  const started = Date.now();
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      resolve({
        ...result,
        response_ms:Date.now() - started,
        checked_at:new Date().toISOString(),
        url:target.toString(),
      });
    };
    const request = requestImpl({
      protocol:'https:', hostname:target.hostname, port:target.port || 443,
      method:'GET', path:target.pathname, timeout:timeoutMs,
      headers:{ Accept:'application/json', 'User-Agent':'Velo-POS-Public-Portal-Check/1' },
      servername:target.hostname,
    }, response => {
      response.resume();
      response.on('end', () => {
        const statusCode = Number(response.statusCode) || 0;
        finish({
          reachable:true,
          online:statusCode >= 200 && statusCode < 400,
          status_code:statusCode,
          detail:`HTTP ${statusCode}`,
        });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('TIMEOUT'), { code:'TIMEOUT' })));
    request.on('error', error => finish({
      reachable:false,
      online:false,
      status_code:0,
      error_code:String(error?.code || ''),
      detail:_networkDetail(error),
    }));
    request.end();
  });
}

module.exports = { checkPublicPortalAccess };
