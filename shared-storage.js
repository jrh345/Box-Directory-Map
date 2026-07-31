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

  async function getStateFromSupabase() {
    const config = getSupabaseConfig();
    if (!config) return null;

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
    return normalizeStatePayload(payload[0]);
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
