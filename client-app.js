const treeRoot = document.getElementById('treeRoot');
const previewSummary = document.getElementById('previewSummary');
const previewFilterButtons = Array.from(document.querySelectorAll('[data-preview-filter]'));
const sidebarTabButtons = Array.from(document.querySelectorAll('[data-sidebar-tab]'));
const sidebarTabPanels = Array.from(document.querySelectorAll('[data-sidebar-panel]'));
const collapseAllButton = document.getElementById('collapseAll');
const expandAllButton = document.getElementById('expandAll');
const fitViewButton = document.getElementById('fitView');
const zoomInButton = document.getElementById('zoomIn');
const zoomOutButton = document.getElementById('zoomOut');
const resetViewButton = document.getElementById('resetView');
const shareButton = document.getElementById('shareLink');
const syncIndicator = document.getElementById('syncIndicator');
const resyncStatusesButton = document.getElementById('resyncStatuses');

function logDebug(message, detail) {
  const entry = { message, detail, at: new Date().toISOString() };
  window.__driveAuditDebug = window.__driveAuditDebug || [];
  window.__driveAuditDebug.push(entry);
  console.debug('[drive-audit]', message, detail || '');
}

const STORAGE_KEY = 'drive-audit-map-statuses';
function resolveApiEndpoint(path) {
  if (typeof window !== 'undefined' && window.DRIVE_AUDIT_API_URL) {
    const configured = window.DRIVE_AUDIT_API_URL;
    if (configured.endsWith('/statuses')) {
      return configured.replace(/\/statuses$/, path);
    }
    if (configured.endsWith('/map-state')) {
      return configured.replace(/\/map-state$/, path);
    }
    return `${configured}${path}`;
  }

  return `/api${path}`;
}
const STATUS_ENDPOINT = resolveApiEndpoint('/statuses');
const TREE_DATA_ENDPOINT = resolveApiEndpoint('/tree-data');
const SVG_NS = 'http://www.w3.org/2000/svg';
const CASCADE_ICON_URL = typeof window !== 'undefined'
  ? String(window.DRIVE_AUDIT_CASCADE_ICON_URL || '').trim()
  : '';
const CARD_WIDTH = 220;
const CARD_HEIGHT = 108;
const ROW_HEIGHT = 136;
const HORIZONTAL_STEP = 280;
const REALTIME_SYNC_INTERVAL_MS = 3000;
const DEFAULT_VIEW_OFFSET_X = 12;
const DEFAULT_VIEW_OFFSET_Y = 24;
const EXPAND_ALL_LEVEL_LIMIT = 3;
const SLOW_RENDER_THRESHOLD_MS = 120;
const SLOW_RENDER_NODE_THRESHOLD = 450;

let treeState = [];
let expandedPaths = new Set();
let statuses = {};
let currentRows = [];
let lastSharedPayload = null;
let realtimeSyncTimer = null;
let realtimeSyncInFlight = false;
let previewFilter = 'all';
let activeViewMode = 'map';
let currentRenderedNodes = [];
let isAutoPruningRender = false;
let manuallyExpandedPaths = new Set();
let lastBulkStatusChoice = 'green';
let viewState = {
  scale: 1,
  offsetX: DEFAULT_VIEW_OFFSET_X,
  offsetY: DEFAULT_VIEW_OFFSET_Y,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

function updateSyncIndicator() {
  if (!syncIndicator) return;

  const info = window.DriveAuditMapSharedStorage?.getSyncInfo?.();
  if (!info) {
    syncIndicator.textContent = 'Status sync: API';
    syncIndicator.className = 'sync-indicator mode-api';
    return;
  }

  const readSource = info.lastReadSource || 'none';
  const writeSource = info.lastWriteSource || 'none';
  const lastError = info.lastError ? ` | Last error: ${info.lastError}` : '';

  if (info.localTestMode) {
    syncIndicator.textContent = 'Local test mode: Supabase writes off';
    syncIndicator.className = 'sync-indicator mode-local';
    syncIndicator.title = `Read: ${readSource} | Write: ${writeSource || 'local-api'}${lastError}`;
    return;
  }

  if (readSource === 'supabase' || writeSource === 'supabase') {
    syncIndicator.textContent = 'Status sync: Supabase';
    syncIndicator.className = 'sync-indicator mode-supabase';
    syncIndicator.title = `Read: ${readSource} | Write: ${writeSource}${lastError}`;
    return;
  }

  syncIndicator.textContent = 'Status sync: API fallback';
  syncIndicator.className = 'sync-indicator mode-api';
  syncIndicator.title = `Read: ${readSource} | Write: ${writeSource}${lastError}`;
}

async function loadStatuses() {
  const localRaw = localStorage.getItem(STORAGE_KEY);
  const fallback = localRaw ? JSON.parse(localRaw) : {};

  try {
    const sharedState = await window.DriveAuditMapSharedStorage?.getState();
    if (sharedState?.statuses) {
      statuses = sharedState.statuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
      updateSyncIndicator();
      return statuses;
    }
  } catch {
    // Ignore shared storage failures and continue with local state.
  }

  try {
    const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return fallback;

    const payload = await response.json();
    const serverStatuses = payload?.statuses && typeof payload.statuses === 'object'
      ? payload.statuses
      : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});

    statuses = { ...fallback, ...serverStatuses };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
    updateSyncIndicator();
    return statuses;
  } catch {
    statuses = fallback;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
    updateSyncIndicator();
    return statuses;
  }
}

