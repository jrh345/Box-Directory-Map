(function (global) {
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

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return { statuses, rows };
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json();
  }

  async function getStateFromSupabase() {
    const config = getSupabaseConfig();
    if (!config) return null;

    const url = `${config.url}/rest/v1/shared_map_state?id=eq.default&select=id,statuses,rows`;
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

  async function saveStateToSupabase(state) {
    const config = getSupabaseConfig();
    if (!config) return null;

    const payload = {
      id: 'default',
      statuses: state.statuses || {},
      rows: Array.isArray(state.rows) ? state.rows : [],
    };

    const existing = await getStateFromSupabase();
    if (!existing) {
      await fetch(`${config.url}/rest/v1/shared_map_state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(payload),
      });
      return payload;
    }

    await fetch(`${config.url}/rest/v1/shared_map_state?id=eq.default`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    return payload;
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
    const config = getSupabaseConfig();
    if (!config) return null;

    const existing = (await getStateFromSupabase()) || { statuses: {}, rows: [] };
    const payload = {
      statuses: statuses || {},
      rows: Array.isArray(existing.rows) ? existing.rows : [],
    };

    return saveStateToSupabase(payload);
  }

  const adapter = {
    async getState() {
      try {
        const supabaseState = await getStateFromSupabase();
        if (supabaseState) return supabaseState;
      } catch {
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        const response = await requestJson(`${getDefaultApiBase()}/map-state`, { cache: 'no-store' });
        return normalizeStatePayload(response);
      } catch {
        return null;
      }
    },

    async saveState(state) {
      try {
        const supabaseState = await saveStateToSupabase(state);
        if (supabaseState) return supabaseState;
      } catch {
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        const response = await requestJson(`${getDefaultApiBase()}/map-state`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(state),
        });
        return normalizeStatePayload(response);
      } catch {
        return null;
      }
    },

    async saveStatuses(statuses) {
      try {
        const supabaseState = await saveStatusesToSupabase(statuses);
        if (supabaseState) return supabaseState;
      } catch {
        // Ignore Supabase failures and fall back to API storage.
      }

      try {
        await saveStatusesToApi(statuses);
      } catch {
        // Ignore status API failures.
      }
    },
  };

  global.DriveAuditMapSharedStorage = adapter;
})(typeof window !== 'undefined' ? window : globalThis);
