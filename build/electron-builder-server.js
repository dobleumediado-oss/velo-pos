'use strict';

const path = require('path');
const pkg = require('../package.json');

module.exports = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: 'dist/server' },
  artifactName: 'Velo-POS-Server-Setup-${version}.${ext}',
  extraResources: [
    {
      from: path.join(__dirname, 'windows-service', 'server-edition.json'),
      to: 'server-edition.json',
    },
    {
      from: path.join(__dirname, 'windows-service', 'vendor', 'WinSW-x64.exe'),
      to: 'service/WinSW-x64.exe',
    },
    {
      from: path.join(__dirname, 'windows-service'),
      to: 'service',
      filter: [
        'install-service.ps1',
        'THIRD_PARTY_NOTICES.txt',
      ],
    },
  ],
  win: {
    ...pkg.build.win,
    // La GUI sigue como usuario normal. El instalador se eleva porque es
    // per-machine y necesita registrar el servicio/firewall.
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    ...pkg.build.nsis,
    perMachine: true,
    allowElevation: true,
    include: path.join(__dirname, 'windows-service', 'installer.nsh'),
  },
  publish: {
    ...pkg.build.publish,
    channel: 'server',
  },
};