async function syncStatusesFromServer(options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);

  try {
    const sharedState = await window.DriveAuditMapSharedStorage?.getState();
    const sharedStatuses = sharedState?.statuses;
    if (sharedStatuses && typeof sharedStatuses === 'object') {
      const canApply = allowEmpty || Object.keys(sharedStatuses).length > 0;
      if (!canApply) {
        updateSyncIndicator();
        return false;
      }

      statuses = sharedState.statuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
      updateSyncIndicator();
      return true;
    }
  } catch {
    // Ignore shared storage failures and continue with local state.
  }

  try {
    const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return false;

    const payload = await response.json();
    const serverStatuses = payload?.statuses && typeof payload.statuses === 'object'
      ? payload.statuses
      : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});

    if (allowEmpty || Object.keys(serverStatuses).length > 0) {
      statuses = serverStatuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
    }
    updateSyncIndicator();
    return true;
  } catch {
    // Ignore remote sync failures and continue with local state.
    updateSyncIndicator();
    return false;
  }
}

function setResyncButtonText(text, timeoutMs = 1500) {
  if (!resyncStatusesButton) return;

  const originalText = resyncStatusesButton.dataset.originalText || resyncStatusesButton.textContent || 'Re-sync statuses';
  resyncStatusesButton.dataset.originalText = originalText;
  resyncStatusesButton.textContent = text;

  if (timeoutMs > 0) {
    window.setTimeout(() => {
      resyncStatusesButton.textContent = originalText;
    }, timeoutMs);
  }
}

async function resyncStatusesNow() {
  if (!resyncStatusesButton) return;

  resyncStatusesButton.disabled = true;
  setResyncButtonText('Re-syncing...', 0);

  const before = JSON.stringify(statuses);
  try {
    const didSync = await syncStatusesFromServer({ allowEmpty: true });
    if (didSync) {
      refreshStatusesInView();
      const changed = before !== JSON.stringify(statuses);
      setResyncButtonText(changed ? 'Re-synced' : 'Already current', 1500);
      logDebug('Manual status re-sync complete', {
        changed,
        statusCount: Object.keys(statuses).length,
      });
    } else {
      setResyncButtonText('Re-sync unavailable', 2200);
      logDebug('Manual status re-sync unavailable', {
        statusCount: Object.keys(statuses).length,
      });
    }
  } catch (error) {
    setResyncButtonText('Re-sync failed', 2200);
    logDebug('Manual status re-sync failed', { message: error?.message, stack: error?.stack });
  } finally {
    resyncStatusesButton.disabled = false;
  }
}

async function saveStatuses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));

  try {
    await window.DriveAuditMapSharedStorage?.saveStatuses(statuses);
    updateSyncIndicator();
  } catch {
    // Ignore shared storage failures and keep the local browser state as the fallback.
    updateSyncIndicator();
  }

  try {
    await fetch(STATUS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ statuses }),
    });
    updateSyncIndicator();
  } catch {
    // Ignore remote save failures and keep the local browser state as the fallback.
    updateSyncIndicator();
  }
}

function applyStatusesToTree(nodes) {
  nodes.forEach((node) => {
    node.status = statuses[node.path] || 'none';
    if (node.children.length > 0) {
      applyStatusesToTree(node.children);
    }
  });
}

function refreshStatusesInView() {
  if (!treeState.length) return;
  applyStatusesToTree(treeState);
  renderCurrentView();
}

async function syncStatusesInBackground() {
  if (realtimeSyncInFlight || !treeState.length) {
    return;
  }

  realtimeSyncInFlight = true;

  try {
    const previousStatuses = JSON.stringify(statuses);
    await syncStatusesFromServer();
    const nextStatuses = JSON.stringify(statuses);

    if (nextStatuses !== previousStatuses) {
      refreshStatusesInView();
      logDebug('Realtime status sync applied', { statusCount: Object.keys(statuses).length });
    }
  } catch (error) {
    logDebug('Realtime status sync failed', { message: error?.message, stack: error?.stack });
  } finally {
    realtimeSyncInFlight = false;
  }
}

function startRealtimeSync() {
  if (realtimeSyncTimer) {
    window.clearInterval(realtimeSyncTimer);
  }

  realtimeSyncTimer = window.setInterval(() => {
    syncStatusesInBackground();
  }, REALTIME_SYNC_INTERVAL_MS);

  window.addEventListener('focus', () => {
    syncStatusesInBackground();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncStatusesInBackground();
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      statuses = JSON.parse(event.newValue);
      refreshStatusesInView();
      logDebug('Statuses refreshed from local storage event', { statusCount: Object.keys(statuses).length });
    } catch {
      // Ignore invalid local storage payloads.
    }
  });
}

function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^C:\//i, '/');
}

