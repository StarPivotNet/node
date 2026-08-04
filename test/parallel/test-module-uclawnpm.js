'use strict';

const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tmpdir = require('../common/tmpdir');

const magic = Buffer.from([0x55, 0x43, 0x4c, 0x4e, 0x50, 0x4d, 0x31, 0x00]);

tmpdir.refresh();
const app = path.join(tmpdir.path, 'app');
const nodeModules = path.join(app, 'node_modules');
fs.mkdirSync(nodeModules, { recursive: true });

function writeArchive(filename, files) {
  let offset = 0;
  const entries = [];
  const directories = new Set(['']);
  const bodies = [];
  for (const [name, value] of Object.entries(files)) {
    const body = Buffer.from(value);
    entries.push([name, offset, body.length]);
    bodies.push(body);
    offset += body.length;
    let directory = path.posix.dirname(name);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const index = Buffer.from(JSON.stringify({
    format: 'uclawnpm',
    version: 1,
    files: entries,
    directories: [...directories],
  }));
  const header = Buffer.alloc(16);
  magic.copy(header);
  header.writeUInt32LE(index.length, 8);
  header.writeUInt32LE(entries.length, 12);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, Buffer.concat([header, index, ...bodies]));
}

writeArchive(path.join(nodeModules, 'archive-cjs.uclawnpm'), {
  'package.json': JSON.stringify({
    name: 'archive-cjs',
    main: 'src/index.js',
    exports: {
      '.': { import: './src/esm.mjs', require: './src/index.js' },
      './feature': './src/feature.js',
    },
  }),
  'src/index.js': "module.exports = require('./feature');",
  'src/feature.js': "module.exports = { source: 'archive-cjs' };",
  'src/second.js': "module.exports = 'second';",
  'src/esm.mjs': "export default { source: 'archive-cjs-esm' };",
});

writeArchive(path.join(nodeModules, '@scope', 'archive-esm.uclawnpm'), {
  'package.json': JSON.stringify({
    name: '@scope/archive-esm',
    type: 'module',
    imports: { '#internal': './internal.js' },
    exports: { '.': './index.js', './feature': './feature.js' },
  }),
  'index.js': `
    import { value } from './feature.js';
    import internal from '#internal';
    import metadata from './metadata.json' with { type: 'json' };
    export default [value, internal, metadata.source].join(':');
  `,
  'feature.js': "export const value = 'archive-esm';",
  'internal.js': "export default 'imports';",
  'metadata.json': JSON.stringify({ source: 'json' }),
  'bin/cli': "process.stdout.write('archive-esm-cli');",
});

fs.mkdirSync(path.join(nodeModules, 'standard-package'), { recursive: true });
fs.writeFileSync(path.join(nodeModules, 'standard-package', 'package.json'), JSON.stringify({
  name: 'standard-package',
  main: 'index.js',
}));
fs.writeFileSync(path.join(nodeModules, 'standard-package', 'index.js'),
                 "module.exports = 'standard-directory';");
writeArchive(path.join(nodeModules, 'standard-package.uclawnpm'), {
  'package.json': JSON.stringify({ name: 'standard-package', main: 'index.js' }),
  'index.js': "module.exports = 'archive-should-not-win';",
});

writeArchive(path.join(nodeModules, 'switch-package.uclawnpm'), {
  'package.json': JSON.stringify({ name: 'switch-package', main: 'index.js' }),
  'index.js': 'archive-version',
});

fs.mkdirSync(path.join(nodeModules, 'named.uclawnpm'), { recursive: true });
fs.writeFileSync(path.join(nodeModules, 'named.uclawnpm', 'package.json'), JSON.stringify({
  name: 'named.uclawnpm',
  main: 'index.js',
}));
fs.writeFileSync(path.join(nodeModules, 'named.uclawnpm', 'index.js'),
                 "module.exports = 'suffix-directory';");

const aliasApp = path.join(tmpdir.path, 'app-alias');
let hasAlias = true;
try {
  fs.symlinkSync(app, aliasApp, common.isWindows ? 'junction' : 'dir');
} catch {
  hasAlias = false;
}

