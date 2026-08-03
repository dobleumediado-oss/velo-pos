'use strict';

const os = require('os');

function isTailscaleIPv4(ip) {
  const match = /^100\.(\d+)\./.exec(String(ip || ''));
  return !!(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function isPrivateIPv4(ip) {
  const text = String(ip || '');
  if (/^10\./.test(text) || /^192\.168\./.test(text)) return true;
  const match = /^172\.(\d+)\./.exec(text);
  return !!(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function classifyNetworkAddress(name, ip) {
  const interfaceName = String(name || '');
  const address = String(ip || '');
  const tailscale = isTailscaleIPv4(address) || /tailscale/i.test(interfaceName);
  if (tailscale) {
    return {
      kind: 'tailscale', label: 'Tailscale', tailscale: true,
      recommended: true, score: 100,
    };
  }

  const virtualByName = /(parallels|vmware|virtualbox|hyper-v|vethernet|wsl|docker|podman|bridge|nat)/i.test(interfaceName);
  // Rangos predeterminados de los hipervisores más comunes. En una VM Windows
  // la interfaz puede llamarse simplemente "Ethernet", por eso no basta el nombre.
  const virtualByAddress = /^10\.211\.55\./.test(address)       // Parallels Shared Network
    || /^192\.168\.64\./.test(address)                         // VM NAT habitual en macOS
    || /^192\.168\.56\./.test(address);                        // VirtualBox host-only
  if (virtualByName || virtualByAddress) {
    return {
      kind: 'virtual', label: 'Red virtual / NAT', tailscale: false,
      recommended: false, score: 10,
      warning: 'Esta dirección pertenece a una red virtual/NAT y normalmente no es accesible desde otras PCs de la red.',
    };
  }

  if (/^169\.254\./.test(address)) {
    return {
      kind: 'link-local', label: 'Red sin configurar', tailscale: false,
      recommended: false, score: 5,
      warning: 'Windows asignó esta IP automáticamente; no es adecuada para conectar terminales.',
    };
  }

  if (isPrivateIPv4(address)) {
    return {
      kind: 'lan', label: 'Red local', tailscale: false,
      recommended: true, score: 80,
    };
  }

  return {
    kind: 'other', label: 'Otra red', tailscale: false,
    recommended: false, score: 40,
  };
}

function listLocalAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const [name, entries] of Object.entries(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || (entry.family !== 'IPv4' && entry.family !== 4) || entry.internal) continue;
      const classified = classifyNetworkAddress(name, entry.address);
      addresses.push({
        ip: String(entry.address || ''),
        interfaceName: name,
        ...classified,
      });
    }
  }

  addresses.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip));
  const bestScore = addresses[0]?.score;
  return addresses.map((address, index) => ({
    ...address,
    primary: index === 0 && bestScore >= 40,
  }));
}

module.exports = {
  isTailscaleIPv4,
  isPrivateIPv4,
  classifyNetworkAddress,
  listLocalAddresses,
};