function buildTree(rows) {
  const rootNodes = [];
  const map = new Map();

  rows.forEach((row) => {
    const fullPath = (row['Full Path'] || '').trim();
    const name = (row['Name'] || '').trim();
    const type = (row['Type'] || '').trim().toLowerCase();

    if (!fullPath || !name) return;

    const normalizedPath = normalizePath(fullPath);
    const node = {
      id: normalizedPath,
      name,
      type,
      path: normalizedPath,
      children: [],
      status: statuses[normalizedPath] || 'none',
    };

    map.set(normalizedPath, node);
  });

  rows.forEach((row) => {
    const fullPath = normalizePath((row['Full Path'] || '').trim());
    const parentFolder = normalizePath((row['Parent Folder'] || '').trim());
    const node = map.get(fullPath);

    if (!node) return;

    if (parentFolder && map.has(parentFolder)) {
      map.get(parentFolder).children.push(node);
    } else {
      rootNodes.push(node);
    }
  });

  const attachChildren = (node) => {
    node.children = node.children
      .filter((child) => child.id !== node.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(attachChildren);
  };

  rootNodes.sort((a, b) => a.name.localeCompare(b.name));
  rootNodes.forEach(attachChildren);

  return rootNodes;
}

function summarizeDescendantStatus(node) {
  let hasYellow = false;
  let hasRed = false;
  let descendantTotal = 0;
  let descendantUnassigned = 0;
  let descendantGreen = 0;
  let descendantYellow = 0;
  let descendantRed = 0;
  let descendantNone = 0;

  node.children.forEach((child) => {
    const childSummary = summarizeDescendantStatus(child);
    hasYellow = hasYellow || childSummary.hasYellow;
    hasRed = hasRed || childSummary.hasRed;
    descendantTotal += 1 + (childSummary.descendantTotal || 0);
    descendantUnassigned += (child.status === 'none' ? 1 : 0) + (childSummary.descendantUnassigned || 0);
    descendantGreen += (child.status === 'green' ? 1 : 0) + (childSummary.descendantGreen || 0);
    descendantYellow += (child.status === 'yellow' ? 1 : 0) + (childSummary.descendantYellow || 0);
    descendantRed += (child.status === 'red' ? 1 : 0) + (childSummary.descendantRed || 0);
    descendantNone += (child.status === 'none' ? 1 : 0) + (childSummary.descendantNone || 0);

    if (child.status === 'yellow') {
      hasYellow = true;
    }
    if (child.status === 'red') {
      hasRed = true;
    }
  });

  node.descendantStatus = {
    hasYellow,
    hasRed,
    descendantTotal,
    descendantUnassigned,
    descendantGreen,
    descendantYellow,
    descendantRed,
    descendantNone,
  };
  return node.descendantStatus;
}

function formatPercent(value, total) {
  if (!total) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function getNodeStatus(node) {
  return statuses[node.path] || 'none';
}

function setDescendantStatuses(node, nextStatus) {
  if (!node || node.type !== 'folder' || !node.children.length) {
    return 0;
  }

  let updatedCount = 0;

  const walk = (currentNode) => {
    currentNode.children.forEach((child) => {
      statuses[child.path] = nextStatus;
      child.status = nextStatus;
      updatedCount += 1;

      if (child.children.length > 0) {
        walk(child);
      }
    });
  };

  walk(node);
  return updatedCount;
}

function getBulkApplyStatus(node) {
  const nodeStatus = getNodeStatus(node);
  return nodeStatus !== 'none' ? nodeStatus : lastBulkStatusChoice;
}

function createCascadeWaveIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 28');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('cascade-icon');

  const base = document.createElementNS(SVG_NS, 'path');
  base.setAttribute('d', 'M4 25 C4 12, 12 3, 24 4 C30 4, 35 7, 36 12 C37 16, 33 20, 28 20 C23 20, 21 17, 20 14 C18 17, 18 22, 23 25 Z');
  base.setAttribute('fill', 'currentColor');
  base.setAttribute('opacity', '0.95');

  const mid = document.createElementNS(SVG_NS, 'path');
  mid.setAttribute('d', 'M9 24 C9 15, 15 8, 24 8 C28 8, 31 10, 32 13 C31 12, 30 12, 28 12 C23 12, 20 15, 20 19 C20 21, 21 23, 23 24 Z');
  mid.setAttribute('fill', 'currentColor');
  mid.setAttribute('opacity', '0.62');

  const tail = document.createElementNS(SVG_NS, 'path');
  tail.setAttribute('d', 'M21 23 C28 22, 35 22, 43 24 C37 21, 30 20, 24 20 C22 20, 21 21, 21 23 Z');
  tail.setAttribute('fill', 'currentColor');
  tail.setAttribute('opacity', '0.72');

  const highlight = document.createElementNS(SVG_NS, 'path');
  highlight.setAttribute('d', 'M9 20 C12 12, 18 8, 25 8 C17 6, 11 11, 9 20 Z');
  highlight.setAttribute('fill', '#ffffff');
  highlight.setAttribute('opacity', '0.35');

  const splashA = document.createElementNS(SVG_NS, 'circle');
  splashA.setAttribute('cx', '34');
  splashA.setAttribute('cy', '10');
  splashA.setAttribute('r', '1.7');
  splashA.setAttribute('fill', 'currentColor');

  const splashB = document.createElementNS(SVG_NS, 'circle');
  splashB.setAttribute('cx', '36.5');
  splashB.setAttribute('cy', '12.5');
  splashB.setAttribute('r', '1.3');
  splashB.setAttribute('fill', 'currentColor');

  svg.appendChild(base);
  svg.appendChild(mid);
  svg.appendChild(tail);
  svg.appendChild(highlight);
  svg.appendChild(splashA);
  svg.appendChild(splashB);
  return svg;
}

function createCascadeIcon() {
  if (!CASCADE_ICON_URL) {
    return createCascadeWaveIcon();
  }

  const img = document.createElement('img');
  img.className = 'cascade-icon-image';
  img.src = CASCADE_ICON_URL;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  img.loading = 'eager';
  img.addEventListener('error', () => {
    if (!img.parentElement) return;
    const fallback = createCascadeWaveIcon();
    img.replaceWith(fallback);
  }, { once: true });
  return img;
}

function doesNodeMatchPreviewFilter(node, filter) {
  const nodeStatus = getNodeStatus(node);

  switch (filter) {
    case 'no-red':
      return nodeStatus !== 'red';
    case 'unassigned-only':
      return nodeStatus === 'none';
    case 'yellow-only':
      return nodeStatus === 'yellow';
    case 'green-only':
      return nodeStatus === 'green';
    case 'red-only':
      return nodeStatus === 'red';
    case 'all':
    default:
      return true;
  }
}

function buildPreviewBranch(node, filter) {
  if (filter === 'all') {
    return {
      node,
      selfMatches: true,
      children: node.children
        .map((child) => buildPreviewBranch(child, filter))
        .filter(Boolean),
    };
  }

  const children = node.children
    .map((child) => buildPreviewBranch(child, filter))
    .filter(Boolean);
  const selfMatches = doesNodeMatchPreviewFilter(node, filter);

  if (!selfMatches && children.length === 0) {
    return null;
  }

  return {
    node,
    selfMatches,
    children,
  };
}

function countPreviewMatches(branches) {
  return branches.reduce((sum, branch) => {
    const selfCount = branch.selfMatches ? 1 : 0;
    return sum + selfCount + countPreviewMatches(branch.children);
  }, 0);
}

function cloneFilteredNodes(branches, renderState) {
  const filteredNodes = [];

  branches.forEach((branch) => {
    renderState.rendered += 1;
    filteredNodes.push({
      id: branch.node.id,
      name: branch.node.name,
      type: branch.node.type,
      path: branch.node.path,
      status: getNodeStatus(branch.node),
      selfMatches: branch.selfMatches,
      descendantStatus: branch.node.descendantStatus,
      children: cloneFilteredNodes(branch.children, renderState),
    });
  });

  return filteredNodes;
}

function buildFilteredViewData() {
  const branches = treeState
    .map((node) => buildPreviewBranch(node, previewFilter))
    .filter(Boolean);

  const matchCount = countPreviewMatches(branches);
  const renderState = { rendered: 0, truncated: false };
  const nodes = cloneFilteredNodes(branches, renderState);

  return {
    nodes,
    matchCount,
    rendered: renderState.rendered,
    truncated: renderState.truncated,
  };
}

function updatePreviewSummary(data = null) {
  if (!previewSummary) return;

  if (activeViewMode !== 'preview') {
    previewSummary.textContent = 'Switch to preview mode';
    return;
  }

  const details = data || buildFilteredViewData();
  if (details.matchCount === 0 || details.nodes.length === 0) {
    previewSummary.textContent = '0 matches';
    return;
  }

  previewSummary.textContent = `${details.matchCount} matches`;
}

function setPreviewFilter(nextFilter) {
  previewFilter = nextFilter;
  previewFilterButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.previewFilter === nextFilter);
  });

  if (activeViewMode === 'preview') {
    renderCurrentView();
  } else {
    updatePreviewSummary();
  }
}

