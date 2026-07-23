'use strict';

const pkg = require('../package.json');

module.exports = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: 'dist/terminal' },
  artifactName: 'Velo-POS-Terminal-Setup-${version}.${ext}',
  win: {
    ...pkg.build.win,
    requestedExecutionLevel: 'asInvoker',
  },
  publish: {
    ...pkg.build.publish,
    channel: 'latest',
  },
};
