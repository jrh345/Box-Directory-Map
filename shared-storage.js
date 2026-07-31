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

    const response = await fetch(`${config.url}/rest/v1/shared_map_state?select=id,statuses&limit=1`, {
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
    const authHeaders = {
      'Content-Type': 'application/json',
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
    };

    const existingResponse = await fetch(`${config.url}/rest/v1/shared_map_state?select=id&limit=1`, {
      headers: authHeaders,
    });

    if (!existingResponse.ok && existingResponse.status !== 406 && existingResponse.status !== 404) {
      const detail = await existingResponse.text().catch(() => '');
      throw new Error(`Supabase row lookup failed with ${existingResponse.status}${detail ? `: ${detail}` : ''}`);
    }

    const existingRows = existingResponse.ok ? await existingResponse.json().catch(() => []) : [];
    const firstRow = Array.isArray(existingRows) ? existingRows[0] : null;

    if (firstRow && firstRow.id !== undefined && firstRow.id !== null) {
      const rowId = encodeURIComponent(String(firstRow.id));
      const updateResponse = await fetch(`${config.url}/rest/v1/shared_map_state?id=eq.${rowId}`, {
        method: 'PATCH',
        headers: {
          ...authHeaders,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ statuses: nextStatuses }),
      });

      if (!updateResponse.ok) {
        const detail = await updateResponse.text().catch(() => '');
        throw new Error(`Supabase update failed with ${updateResponse.status}${detail ? `: ${detail}` : ''}`);
      }

      const updatedPayload = await updateResponse.json().catch(() => []);
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
          const noIdPayload = await insertNoId.json();
          const noIdState = Array.isArray(noIdPayload) ? noIdPayload[0] : noIdPayload;
          return normalizeStatePayload(noIdState);
        }
      }

      // Another client may have created the row after our insert attempt.
      if (insertResponse.status === 409) {
        const retryLookup = await fetch(`${config.url}/rest/v1/shared_map_state?select=id&limit=1`, {
          headers: authHeaders,
        });
        if (retryLookup.ok) {
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
              const retryPayload = await retryUpdate.json().catch(() => []);
              const retryState = Array.isArray(retryPayload) ? retryPayload[0] : retryPayload;
              return normalizeStatePayload(retryState);
            }

            const retryDetail = await retryUpdate.text().catch(() => '');
            throw new Error(`Supabase retry update failed with ${retryUpdate.status}${retryDetail ? `: ${retryDetail}` : ''}`);
          }
        }
      }

      const detail = await insertResponse.text().catch(() => '');
      throw new Error(`Supabase insert failed with ${insertResponse.status}${detail ? `: ${detail}` : ''}`);
    }

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