function setSidebarTab(nextTab) {
  if (nextTab === activeViewMode) {
    return;
  }

  activeViewMode = nextTab;

  sidebarTabButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.sidebarTab === nextTab);
  });

  sidebarTabPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.sidebarPanel === nextTab);
  });

  renderCurrentView();
}

function fitViewToNodes(nodes, options = {}) {
  const { readOnly = false } = options;
  const viewport = document.getElementById('mapViewport');
  if (!viewport || !nodes.length) return;

  const { layout } = layoutMap(nodes);
  if (!layout.length) return;

  const viewportRect = viewport.getBoundingClientRect();
  const padding = 40;
  const minX = Math.min(...layout.map((entry) => entry.x));
  const minY = Math.min(...layout.map((entry) => entry.y));
  const maxX = Math.max(...layout.map((entry) => entry.x + CARD_WIDTH));
  const maxY = Math.max(...layout.map((entry) => entry.y + CARD_HEIGHT));
  const contentWidth = maxX - minX + padding * 2;
  const contentHeight = maxY - minY + padding * 2;
  const scaleX = viewportRect.width / contentWidth;
  const scaleY = viewportRect.height / contentHeight;
  const nextScale = Math.max(0.35, Math.min(1.4, Math.min(scaleX, scaleY)));

  viewState.scale = nextScale;
  viewState.offsetX = padding - minX * nextScale;
  viewState.offsetY = padding - minY * nextScale;

  const svg = viewport.querySelector('svg');
  if (svg) {
    const mapContent = svg.querySelector('#mapContent');
    if (mapContent) {
      mapContent.setAttribute('transform', `translate(${viewState.offsetX}, ${viewState.offsetY}) scale(${viewState.scale})`);
    }
  }
}

