(function (global) {
  function toBase64Url(value) {
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(value)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'utf8').toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    return value;
  }

  function fromBase64Url(value) {
    if (!value) return '';

    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);

    if (typeof atob === 'function') {
      return decodeURIComponent(escape(atob(padded)));
    }

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }

    return padded;
  }

  function encodeSharedState(payload) {
    return toBase64Url(JSON.stringify(payload));
  }

  function decodeSharedState(value) {
    if (!value) return null;

    try {
      const decoded = fromBase64Url(value);
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function buildShareUrl(location, payload) {
    const url = new URL(location.href);
    url.hash = `share=${encodeSharedState(payload)}`;
    return url.toString();
  }

  const api = {
    encodeSharedState,
    decodeSharedState,
    buildShareUrl,
  };

  global.DriveAuditMapShareState = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
