'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeIndexOf,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  ArrayPrototypeSplice,
  JSONParse,
  NumberIsSafeInteger,
  RegExpPrototypeExec,
  SafeMap,
  SafeSet,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeLastIndexOf,
  StringPrototypeReplaceAll,
  StringPrototypeSlice,
  StringPrototypeStartsWith,
} = primordials;

const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const binding = internalBinding('fs');
const {
  fs: { S_IFDIR, S_IFMT, S_IFREG },
} = internalBinding('constants');

const kHeaderSize = 16;
const kMagic = Buffer.from([0x55, 0x43, 0x4c, 0x4e, 0x50, 0x4d, 0x31, 0x00]);
const kMaximumIndexSize = 64 * 1024 * 1024;
const kMaximumOpenArchives = 64;
const archiveCache = new SafeMap();
const archiveFileDescriptors = new SafeMap();
const archiveFileOrder = [];
const knownArchives = new SafeSet();
const packageResolutionCache = new SafeMap();

function isArchiveFile(filename) {
  const stats = binding.lstat(filename, false, undefined, false);
  return stats !== undefined && (stats[1] & S_IFMT) === S_IFREG;
}

function isDirectory(filename) {
  const stats = binding.stat(filename, false, undefined, false);
  return stats !== undefined && (stats[1] & S_IFMT) === S_IFDIR;
}

function normalizeEntry(entry) {
  entry = StringPrototypeReplaceAll(entry, '\\', '/');
  while (StringPrototypeStartsWith(entry, '/')) {
    entry = StringPrototypeSlice(entry, 1);
  }
  return entry;
}

function isSafeEntry(entry, allowEmpty) {
  if (typeof entry !== 'string' || normalizeEntry(entry) !== entry ||
      StringPrototypeIncludes(entry, '\0') || StringPrototypeIncludes(entry, ':') ||
      StringPrototypeIncludes(entry, '//') || StringPrototypeEndsWith(entry, '/')) {
    return false;
  }
  if (entry === '') {
    return allowEmpty;
  }
  return entry !== '.' && entry !== '..' &&
    !StringPrototypeStartsWith(entry, './') &&
    !StringPrototypeStartsWith(entry, '../') &&
    !StringPrototypeIncludes(entry, '/./') &&
    !StringPrototypeIncludes(entry, '/../') &&
    !StringPrototypeEndsWith(entry, '/.') &&
    !StringPrototypeEndsWith(entry, '/..');
}

function archivePathInfo(filename) {
  if (typeof filename !== 'string' || !StringPrototypeIncludes(filename, '.uclawnpm')) {
    return;
  }
  const pattern = /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+\.uclawnpm(?=$|[\\/])/g;
  let match;
  let selected;
  while ((match = RegExpPrototypeExec(pattern, filename)) !== null) {
    selected = match;
  }
  if (selected === undefined) {
    return;
  }
  const archiveEnd = selected.index + selected[0].length;
  return {
    __proto__: null,
    archivePath: StringPrototypeSlice(filename, 0, archiveEnd),
    entry: normalizeEntry(StringPrototypeSlice(filename, archiveEnd)),
  };
}

function readExactly(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) {
      throw new Error('Unexpected end of .uclawnpm archive');
    }
    offset += read;
  }
}

function openArchive(archivePath) {
  const cached = archiveFileDescriptors.get(archivePath);
  if (cached !== undefined) {
    const index = ArrayPrototypeIndexOf(archiveFileOrder, archivePath);
    if (index !== -1) {
      ArrayPrototypeSplice(archiveFileOrder, index, 1);
    }
    ArrayPrototypePush(archiveFileOrder, archivePath);
    return cached;
  }
  while (archiveFileOrder.length >= kMaximumOpenArchives) {
    const oldest = ArrayPrototypeShift(archiveFileOrder);
    const fd = archiveFileDescriptors.get(oldest);
    if (fd !== undefined) {
      archiveFileDescriptors.delete(oldest);
      fs.closeSync(fd);
    }
  }
  const fd = fs.openSync(archivePath, 'r');
  archiveFileDescriptors.set(archivePath, fd);
  ArrayPrototypePush(archiveFileOrder, archivePath);
  return fd;
}

function closeArchive(archivePath) {
  const fd = archiveFileDescriptors.get(archivePath);
  if (fd === undefined) {
    return;
  }
  archiveFileDescriptors.delete(archivePath);
  const index = ArrayPrototypeIndexOf(archiveFileOrder, archivePath);
  if (index !== -1) {
    ArrayPrototypeSplice(archiveFileOrder, index, 1);
  }
  fs.closeSync(fd);
}

function invalidArchive(archivePath, message) {
  const error = new Error(`Invalid .uclawnpm archive ${archivePath}: ${message}`);
  error.code = 'ERR_UCLAWNPM_INVALID_ARCHIVE';
  return error;
}

