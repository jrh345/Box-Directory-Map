(function (global) {
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

    const url = `${config.url}/rest/v1/shared_map_state?id=eq.default&select=id,statuses`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
      },
    });

    if (!response.ok) {
      if (response.status === 406 || response.status === 404) {
        return null;
      }
      throw new Error(`Supabase read failed with ${response.status}`);
    }

    const payload = await response.json();
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

    const upsertResponse = await fetch(`${config.url}/rest/v1/shared_map_state?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: 'default',
        statuses: nextStatuses,
        rows: [],
      }),
    });

    if (!upsertResponse.ok) {
      const detail = await upsertResponse.text().catch(() => '');
      throw new Error(`Supabase upsert failed with ${upsertResponse.status}${detail ? `: ${detail}` : ''}`);
    }

    const updatedPayload = await upsertResponse.json();
    const updatedState = Array.isArray(updatedPayload) ? updatedPayload[0] : updatedPayload;
    return normalizeStatePayload(updatedState);
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
