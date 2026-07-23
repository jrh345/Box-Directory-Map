const treeRoot = document.getElementById('treeRoot');
const expandAllButton = document.getElementById('expandAll');
const zoomInButton = document.getElementById('zoomIn');
const zoomOutButton = document.getElementById('zoomOut');
const resetViewButton = document.getElementById('resetView');
const shareButton = document.getElementById('shareLink');

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
const CARD_WIDTH = 220;
const CARD_HEIGHT = 72;
const ROW_HEIGHT = 100;
const HORIZONTAL_STEP = 280;
const REALTIME_SYNC_INTERVAL_MS = 3000;

let treeState = [];
let expandedPaths = new Set();
let statuses = {};
let currentRows = [];
let lastSharedPayload = null;
let realtimeSyncTimer = null;
let realtimeSyncInFlight = false;
let viewState = {
  scale: 1,
  offsetX: 40,
  offsetY: 40,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

async function loadStatuses() {
  const localRaw = localStorage.getItem(STORAGE_KEY);
  const fallback = localRaw ? JSON.parse(localRaw) : {};

  try {
    const sharedState = await window.DriveAuditMapSharedStorage?.getState();
    if (sharedState?.statuses) {
      statuses = sharedState.statuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
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
    return statuses;
  } catch {
    statuses = fallback;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
    return statuses;
  }
}

async function syncStatusesFromServer() {
  try {
    const sharedState = await window.DriveAuditMapSharedStorage?.getState();
    if (sharedState?.statuses) {
      statuses = sharedState.statuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
      return;
    }
  } catch {
    // Ignore shared storage failures and continue with local state.
  }

  try {
    const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return;

    const payload = await response.json();
    const serverStatuses = payload?.statuses && typeof payload.statuses === 'object'
      ? payload.statuses
      : (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});

    if (Object.keys(serverStatuses).length > 0) {
      statuses = serverStatuses;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
    }
  } catch {
    // Ignore remote sync failures and continue with local state.
  }
}

async function saveStatuses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));

  try {
    await window.DriveAuditMapSharedStorage?.saveStatuses(statuses);
  } catch {
    // Ignore shared storage failures and keep the local browser state as the fallback.
  }

  try {
    await fetch(STATUS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ statuses }),
    });
  } catch {
    // Ignore remote save failures and keep the local browser state as the fallback.
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
  renderMap(treeState);
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

  node.children.forEach((child) => {
    const childSummary = summarizeDescendantStatus(child);
    hasYellow = hasYellow || childSummary.hasYellow;
    hasRed = hasRed || childSummary.hasRed;

    if (child.status === 'yellow') {
      hasYellow = true;
    }
    if (child.status === 'red') {
      hasRed = true;
    }
  });

  node.descendantStatus = { hasYellow, hasRed };
  return node.descendantStatus;
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
      x: depth * HORIZONTAL_STEP + 30,
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

function buildMapSvg(nodes) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 2200 1800');
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('id', 'mapContent');

  const { layout, connectors } = layoutMap(nodes);
  const maxX = Math.max(...layout.map((entry) => entry.x + CARD_WIDTH), 900);
  const maxY = Math.max(...layout.map((entry) => entry.y + CARD_HEIGHT), 500);
  const width = Math.max(1200, maxX + 140);
  const height = Math.max(700, maxY + 120);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

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

    card.className = `map-node-card status-${node.status} ${descendantClasses.join(' ')}`.trim();

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
      } else {
        expandedPaths.add(node.path);
      }
      renderMap(treeState);
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

    const controls = document.createElement('div');
    controls.className = 'map-node-controls';

    ['green', 'yellow', 'red'].forEach((statusValue) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `status-button ${statusValue}`;
      button.title = `Set ${statusValue}`;
      if (node.status === statusValue) button.classList.add('active');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextStatus = node.status === statusValue ? 'none' : statusValue;
        statuses[node.path] = nextStatus;
        node.status = nextStatus;
        saveStatuses();
        renderMap(treeState);
      });
      button.addEventListener('mousedown', (event) => {
        event.stopPropagation();
      });
      controls.appendChild(button);
    });

    card.appendChild(controls);
    foreignObject.appendChild(card);
    group.appendChild(foreignObject);
  });

  svg.appendChild(group);
  return svg;
}