function getRowCount(node) {
  if (node.type !== 'folder' || node.children.length === 0 || !expandedPaths.has(node.path)) {
    return 1;
  }

  return node.children.reduce((sum, child) => sum + getRowCount(child), 0);
}

function layoutMap(nodes) {
  const layout = [];
  const connectors = [];
  let currentTop = 40;

  const placeNode = (node, depth, top) => {
    const rowCount = getRowCount(node);
    const centerY = top + (rowCount * ROW_HEIGHT) / 2;
    const layoutNode = {
      x: depth * HORIZONTAL_STEP + 8,
      y: centerY - CARD_HEIGHT / 2,
      node,
    };

    layout.push(layoutNode);

    if (node.type === 'folder' && node.children.length > 0 && expandedPaths.has(node.path)) {
      let childTop = top;
      node.children.forEach((child) => {
        const childRows = getRowCount(child);
        placeNode(child, depth + 1, childTop);
        connectors.push({
          parent: layoutNode,
          child: layout.find((entry) => entry.node.path === child.path),
        });
        childTop += childRows * ROW_HEIGHT;
      });
    }
  };

  nodes.forEach((node) => {
    const rowCount = getRowCount(node);
    placeNode(node, 0, currentTop);
    currentTop += rowCount * ROW_HEIGHT;
  });

  return { layout, connectors };
}

function buildMapSvg(nodes, minWidth = 0, minHeight = 0, options = {}) {
  const { readOnly = false } = options;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('id', 'mapContent');

  const { layout, connectors } = layoutMap(nodes);
  const maxX = Math.max(...layout.map((entry) => entry.x + CARD_WIDTH), CARD_WIDTH + 40);
  const maxY = Math.max(...layout.map((entry) => entry.y + CARD_HEIGHT), CARD_HEIGHT + 40);
  const width = Math.max(maxX + 80, minWidth);
  const height = Math.max(maxY + 80, minHeight);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  connectors.forEach(({ parent, child }) => {
    if (!parent || !child) return;
    const path = document.createElementNS(SVG_NS, 'path');
    const startX = parent.x + CARD_WIDTH;
    const startY = parent.y + CARD_HEIGHT / 2;
    const endX = child.x;
    const endY = child.y + CARD_HEIGHT / 2;
    path.setAttribute('class', 'map-connector');
    path.setAttribute(
      'd',
      `M ${startX} ${startY} C ${startX + 50} ${startY}, ${endX - 50} ${endY}, ${endX} ${endY}`
    );
    group.appendChild(path);
  });

  layout.forEach(({ node, x, y }) => {
    const foreignObject = document.createElementNS(SVG_NS, 'foreignObject');
    foreignObject.setAttribute('x', String(x));
    foreignObject.setAttribute('y', String(y));
    foreignObject.setAttribute('width', String(CARD_WIDTH));
    foreignObject.setAttribute('height', String(CARD_HEIGHT));

    const card = document.createElement('div');
    const descendantClasses = [];
    if (node.descendantStatus?.hasYellow) descendantClasses.push('has-descendant-yellow');
    if (node.descendantStatus?.hasRed) descendantClasses.push('has-descendant-red');

    const modeClasses = [];
    if (node.selfMatches === false) {
      modeClasses.push('context-only');
    }
    card.className = `map-node-card status-${node.status} ${modeClasses.join(' ')} ${descendantClasses.join(' ')}`.trim();
    card.style.height = `${CARD_HEIGHT}px`;

    const titleRow = document.createElement('div');
    titleRow.className = 'map-node-title';

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'map-toggle';
    toggleButton.textContent = node.type === 'folder' ? (expandedPaths.has(node.path) ? '−' : '+') : '•';
    toggleButton.disabled = node.type !== 'folder';
    toggleButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (node.type !== 'folder') return;
      if (expandedPaths.has(node.path)) {
        expandedPaths.delete(node.path);
        manuallyExpandedPaths.delete(node.path);
      } else {
        expandedPaths.add(node.path);
        manuallyExpandedPaths.add(node.path);
      }
      renderCurrentView();
    });
    toggleButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });

    const label = document.createElement('div');
    label.className = 'map-node-label';
    label.textContent = node.name;
    label.title = node.name;

    const type = document.createElement('div');
    type.className = 'map-node-type';
    type.textContent = node.type;

    titleRow.appendChild(toggleButton);
    titleRow.appendChild(label);
    titleRow.appendChild(type);
    card.appendChild(titleRow);

    if (!readOnly) {
      const controls = document.createElement('div');
      controls.className = 'map-node-controls';
      const folderStatusSummary = node.type === 'folder' && (node.descendantStatus?.descendantTotal || 0) > 0;
      const statusPercentages = folderStatusSummary
        ? {
          green: formatPercent(node.descendantStatus.descendantGreen || 0, node.descendantStatus.descendantTotal),
          yellow: formatPercent(node.descendantStatus.descendantYellow || 0, node.descendantStatus.descendantTotal),
          red: formatPercent(node.descendantStatus.descendantRed || 0, node.descendantStatus.descendantTotal),
        }
        : null;

      ['green', 'yellow', 'red'].forEach((statusValue) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `status-button ${statusValue}`;
        if (folderStatusSummary) {
          button.classList.add('folder-summary');
          button.textContent = statusPercentages[statusValue] || '0%';
          button.title = `${statusValue}: ${statusPercentages[statusValue] || '0%'} of descendant nodes`;
        } else {
          button.title = `Set ${statusValue}`;
        }
        if (node.status === statusValue) button.classList.add('active');
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const nextStatus = node.status === statusValue ? 'none' : statusValue;
          lastBulkStatusChoice = statusValue;
          statuses[node.path] = nextStatus;
          node.status = nextStatus;
          saveStatuses();
          renderCurrentView();
        });
        button.addEventListener('mousedown', (event) => {
          event.stopPropagation();
        });
        controls.appendChild(button);
      });

      if (folderStatusSummary) {
        const badge = document.createElement('div');
        const fullyReviewed = node.descendantStatus.descendantNone === 0;
        badge.className = `map-node-review ${fullyReviewed ? 'is-reviewed' : 'is-pending'}`;
        badge.textContent = fullyReviewed
          ? '100% reviewed'
          : `${node.descendantStatus.descendantNone} unassigned`;
        badge.title = fullyReviewed
          ? 'All descendant nodes have statuses assigned'
          : `${node.descendantStatus.descendantNone} descendant nodes still need a status`;

        if (node.type === 'folder' && node.children.length > 0) {
          const applyAllButton = document.createElement('button');
          applyAllButton.type = 'button';
          applyAllButton.className = 'map-node-action';
          applyAllButton.setAttribute('aria-label', 'Cascade');
          applyAllButton.title = 'Cascade this folder status to all descendant nodes';
          applyAllButton.appendChild(createCascadeIcon());
          applyAllButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const nextStatus = getBulkApplyStatus(node);
            const updatedCount = setDescendantStatuses(node, nextStatus);
            if (updatedCount > 0) {
              saveStatuses();
              applyStatusesToTree(treeState);
              renderCurrentView();
              logDebug('Applied folder status to descendants', {
                folderPath: node.path,
                status: nextStatus,
                updatedCount,
              });
            }
          });
          applyAllButton.addEventListener('mousedown', (event) => {
            event.stopPropagation();
          });
          controls.appendChild(applyAllButton);
        }

        controls.appendChild(badge);
      }

      if (node.type === 'folder' && node.children.length > 0) {
        // Cascade button is appended with the completion badge above.
      }

      card.appendChild(controls);
    }
    foreignObject.appendChild(card);
    group.appendChild(foreignObject);
  });

  svg.appendChild(group);
  return { svg, renderedNodeCount: layout.length };
}

