(function (global) {
  function logStorageDebug(message, detail) {
    const entry = { scope: 'shared-storage', message, detail, at: new Date().toISOString() };
    global.__driveAuditDebug = global.__driveAuditDebug || [];
    global.__driveAuditDebug.push(entry);
    console.debug('[drive-audit][storage]', message, detail || '');
  }

  async function readErrorText(response) {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  async function requestSupabaseJson(url, options = {}, label = 'supabase-request') {
    const response = await fetch(url, options);
    if (!response.ok) {
      const detail = await readErrorText(response);
      logStorageDebug(`${label} failed`, {
        url,
        status: response.status,
        detail,
      });
      const suffix = detail ? `: ${detail}` : '';
      throw new Error(`${label} failed with ${response.status}${suffix}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    logStorageDebug(`${label} ok`, {
      url,
      status: response.status,
    });
    return payload;
  }

  function isLocalHostRuntime() {
    const host = String(global.location?.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function getSupabaseConfig() {
    const url = global.DRIVE_AUDIT_SUPABASE_URL || '';
    const key = global.DRIVE_AUDIT_SUPABASE_ANON_KEY || '';
    if (!url || !key) return null;
    return { url: url.replace(/\/$/, ''), key };
  }

  function getDefaultApiBase() {
    if (global.DRIVE_AUDIT_API_URL) {
      const configured = String(global.DRIVE_AUDIT_API_URL).trim();
      if (configured.endsWith('/statuses')) {
        return configured.replace(/\/statuses$/, '');
      }
      if (configured.endsWith('/map-state')) {
        return configured.replace(/\/map-state$/, '');
      }
      return configured;
    }

    return '/api';
  }

  function normalizeStatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { statuses: {}, rows: [] };
    }

    const statuses = payload.statuses && typeof payload.statuses === 'object' && !Array.isArray(payload.statuses)
      ? payload.statuses
      : {};

    return { statuses, rows: [] };
  }

  function normalizeStatusesPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {};
    }

    const nestedStatuses = payload.statuses;
    if (nestedStatuses && typeof nestedStatuses === 'object' && !Array.isArray(nestedStatuses)) {
      return nestedStatuses;
    }

    return payload;
  }

  const SUPABASE_NODE_STATUS_PAGE_SIZE = 1000;
  const SUPABASE_NODE_STATUS_UPSERT_CHUNK = 500;
  let supabaseNodeStatusesAvailable = null;
  let lastSupabaseStatusesSnapshot = null;

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json();
  }

  const runtimeInfo = {
    localTestMode: isLocalHostRuntime(),
    supabaseConfigured: Boolean(getSupabaseConfig()),
    supabaseWritesEnabled: !isLocalHostRuntime(),
    lastReadSource: 'none',
    lastWriteSource: 'none',
    lastError: null,
  };
  const strictSupabaseMode = !runtimeInfo.localTestMode && runtimeInfo.supabaseConfigured;

  function setRuntimeInfo(patch) {
    Object.assign(runtimeInfo, patch || {});
  }

  function getRuntimeInfo() {
    return { ...runtimeInfo };
  }

  function buildSupabaseHeaders(config, extra = {}) {
    return {
      'Content-Type': 'application/json',
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      ...extra,
    };
  }

  async function ensureNodeStatusesAvailability(config) {
    if (supabaseNodeStatusesAvailable !== null) {
      return supabaseNodeStatusesAvailable;
    }

    const url = `${config.url}/rest/v1/node_statuses?select=node_path,status&limit=1`;
    const response = await fetch(url, {
      headers: buildSupabaseHeaders(config),
    });

    if (response.ok) {
      supabaseNodeStatusesAvailable = true;
      logStorageDebug('supabase-node-statuses available', { status: response.status });
      return true;
    }

    const detail = await readErrorText(response);
    if (response.status === 404 && /node_statuses/i.test(detail)) {
      supabaseNodeStatusesAvailable = false;
      logStorageDebug('supabase-node-statuses unavailable', { status: response.status, detail });
      return false;
    }

    logStorageDebug('supabase-node-statuses probe failed', {
      status: response.status,
      detail,
    });
    throw new Error(`Supabase node_statuses probe failed with ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  async function fetchNodeStatusesFromSupabase(config) {
    const statuses = {};
    let from = 0;

    while (true) {
      const to = from + SUPABASE_NODE_STATUS_PAGE_SIZE - 1;
      const url = `${config.url}/rest/v1/node_statuses?select=node_path,status&order=node_path.asc`;
      const response = await fetch(url, {
        headers: buildSupabaseHeaders(config, {
          Range: `${from}-${to}`,
        }),
      });

      if (!response.ok) {
        const detail = await readErrorText(response);
        throw new Error(`Supabase node_statuses read failed with ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const rows = await response.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) {
        break;
      }

      rows.forEach((row) => {
        const path = row?.node_path;
        const status = row?.status;
        if (!path || typeof path !== 'string') return;
        if (status === 'green' || status === 'yellow' || status === 'red') {
          statuses[path] = status;
        }
      });

      if (rows.length < SUPABASE_NODE_STATUS_PAGE_SIZE) {
        break;
      }
      from += SUPABASE_NODE_STATUS_PAGE_SIZE;
    }

    return statuses;
  }

  function buildChangedStatusRows(previousStatuses, nextStatuses) {
    const rows = [];
    const prev = previousStatuses && typeof previousStatuses === 'object' ? previousStatuses : {};
    const next = nextStatuses && typeof nextStatuses === 'object' ? nextStatuses : {};
    const keySet = new Set([...Object.keys(prev), ...Object.keys(next)]);

    keySet.forEach((path) => {
      const before = prev[path] || 'none';
      const after = next[path] || 'none';
      if (before === after) return;
      rows.push({
        node_path: path,
        status: after,
      });
    });

    return rows;
  }

  function buildNodeStatusRowsFromSnapshot(statuses) {
    const rows = [];
    const source = statuses && typeof statuses === 'object' ? statuses : {};

    Object.entries(source).forEach(([path, status]) => {
      if (!path || typeof path !== 'string') return;
      if (status === 'green' || status === 'yellow' || status === 'red' || status === 'none') {
        rows.push({
          node_path: path,
          status,
        });
      }
    });

    return rows;
  }

  async function upsertNodeStatusesToSupabase(config, rows) {
    if (!rows.length) return;

    for (let index = 0; index < rows.length; index += SUPABASE_NODE_STATUS_UPSERT_CHUNK) {
      const chunk = rows.slice(index, index + SUPABASE_NODE_STATUS_UPSERT_CHUNK);
      await requestSupabaseJson(
        `${config.url}/rest/v1/node_statuses?on_conflict=node_path`,
        {
          method: 'POST',
          headers: buildSupabaseHeaders(config, {
            Prefer: 'resolution=merge-duplicates,return=minimal',
          }),
          body: JSON.stringify(chunk),
        },
        'supabase-node-statuses-upsert'
      );
    }
  }

  async function getLegacyStateFromSupabase(config) {
    const url = `${config.url}/rest/v1/shared_map_state?select=id,statuses&limit=1`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
    });

    if (!response.ok) {
      const detail = await readErrorText(response);
      logStorageDebug('supabase-read failed', {
        url,
        status: response.status,
        detail,
      });
      if (response.status === 406 || response.status === 404) {
        return null;
      }
      throw new Error(`Supabase read failed with ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const payload = await response.json();
    logStorageDebug('supabase-read ok', {
      url,
      status: response.status,
      rowCount: Array.isArray(payload) ? payload.length : 0,
    });
    if (!Array.isArray(payload) || payload.length === 0) return null;
    const state = normalizeStatePayload(payload[0]);
    lastSupabaseStatusesSnapshot = { ...(state.statuses || {}) };
    return state;
  }

  async function getStateFromSupabase() {
    const config = getSupabaseConfig();
    if (!config) return null;

    if (await ensureNodeStatusesAvailability(config)) {
      const rowStatuses = await fetchNodeStatusesFromSupabase(config);
      const rowStatusCount = Object.keys(rowStatuses).length;

      if (rowStatusCount > 0) {
        lastSupabaseStatusesSnapshot = { ...rowStatuses };
        logStorageDebug('supabase-node-statuses read complete', {
          count: rowStatusCount,
        });
        return { statuses: rowStatuses, rows: [] };
      }

      const legacyState = await getLegacyStateFromSupabase(config);
      const legacyStatuses = legacyState?.statuses || {};
      const legacyCount = Object.keys(legacyStatuses).length;
      if (legacyCount > 0) {
        const seedRows = buildNodeStatusRowsFromSnapshot(legacyStatuses);
        await upsertNodeStatusesToSupabase(config, seedRows);
        lastSupabaseStatusesSnapshot = { ...legacyStatuses };
        logStorageDebug('supabase-node-statuses backfilled from shared_map_state', {
          seededRows: seedRows.length,
        });
        return { statuses: legacyStatuses, rows: [] };
      }

      lastSupabaseStatusesSnapshot = {};
      logStorageDebug('supabase-node-statuses is empty and no legacy statuses found', {});
      return { statuses: {}, rows: [] };
    }

    return getLegacyStateFromSupabase(config);
  }

  async function saveStatusesToApi(statuses) {
    const baseUrl = getDefaultApiBase();
    await requestJson(`${baseUrl}/statuses`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ statuses }),
    });
  }

  async function saveStatusesToSupabase(statuses) {
    if (runtimeInfo.localTestMode) {
      setRuntimeInfo({ lastWriteSource: 'local-api', lastError: null });
      return null;
    }

    const config = getSupabaseConfig();
    if (!config) return null;
    const nextStatuses = statuses && typeof statuses === 'object' ? statuses : {};

    if (await ensureNodeStatusesAvailability(config)) {
      if (!lastSupabaseStatusesSnapshot) {
        lastSupabaseStatusesSnapshot = await fetchNodeStatusesFromSupabase(config);
      }

      const changedRows = buildChangedStatusRows(lastSupabaseStatusesSnapshot, nextStatuses);
      await upsertNodeStatusesToSupabase(config, changedRows);
      lastSupabaseStatusesSnapshot = { ...nextStatuses };
      logStorageDebug('supabase-node-statuses write complete', {
        changedRows: changedRows.length,
        statusCount: Object.keys(nextStatuses).length,
      });
      return { statuses: nextStatuses, rows: [] };
    }

    const authHeaders = {
      'Content-Type': 'application/json',
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
    };

    let existingRows = [];
    try {
      const lookupPayload = await requestSupabaseJson(
        `${config.url}/rest/v1/shared_map_state?select=id&limit=1`,
        { headers: authHeaders },
        'supabase-row-lookup'
      );
      existingRows = Array.isArray(lookupPayload) ? lookupPayload : [];
    } catch (error) {
      if (!String(error?.message || '').includes('406') && !String(error?.message || '').includes('404')) {
        throw error;
      }
      existingRows = [];
    }
    const firstRow = Array.isArray(existingRows) ? existingRows[0] : null;

    if (firstRow && firstRow.id !== undefined && firstRow.id !== null) {
      const rowId = encodeURIComponent(String(firstRow.id));
      const updatedPayload = await requestSupabaseJson(
        `${config.url}/rest/v1/shared_map_state?id=eq.${rowId}`,
        {
          method: 'PATCH',
          headers: {
            ...authHeaders,
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ statuses: nextStatuses }),
        },
        'supabase-update-existing-row'
      );
      const updatedState = Array.isArray(updatedPayload) ? updatedPayload[0] : updatedPayload;
      return normalizeStatePayload(updatedState);
    }

    const insertResponse = await fetch(`${config.url}/rest/v1/shared_map_state`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        id: 'default',
        statuses: nextStatuses,
      }),
    });

    if (!insertResponse.ok) {
      const insertDetail = await readErrorText(insertResponse);
      logStorageDebug('supabase-insert-default failed', {
        status: insertResponse.status,
        detail: insertDetail,
      });
      // If insert with id default fails due id type mismatch, try insert with only statuses.
      if (insertResponse.status === 400) {
        const insertNoId = await fetch(`${config.url}/rest/v1/shared_map_state`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ statuses: nextStatuses }),
        });
        if (insertNoId.ok) {
          logStorageDebug('supabase-insert-without-id ok', { status: insertNoId.status });
          const noIdPayload = await insertNoId.json();
          const noIdState = Array.isArray(noIdPayload) ? noIdPayload[0] : noIdPayload;
          return normalizeStatePayload(noIdState);
        }
        const noIdDetail = await readErrorText(insertNoId);
        logStorageDebug('supabase-insert-without-id failed', {
          status: insertNoId.status,
          detail: noIdDetail,
        });
      }

      // Another client may have created the row after our insert attempt.
      if (insertResponse.status === 409) {
        const retryLookup = await fetch(`${config.url}/rest/v1/shared_map_state?select=id&limit=1`, {
          headers: authHeaders,
        });
        if (retryLookup.ok) {
          logStorageDebug('supabase-retry-lookup ok', { status: retryLookup.status });
          const retryRows = await retryLookup.json().catch(() => []);
          const retryFirst = Array.isArray(retryRows) ? retryRows[0] : null;
          if (retryFirst && retryFirst.id !== undefined && retryFirst.id !== null) {
            const retryId = encodeURIComponent(String(retryFirst.id));
            const retryUpdate = await fetch(`${config.url}/rest/v1/shared_map_state?id=eq.${retryId}`, {
              method: 'PATCH',
              headers: {
                ...authHeaders,
                Prefer: 'return=representation',
              },
              body: JSON.stringify({ statuses: nextStatuses }),
            });
            if (retryUpdate.ok) {
              logStorageDebug('supabase-retry-update ok', { status: retryUpdate.status });
              const retryPayload = await retryUpdate.json().catch(() => []);
              const retryState = Array.isArray(retryPayload) ? retryPayload[0] : retryPayload;
              return normalizeStatePayload(retryState);
            }

            const retryDetail = await retryUpdate.text().catch(() => '');
            throw new Error(`Supabase retry update failed with ${retryUpdate.status}${retryDetail ? `: ${retryDetail}` : ''}`);
          }
        }
      }

      throw new Error(`Supabase insert failed with ${insertResponse.status}${insertDetail ? `: ${insertDetail}` : ''}`);
    }

    logStorageDebug('supabase-insert-default ok', { status: insertResponse.status });
    const insertedPayload = await insertResponse.json();
    const insertedState = Array.isArray(insertedPayload) ? insertedPayload[0] : insertedPayload;
    return normalizeStatePayload(insertedState);
  }

  const adapter = {
    async getState() {
      if (runtimeInfo.localTestMode) {
        try {
          const response = await requestJson(`${getDefaultApiBase()}/statuses`, { cache: 'no-store' });
          setRuntimeInfo({ lastReadSource: 'local-api', lastError: null });
          return { statuses: normalizeStatusesPayload(response), rows: [] };
        } catch {
          setRuntimeInfo({ lastReadSource: 'none' });
          return null;
        }
      }

      try {
        const supabaseState = await getStateFromSupabase();
        if (supabaseState) {
          setRuntimeInfo({ lastReadSource: 'supabase', lastError: null });
          return supabaseState;
        }
      } catch (error) {
        setRuntimeInfo({ lastError: error?.message || 'Supabase read failed' });
        if (strictSupabaseMode) {
          setRuntimeInfo({ lastReadSource: 'none' });
          return null;
        }
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        const response = await requestJson(`${getDefaultApiBase()}/statuses`, { cache: 'no-store' });
        setRuntimeInfo({ lastReadSource: 'local-api', lastError: null });
        return { statuses: normalizeStatusesPayload(response), rows: [] };
      } catch {
        setRuntimeInfo({ lastReadSource: 'none' });
        return null;
      }
    },

    async saveState(state) {
      try {
        const supabaseState = await saveStatusesToSupabase(state?.statuses || {});
        if (supabaseState) {
          setRuntimeInfo({ lastWriteSource: 'supabase', lastError: null });
          return supabaseState;
        }
      } catch (error) {
        setRuntimeInfo({ lastError: error?.message || 'Supabase write failed' });
        if (strictSupabaseMode) {
          throw error;
        }
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        await saveStatusesToApi(state?.statuses || {});
        setRuntimeInfo({ lastWriteSource: 'local-api', lastError: null });
        return { statuses: state?.statuses || {}, rows: [] };
      } catch {
        return null;
      }
    },

    async saveStatuses(statuses) {
      try {
        const supabaseState = await saveStatusesToSupabase(statuses);
        if (supabaseState) {
          setRuntimeInfo({ lastWriteSource: 'supabase', lastError: null });
          return supabaseState;
        }
      } catch (error) {
        setRuntimeInfo({ lastError: error?.message || 'Supabase write failed' });
        if (strictSupabaseMode) {
          throw error;
        }
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        await saveStatusesToApi(statuses);
        setRuntimeInfo({ lastWriteSource: 'local-api', lastError: null });
      } catch {
        // Ignore status API failures.
      }
    },

    getSyncInfo() {
      return getRuntimeInfo();
    },
  };

  global.DriveAuditMapSharedStorage = adapter;
})(typeof window !== 'undefined' ? window : globalThis);
