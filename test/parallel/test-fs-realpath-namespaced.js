'use strict';

const common = require('../common');
if (!common.isWindows) {
  common.skip('Windows extended-length paths only');
}

const assert = require('assert');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const file = path.resolve(__filename);
const namespacedFile = path.toNamespacedPath(file);
const expected = file.toLowerCase();

function assertPath(actual, message) {
  assert.strictEqual(actual.toLowerCase(), expected, message);
}

assert.strictEqual(fs.realpathSync(namespacedFile).toLowerCase(),
                   namespacedFile.toLowerCase(),
                   'sync realpath preserves namespace');
assertPath(fs.realpathSync.native(namespacedFile), 'sync native realpath');

fs.realpath(namespacedFile, common.mustSucceed((result) => {
  assert.strictEqual(result.toLowerCase(), namespacedFile.toLowerCase(),
                     'callback realpath preserves namespace');
}));

fs.realpath.native(namespacedFile, common.mustSucceed((result) => {
  assertPath(result, 'callback native realpath');
}));

Promise.all([
  fs.promises.realpath(namespacedFile),
  fs.promises.realpath(namespacedFile, { encoding: 'utf8' }),
]).then(common.mustCall((results) => {
  results.forEach((result) => assertPath(result, 'promise realpath'));
}));

const root = path.parse(file).root;
const namespacedRoot = path.toNamespacedPath(root);
assert.strictEqual(fs.realpathSync(namespacedRoot).toLowerCase(),
                   namespacedRoot.toLowerCase(),
                   'extended drive root');

const child = child_process.spawnSync(
  path.toNamespacedPath(process.execPath),
  ['-e', 'process.stdout.write(process.execPath)'],
  { encoding: 'utf8' });
assert.strictEqual(child.status, 0, child.stderr);
assert.strictEqual(child.stdout.toLowerCase(), process.execPath.toLowerCase());

const shell = child_process.spawnSync(
  process.execPath,
  ['-e', "process.stdout.write('shell-ok')"],
  { shell: true, encoding: 'utf8' });
assert.strictEqual(shell.status, 0, shell.stderr);
assert.strictEqual(shell.stdout, 'shell-ok');