function renderMap(nodes, options = {}) {
  const { readOnly = false } = options;
  const renderStartedAt = performance.now();
  currentRenderedNodes = nodes;
  nodes.forEach((node) => summarizeDescendantStatus(node));
  treeRoot.innerHTML = '';

  if (!nodes.length) {
    treeRoot.innerHTML = '<div class="empty-state">No nodes match the current filter.</div>';
    return { renderDurationMs: performance.now() - renderStartedAt, renderedNodeCount: 0 };
  }

  const viewport = document.createElement('div');
  viewport.className = 'map-viewport';
  viewport.id = 'mapViewport';
  treeRoot.appendChild(viewport);

  const viewportWidth = Math.max(viewport.clientWidth, treeRoot.clientWidth, 900);
  const viewportHeight = Math.max(viewport.clientHeight, treeRoot.clientHeight, 520);
  const { svg, renderedNodeCount } = buildMapSvg(nodes, viewportWidth, viewportHeight, { readOnly });
  viewport.appendChild(svg);

  const mapContent = svg.querySelector('#mapContent');
  mapContent.setAttribute('transform', `translate(${viewState.offsetX}, ${viewState.offsetY}) scale(${viewState.scale})`);

  const dragSurface = viewport;
  let pointerId = null;

  const updateTransform = () => {
    mapContent.setAttribute('transform', `translate(${viewState.offsetX}, ${viewState.offsetY}) scale(${viewState.scale})`);
  };

  const setPointerCapture = (event) => {
    pointerId = event.pointerId;
    dragSurface.setPointerCapture(pointerId);
  };

  dragSurface.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) return;
    if (event.target.closest('button, .map-node-card')) return;

    viewState.isDragging = true;
    viewState.dragStartX = event.clientX - viewState.offsetX;
    viewState.dragStartY = event.clientY - viewState.offsetY;
    viewport.classList.add('is-dragging');
    setPointerCapture(event);
  });

  dragSurface.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  dragSurface.addEventListener('pointermove', (event) => {
    if (!viewState.isDragging) return;
    viewState.offsetX = event.clientX - viewState.dragStartX;
    viewState.offsetY = event.clientY - viewState.dragStartY;
    updateTransform();
  });

  dragSurface.addEventListener('pointerup', () => {
    viewState.isDragging = false;
    viewport.classList.remove('is-dragging');
  });

  dragSurface.addEventListener('pointerleave', () => {
    viewState.isDragging = false;
    viewport.classList.remove('is-dragging');
  });

  dragSurface.addEventListener('pointercancel', () => {
    viewState.isDragging = false;
    viewport.classList.remove('is-dragging');
  });

  dragSurface.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    const nextScale = Math.min(2.4, Math.max(0.7, viewState.scale + delta));
    const viewportRect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - viewportRect.left;
    const anchorY = event.clientY - viewportRect.top;

    // Keep the content under the mouse pointer fixed while zooming.
    const worldX = (anchorX - viewState.offsetX) / viewState.scale;
    const worldY = (anchorY - viewState.offsetY) / viewState.scale;

    viewState.scale = nextScale;
    viewState.offsetX = anchorX - worldX * viewState.scale;
    viewState.offsetY = anchorY - worldY * viewState.scale;
    updateTransform();
  }, { passive: false });

  return {
    renderDurationMs: performance.now() - renderStartedAt,
    renderedNodeCount,
  };
}

