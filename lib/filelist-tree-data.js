const fs = require('fs');
const path = require('path');

const FILELIST_PATH = path.join(__dirname, '..', 'data', 'filelist.txt');

function normalizePath(value) {
  return String(value || '').trim().replace(/\//g, '\\').replace(/\\+$/g, '');
}

function splitSegments(fullPath) {
  const normalized = normalizePath(fullPath);
  const root = path.win32.parse(normalized).root;
  const withoutRoot = normalized.slice(root.length);
  return withoutRoot.split('\\').filter(Boolean);
}

function commonPrefixLength(paths) {
  if (paths.length === 0) {
    return 0;
  }

  const split = paths.map(splitSegments);
  const minLen = Math.min(...split.map((segments) => segments.length));
  let idx = 0;
  while (idx < minLen) {
    const segment = split[0][idx];
    if (!split.every((segments) => segments[idx] === segment)) {
      break;
    }
    idx += 1;
  }

  return idx;
}

function readRowsFromFilelist() {
  if (!fs.existsSync(FILELIST_PATH)) {
    return [];
  }

  const lines = fs
    .readFileSync(FILELIST_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => normalizePath(line))
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const uniquePaths = Array.from(new Set(lines));
  uniquePaths.sort((a, b) => a.localeCompare(b));

  const prefixLen = commonPrefixLength(uniquePaths);
  const pathSet = new Set(uniquePaths);
  const folderSet = new Set();

  uniquePaths.forEach((fullPath) => {
    const parent = path.win32.dirname(fullPath);
    if (pathSet.has(parent)) {
      folderSet.add(parent);
    }
  });

  const rows = uniquePaths
    .map((fullPath) => {
      const segments = splitSegments(fullPath);
      if (segments.length <= prefixLen) {
        return null;
      }

      const parentFolder = path.win32.dirname(fullPath);
      const relativeSegments = segments.slice(prefixLen);
      const name = relativeSegments[relativeSegments.length - 1] || '';
      const isFolder = folderSet.has(fullPath);
      const extension = isFolder ? '' : path.win32.extname(name).replace(/^\./, '');
      const topLevel = relativeSegments[0] || '';
      const depth = relativeSegments.length;

      return {
        'Full Path': fullPath,
        Type: isFolder ? 'folder' : 'file',
        Name: name,
        Extension: extension,
        'Parent Folder': parentFolder,
        'Top-Level Folder': topLevel,
        Depth: String(depth),
      };
    })
    .filter(Boolean);

  return rows;
}

module.exports = {
  FILELIST_PATH,
  readRowsFromFilelist,
};