function loadArchive(archivePath) {
  const cached = archiveCache.get(archivePath);
  if (cached !== undefined) {
    return cached;
  }

  const fd = openArchive(archivePath);
  try {
    const size = fs.fstatSync(fd).size;
    if (!NumberIsSafeInteger(size) || size < kHeaderSize) {
      throw invalidArchive(archivePath, 'file is shorter than the header');
    }
    const header = Buffer.allocUnsafe(kHeaderSize);
    readExactly(fd, header, 0);
    if (!header.subarray(0, kMagic.length).equals(kMagic)) {
      throw invalidArchive(archivePath, 'magic does not match UCLNPM1');
    }
    const indexLength = header.readUInt32LE(8);
    const fileCount = header.readUInt32LE(12);
    if (indexLength === 0 || indexLength > kMaximumIndexSize ||
        kHeaderSize + indexLength > size) {
      throw invalidArchive(archivePath, 'index length is invalid');
    }
    const indexBytes = Buffer.allocUnsafe(indexLength);
    readExactly(fd, indexBytes, kHeaderSize);
    let parsed;
    try {
      parsed = JSONParse(indexBytes.toString('utf8'));
    } catch {
      throw invalidArchive(archivePath, 'index is not valid JSON');
    }
    if (parsed?.format !== 'uclawnpm' || parsed?.version !== 1 ||
        !ArrayIsArray(parsed.files) || !ArrayIsArray(parsed.directories)) {
      throw invalidArchive(archivePath, 'index schema is unsupported');
    }
    if (parsed.files.length !== fileCount) {
      throw invalidArchive(archivePath, 'file count does not match the index');
    }

    const dataOffset = kHeaderSize + indexLength;
    const dataLength = size - dataOffset;
    const files = new SafeMap();
    for (let i = 0; i < parsed.files.length; i++) {
      const file = parsed.files[i];
      if (!ArrayIsArray(file) || file.length !== 3 || typeof file[0] !== 'string' ||
          !NumberIsSafeInteger(file[1]) || !NumberIsSafeInteger(file[2]) ||
          file[1] < 0 || file[2] < 0 || !NumberIsSafeInteger(file[1] + file[2]) ||
          file[1] + file[2] > dataLength) {
        throw invalidArchive(archivePath, `file entry ${i} is invalid`);
      }
      const name = normalizeEntry(file[0]);
      if (!isSafeEntry(name, false) || files.has(name)) {
        throw invalidArchive(archivePath, `file path ${file[0]} is unsafe or duplicated`);
      }
      files.set(name, { __proto__: null, offset: file[1], length: file[2] });
    }

    const directories = new SafeSet();
    for (let i = 0; i < parsed.directories.length; i++) {
      const name = parsed.directories[i];
      if (!isSafeEntry(name, true) || directories.has(name)) {
        throw invalidArchive(archivePath, `directory path ${name} is unsafe`);
      }
      directories.add(name);
    }
    directories.add('');
    const archive = {
      __proto__: null,
      archivePath,
      dataOffset,
      files,
      directories,
    };
    archiveCache.set(archivePath, archive);
    return archive;
  } catch (error) {
    closeArchive(archivePath);
    throw error;
  }
}

function resolvePath(filename, useCache = true) {
  if (typeof filename !== 'string' ||
      (!StringPrototypeIncludes(filename, `${path.sep}node_modules${path.sep}`) &&
       !StringPrototypeIncludes(filename, '/node_modules/') &&
       !StringPrototypeStartsWith(filename, `node_modules${path.sep}`) &&
       !StringPrototypeStartsWith(filename, 'node_modules/'))) {
    return;
  }
  const existing = archivePathInfo(filename);
  if (existing !== undefined) {
    if (knownArchives.has(existing.archivePath) || isArchiveFile(existing.archivePath)) {
      knownArchives.add(existing.archivePath);
      return filename;
    }
    return;
  }

  const pattern = /(?:^|[\\/])node_modules[\\/]((?:@[^\\/]+[\\/])?([^\\/]+))(?=$|[\\/])/g;
  const matches = [];
  let match;
  while ((match = RegExpPrototypeExec(pattern, filename)) !== null) {
    ArrayPrototypePush(matches, match);
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    match = matches[i];
    const packageName = match[2];
    if (StringPrototypeStartsWith(packageName, '.') ||
        StringPrototypeEndsWith(packageName, '.uclawnpm')) {
      continue;
    }
    const packageEnd = match.index + match[0].length;
    const packagePath = StringPrototypeSlice(filename, 0, packageEnd);
    const cachedArchivePath = useCache ? packageResolutionCache.get(packagePath) : undefined;
    if (cachedArchivePath === false) {
      continue;
    }
    if (cachedArchivePath !== undefined) {
      return cachedArchivePath + StringPrototypeSlice(filename, packageEnd);
    }
    if (isDirectory(packagePath)) {
      if (useCache) {
        packageResolutionCache.set(packagePath, false);
      }
      continue;
    }
    const archivePath = `${packagePath}.uclawnpm`;
    if (isArchiveFile(archivePath)) {
      knownArchives.add(archivePath);
      if (useCache) {
        packageResolutionCache.set(packagePath, archivePath);
      }
      return archivePath + StringPrototypeSlice(filename, packageEnd);
    }
  }
}