function countVisibleNodes(nodes) {
  let count = 0;

  const walk = (nodeList) => {
    nodeList.forEach((node) => {
      count += 1;
      if (node.type === 'folder' && node.children.length > 0 && expandedPaths.has(node.path)) {
        walk(node.children);
      }
    });
  };

  walk(nodes);
  return count;
}

function subtreeHasAssignedStatus(node) {
  if (getNodeStatus(node) !== 'none') {
    return true;
  }

  for (const child of node.children) {
    if (subtreeHasAssignedStatus(child)) {
      return true;
    }
  }

  return false;
}

function removePathAndDescendantsFromSet(pathSet, basePath) {
  const basePrefix = `${basePath}/`;
  Array.from(pathSet).forEach((path) => {
    if (path === basePath || path.startsWith(basePrefix)) {
      pathSet.delete(path);
    }
  });
}

function collapseExpandedBeyondLevel(nodes, maxLevel, options = {}, currentLevel = 1) {
  const { preserveAssigned = true, protectedPaths = new Set() } = options;
  let removedCount = 0;

  nodes.forEach((node) => {
    if (node.type !== 'folder') {
      return;
    }

    const isExpanded = expandedPaths.has(node.path);
    const shouldCollapseForLevel = currentLevel >= maxLevel;
    const hasAssignedStatus = subtreeHasAssignedStatus(node);
    const isProtected = protectedPaths.has(node.path);

    if (
      isExpanded &&
      shouldCollapseForLevel &&
      !isProtected &&
      (!preserveAssigned || !hasAssignedStatus)
    ) {
      expandedPaths.delete(node.path);
      removePathAndDescendantsFromSet(manuallyExpandedPaths, node.path);
      removedCount += 1;
    }

    if (node.children.length > 0) {
      removedCount += collapseExpandedBeyondLevel(node.children, maxLevel, options, currentLevel + 1);
    }
  });

  return removedCount;
}

function maybePruneUnusedNodesForPerformance(renderMetrics) {
  if (!renderMetrics || activeViewMode !== 'map' || isAutoPruningRender) {
    return false;
  }

  const visibleNodeCount = countVisibleNodes(treeState);
  const isSlowRender = renderMetrics.renderDurationMs >= SLOW_RENDER_THRESHOLD_MS;
  const isLargeRender = visibleNodeCount >= SLOW_RENDER_NODE_THRESHOLD;

  if (!isSlowRender || !isLargeRender) {
    return false;
  }

  let removed = collapseExpandedBeyondLevel(treeState, EXPAND_ALL_LEVEL_LIMIT, {
    preserveAssigned: true,
    protectedPaths: manuallyExpandedPaths,
  });

  if (removed === 0) {
    removed = collapseExpandedBeyondLevel(treeState, EXPAND_ALL_LEVEL_LIMIT, {
      preserveAssigned: false,
      protectedPaths: manuallyExpandedPaths,
    });
  }

  if (removed === 0) {
    return false;
  }

  logDebug('Auto-pruned deep expanded nodes for performance', {
    removed,
    renderDurationMs: Math.round(renderMetrics.renderDurationMs),
    visibleNodeCount,
  });

  return true;
}

function renderCurrentView() {
  if (!treeState.length) {
    treeRoot.innerHTML = '<div class="empty-state">Loading tree snapshot...</div>';
    updatePreviewSummary();
    return;
  }

  if (activeViewMode === 'preview') {
    const filteredView = buildFilteredViewData();
    updatePreviewSummary(filteredView);
    renderMap(filteredView.nodes, { readOnly: true });
    fitViewToNodes(filteredView.nodes, { readOnly: true });
    return;
  }

  updatePreviewSummary();
  const renderMetrics = renderMap(treeState, { readOnly: false });

  if (maybePruneUnusedNodesForPerformance(renderMetrics)) {
    isAutoPruningRender = true;
    try {
      renderMap(treeState, { readOnly: false });
    } finally {
      isAutoPruningRender = false;
    }
  }
}

function initializeFromRows(rows) {
  treeState = buildTree(rows);
  if (treeState.length === 0) {
    treeRoot.innerHTML = '<p>No valid rows were found in the tree snapshot.</p>';
    return;
  }

  expandedPaths = new Set();
  manuallyExpandedPaths = new Set();
  viewState.offsetX = DEFAULT_VIEW_OFFSET_X;
  viewState.offsetY = DEFAULT_VIEW_OFFSET_Y;
  viewState.scale = 1;

  renderCurrentView();
}