const main = path.join(app, 'main.mjs');
fs.writeFileSync(main, `
import archiveEsm from '@scope/archive-esm';
import archiveCjsEsm from 'archive-cjs';
import { value } from '@scope/archive-esm/feature';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const cjs = require('archive-cjs');
const cjsFeature = require('archive-cjs/feature');
const standard = require('standard-package');
const suffixDirectory = require('named.uclawnpm');
const resolved = require.resolve('archive-cjs');
const publicRead = fs.readFileSync(resolved, 'utf8').includes("require('./feature')");
const publicExists = fs.existsSync(resolved);
const publicStat = fs.statSync(resolved);
const publicLstat = fs.lstatSync(resolved, { bigint: true });
const publicDirectory = fs.statSync(path.dirname(resolved));
const publicRealpath = fs.realpathSync(resolved);
const publicBufferPath = Buffer.from(resolved);
const publicBufferRead = fs.readFileSync(publicBufferPath, 'utf8') ===
  fs.readFileSync(resolved, 'utf8');
const publicBufferStat = fs.statSync(publicBufferPath).isFile() &&
  fs.lstatSync(publicBufferPath).isFile();
const publicBufferExists = fs.existsSync(publicBufferPath);
const publicBufferRealpath = fs.realpathSync(publicBufferPath) === resolved;
const originalCwd = process.cwd();
process.chdir(${JSON.stringify(app)});
const publicRelativePath = path.join('node_modules', 'archive-cjs', 'src', 'index.js');
const publicRelativeRead = fs.readFileSync(publicRelativePath, 'utf8') ===
  fs.readFileSync(resolved, 'utf8');
const publicRelativeExists = fs.existsSync(publicRelativePath);
const publicRelativeStat = fs.statSync(publicRelativePath).isFile() &&
  fs.lstatSync(Buffer.from(publicRelativePath)).isFile();
const publicRelativeBufferRead = fs.readFileSync(Buffer.from(publicRelativePath), 'utf8') ===
  fs.readFileSync(resolved, 'utf8');
const publicRelativeRealpath = fs.realpathSync(publicRelativePath) === resolved;
process.chdir(originalCwd);
const oversizedBuffer = Buffer.alloc(64, 0x78);
const bufferedRead = fs.readFileSync(resolved, { buffer: oversizedBuffer });
const publicUserBuffer = bufferedRead.equals(Buffer.from("module.exports = require('./feature');")) &&
  oversizedBuffer.subarray(bufferedRead.length).every((byte) => byte === 0x78);
let allocatedSize;
const allocatedRead = fs.readFileSync(resolved, {
  buffer(size) {
    allocatedSize = size;
    return Buffer.alloc(size + 8);
  },
  encoding: 'utf8',
});
const publicBufferFactory = allocatedSize === 38 &&
  allocatedRead.includes("require('./feature')");
let smallBufferError;
try {
  fs.readFileSync(resolved, { buffer: Buffer.alloc(1) });
} catch (error) {
  smallBufferError = error.code;
}
const bigintModes = [true, false, 1, 'false'].map((bigint) =>
  typeof fs.statSync(resolved, { bigint }).size);
let bigintGetterReads = 0;
const bigintGetterType = typeof fs.lstatSync(resolved, {
  get bigint() {
    bigintGetterReads++;
    return true;
  },
}).size;
const missing = path.join(path.dirname(resolved), 'missing.js');
let missingError;
try {
  fs.readFileSync(missing);
} catch (error) {
  missingError = { code: error.code, syscall: error.syscall, path: error.path === missing };
}
let directoryError;
try {
  fs.readFileSync(path.dirname(resolved));
} catch (error) {
  directoryError = {
    code: error.code,
    syscall: error.syscall,
    path: error.path === path.dirname(resolved),
  };
}
const switchRoot = path.join(${JSON.stringify(nodeModules)}, 'switch-package');
const switchEntry = path.join(switchRoot, 'index.js');
const switchArchiveFirst = fs.readFileSync(switchEntry, 'utf8');
fs.mkdirSync(switchRoot);
fs.writeFileSync(switchEntry, 'directory-version');
const switchDirectory = fs.readFileSync(switchEntry, 'utf8');
fs.rmSync(switchRoot, { recursive: true });
const switchArchiveAgain = fs.readFileSync(switchEntry, 'utf8');
const publicParentRealpath = ${hasAlias} ? fs.realpathSync(path.join(
  ${JSON.stringify(aliasApp)},
  'node_modules',
  'archive-cjs',
  'src',
  'index.js',
)) === path.join(fs.realpathSync(${JSON.stringify(app)}),
                 'node_modules', 'archive-cjs', 'src', 'index.js') : null;
const archiveContainer = fs.readFileSync(
  path.join(${JSON.stringify(nodeModules)}, 'archive-cjs.uclawnpm'),
).subarray(0, 8).toString('hex');
let readWriteRejected = false;
try {
  fs.readFileSync(resolved, { encoding: 'utf8', flag: 'r+' });
} catch (error) {
  readWriteRejected = error.code === 'ENOENT';
}
let lateMissing = false;
try { require('late-standard'); } catch (error) { lateMissing = error.code === 'MODULE_NOT_FOUND'; }
const lateRoot = path.join(${JSON.stringify(nodeModules)}, 'late-standard');
fs.mkdirSync(lateRoot);
fs.writeFileSync(path.join(lateRoot, 'package.json'), '{"name":"late-standard","main":"index.js"}');
fs.writeFileSync(path.join(lateRoot, 'index.js'), "module.exports = 'late-standard';");
const lateStandard = require('late-standard');
process.stdout.write(JSON.stringify({
  archiveEsm, archiveCjsEsm, value, cjs, cjsFeature, standard, suffixDirectory,
  logicalResolve: resolved.endsWith(path.join('node_modules', 'archive-cjs', 'src', 'index.js')),
  publicRead,
  publicExists,
  publicStat: { file: publicStat.isFile(), size: publicStat.size },
  publicLstat: { file: publicLstat.isFile(), size: String(publicLstat.size) },
  publicDirectory: publicDirectory.isDirectory(),
  publicRealpath: publicRealpath === resolved,
  publicBufferRead,
  publicBufferStat,
  publicBufferExists,
  publicBufferRealpath,
  publicRelativeRead,
  publicRelativeExists,
  publicRelativeStat,
  publicRelativeBufferRead,
  publicRelativeRealpath,
  publicUserBuffer,
  publicBufferFactory,
  smallBufferError,
  bigintModes,
  bigintGetterReads,
  bigintGetterType,
  missingError,
  directoryError,
  switchArchiveFirst,
  switchDirectory,
  switchArchiveAgain,
  publicParentRealpath,
  archiveContainer,
  readWriteRejected,
  lateMissing,
  lateStandard,
}));
`);