function renderMap(nodes) {
  nodes.forEach((node) => summarizeDescendantStatus(node));
  treeRoot.innerHTML = '';

  const viewport = document.createElement('div');
  viewport.className = 'map-viewport';
  viewport.id = 'mapViewport';

  const svg = buildMapSvg(nodes);
  viewport.appendChild(svg);
  treeRoot.appendChild(viewport);

  const mapContent = svg.querySelector('#mapContent');
  mapContent.setAttribute('transform', `translate(${viewState.offsetX}, ${viewState.offsetY}) scale(${viewState.scale})`);

  const svgEl = svg;
  let pointerId = null;

  const updateTransform = () => {
    mapContent.setAttribute('transform', `translate(${viewState.offsetX}, ${viewState.offsetY}) scale(${viewState.scale})`);
  };

  const setPointerCapture = (event) => {
    pointerId = event.pointerId;
    svgEl.setPointerCapture(pointerId);
  };

  svgEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) return;
    if (event.target.closest('button, .map-node-card')) return;

    viewState.isDragging = true;
    viewState.dragStartX = event.clientX - viewState.offsetX;
    viewState.dragStartY = event.clientY - viewState.offsetY;
    setPointerCapture(event);
  });

  svgEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  svgEl.addEventListener('pointermove', (event) => {
    if (!viewState.isDragging) return;
    viewState.offsetX = event.clientX - viewState.dragStartX;
    viewState.offsetY = event.clientY - viewState.dragStartY;
    updateTransform();
  });

  svgEl.addEventListener('pointerup', () => {
    viewState.isDragging = false;
  });

  svgEl.addEventListener('pointerleave', () => {
    viewState.isDragging = false;
  });

  svgEl.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    const nextScale = Math.min(2.4, Math.max(0.7, viewState.scale + delta));
    viewState.scale = nextScale;
    updateTransform();
  }, { passive: false });
}

function initializeFromRows(rows) {
  treeState = buildTree(rows);
  if (treeState.length === 0) {
    treeRoot.innerHTML = '<p>No valid rows were found in the SQLite snapshot.</p>';
    return;
  }

  treeState.forEach((node) => {
    expandedPaths.add(node.path);
  });

  renderMap(treeState);
}

async function bootstrapApp() {
  logDebug('Bootstrap start', { path: window.location.pathname + window.location.search + window.location.hash });
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
  logDebug('SQLite load start', { endpoint: TREE_DATA_ENDPOINT });

  try {
    const response = await fetch(TREE_DATA_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`SQLite endpoint returned ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    logDebug('SQLite rows received', { rowCount: rows.length, source: payload?.source || null });

    if (rows.length === 0) {
      treeRoot.innerHTML = '<div class="empty-state">SQLite snapshot is empty. Import data into the database first.</div>';
      return;
    }

    currentRows = rows;
    await syncStatusesFromServer();
    initializeFromRows(rows);
    lastSharedPayload = { statuses, rows };
    logDebug('SQLite load complete', { rowCount: rows.length });
  } catch (error) {
    logDebug('SQLite load failed', { message: error?.message, stack: error?.stack });
    console.error('Drive audit SQLite load failed', error);
    treeRoot.innerHTML = '<div class="empty-state">Failed to load SQLite snapshot. Check server logs and console details.</div>';
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

  const shareUrl = window.DriveAuditMapShareState?.buildShareUrl(window.location, payload);
  if (!shareUrl) {
    setShareButtonText('Share unavailable', 1800);
    return;
  }

  try {
    await copyTextToClipboard(shareUrl);

    try {
      window.history.replaceState({}, '', shareUrl);
    } catch {
      // URL updates can fail on very long hashes; copy still succeeded.
    }

    setShareButtonText('Copied!');
  } catch {
    setShareButtonText('Copy failed', 2200);
  }
}

expandAllButton.addEventListener('click', () => {
  treeState.forEach((node) => {
    expandedPaths.add(node.path);
  });
  renderMap(treeState);
});

zoomInButton.addEventListener('click', () => {
  viewState.scale = Math.min(2.4, viewState.scale + 0.1);
  renderMap(treeState);
});

zoomOutButton.addEventListener('click', () => {
  viewState.scale = Math.max(0.7, viewState.scale - 0.1);
  renderMap(treeState);
});

resetViewButton.addEventListener('click', () => {
  viewState.scale = 1;
  viewState.offsetX = 40;
  viewState.offsetY = 40;
  renderMap(treeState);
});

shareButton?.addEventListener('click', () => {
  shareCurrentState();
});

bootstrapApp();