function expandAllFolders(nodes, expandedSet, maxLevel = EXPAND_ALL_LEVEL_LIMIT, currentLevel = 1) {
  nodes.forEach((node) => {
    if (node.type === 'folder') {
      if (currentLevel < maxLevel) {
        expandedSet.add(node.path);
      }

      if (node.children.length > 0) {
        expandAllFolders(node.children, expandedSet, maxLevel, currentLevel + 1);
      }
    }
  });
}

async function bootstrapApp() {
  logDebug('Bootstrap start', { path: window.location.pathname + window.location.search + window.location.hash });
  updateSyncIndicator();
  try {
    statuses = await loadStatuses();
    logDebug('Statuses loaded', { statusCount: Object.keys(statuses).length });
    await loadRowsFromDatabase();
    startRealtimeSync();
  } catch (error) {
    logDebug('Bootstrap failed', { message: error?.message, stack: error?.stack });
    console.error('Drive audit bootstrap failed', error);
  }
}

async function loadRowsFromDatabase() {
  logDebug('Tree data load start', { endpoint: TREE_DATA_ENDPOINT });

  try {
    const response = await fetch(TREE_DATA_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Tree data endpoint returned ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    logDebug('Tree rows received', { rowCount: rows.length, source: payload?.source || null });

    if (rows.length === 0) {
      treeRoot.innerHTML = '<div class="empty-state">Tree snapshot is empty. Import the JSON source first.</div>';
      return;
    }

    currentRows = rows;
    await syncStatusesFromServer();
    initializeFromRows(rows);
    lastSharedPayload = { statuses, rows };
    logDebug('Tree data load complete', { rowCount: rows.length });
  } catch (error) {
    logDebug('Tree data load failed', { message: error?.message, stack: error?.stack });
    console.error('Drive audit tree data load failed', error);
    treeRoot.innerHTML = '<div class="empty-state">Failed to load tree snapshot. Check server logs and console details.</div>';
  }
}

function setShareButtonText(text, timeoutMs = 1500) {
  if (!shareButton) return;
  const originalText = shareButton.dataset.originalText || shareButton.textContent || 'Copy share link';
  shareButton.dataset.originalText = originalText;
  shareButton.textContent = text;

  if (timeoutMs > 0) {
    window.setTimeout(() => {
      shareButton.textContent = originalText;
    }, timeoutMs);
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('Clipboard write not available');
  }
}

async function shareCurrentState() {
  if (!treeState.length) {
    setShareButtonText('Nothing to share', 1800);
    return;
  }

  const payload = {
    statuses,
  };

  const configuredShareBaseUrl = typeof window.DRIVE_AUDIT_PUBLIC_SHARE_URL === 'string'
    ? window.DRIVE_AUDIT_PUBLIC_SHARE_URL.trim()
    : '';
  const shareUrl = window.DriveAuditMapShareState?.buildShareUrl(
    window.location,
    payload,
    configuredShareBaseUrl
  );
  if (!shareUrl) {
    setShareButtonText('Share unavailable', 1800);
    return;
  }

  try {
    await copyTextToClipboard(shareUrl);

    try {
      const shareUrlObject = new URL(shareUrl);
      if (shareUrlObject.origin === window.location.origin) {
        window.history.replaceState({}, '', shareUrl);
      }
    } catch {
      // URL updates can fail on very long hashes; copy still succeeded.
    }

    setShareButtonText('Copied!');
  } catch {
    setShareButtonText('Copy failed', 2200);
  }
}

expandAllButton.addEventListener('click', () => {
  expandedPaths.clear();
  manuallyExpandedPaths.clear();
  expandAllFolders(treeState, expandedPaths, EXPAND_ALL_LEVEL_LIMIT);
  renderCurrentView();
});

collapseAllButton?.addEventListener('click', () => {
  expandedPaths.clear();
  manuallyExpandedPaths.clear();
  renderCurrentView();
});

zoomInButton.addEventListener('click', () => {
  viewState.scale = Math.min(2.4, viewState.scale + 0.1);
  renderCurrentView();
});

zoomOutButton.addEventListener('click', () => {
  viewState.scale = Math.max(0.7, viewState.scale - 0.1);
  renderCurrentView();
});

resetViewButton.addEventListener('click', () => {
  viewState.scale = 1;
  viewState.offsetX = DEFAULT_VIEW_OFFSET_X;
  viewState.offsetY = DEFAULT_VIEW_OFFSET_Y;
  renderCurrentView();
});

fitViewButton?.addEventListener('click', () => {
  if (!currentRenderedNodes.length) return;
  fitViewToNodes(currentRenderedNodes, { readOnly: activeViewMode === 'preview' });
});

window.addEventListener('resize', () => {
  if (activeViewMode === 'preview' && currentRenderedNodes.length > 0) {
    fitViewToNodes(currentRenderedNodes, { readOnly: true });
  }
});

shareButton?.addEventListener('click', () => {
  shareCurrentState();
});

resyncStatusesButton?.addEventListener('click', () => {
  resyncStatusesNow();
});

previewFilterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setPreviewFilter(button.dataset.previewFilter || 'all');
  });
});

sidebarTabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setSidebarTab(button.dataset.sidebarTab || 'map');
  });
});

setSidebarTab(activeViewMode);

bootstrapApp();
