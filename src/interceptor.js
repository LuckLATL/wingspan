// WINGSPAN — Credential + presence interceptor
// Runs in MAIN world (page context) at document_start.
//
// Does two things:
//   1. Captures Matrix credentials from the first authenticated /_matrix/ request.
//   2. Intercepts every /sync response and extracts live presence events from it.
//      This is far more accurate than the GET presence endpoint, which many servers
//      leave disabled or return stale data for.
//
// The manifest matches *://*/*, but the messages posted here are no-ops on any
// page that doesn't fire /_matrix/ requests, and content.js (which is host-gated
// via the user-editable domain list) is the only listener — so disabled hosts
// see no observable behavior beyond a thin fetch wrapper.

(function () {
  const _fetch = window.fetch.bind(window);
  let credsCaptured = false;

  window.fetch = function wingspanFetch(input, init) {
    const url = typeof input === 'string'
      ? input
      : (input instanceof Request ? input.url : String(input));

    const isMatrix = url.includes('/_matrix/');
    const isSync   = isMatrix && url.includes('/sync');

    // ── 1. Capture credentials ──────────────────────────────────────────────
    if (!credsCaptured && isMatrix) {
      try {
        const hdrs = init?.headers;
        let auth = null;
        if (hdrs instanceof Headers) {
          auth = hdrs.get('Authorization');
        } else if (hdrs && typeof hdrs === 'object') {
          for (const k of Object.keys(hdrs)) {
            if (k.toLowerCase() === 'authorization') { auth = hdrs[k]; break; }
          }
        }
        if (auth?.startsWith('Bearer ')) {
          let hsUrl = null;
          try { hsUrl = new URL(url).origin; } catch (_) {}
          if (hsUrl) {
            window.postMessage({
              type: '__wingspan_creds__',
              accessToken: auth.slice(7),
              hsUrl,
            }, '*');
            credsCaptured = true;
          }
        }
      } catch (_) {}
    }

    // ── 2. Tap sync responses for presence events ───────────────────────────
    if (isSync) {
      return _fetch(input, init).then(response => {
        // Clone so Cinny still gets its own copy to read
        response.clone().json().then(body => {
          const events = body?.presence?.events;
          if (!Array.isArray(events) || events.length === 0) return;

          window.postMessage({
            type: '__wingspan_presence__',
            events: events.map(e => ({
              userId:          e.sender,
              presence:        e.content?.presence,
              currentlyActive: e.content?.currently_active ?? false,
              lastActiveAgo:   e.content?.last_active_ago ?? null,
              statusMsg:       e.content?.status_msg       ?? null,
            })),
          }, '*');
        }).catch(() => {});

        return response;
      });
    }

    return _fetch(input, init);
  };
})();
