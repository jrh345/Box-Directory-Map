const fs = require('fs');
const path = require('path');

const GRAPH_JSON_PATH = path.join(__dirname, '..', 'data', 'graph_nodes_edges.json');
const TREE_JSON_PATH = path.join(__dirname, '..', 'data', 'tree_d3.json');
const ROOT_BASE_PATH = process.env.DRIVE_AUDIT_ROOT_BASE_PATH || 'C:\\USERS\\JRH345\\BOX\\CON-NTC';

function readGraphJson() {
  if (!fs.existsSync(GRAPH_JSON_PATH)) {
    return null;
  }

  const raw = fs.readFileSync(GRAPH_JSON_PATH, 'utf8');
  return JSON.parse(raw);
}

function readTreeJson() {
  if (!fs.existsSync(TREE_JSON_PATH)) {
    return null;
  }

  const raw = fs.readFileSync(TREE_JSON_PATH, 'utf8');
  return JSON.parse(raw);
}

function buildRowsFromTreeJson(node, ancestorLabels = [], rows = []) {
  if (!node || typeof node !== 'object') {
    return rows;
  }

  const label = String(node.name || '').trim();
  if (!label) {
    return rows;
  }

  const nextLabels = [...ancestorLabels, label];
  if (ancestorLabels.length > 0) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const pathKey = ancestorLabels.concat(label).join('/');
    const isSoftwareArticulate = pathKey === 'CON-NTC/NTC/Software/Articulate';
    const isFolder = hasChildren || isSoftwareArticulate;
    const fullPath = path.win32.join(ROOT_BASE_PATH, ...nextLabels);
    const parentFolder = path.win32.join(ROOT_BASE_PATH, ...ancestorLabels);
    const extension = isFolder ? '' : path.win32.extname(label).replace(/^\./, '');

    rows.push({
      'Full Path': fullPath,
      Type: isFolder ? 'folder' : 'file',
      Name: label,
      Extension: extension,
      'Parent Folder': parentFolder,
      'Top-Level Folder': nextLabels[0] || '',
      Depth: String(ancestorLabels.length),
    });
  }

  (Array.isArray(node.children) ? node.children : []).forEach((child) => {
    buildRowsFromTreeJson(child, nextLabels, rows);
  });

  return rows;
}

function buildRowsFromGraphJson(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];

  if (nodes.length === 0) {
    return [];
  }

  const nodeMap = new Map();
  const childrenMap = new Map();
  const incomingCounts = new Map();

  nodes.forEach((node) => {
    if (!node || typeof node.id === 'undefined') {
      return;
    }

    nodeMap.set(node.id, node);
    incomingCounts.set(node.id, 0);
  });

  edges.forEach((edge) => {
    const from = edge?.from;
    const to = edge?.to;

    if (!nodeMap.has(from) || !nodeMap.has(to)) {
      return;
    }

    if (!childrenMap.has(from)) {
      childrenMap.set(from, []);
    }

    childrenMap.get(from).push(to);
    incomingCounts.set(to, (incomingCounts.get(to) || 0) + 1);
  });

  const rootNode = nodes.find((node) => incomingCounts.get(node.id) === 0) || nodes[0];
  if (!rootNode) {
    return [];
  }

  const rows = [];

  const walk = (nodeId, ancestorLabels = []) => {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    const label = String(node.label || '').trim();
    if (!label) {
      return;
    }

    const nextLabels = [...ancestorLabels, label];
    if (nodeId !== rootNode.id) {
      const fullPath = path.win32.join(ROOT_BASE_PATH, ...nextLabels);
      const parentFolder = path.win32.join(ROOT_BASE_PATH, ...ancestorLabels);
      const itemType = String(node.type || '').trim().toLowerCase();
      const hasChildren = (childrenMap.get(nodeId) || []).length > 0;
      const pathKey = nextLabels.join('/');
      const isSoftwareArticulate = pathKey === 'CON-NTC/NTC/Software/Articulate';
      const isFolder = itemType === 'folder' || hasChildren || isSoftwareArticulate;
      const extension = isFolder ? '' : path.win32.extname(label).replace(/^\./, '');

      rows.push({
        'Full Path': fullPath,
        Type: itemType,
        Name: label,
        Extension: extension,
        'Parent Folder': parentFolder,
        'Top-Level Folder': nextLabels[0] || '',
        Depth: String(typeof node.depth === 'number' ? node.depth : nextLabels.length - 1),
      });
    }

    const childIds = childrenMap.get(nodeId) || [];
    childIds.forEach((childId) => walk(childId, nextLabels));
  };

  const rootChildren = childrenMap.get(rootNode.id) || [];
  rootChildren.forEach((childId) => walk(childId, []));

  return rows.sort((a, b) => a['Full Path'].localeCompare(b['Full Path']));
}

function readRowsFromGraphJson() {
  const data = readGraphJson();
  if (!data) {
    return [];
  }

  return buildRowsFromGraphJson(data);
}

function readRowsFromTreeJson() {
  const data = readTreeJson();
  if (!data) {
    return [];
  }

  return buildRowsFromTreeJson(data);
}

module.exports = {
  GRAPH_JSON_PATH,
  TREE_JSON_PATH,
  ROOT_BASE_PATH,
  readGraphJson,
  readTreeJson,
  buildRowsFromGraphJson,
  buildRowsFromTreeJson,
  readRowsFromGraphJson,
  readRowsFromTreeJson,
};