function statArchivePath(archiveFilename) {
  const info = archivePathInfo(archiveFilename);
  if (info === undefined ||
      (!knownArchives.has(info.archivePath) && !isArchiveFile(info.archivePath))) {
    return;
  }
  knownArchives.add(info.archivePath);
  const archive = loadArchive(info.archivePath);
  const file = archive.files.get(info.entry);
  if (file !== undefined) {
    return { __proto__: null, type: 0, size: file.length };
  }
  if (archive.directories.has(info.entry)) {
    return { __proto__: null, type: 1, size: 0 };
  }
}

function stat(filename) {
  const archiveFilename = resolvePath(filename) ?? filename;
  return statArchivePath(archiveFilename)?.type ?? -1;
}

function logicalStat(filename) {
  const info = logicalPathInfo(filename);
  if (info !== undefined) {
    return { __proto__: null, type: info.type, size: info.size };
  }
}

function readFileSync(filename, encoding) {
  const archiveFilename = resolvePath(filename) ?? filename;
  const info = archivePathInfo(archiveFilename);
  if (info === undefined ||
      (!knownArchives.has(info.archivePath) && !isFile(info.archivePath))) {
    return;
  }
  knownArchives.add(info.archivePath);
  const archive = loadArchive(info.archivePath);
  const entry = archive.files.get(info.entry);
  if (entry === undefined) {
    const error = new Error(`No such file in .uclawnpm archive: ${filename}`);
    error.code = 'ENOENT';
    error.path = filename;
    throw error;
  }
  const buffer = Buffer.allocUnsafe(entry.length);
  const fd = openArchive(info.archivePath);
  readExactly(fd, buffer, archive.dataOffset + entry.offset);
  return encoding === undefined ? buffer : buffer.toString(encoding);
}

function logicalPathInfo(filename) {
  if (archivePathInfo(filename) !== undefined) {
    return;
  }
  const archiveFilename = resolvePath(filename, false);
  if (archiveFilename === undefined) {
    return;
  }
  const stats = statArchivePath(archiveFilename);
  if (stats === undefined) {
    return;
  }
  const info = archivePathInfo(archiveFilename);
  return {
    __proto__: null,
    archivePath: info.archivePath,
    entry: info.entry,
    type: stats.type,
    size: stats.size,
  };
}

function readLogicalPathSync(filename) {
  const info = logicalPathInfo(filename);
  if (info === undefined || info.type === 1) {
    return info;
  }
  const archive = loadArchive(info.archivePath);
  const entry = archive.files.get(info.entry);
  const source = Buffer.allocUnsafe(entry.length);
  const fd = openArchive(info.archivePath);
  readExactly(fd, source, archive.dataOffset + entry.offset);
  return {
    __proto__: null,
    archivePath: info.archivePath,
    entry: info.entry,
    type: info.type,
    size: info.size,
    source,
  };
}

function resolvePackageJSONPath(jsonPath) {
  const info = archivePathInfo(jsonPath);
  if (info !== undefined) {
    return stat(jsonPath) === 0 ? jsonPath : undefined;
  }
  if (!StringPrototypeEndsWith(jsonPath, `${path.sep}package.json`) &&
      !StringPrototypeEndsWith(jsonPath, '/package.json')) {
    return;
  }
  const resolved = resolvePath(jsonPath);
  if (resolved !== undefined && stat(resolved) === 0) {
    return resolved;
  }
}

function findNearestPackageJSONPath(filename) {
  const resolved = archivePathInfo(filename) === undefined ? resolvePath(filename) : filename;
  if (resolved !== undefined) {
    const info = archivePathInfo(resolved);
    let entry = info.entry;
    if (entry !== '') {
      const lastSlash = StringPrototypeLastIndexOf(entry, '/');
      entry = lastSlash === -1 ? '' : StringPrototypeSlice(entry, 0, lastSlash);
    }
    while (true) {
      const candidate = path.join(info.archivePath, entry, 'package.json');
      if (stat(candidate) === 0) {
        return path.join(
          StringPrototypeSlice(info.archivePath, 0, -'.uclawnpm'.length),
          entry,
          'package.json',
        );
      }
      if (entry === '') {
        return;
      }
      const lastSlash = StringPrototypeLastIndexOf(entry, '/');
      entry = lastSlash === -1 ? '' : StringPrototypeSlice(entry, 0, lastSlash);
    }
  }
}

function isArchivePath(filename) {
  const info = archivePathInfo(filename);
  if (info !== undefined &&
      (knownArchives.has(info.archivePath) || isArchiveFile(info.archivePath))) {
    knownArchives.add(info.archivePath);
    return true;
  }
  return resolvePath(filename) !== undefined;
}

module.exports = {
  findNearestPackageJSONPath,
  isArchivePath,
  logicalPathInfo,
  logicalStat,
  readLogicalPathSync,
  readFileSync,
  resolvePackageJSONPath,
  resolvePath,
  stat,
};