const result = spawnSync(process.execPath, [main], { encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr);
assert.deepStrictEqual(JSON.parse(result.stdout), {
  archiveEsm: 'archive-esm:imports:json',
  archiveCjsEsm: { source: 'archive-cjs-esm' },
  value: 'archive-esm',
  cjs: { source: 'archive-cjs' },
  cjsFeature: { source: 'archive-cjs' },
  standard: 'standard-directory',
  suffixDirectory: 'suffix-directory',
  logicalResolve: true,
  publicRead: true,
  publicExists: true,
  publicStat: { file: true, size: 38 },
  publicLstat: { file: true, size: '38' },
  publicDirectory: true,
  publicRealpath: true,
  publicBufferRead: true,
  publicBufferStat: true,
  publicBufferExists: true,
  publicBufferRealpath: true,
  publicRelativeRead: true,
  publicRelativeExists: true,
  publicRelativeStat: true,
  publicRelativeBufferRead: true,
  publicRelativeRealpath: true,
  publicUserBuffer: true,
  publicBufferFactory: true,
  smallBufferError: 'ERR_INVALID_ARG_VALUE',
  bigintModes: ['bigint', 'number', 'number', 'number'],
  bigintGetterReads: 1,
  bigintGetterType: 'bigint',
  missingError: { code: 'ENOENT', syscall: 'open', path: true },
  directoryError: { code: 'EISDIR', syscall: 'read', path: true },
  switchArchiveFirst: 'archive-version',
  switchDirectory: 'directory-version',
  switchArchiveAgain: 'archive-version',
  publicParentRealpath: hasAlias ? true : null,
  archiveContainer: magic.toString('hex'),
  readWriteRejected: true,
  lateMissing: true,
  lateStandard: 'late-standard',
});

const descriptorCache = path.join(app, 'descriptor-cache.cjs');
fs.writeFileSync(descriptorCache, `
const fs = require('fs');
const originalOpenSync = fs.openSync;
let archiveOpens = 0;
fs.openSync = function(filename, ...args) {
  if (String(filename).endsWith('archive-cjs.uclawnpm')) archiveOpens++;
  return Reflect.apply(originalOpenSync, fs, [filename, ...args]);
};
require('archive-cjs');
const opensAfterFirstLoad = archiveOpens;
require(${JSON.stringify(path.join(nodeModules, 'archive-cjs', 'src', 'second.js'))});
process.stdout.write(String(opensAfterFirstLoad) + ':' + String(archiveOpens));
`);
const descriptorCacheResult = spawnSync(process.execPath, [descriptorCache], {
  encoding: 'utf8',
});
assert.strictEqual(descriptorCacheResult.status, 0, descriptorCacheResult.stderr);
const [opensAfterFirstLoad, opensAfterSecondLoad] = descriptorCacheResult.stdout
  .split(':')
  .map(Number);
assert.ok(opensAfterFirstLoad > 0);
assert.strictEqual(opensAfterSecondLoad, opensAfterFirstLoad);

const permissionProbe = spawnSync(process.execPath, [
  '--permission',
  '--input-type=commonjs',
  '--eval',
  `
    const fs = require('fs');
    const filename = process.argv[1];
    const errors = {};
    for (const [name, operation] of Object.entries({
      existsSync: () => fs.existsSync(filename),
      readFileSync: () => fs.readFileSync(filename),
      statSync: () => fs.statSync(filename),
      lstatSync: () => fs.lstatSync(filename),
      realpathSync: () => fs.realpathSync(filename),
    })) {
      try { operation(); } catch (error) { errors[name] = error.code; }
    }
    process.stdout.write(JSON.stringify(errors));
  `,
  path.join(nodeModules, 'archive-cjs', 'src', 'index.js'),
], { encoding: 'utf8' });
assert.strictEqual(permissionProbe.status, 0, permissionProbe.stderr);
assert.deepStrictEqual(JSON.parse(permissionProbe.stdout), {
  existsSync: 'ERR_ACCESS_DENIED',
  readFileSync: 'ERR_ACCESS_DENIED',
  statSync: 'ERR_ACCESS_DENIED',
  lstatSync: 'ERR_ACCESS_DENIED',
  realpathSync: 'ERR_ACCESS_DENIED',
});

const permissionAllowedProbe = spawnSync(process.execPath, [
  '--permission',
  `--allow-fs-read=${nodeModules}${path.sep}*`,
  '--input-type=commonjs',
  '--eval',
  `
    const fs = require('fs');
    const filename = process.argv[1];
    process.stdout.write(JSON.stringify({
      existsSync: fs.existsSync(filename),
      readFileSync: fs.readFileSync(filename, 'utf8').length,
      statSync: fs.statSync(filename).isFile(),
      lstatSync: fs.lstatSync(filename).isFile(),
      realpathSync: fs.realpathSync(filename) === filename,
    }));
  `,
  path.join(nodeModules, 'archive-cjs', 'src', 'index.js'),
], { encoding: 'utf8' });
assert.strictEqual(permissionAllowedProbe.status, 0, permissionAllowedProbe.stderr);
assert.deepStrictEqual(JSON.parse(permissionAllowedProbe.stdout), {
  existsSync: true,
  readFileSync: 38,
  statSync: true,
  lstatSync: true,
  realpathSync: true,
});

const binEntry = path.join(nodeModules, 'archive-cjs', 'src', 'feature.js');
const binResult = spawnSync(process.execPath, [binEntry], { encoding: 'utf8' });
assert.strictEqual(binResult.status, 0, binResult.stderr);

const extensionlessEsmEntry = path.join(nodeModules, '@scope', 'archive-esm', 'bin', 'cli');
const extensionlessEsmResult = spawnSync(process.execPath, [extensionlessEsmEntry], {
  encoding: 'utf8',
});
assert.strictEqual(extensionlessEsmResult.status, 0, extensionlessEsmResult.stderr);
assert.strictEqual(extensionlessEsmResult.stdout, 'archive-esm-cli');

const invalid = path.join(nodeModules, 'invalid.uclawnpm');
fs.writeFileSync(invalid, Buffer.from('invalid'));
const invalidResult = spawnSync(process.execPath, [
  '-e',
  `require(${JSON.stringify(path.join(app, 'node_modules', 'invalid', 'index.js'))})`,
], { encoding: 'utf8' });
assert.notStrictEqual(invalidResult.status, 0);
assert.match(invalidResult.stderr, /ERR_UCLAWNPM_INVALID_ARCHIVE/);
