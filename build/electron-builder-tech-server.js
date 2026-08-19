'use strict';

const path = require('path');
const pkg = require('../package.json');

module.exports = {
  ...pkg.build,
  appId: 'do.velotechpos.server',
  productName: 'Velo Tech POS Server',
  copyright: 'Copyright 2026 — Velo Tech POS',
  directories: { ...pkg.build.directories, output: 'dist/tech-server' },
  artifactName: 'Velo-Tech-POS-Server-Setup-${version}.${ext}',
  extraMetadata: { veloVertical: 'tech' },
  extraResources: [
    {
      from: path.join(__dirname, 'windows-service', 'server-edition-tech.json'),
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
        'configure-tailscale-funnel.ps1',
        'THIRD_PARTY_NOTICES.txt',
      ],
    },
  ],
  win: {
    ...pkg.build.win,
    icon: 'src/assets/velo-tech-icon.ico',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    ...pkg.build.nsis,
    perMachine: true,
    allowElevation: true,
    shortcutName: 'Velo Tech POS Server',
    installerIcon: 'src/assets/velo-tech-icon.ico',
    uninstallerIcon: 'src/assets/velo-tech-icon.ico',
    installerHeaderIcon: 'src/assets/velo-tech-icon.ico',
    include: path.join(__dirname, 'windows-service', 'installer-tech.nsh'),
  },
  publish: {
    ...pkg.build.publish,
    channel: 'server-tech',
  },
};
