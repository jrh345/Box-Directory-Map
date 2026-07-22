let state = {
  statuses: {},
  rows: [],
};

function normalizeStatuses(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.statuses && typeof payload.statuses === 'object' && !Array.isArray(payload.statuses)) {
      return payload.statuses;
    }
    return payload;
  }
  return {};
}

function normalizeRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function getState() {
  return state;
}

function setStatuses(payload) {
  state = {
    ...state,
    statuses: normalizeStatuses(payload),
  };
  return state;
}

function setMapState(payload) {
  state = {
    statuses: normalizeStatuses(payload),
    rows: normalizeRows(payload),
  };
  return state;
}

module.exports = {
  getState,
  setStatuses,
  setMapState,
};
