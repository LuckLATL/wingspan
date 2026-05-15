// WINGSPAN v1.1.0 — Cinny Matrix client enhancement
// GIF picker (upload as attachment, masonry layout, favorites) + presence indicators

(function () {
  'use strict';

  const DEFAULT_DOMAINS = [
    'app.cinny.in',
    'dev.cinny.in',
    'localhost',
    '127.0.0.1',
  ];

  const CFG = {
    KLIPY_KEY:        '',
    KLIPY_BASE:       'https://api.klipy.com/api/v1',
    GIF_LIMIT:        20,
    PRESENCE_TTL:     60_000,
    DEBOUNCE_MS:      250,
    FAV_KEY:          'wingspan_gif_favs',
    PAUSE_CHAT_GIFS:  true,
    SHOW_PRESENCE:    true,
    USER_BANNERS:     true,
    ROOM_NICKNAMES:   true,
    SPACE_CATEGORIES: true,
    FADE_NOISE:       true,
    DOMAINS:          DEFAULT_DOMAINS.slice(),
  };

  // Host allowlist. Supports exact hostnames and `*.example.com` (matches the
  // bare apex and any subdomain). Patterns are compared lowercased.
  function hostMatches(hostname, patterns) {
    const h = (hostname || '').toLowerCase();
    if (!h) return false;
    for (const raw of patterns) {
      const p = String(raw || '').trim().toLowerCase();
      if (!p) continue;
      if (p === h) return true;
      if (p.startsWith('*.')) {
        const suffix = p.slice(1);          // '.example.com'
        if (h === suffix.slice(1)) return true;
        if (h.endsWith(suffix)) return true;
      }
    }
    return false;
  }

  function normalizeDomains(list) {
    if (!Array.isArray(list)) return DEFAULT_DOMAINS.slice();
    const out = [];
    for (const raw of list) {
      const s = String(raw || '').trim().toLowerCase();
      if (s && !out.includes(s)) out.push(s);
    }
    return out.length ? out : DEFAULT_DOMAINS.slice();
  }

  let bootedInner = false;

  const GIF_CATEGORIES = [
    { id: 'favorites', label: '♥ Favorites', query: null,        color: 'linear-gradient(135deg,#f43f5e,#be123c)'  },
    { id: 'trending',  label: 'Trending',    query: null,        color: 'linear-gradient(135deg,#f97316,#c2410c)'  },
    { id: 'reactions', label: 'Reactions',   query: 'reactions', color: 'linear-gradient(135deg,#a855f7,#6d28d9)'  },
    { id: 'feelings',  label: 'Feelings',    query: 'feelings',  color: 'linear-gradient(135deg,#ec4899,#be185d)'  },
    { id: 'animals',   label: 'Animals',     query: 'animals',   color: 'linear-gradient(135deg,#22c55e,#15803d)'  },
    { id: 'funny',     label: 'Funny',       query: 'funny',     color: 'linear-gradient(135deg,#eab308,#a16207)'  },
    { id: 'gaming',    label: 'Gaming',      query: 'gaming',    color: 'linear-gradient(135deg,#6366f1,#3730a3)'  },
    { id: 'anime',     label: 'Anime',       query: 'anime',     color: 'linear-gradient(135deg,#06b6d4,#0e7490)'  },
    { id: 'sports',    label: 'Sports',      query: 'sports',    color: 'linear-gradient(135deg,#3b82f6,#1d4ed8)'  },
    { id: 'food',      label: 'Food',        query: 'food',      color: 'linear-gradient(135deg,#fb923c,#9a3412)'  },
  ];

  // ─── State ────────────────────────────────────────────────────────────────

  let creds             = null;
  let presenceCache     = new Map();
  let gifPickerEl       = null;
  let gifPickerOpen     = false;
  let pickerMode        = 'trending';   // 'trending' | 'search' | 'favorites'
  let activeCategory    = 'trending';
  let presenceScheduled = false;
  let aliases           = { users: {}, rooms: {} };  // local nickname overrides

  let gifPage        = 1;
  let gifQuery       = '';
  let gifLoadingMore = false;
  let gifHasMore     = true;

  const categoryPreviewCache = new Map(); // survives picker open/close within the same page load

  // ─── Boot ─────────────────────────────────────────────────────────────────

  function boot() {
    // Load settings from storage first, then initialise
    chrome.storage.local.get({
      klipyKey:        CFG.KLIPY_KEY,
      pauseChatGifs:   CFG.PAUSE_CHAT_GIFS,
      showPresence:    CFG.SHOW_PRESENCE,
      userBanners:     CFG.USER_BANNERS,
      roomNicknames:   CFG.ROOM_NICKNAMES,
      spaceCategories: CFG.SPACE_CATEGORIES,
      fadeNoise:       CFG.FADE_NOISE,
      gifLimit:        CFG.GIF_LIMIT,
      domains:         CFG.DOMAINS,
      aliases:         { users: {}, rooms: {} },
    }, (s) => {
      if (s.klipyKey)       CFG.KLIPY_KEY       = s.klipyKey;
      CFG.PAUSE_CHAT_GIFS   = s.pauseChatGifs;
      CFG.SHOW_PRESENCE     = s.showPresence;
      CFG.USER_BANNERS      = s.userBanners;
      CFG.ROOM_NICKNAMES    = s.roomNicknames;
      CFG.SPACE_CATEGORIES  = s.spaceCategories;
      CFG.FADE_NOISE        = s.fadeNoise;
      CFG.GIF_LIMIT         = s.gifLimit;
      CFG.DOMAINS           = normalizeDomains(s.domains);
      aliases               = normalizeAliases(s.aliases);
      if (hostMatches(location.hostname, CFG.DOMAINS)) {
        bootedInner = true;
        bootInner();
      }
    });

    // Apply setting changes live (no page reload needed)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.klipyKey)      CFG.KLIPY_KEY      = changes.klipyKey.newValue;
      if (changes.gifLimit)      CFG.GIF_LIMIT       = changes.gifLimit.newValue;
      if (changes.pauseChatGifs) CFG.PAUSE_CHAT_GIFS = changes.pauseChatGifs.newValue;
      if (changes.showPresence) {
        CFG.SHOW_PRESENCE = changes.showPresence.newValue;
        if (!CFG.SHOW_PRESENCE) {
          // Remove all existing dots and reset markers so they re-inject if re-enabled
          document.querySelectorAll('[data-wingspan="dot"]').forEach(d => d.remove());
          document.querySelectorAll('[data-wingspan-presence]').forEach(el =>
            el.removeAttribute('data-wingspan-presence'));
          document.querySelectorAll('[data-wingspan-dm-presence]').forEach(el =>
            el.removeAttribute('data-wingspan-dm-presence'));
        } else {
          injectPresenceDots();
          injectDmListPresence();
        }
      }
      if (changes.userBanners) {
        CFG.USER_BANNERS = changes.userBanners.newValue;
        if (!CFG.USER_BANNERS) revertUserBanners();
        else                   { injectUserBanners(); injectProfileBanners(); }
      }
      if (changes.roomNicknames) {
        CFG.ROOM_NICKNAMES = changes.roomNicknames.newValue;
        if (!CFG.ROOM_NICKNAMES) revertAliases();
        else                     { aliasVersion++; applyAliases(); }
      }
      if (changes.spaceCategories) {
        CFG.SPACE_CATEGORIES = changes.spaceCategories.newValue;
        if (CFG.SPACE_CATEGORIES) applyRoomCategories();
        // Disabling stops new applies; full revert of moved rows needs a page reload.
      }
      if (changes.fadeNoise) {
        CFG.FADE_NOISE = changes.fadeNoise.newValue;
        if (!CFG.FADE_NOISE) {
          document.querySelectorAll('[data-wingspan-dim]').forEach(el =>
            el.removeAttribute('data-wingspan-dim'));
        } else {
          dimChatNoise();
        }
      }
      if (changes.aliases) {
        aliases = normalizeAliases(changes.aliases.newValue);
        aliasVersion++;
        if (CFG.ROOM_NICKNAMES) applyAliases();
      }
      if (changes.domains) {
        CFG.DOMAINS = normalizeDomains(changes.domains.newValue);
        const allowed = hostMatches(location.hostname, CFG.DOMAINS);
        if (allowed && !bootedInner) {
          bootedInner = true;
          bootInner();
        }
        // Removing the current host from the list doesn't unwind injected DOM —
        // page reload is needed to fully disable on this tab.
      }
    });
  }

  function bootInner() {
    // 1. Try localStorage immediately (works if already logged in on reload)
    creds = readCreds();
    maybeStartPresence();

    // 2. Listen for messages from interceptor.js (MAIN world)
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data?.type) return;

      // Credentials captured from first authenticated Matrix request
      if (e.data.type === '__wingspan_creds__' && e.data.accessToken && e.data.hsUrl) {
        creds = {
          hsUrl:       e.data.hsUrl,
          accessToken: e.data.accessToken,
          userId:      creds?.userId ?? null,
        };
        maybeStartPresence();
        injectPresenceDots(/* force= */ true);
        injectDmListPresence();
      }

      // Live presence events extracted from each /sync response
      if (e.data.type === '__wingspan_presence__' && Array.isArray(e.data.events)) {
        for (const ev of e.data.events) {
          if (!ev.userId) continue;

          // currently_active=true means the client is actively syncing right now
          let status = ev.presence ?? 'unknown';
          if (ev.currentlyActive) status = 'online';

          const statusMsg = ev.statusMsg ?? null;
          presenceCache.set(ev.userId, { status, statusMsg, ts: Date.now() });

          // Update any dot already in the DOM
          for (const dot of document.querySelectorAll(`[data-wingspan-user="${ev.userId}"]`)) {
            applyDot(dot, status);
          }

          // Update any status message label already in the DOM
          for (const el of document.querySelectorAll(`[data-wingspan-status-for="${ev.userId}"]`)) {
            el.textContent = statusMsg || '';
            el.parentElement?.classList.toggle('wingspan-has-status', !!statusMsg);
          }
        }
      }
    });

    // Coalesce mutations to one scan per animation frame instead of debouncing
    // by 250ms — that delay was visible as layout shift after every Cinny
    // re-render. All inject*() helpers below are idempotent (processed-markers,
    // signature checks), so running each frame is cheap.
    const mo = new MutationObserver(rafCoalesce(scan));
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function rafCoalesce(fn) {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn();
      });
    };
  }

  function maybeStartPresence() {
    if (!presenceScheduled && creds?.accessToken) {
      presenceScheduled = true;
      setInterval(refreshPresence, CFG.PRESENCE_TTL);
    }
  }

  function scan() {
    injectGifButton();
    if (CFG.SHOW_PRESENCE)    injectPresenceDots();
    if (CFG.SHOW_PRESENCE)    injectStatusMessages();
    if (CFG.SHOW_PRESENCE)    injectDmListPresence();
    if (CFG.PAUSE_CHAT_GIFS)  pauseChatGifs();
    injectImageViewerZoom();
    if (CFG.USER_BANNERS)     injectProfileBanners();
    if (CFG.ROOM_NICKNAMES)   injectAliasMenuButton();
    if (CFG.ROOM_NICKNAMES)   applyAliases();
    if (CFG.SPACE_CATEGORIES) applyRoomCategories();
    if (CFG.FADE_NOISE)       dimChatNoise();
    injectLobbyFilter();
    injectLobbyBanner();
    if (CFG.USER_BANNERS)     injectUserBanners();
  }

  // ─── User profile banners (member list + DM list) ───────────────────────
  // Discord-style: paint the user's profile banner (chat.commet.profile_banner
  // and friends — MSC4133 extended profile fields) behind each user row.
  const USER_BANNER_KEYS = [
    'chat.commet.profile_banner',
    'm.banner_uri',
    'com.commet.banner_url',
  ];
  const userBannerCache = new Map(); // userId -> blob URL | null | 'pending'

  function injectUserBanners() {
    if (!creds?.hsUrl || !creds?.accessToken) return;
    // Member-list rows: <button data-user-id="@…:server">. Skip any matches
    // inside a message item — chat timelines have author + avatar buttons
    // with the same attribute and we don't want banners there.
    for (const el of document.querySelectorAll('button[data-user-id]')) {
      if (el.closest('[data-message-item]')) continue;
      const uid = el.getAttribute('data-user-id');
      if (uid) applyUserBanner(el, uid);
    }
    // DM-list rows: the <a> is wrapped in a <div class="t4fedt8"> that owns
    // the hover/selected background and the row's rounded shape. Painting
    // the banner on the <a> leaves the wrapper visible on top of it; target
    // the wrapper instead.
    for (const a of document.querySelectorAll('a[href^="/direct/"]')) {
      const uid = a.querySelector('[data-wingspan-user]')?.getAttribute('data-wingspan-user');
      if (!uid) continue;
      const row = a.parentElement;
      if (row) applyUserBanner(row, uid);
    }
  }

  async function applyUserBanner(el, userId) {
    if (el.dataset.wingspanUserBannerFor === userId) return;

    // Wipe any prior banner first. Cinny re-uses DM-row wrappers when the
    // list reorders, so without clearing the styles the new occupant would
    // briefly (or permanently, if they have no banner) inherit the previous
    // user's painted banner. Marking the dataset before awaiting also lets
    // a concurrent scan tick see the in-progress user and bail.
    el.dataset.wingspanUserBannerFor = userId;
    el.removeAttribute('data-wingspan-user-banner');
    el.style.removeProperty('background-image');
    el.style.removeProperty('background-size');
    el.style.removeProperty('background-position');
    el.style.removeProperty('background-repeat');

    let url = userBannerCache.get(userId);
    if (url === 'pending') return;
    if (url === undefined) {
      userBannerCache.set(userId, 'pending');
      try { url = await fetchUserBannerBlob(userId); }
      catch (_) { url = null; }
      userBannerCache.set(userId, url);
    }

    // If the wrapper was reassigned to yet another user while we awaited,
    // don't paint a stale banner over the now-current user.
    if (el.dataset.wingspanUserBannerFor !== userId) return;

    if (url) {
      el.setAttribute('data-wingspan-user-banner', '1');
      el.style.setProperty('background-image',    `url("${url}")`, 'important');
      el.style.setProperty('background-size',     'cover',         'important');
      el.style.setProperty('background-position', 'center',        'important');
      el.style.setProperty('background-repeat',   'no-repeat',     'important');
    }
  }

  async function fetchUserBannerBlob(userId) {
    const profileUrl = `${creds.hsUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`;
    const res = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json();

    let mxc = null;
    for (const key of USER_BANNER_KEYS) {
      let val = json?.[key];
      if (typeof val !== 'string') continue;
      // Some servers wrap the value in literal quotes — Commet strips them.
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith('mxc://')) { mxc = val; break; }
    }
    if (!mxc) return null;

    const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const [, server, mediaId] = m;

    const thumbUrl = `${creds.hsUrl}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=480&height=96&method=scale&allow_redirect=true`;
    const blobRes = await fetch(thumbUrl, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!blobRes.ok) return null;
    return URL.createObjectURL(await blobRes.blob());
  }

  // Reads the everypizza-ecosystem space banner state event (used by Commet,
  // Sable, VirtualChat) from the current space and applies the resolved
  // image as a background on the lobby's top header bar. The thumbnail
  // endpoint is authenticated on newer Synapse, so we fetch the blob with
  // our access token and hand background-image a blob: URL.
  const SPACE_BANNER_EVENT = 'page.codeberg.everypizza.room.banner';
  const bannerCache = new Map(); // spaceId -> blob URL | null

  function injectLobbyBanner() {
    const header = document.querySelector('header._1xki9of2');
    if (!header) return;
    const spaceId = currentSpaceIdFromUrl();
    if (!spaceId || !creds?.hsUrl || !creds?.accessToken) return;
    // Avoid re-running once we've handled the current space.
    if (header.dataset.wingspanBannerSpace === spaceId) return;
    applyLobbyBanner(header, spaceId);
  }

  async function applyLobbyBanner(header, spaceId) {
    // Tag the header up front so concurrent scan ticks don't re-enter.
    header.dataset.wingspanBannerSpace = spaceId;

    let bannerUrl;
    if (bannerCache.has(spaceId)) {
      bannerUrl = bannerCache.get(spaceId);
    } else {
      try { bannerUrl = await fetchSpaceBannerBlob(spaceId); }
      catch (_) { bannerUrl = null; }
      bannerCache.set(spaceId, bannerUrl);
    }

    // The user may have navigated to a different space while we were
    // fetching. Bail without touching the header if so.
    if (header.dataset.wingspanBannerSpace !== spaceId) return;

    if (bannerUrl) {
      header.setAttribute('data-wingspan-banner', '1');
      header.style.setProperty('background-image',    `url("${bannerUrl}")`, 'important');
      header.style.setProperty('background-size',     'cover',               'important');
      header.style.setProperty('background-position', 'center',              'important');
      header.style.setProperty('position',            'relative',            'important');
      header.style.setProperty('isolation',           'isolate',             'important');
    } else {
      header.removeAttribute('data-wingspan-banner');
      header.style.removeProperty('background-image');
    }
  }

  async function fetchSpaceBannerBlob(spaceId) {
    const stateUrl = `${creds.hsUrl}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/${encodeURIComponent(SPACE_BANNER_EVENT)}/`;
    const stateRes = await fetch(stateUrl, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!stateRes.ok) return null;
    const state = await stateRes.json();
    const mxc = state?.url;
    if (typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null;

    const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const [, server, mediaId] = m;

    // Authenticated media endpoint (Synapse 1.78+). The pre-auth /_matrix/media/v3
    // path still works on older servers but redirects on newer ones, so the
    // authenticated route is the safe default.
    const thumbUrl = `${creds.hsUrl}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=1024&height=256&method=scale&allow_redirect=true`;
    const blobRes = await fetch(thumbUrl, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!blobRes.ok) return null;
    const blob = await blobRes.blob();
    return URL.createObjectURL(blob);
  }

  // ─── Lobby: search/filter input ────────────────────────────────────────────

  // Injects a search input into the lobby hero header. Typing narrows the
  // visible room cards in real time. Idempotent: skipped if already present.
  function injectLobbyFilter() {
    for (const hero of document.querySelectorAll('._1xki9ofa')) {
      if (hero.querySelector('[data-wingspan="lobby-filter"]')) continue;
      const input = document.createElement('input');
      input.setAttribute('data-wingspan', 'lobby-filter');
      input.className = 'wingspan-lobby-filter';
      input.type = 'text';
      input.placeholder = 'Search rooms…';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.addEventListener('input', () => filterLobbyRows(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; filterLobbyRows(''); input.blur(); }
      });
      hero.appendChild(input);
    }
  }

  function filterLobbyRows(query) {
    const q = (query || '').trim().toLowerCase();
    for (const row of document.querySelectorAll('._1xki9of8 .azdvag2')) {
      // First <p> inside a row is the room name.
      const name = (row.querySelector('p')?.textContent || '').toLowerCase();
      row.style.display = !q || name.includes(q) ? '' : 'none';
    }
  }

  // Tag deleted messages and Matrix room/state events with `data-wingspan-dim`
  // so a CSS rule can fade them out — they're noise when you're skimming.
  // Hovering brings them back to full opacity so you can still read them.
  const ROOM_EVENT_PATTERNS = [
    /state event\.?$/i,
    /(joined|left|rejoined) the room\.?$/i,
    /changed (their|the) (avatar|name|display name|topic)/i,
    /\b(invited|kicked|banned|unbanned|removed)\b/i,
  ];
  function dimChatNoise() {
    for (const msg of document.querySelectorAll('[data-message-item]')) {
      let kind = '';

      const italic = msg.querySelector('p > span > i');
      if (italic && /This message has been deleted/i.test(italic.textContent || '')) {
        kind = 'deleted';
      } else if (!msg.querySelector('button[data-user-id]')) {
        // Compact row — no clickable avatar — matched against the small set of
        // canonical event phrasings so plain user text can't false-positive.
        const p = msg.querySelector('p');
        const pText = (p?.textContent || '').replace(/\s+/g, ' ').trim();
        if (pText && ROOM_EVENT_PATTERNS.some(re => re.test(pText))) {
          kind = 'room-event';
        }
      }

      const current = msg.getAttribute('data-wingspan-dim') || '';
      if (current === kind) continue;
      if (kind) msg.setAttribute('data-wingspan-dim', kind);
      else      msg.removeAttribute('data-wingspan-dim');
    }
  }

  function revertUserBanners() {
    for (const el of document.querySelectorAll('[data-wingspan-user-banner]')) {
      el.removeAttribute('data-wingspan-user-banner');
      el.style.removeProperty('background-image');
      el.style.removeProperty('background-size');
      el.style.removeProperty('background-position');
      el.style.removeProperty('background-repeat');
      delete el.dataset.wingspanUserBannerFor;
    }
    for (const img of document.querySelectorAll('img[data-wingspan-banner]')) {
      img.removeAttribute('data-wingspan-banner');
    }
  }

  function revertAliases() {
    for (const node of document.querySelectorAll('[data-wingspan-orig-name]')) {
      const orig = node.getAttribute('data-wingspan-orig-name');
      if (node.textContent !== orig) node.textContent = orig;
      node.removeAttribute('data-wingspan-orig-name');
    }
    for (const el of document.querySelectorAll('[data-wingspan-alias-sig]')) {
      el.removeAttribute('data-wingspan-alias-sig');
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function readCreds() {
    try {
      let hsUrl = null, accessToken = null, userId = null;

      hsUrl       = localStorage.getItem('mx_hs_url');
      accessToken = localStorage.getItem('mx_access_token');
      userId      = localStorage.getItem('mx_user_id');

      if (!hsUrl || !accessToken) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (!k || !v) continue;
          let obj = null;
          try { obj = JSON.parse(v); } catch (_) {}
          const kl = k.toLowerCase();
          if (!hsUrl && (kl.includes('hs_url') || kl.includes('homeserver')))
            hsUrl = (obj && (obj.base_url || obj.hsUrl)) || v;
          if (!accessToken && (kl.includes('access_token') || kl.includes('accesstoken')))
            accessToken = v;
          if (!userId && (kl.includes('user_id') || kl.includes('userid'))) {
            const c = (obj && typeof obj === 'string' ? obj : null) || v;
            if (c && c.startsWith('@')) userId = c;
          }
          if (obj && typeof obj === 'object') {
            if (!hsUrl) hsUrl = obj.hsUrl || obj.hs_url || obj.base_url || null;
            if (!accessToken) accessToken = obj.accessToken || obj.access_token || null;
            if (!userId) {
              const c = obj.userId || obj.user_id || null;
              if (c && c.startsWith('@')) userId = c;
            }
          }
        }
      }

      if (hsUrl && hsUrl.endsWith('/')) hsUrl = hsUrl.slice(0, -1);
      return { hsUrl, accessToken, userId };
    } catch (_) {
      return { hsUrl: null, accessToken: null, userId: null };
    }
  }

  // ─── Favorites ────────────────────────────────────────────────────────────

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(CFG.FAV_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function saveFavs(favs) {
    localStorage.setItem(CFG.FAV_KEY, JSON.stringify(favs));
  }

  function isFav(url) {
    return loadFavs().some(f => f.url === url);
  }

  // Returns true if now favorited, false if removed
  function toggleFav(gifData) {
    const favs = loadFavs();
    const idx  = favs.findIndex(f => f.url === gifData.url);
    if (idx >= 0) {
      favs.splice(idx, 1);
      saveFavs(favs);
      return false;
    }
    favs.unshift({ ...gifData, savedAt: Date.now() });
    saveFavs(favs);
    return true;
  }

  // ─── GIF button injection ─────────────────────────────────────────────────

  function injectGifButton() {
    if (document.querySelector('[data-wingspan="gif-btn"]')) return;
    const toolbar = findComposerToolbar();
    if (!toolbar) return;

    const btn = document.createElement('button');
    btn.setAttribute('data-wingspan', 'gif-btn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', 'Insert GIF (Wingspan)');
    btn.className = 'wingspan-gif-btn';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
        <rect x="2" y="5" width="20" height="14" rx="3"
              stroke="currentColor" stroke-width="1.5" fill="none"/>
        <text x="12" y="15.5" font-family="sans-serif" font-weight="800"
              font-size="8" fill="currentColor" text-anchor="middle">GIF</text>
      </svg>`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleGifPicker(btn);
    });

    // Insert before the last button in the toolbar (which is the send button)
    const allBtns = toolbar.querySelectorAll('button');
    const sendBtn = allBtns[allBtns.length - 1];
    if (sendBtn) sendBtn.parentElement.insertBefore(btn, sendBtn);
    else toolbar.appendChild(btn);
  }

  function findComposerToolbar() {
    const input = document.querySelector('[data-editable-name="RoomInput"]');
    if (!input) return null;

    let el = input.parentElement;
    for (let depth = 0; depth < 12 && el; depth++) {
      const parent = el.parentElement;
      if (!parent) break;

      let best = null, bestCount = 0;
      for (const sib of parent.children) {
        if (sib === el) continue;
        const btns = sib.querySelectorAll('button');
        if (btns.length >= 1 && sib.querySelector('button svg') && btns.length > bestCount) {
          best = sib;
          bestCount = btns.length;
        }
      }
      if (best) return best;

      el = parent;
    }
    return null;
  }

  // ─── GIF picker ───────────────────────────────────────────────────────────

  function toggleGifPicker(anchor) {
    gifPickerOpen ? closeGifPicker() : openGifPicker(anchor);
  }

  function openGifPicker(anchor) {
    closeGifPicker();
    gifPickerEl = buildPickerEl();
    document.body.appendChild(gifPickerEl);
    positionPicker(anchor);
    gifPickerOpen = true;
    loadCategoryPreviews();
    gifPickerEl.querySelector('[data-wingspan="gif-search"]')?.focus();
    setTimeout(() => document.addEventListener('click', outsideClick), 80);
  }

  function loadCategoryPreviews() {
    GIF_CATEGORIES.forEach(async (cat) => {
      const card = () => gifPickerEl?.querySelector(`.wingspan-cat-card[data-category="${cat.id}"]`);

      // Favorites: always re-read local storage (no cache, changes between opens)
      if (cat.id === 'favorites') {
        const url = loadFavs()[0]?.thumbUrl || loadFavs()[0]?.url;
        if (url) card()?.style && (card().style.backgroundImage = `url("${url}")`);
        return;
      }

      if (categoryPreviewCache.has(cat.id)) {
        const url = categoryPreviewCache.get(cat.id);
        if (url) card()?.style && (card().style.backgroundImage = `url("${url}")`);
        return;
      }

      try {
        const endpoint = cat.id === 'trending'
          ? `${CFG.KLIPY_BASE}/${CFG.KLIPY_KEY}/gifs/trending?per_page=1`
          : `${CFG.KLIPY_BASE}/${CFG.KLIPY_KEY}/gifs/search?q=${encodeURIComponent(cat.query)}&per_page=1`;
        const items = klipyItems(await (await fetch(endpoint)).json());
        const url   = items[0]?.file?.sm?.gif?.url || items[0]?.file?.md?.gif?.url || items[0]?.file?.gif?.url || null;
        categoryPreviewCache.set(cat.id, url);
        if (url) card()?.style && (card().style.backgroundImage = `url("${url}")`);
      } catch (_) {
        categoryPreviewCache.set(cat.id, null);
      }
    });
  }

  function closeGifPicker() {
    gifPickerEl?.remove();
    gifPickerEl   = null;
    gifPickerOpen = false;
    document.removeEventListener('click', outsideClick);
  }

  function outsideClick(e) {
    if (
      gifPickerEl &&
      !gifPickerEl.contains(e.target) &&
      !e.target.closest('[data-wingspan="gif-btn"]')
    ) closeGifPicker();
  }

  function positionPicker(anchor) {
    if (!gifPickerEl) return;
    const r = anchor.getBoundingClientRect();
    const W = 500, H = 560;
    let top  = r.top - H - 10;
    let left = r.left - W + 32; // right-align to button
    if (top < 8)                          top  = r.bottom + 10;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    if (left < 8)                         left = 8;
    gifPickerEl.style.top  = `${top}px`;
    gifPickerEl.style.left = `${left}px`;
  }

  function buildPickerEl() {
    const el = document.createElement('div');
    el.setAttribute('data-wingspan', 'gif-picker');
    el.setAttribute('data-wingspan-view', 'categories');
    el.className = 'wingspan-gif-picker';
    const targetName = getCurrentRoomName();
    el.innerHTML = `
      <div class="wingspan-gif-header">
        <button class="wingspan-back-btn" data-wingspan="gif-back" type="button" title="Back">‹</button>
        <input class="wingspan-gif-search" type="text"
               placeholder="Search GIFs…" data-wingspan="gif-search" autocomplete="off"/>
        <button class="wingspan-gif-close" data-wingspan="gif-close" type="button">✕</button>
      </div>
      <div class="wingspan-gif-target" data-wingspan="gif-target">Sending to <b></b></div>
      <div class="wingspan-gif-categories" data-wingspan="gif-categories">
        ${GIF_CATEGORIES.map(c =>
          `<button class="wingspan-cat-card" data-category="${c.id}" type="button"
                   style="background-image:${c.color}">
             <span>${c.label}</span>
           </button>`
        ).join('')}
      </div>
      <div class="wingspan-gif-grid" data-wingspan="gif-grid"><div class="wingspan-gif-grid-inner" data-wingspan="gif-grid-inner"></div></div>
      <div class="wingspan-gif-footer">Powered by Klipy</div>`;

    const searchEl = el.querySelector('[data-wingspan="gif-search"]');
    const catsEl   = el.querySelector('[data-wingspan="gif-categories"]');
    const gridEl   = el.querySelector('[data-wingspan="gif-grid"]');
    const backBtn  = el.querySelector('[data-wingspan="gif-back"]');
    const targetEl = el.querySelector('[data-wingspan="gif-target"]');
    targetEl.querySelector('b').textContent = targetName || '…';
    if (targetName) targetEl.title = `Room ID: ${resolveRoomId() || ''}`;

    catsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.wingspan-cat-card');
      if (!btn) return;
      loadCategory(btn.dataset.category);
    });

    backBtn.addEventListener('click', () => {
      searchEl.value = '';
      showCategoryView();
    });

    searchEl.addEventListener('input', debounce((e) => {
      const q = e.target.value.trim();
      if (q) {
        pickerMode = 'search';
        showGifView();
        searchGifs(q);
      } else {
        showCategoryView();
      }
    }, 380));

    gridEl.addEventListener('scroll', () => {
      if (gifLoadingMore || !gifHasMore || pickerMode === 'favorites') return;
      if (gridEl.scrollHeight - gridEl.scrollTop - gridEl.clientHeight < 200) {
        gifPage++;
        if (pickerMode === 'trending')    loadTrending(gifPage);
        else if (pickerMode === 'search') searchGifs(gifQuery, gifPage);
      }
    });

    el.querySelector('[data-wingspan="gif-close"]').addEventListener('click', closeGifPicker);

    return el;
  }

  function showCategoryView() {
    if (!gifPickerEl) return;
    gifPickerEl.setAttribute('data-wingspan-view', 'categories');
  }

  function showGifView() {
    if (!gifPickerEl) return;
    gifPickerEl.setAttribute('data-wingspan-view', 'gifs');
  }

  function loadCategory(id) {
    const cat = GIF_CATEGORIES.find(c => c.id === id);
    activeCategory = id;
    showGifView();
    if (id === 'favorites') {
      pickerMode = 'favorites';
      showFavorites();
    } else if (id === 'trending') {
      pickerMode = 'trending';
      loadTrending();
    } else {
      pickerMode = 'search';
      searchGifs(cat?.query || id);
    }
  }

  function getGrid() {
    return gifPickerEl?.querySelector('[data-wingspan="gif-grid-inner"]') ?? null;
  }

  // ─── GIF data fetching ────────────────────────────────────────────────────

  function klipyItems(body) {
    // Response is { result, data: { data: [...] } } or { result, data: [...] }
    const d = body?.data;
    return Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
  }

  async function loadTrending(page = 1) {
    const grid = getGrid();
    if (!grid || gifLoadingMore) return;
    gifLoadingMore = true;
    if (page === 1) {
      gifPage = 1; gifHasMore = true;
      setGridStatus(grid, 'Loading…');
    } else {
      setGridLoader(grid, true);
    }
    try {
      const r = await fetch(
        `${CFG.KLIPY_BASE}/${CFG.KLIPY_KEY}/gifs/trending?per_page=${CFG.GIF_LIMIT}&page=${page}`
      );
      const items = klipyItems(await r.json());
      gifHasMore = items.length >= CFG.GIF_LIMIT;
      renderGifs(grid, items, page > 1);
    } catch (_) {
      if (page === 1) setGridStatus(grid, 'Could not load GIFs.');
    } finally {
      setGridLoader(grid, false);
      gifLoadingMore = false;
    }
  }

  async function searchGifs(q, page = 1) {
    const grid = getGrid();
    if (!grid || gifLoadingMore) return;
    gifLoadingMore = true;
    gifQuery = q;
    if (page === 1) {
      gifPage = 1; gifHasMore = true;
      setGridStatus(grid, 'Searching…');
    } else {
      setGridLoader(grid, true);
    }
    try {
      const r = await fetch(
        `${CFG.KLIPY_BASE}/${CFG.KLIPY_KEY}/gifs/search?q=${encodeURIComponent(q)}&per_page=${CFG.GIF_LIMIT}&page=${page}`
      );
      const items = klipyItems(await r.json());
      gifHasMore = items.length >= CFG.GIF_LIMIT;
      renderGifs(grid, items, page > 1);
    } catch (_) {
      if (page === 1) setGridStatus(grid, 'Search failed.');
    } finally {
      setGridLoader(grid, false);
      gifLoadingMore = false;
    }
  }

  function setGridLoader(grid, show) {
    const existing = grid.querySelector('[data-wingspan="gif-loader"]');
    if (show && !existing) {
      const el = document.createElement('div');
      el.className = 'wingspan-gif-loader';
      el.setAttribute('data-wingspan', 'gif-loader');
      grid.appendChild(el);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  function showFavorites() {
    const grid = getGrid();
    if (!grid) return;
    const favs = loadFavs();
    if (!favs.length) {
      setGridStatus(grid, 'No favorites yet.<br>Hover a GIF and click ♥ to save it.');
      return;
    }
    resetGrid(grid);
    for (const f of favs) appendGifItemToGrid(grid, createGifItem(f), null);
  }

  // ─── GIF rendering ────────────────────────────────────────────────────────

  // Builds a stable masonry: each column is a flex container we append into.
  // Existing items never move when a new page is loaded — the new items just
  // flow into whichever column is currently shortest.
  function ensureMasonry(grid) {
    if (grid._wingspanMasonryRow && grid._wingspanMasonryRow.isConnected) {
      return grid._wingspanMasonryState;
    }
    grid.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'wingspan-masonry';
    grid.appendChild(row);
    const columns = [];
    for (let i = 0; i < 3; i++) {
      const c = document.createElement('div');
      c.className = 'wingspan-masonry-col';
      row.appendChild(c);
      columns.push(c);
    }
    const state = { row, columns, heights: [0, 0, 0] };
    grid._wingspanMasonryRow = row;
    grid._wingspanMasonryState = state;
    return state;
  }

  function resetGrid(grid) {
    grid.innerHTML = '';
    grid._wingspanMasonryRow = null;
    grid._wingspanMasonryState = null;
  }

  function setGridStatus(grid, html) {
    resetGrid(grid);
    const status = document.createElement('div');
    status.className = 'wingspan-gif-status';
    status.innerHTML = html;
    grid.appendChild(status);
  }

  function appendGifItemToGrid(grid, item, estHeight) {
    const state = ensureMasonry(grid);
    let idx = 0;
    for (let i = 1; i < state.heights.length; i++) {
      if (state.heights[i] < state.heights[idx]) idx = i;
    }
    state.columns[idx].appendChild(item);
    state.heights[idx] += (estHeight || 150) + 6;
  }

  // Estimate rendered item height from intrinsic dimensions so column
  // selection stays balanced before images load.
  function estimateItemHeight(grid, gif) {
    const candidates = [
      gif.file?.sm?.gif, gif.file?.md?.gif,
      gif.file?.xs?.gif, gif.file?.hd?.gif, gif.file?.gif,
    ];
    let w = 0, h = 0;
    for (const c of candidates) {
      if (c?.width && c?.height) { w = c.width; h = c.height; break; }
    }
    if (!w || !h) return 150;
    const gap = 6, cols = 3;
    const innerWidth = grid.clientWidth || 484;
    const colWidth = (innerWidth - gap * (cols - 1)) / cols;
    return colWidth * (h / w);
  }

  function renderGifs(grid, results, append = false) {
    if (!append) resetGrid(grid);
    if (!results.length && !append) {
      setGridStatus(grid, 'No results.');
      return;
    }
    for (const gif of results) {
      const url      = gif.file?.hd?.gif?.url || gif.file?.gif?.url;
      if (!url) continue;
      const thumbUrl = gif.file?.sm?.gif?.url
                    || gif.file?.md?.gif?.url
                    || gif.file?.xs?.gif?.url
                    || url;
      const item = createGifItem({ url, thumbUrl, title: gif.title || '' });
      appendGifItemToGrid(grid, item, estimateItemHeight(grid, gif));
    }
  }

  function createGifItem({ url, thumbUrl, title }) {
    const favorited = isFav(url);

    const item = document.createElement('div');
    item.className = 'wingspan-gif-item';

    const img = document.createElement('img');
    img.src     = thumbUrl;
    img.alt     = title || 'GIF';
    img.loading = 'lazy';
    item.appendChild(img);

    // Favorite button
    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'wingspan-fav-btn';
    favBtn.setAttribute('data-fav', favorited ? 'true' : 'false');
    favBtn.title = favorited ? 'Remove from favorites' : 'Add to favorites';
    favBtn.textContent = '♥';

    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFav = toggleFav({ url, thumbUrl, title });
      favBtn.setAttribute('data-fav', nowFav ? 'true' : 'false');
      favBtn.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
      if (pickerMode === 'favorites' && !nowFav) {
        item.style.transition = 'opacity 0.2s';
        item.style.opacity = '0';
        setTimeout(() => item.remove(), 200);
      }
    });

    item.appendChild(favBtn);

    item.addEventListener('click', () => {
      insertGifAsAttachment(url, title);
      closeGifPicker();
    });

    return item;
  }

  // ─── GIF upload as attachment ─────────────────────────────────────────────

  // The URL is the single source of truth for which room the user is looking
  // at. We deliberately do NOT fall back to a "last seen room" cached from
  // intercepted API traffic, because Cinny issues background room-scoped calls
  // (state, message fetches, read receipts) for rooms that aren't on screen —
  // using that as a fallback caused GIFs to land in stale rooms.
  //
  // Cinny may use either hash routing (/#/home/!room) or HTML5 path routing
  // (/home/!room) depending on deployment, so we read whichever one carries
  // the path.
  //
  // Returns { roomId, sidebarEl } where sidebarEl is the matching sidebar <a>
  // when one was found (used to pull the visible room name straight from it).
  function resolveCurrentRoom() {
    // Pick whichever of pathname/hash actually has the route content.
    const path = window.location.pathname || '';
    const hash = window.location.hash || '';
    const route = (path && path !== '/') ? path : hash;

    // Primary: find the sidebar link whose href matches the current route.
    // That link IS what the user clicked to navigate here, so it's the most
    // reliable mapping from URL → on-screen room.
    if (route) {
      for (const a of document.querySelectorAll('a[href*="/!"]')) {
        const href = a.getAttribute('href') || '';
        if (!(href === route || href.endsWith(route))) continue;
        const m = href.match(/!([^/?#\s]+)/g);
        if (!m?.length) continue;
        try { return { roomId: decodeURIComponent(m[m.length - 1]), sidebarEl: a }; }
        catch (_) {}
      }
    }

    // Fallback: parse the route directly. The room is the last !-prefixed path
    // segment. Exception: a bare /!spaceId is a space view with no room
    // selected — that single ! segment is a space ID, not a room target.
    const segments = route.replace(/^[#/]+/, '').split('/').filter(Boolean);
    if (!segments.length) return { roomId: null, sidebarEl: null };

    const bangIdxs = [];
    segments.forEach((s, i) => { if (s.startsWith('!')) bangIdxs.push(i); });
    if (!bangIdxs.length) return { roomId: null, sidebarEl: null };
    if (bangIdxs.length === 1 && bangIdxs[0] === 0) return { roomId: null, sidebarEl: null };

    const last = segments[bangIdxs[bangIdxs.length - 1]];
    try { return { roomId: decodeURIComponent(last), sidebarEl: null }; }
    catch (_) { return { roomId: null, sidebarEl: null }; }
  }

  function resolveRoomId() {
    return resolveCurrentRoom().roomId;
  }

  // Best-effort label for the room a GIF is about to be sent to. Prefers the
  // text shown on the matching sidebar entry (alias-respecting, since aliases
  // are already swapped in-place there), then any explicit alias mapping, and
  // finally the raw room ID so the user always sees *something* to verify.
  function getCurrentRoomName() {
    const { roomId, sidebarEl } = resolveCurrentRoom();
    if (!roomId) return null;

    if (sidebarEl) {
      const txt = findNameNode(sidebarEl)?.textContent?.trim();
      if (txt) return txt;
    }
    if (aliases.rooms[roomId]) return aliases.rooms[roomId];
    return roomId;
  }

  function blobDimensions(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
      img.src = url;
    });
  }

  // Use the GIF title as-is for the filename — no extension appended.
  // Only filesystem-illegal characters (path separators, control chars, …)
  // are stripped so spaces, parens, dashes, etc. stay intact.
  function gifFilename(title) {
    if (!title) return 'animation';
    const safe = title.trim().replace(/[/\\:*?"<>|\x00-\x1f]/g, '').slice(0, 120);
    return safe || 'animation';
  }

  async function sendViaMatrix(blob, title) {
    if (!creds?.hsUrl || !creds?.accessToken) throw new Error('no creds');
    const roomId = resolveRoomId();
    if (!roomId) throw new Error('no room');

    const filename = gifFilename(title);
    // Per MSC2530, clients should NOT render `body` as a visible caption
    // when it equals `filename` — it's then treated purely as alt text /
    // tooltip. Cinny follows this, so matching them gives us the GIF title
    // as a hover tooltip without a duplicate text caption next to the image.
    const body     = filename;

    const [{ w, h }, up] = await Promise.all([
      blobDimensions(blob),
      fetch(`${creds.hsUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${creds.accessToken}`,
          'Content-Type': blob.type || 'image/gif',
        },
        body: blob,
      }),
    ]);
    if (!up.ok) throw new Error(`upload ${up.status}`);
    const { content_uri } = await up.json();

    const info = { mimetype: 'image/gif', size: blob.size };
    if (w && h) { info.w = w; info.h = h; }

    const txnId = `wingspan_${Date.now()}`;
    const send = await fetch(
      `${creds.hsUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method:  'PUT',
        headers: {
          Authorization:  `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msgtype: 'm.image',
          url:     content_uri,
          body,
          filename,
          info,
        }),
      }
    );
    if (!send.ok) throw new Error(`send ${send.status}`);
  }

  function showWingspanToast(msg, isError = false) {
    const t = document.createElement('div');
    t.setAttribute('data-wingspan', 'toast');
    t.textContent = msg;
    t.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:${isError ? '#b91c1c' : '#374151'}; color:#f3f4f6;
      padding:8px 14px; border-radius:8px; font-size:13px; z-index:999999;
      pointer-events:none; white-space:nowrap;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function insertGifAsAttachment(gifUrl, title) {
    const btn    = document.querySelector('[data-wingspan="gif-btn"]');
    const editor = document.querySelector('[data-editable-name="RoomInput"]');
    if (!editor) return;

    if (btn) btn.classList.add('wingspan-uploading');

    try {
      const res = await fetch(gifUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      // Primary: Matrix API upload — works on Chrome and Firefox
      if (creds?.hsUrl && creds?.accessToken && resolveRoomId()) {
        await sendViaMatrix(blob, title);
        return;
      }

      // Fallback: ClipboardEvent paste (Chrome only — Firefox ignores synthetic clipboardData)
      const file = new File([blob], gifFilename(title), { type: blob.type || 'image/gif' });
      const dt   = new DataTransfer();
      dt.items.add(file);
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles:       true,
        cancelable:    true,
      }));
    } catch (err) {
      console.error('[Wingspan] GIF attach error:', err);
      showWingspanToast(`GIF failed: ${err.message}`, true);
    } finally {
      if (btn) btn.classList.remove('wingspan-uploading');
    }
  }

  // ─── Chat GIF hover-to-play ───────────────────────────────────────────────

  // Finds GIF images in message content and pauses them until hovered.
  // Uses fetch (CORS bypassed by extension host_permissions) to grab the image
  // as a blob, extract the first frame via canvas, then swap src on hover.
  function pauseChatGifs() {
    const candidates = document.querySelectorAll(
      '[data-message-item] img:not([data-wingspan-gif])'
    );
    for (const img of candidates) {
      if (img.closest('[data-user-id]')) continue;   // skip avatars
      const src = img.src || '';
      if (!src.includes('/_matrix/')) continue;      // Matrix media only
      img.setAttribute('data-wingspan-gif', 'pending');
      processChatGif(img, src);
    }
  }

  async function processChatGif(img, src) {
    try {
      const res  = await fetch(src);
      const blob = await res.blob();

      if (!blob.type.includes('image/gif')) {
        img.setAttribute('data-wingspan-gif', 'skip');
        return;
      }

      // Blob URL → same-origin, safe to draw to canvas
      const animUrl  = URL.createObjectURL(blob);
      const frameUrl = await gifFirstFrame(animUrl);

      img.src = frameUrl;
      img.setAttribute('data-wingspan-gif', 'paused');

      img.addEventListener('mouseenter', () => { img.src = animUrl; });
      img.addEventListener('mouseleave', () => { img.src = frameUrl; });
    } catch (_) {
      img.setAttribute('data-wingspan-gif', 'error');
    }
  }

  function gifFirstFrame(blobUrl) {
    return new Promise((resolve, reject) => {
      const tmp = new Image();
      tmp.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = tmp.naturalWidth;
          canvas.height = tmp.naturalHeight;
          canvas.getContext('2d').drawImage(tmp, 0, 0);
          canvas.toBlob(b => {
            if (b) resolve(URL.createObjectURL(b));
            else   reject(new Error('toBlob failed'));
          }, 'image/png');
        } catch (e) { reject(e); }
      };
      tmp.onerror = reject;
      tmp.src = blobUrl;
    });
  }

  // ─── Presence dots ────────────────────────────────────────────────────────

  function injectPresenceDots(force = false) {
    const fresh = document.querySelectorAll('[data-user-id]:not([data-wingspan-presence])');
    for (const el of fresh) {
      const userId = el.getAttribute('data-user-id');
      if (!userId) continue;

      // Skip text-only username buttons (chat messages, etc.) — they have no avatar img.
      const img = el.querySelector('img');
      if (!img) continue;

      el.setAttribute('data-wingspan-presence', 'pending');

      // Anchor to the img's direct parent (the Avatar component wrapper),
      // not to el itself which may be a wide member-row container.
      const dotHost = img.parentElement ?? el;
      dotHost.style.position = 'relative';
      dotHost.style.overflow = 'visible';

      const dot = document.createElement('span');
      dot.className = 'wingspan-presence-dot wingspan-presence-unknown';
      dot.setAttribute('data-wingspan', 'dot');
      dot.setAttribute('data-wingspan-user', userId);
      dotHost.appendChild(dot);

      if (creds?.accessToken) fetchPresence(userId).then(({ status }) => applyDot(dot, status));
    }

    // Retry pending dots when creds just arrived
    if (force && creds?.accessToken) {
      for (const dot of document.querySelectorAll('[data-wingspan="dot"].wingspan-presence-unknown')) {
        const userId = dot.getAttribute('data-wingspan-user');
        if (userId) fetchPresence(userId).then(({ status }) => applyDot(dot, status));
      }
    }
  }

  function injectStatusMessages() {
    const fresh = document.querySelectorAll('[data-user-id]:not([data-wingspan-status-msg])');
    for (const el of fresh) {
      const userId = el.getAttribute('data-user-id');
      if (!userId) continue;

      const img = el.querySelector('img');
      if (!img) continue; // skip non-avatar elements (inline username mentions, etc.)

      // Find the name area: the first direct child that isn't the avatar wrapper and has text
      const avatarWrapper = img.parentElement;
      let nameArea = null;
      for (const child of el.children) {
        if (child === avatarWrapper) continue;
        if (child.textContent.trim()) { nameArea = child; break; }
      }
      if (!nameArea) continue;

      el.setAttribute('data-wingspan-status-msg', 'injected');

      const msgEl = document.createElement('span');
      msgEl.className = 'wingspan-user-status-msg';
      msgEl.setAttribute('data-wingspan-status-for', userId);
      nameArea.appendChild(msgEl);

      function applyStatusMsg(statusMsg) {
        if (!document.contains(msgEl)) return;
        msgEl.textContent = statusMsg || '';
        nameArea.classList.toggle('wingspan-has-status', !!statusMsg);
      }

      const cached = presenceCache.get(userId);
      if (cached?.statusMsg) {
        applyStatusMsg(cached.statusMsg);
      } else if (creds?.accessToken) {
        fetchPresence(userId).then(({ statusMsg }) => applyStatusMsg(statusMsg));
      }
    }
  }

  // ─── DM list presence ────────────────────────────────────────────────────
  // The Direct Messages sidebar lists rooms (not users), so the data-user-id
  // hook used elsewhere doesn't apply. We resolve roomId → other user via the
  // Matrix `m.direct` account-data event, then attach a dot to the avatar.

  let directMap   = null;            // Map<roomId, userId>
  let directMapTs = 0;
  let directMapInflight = null;
  const DIRECT_TTL = 5 * 60 * 1000;

  async function getDirectMap() {
    if (directMap && Date.now() - directMapTs < DIRECT_TTL) return directMap;
    if (directMapInflight) return directMapInflight;
    if (!creds?.hsUrl || !creds?.accessToken || !creds?.userId) return directMap;

    directMapInflight = (async () => {
      try {
        const res = await fetch(
          `${creds.hsUrl}/_matrix/client/v3/user/${encodeURIComponent(creds.userId)}/account_data/m.direct`,
          { headers: { Authorization: `Bearer ${creds.accessToken}` } }
        );
        if (!res.ok) return directMap;
        const body = await res.json();
        const map = new Map();
        for (const [user, rooms] of Object.entries(body || {})) {
          if (!Array.isArray(rooms)) continue;
          for (const r of rooms) map.set(r, user);
        }
        directMap   = map;
        directMapTs = Date.now();
        return map;
      } catch (_) {
        return directMap;
      } finally {
        directMapInflight = null;
      }
    })();
    return directMapInflight;
  }

  function injectDmListPresence() {
    const rows = document.querySelectorAll('a[href*="/direct/!"]');
    for (const a of rows) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/direct\/(![^/?#\s]+)/);
      if (!m) continue;
      let roomId;
      try { roomId = decodeURIComponent(m[1]); } catch (_) { continue; }

      // Virtualised list reuses <a> nodes — re-inject when href changes
      if (a.getAttribute('data-wingspan-dm-presence') === roomId) continue;

      const img = a.querySelector('img');
      if (!img) continue;
      const dotHost = img.parentElement;
      if (!dotHost) continue;

      // Drop any stale dot on this host (left over from a recycled row)
      dotHost.querySelectorAll('[data-wingspan="dot"][data-wingspan-dm="1"]').forEach(d => d.remove());
      a.setAttribute('data-wingspan-dm-presence', roomId);

      getDirectMap().then(map => {
        // Bail if the row has since been recycled to a different room
        if (a.getAttribute('data-wingspan-dm-presence') !== roomId) return;
        const userId = map?.get(roomId);
        if (!userId) return;

        dotHost.style.position = 'relative';
        dotHost.style.overflow = 'visible';

        const dot = document.createElement('span');
        dot.className = 'wingspan-presence-dot wingspan-presence-unknown';
        dot.setAttribute('data-wingspan', 'dot');
        dot.setAttribute('data-wingspan-dm', '1');
        dot.setAttribute('data-wingspan-user', userId);
        dotHost.appendChild(dot);

        const cached = presenceCache.get(userId);
        if (cached) applyDot(dot, cached.status);
        else if (creds?.accessToken) fetchPresence(userId).then(({ status }) => applyDot(dot, status));
      });
    }
  }

  async function fetchPresence(userId) {
    // Prefer sync-derived presence (live, set by interceptor.js)
    const cached = presenceCache.get(userId);
    if (cached && Date.now() - cached.ts < CFG.PRESENCE_TTL)
      return { status: cached.status, statusMsg: cached.statusMsg ?? null };

    if (!creds?.hsUrl || !creds?.accessToken) return { status: 'unknown', statusMsg: null };

    // Fallback: GET endpoint (stale on many servers — last resort only)
    try {
      const res = await fetch(
        `${creds.hsUrl}/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`,
        { headers: { Authorization: `Bearer ${creds.accessToken}` } }
      );
      if (!res.ok) return { status: 'unknown', statusMsg: null };
      const body = await res.json();
      let status = body.presence ?? 'unknown';
      if (body.currently_active) status = 'online';
      const statusMsg = body.status_msg ?? null;
      presenceCache.set(userId, { status, statusMsg, ts: Date.now() });
      return { status, statusMsg };
    } catch (_) { return { status: 'unknown', statusMsg: null }; }
  }

  // ─── Local nickname aliases ──────────────────────────────────────────────
  // Aliases live entirely in chrome.storage.local and never touch the server.
  // For DM rooms we alias the partner's user ID (so the nickname follows them
  // everywhere their MXID appears); for everything else we alias the room.

  function normalizeAliases(raw) {
    const out = { users: {}, rooms: {} };
    if (raw && typeof raw === 'object') {
      if (raw.users && typeof raw.users === 'object') Object.assign(out.users, raw.users);
      if (raw.rooms && typeof raw.rooms === 'object') Object.assign(out.rooms, raw.rooms);
    }
    return out;
  }

  function persistAliases() {
    chrome.storage.local.set({ aliases });
  }

  function setUserAlias(userId, name) {
    if (!name) delete aliases.users[userId];
    else aliases.users[userId] = name;
    aliasVersion++;
    persistAliases();
    applyAliases();
  }

  function setRoomAlias(roomId, name) {
    if (!name) delete aliases.rooms[roomId];
    else aliases.rooms[roomId] = name;
    aliasVersion++;
    persistAliases();
    applyAliases();
  }

  // Find the leaf text element that displays a room/user's name inside `el`.
  // Skips Wingspan-injected nodes and avatar wrappers (the `img alt` is a name
  // copy, not the visible label).
  function findNameNode(el) {
    for (const c of el.querySelectorAll('p, b, span')) {
      if (c.classList.contains('wingspan-presence-dot'))   continue;
      if (c.classList.contains('wingspan-user-status-msg')) continue;
      if (c.querySelector('img'))                        continue;
      if (c.children.length > 0)                         continue;
      const txt = c.textContent;
      if (!txt || !txt.trim())                            continue;
      return c;
    }
    return null;
  }

  function swapName(nameNode, alias) {
    if (!nameNode.hasAttribute('data-wingspan-orig-name')) {
      nameNode.setAttribute('data-wingspan-orig-name', nameNode.textContent);
    }
    const orig = nameNode.getAttribute('data-wingspan-orig-name');
    const target = alias || orig;
    if (nameNode.textContent !== target) nameNode.textContent = target;
  }

  // Bump on every alias change so the signature compare below invalidates
  // every node and re-applies. The actual value isn't meaningful; only that
  // it differs from what's stored on each element.
  let aliasVersion = 0;

  async function applyAliases() {
    // Users: any element tagged with the MXID. Per-element signature lets us
    // skip work on rows that already display the correct text — keeps this
    // cheap when the rAF-coalesced scan fires on every frame.
    for (const el of document.querySelectorAll('[data-user-id]')) {
      const userId = el.getAttribute('data-user-id');
      const expected = (aliases.users[userId] || '') + '@' + aliasVersion;
      if (el.getAttribute('data-wingspan-alias-sig') === expected) continue;
      const nameNode = findNameNode(el);
      if (nameNode) swapName(nameNode, aliases.users[userId]);
      el.setAttribute('data-wingspan-alias-sig', expected);
    }

    // Rooms: every sidebar link that points at a room. DM rows resolve to
    // their partner's user alias when no per-room alias is set.
    let map = null;
    try { map = await getDirectMap(); } catch (_) {}
    for (const a of document.querySelectorAll('a[href*="/!"]')) {
      const href = a.getAttribute('href') || '';
      // Space-room links are /!spaceId/!roomId — the room is the LAST !-segment.
      const all = [...href.matchAll(/!([^/?#\s]+)/g)];
      if (all.length === 0) continue;
      let roomId;
      try { roomId = '!' + decodeURIComponent(all[all.length - 1][1]); } catch (_) { continue; }

      let alias = aliases.rooms[roomId];
      if (!alias && map) {
        const userId = map.get(roomId);
        if (userId) alias = aliases.users[userId];
      }

      const expected = (alias || '') + '@' + aliasVersion;
      if (a.getAttribute('data-wingspan-alias-sig') === expected) continue;
      const nameNode = findNameNode(a);
      if (nameNode) swapName(nameNode, alias);
      a.setAttribute('data-wingspan-alias-sig', expected);
    }
  }

  // ─── Nickname menu button ────────────────────────────────────────────────
  // Cinny renders the row's three-dots menu into #portalContainer with
  // id="menu-{roomId}". When that menu opens, we clone one of its existing
  // buttons (so we inherit the hashed styling) and append a Set/Edit Nickname
  // entry that opens a prompt.

  const PENCIL_PATHS = `
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" fill="currentColor"/>
    <path d="M20.71 7.04a.996.996 0 000-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/>
  `;

  function injectAliasMenuButton() {
    const portal = document.getElementById('portalContainer');
    if (!portal) return;

    const menus = portal.querySelectorAll('[id^="menu-!"]:not([data-wingspan-alias-menu])');
    for (const menu of menus) {
      const roomId = menu.id.slice('menu-'.length);
      if (!roomId.startsWith('!')) continue;

      // Pick a non-disabled button as the styling template
      const sample = menu.querySelector('button:not([disabled])');
      if (!sample) continue;

      // Find a button-bearing div to drop the new item into. The first such
      // group is "Mark as Read / Notifications" — we put Nickname there so
      // it's near the top.
      let group = null;
      for (const div of menu.querySelectorAll('div')) {
        if ([...div.children].some(c => c.tagName === 'BUTTON')) { group = div; break; }
      }
      if (!group) continue;

      menu.setAttribute('data-wingspan-alias-menu', 'injected');

      const btn = sample.cloneNode(true);
      btn.removeAttribute('aria-pressed');
      btn.removeAttribute('disabled');
      btn.setAttribute('data-wingspan', 'alias-btn');

      const labelEl = btn.querySelector('span');
      const svgEl   = btn.querySelector('svg');
      if (svgEl) svgEl.innerHTML = PENCIL_PATHS;

      // Pick a label that reflects whether an alias already exists. We don't
      // know yet whether this is a DM (need m.direct), so resolve async.
      const setLabel = (text) => { if (labelEl) labelEl.textContent = text; };
      setLabel('Set Nickname');
      (async () => {
        const map = await getDirectMap().catch(() => null);
        const userId = map?.get(roomId);
        const current = userId ? aliases.users[userId] : aliases.rooms[roomId];
        setLabel(current ? 'Edit Nickname' : 'Set Nickname');
      })();

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const map = await getDirectMap().catch(() => null);
        const userId = map?.get(roomId);

        if (userId) {
          const current = aliases.users[userId] || '';
          const next = window.prompt('Set nickname for this user (leave empty to clear)', current);
          if (next !== null) setUserAlias(userId, next.trim() || null);
        } else {
          const current = aliases.rooms[roomId] || '';
          const next = window.prompt('Set nickname for this room (leave empty to clear)', current);
          if (next !== null) setRoomAlias(roomId, next.trim() || null);
        }
      });

      group.insertBefore(btn, group.firstChild);
    }
  }

  function applyDot(dot, status) {
    dot.className = 'wingspan-presence-dot';
    const map = {
      online:      ['wingspan-presence-online',  'Online'],
      unavailable: ['wingspan-presence-away',    'Away'],
      offline:     ['wingspan-presence-offline', 'Offline'],
    };
    const [cls, label] = map[status] ?? ['wingspan-presence-unknown', ''];
    dot.classList.add(cls);
    if (label) dot.title = label;
  }

  async function refreshPresence() {
    for (const dot of document.querySelectorAll('[data-wingspan="dot"]')) {
      const userId = dot.getAttribute('data-wingspan-user');
      if (!userId) continue;
      presenceCache.delete(userId);
      applyDot(dot, (await fetchPresence(userId)).status);
    }
  }

  // ─── Profile card banner ─────────────────────────────────────────────────
  // Cinny's UserHero renders the user's avatar blurred + scaled as the banner.
  // We detect the banner img via draggable="false" + userId alt text + inline
  // backgroundColor on the parent (set by colorMXID — the only reliable anchor
  // since vanilla-extract hashes class names in production).
  // We then fetch the profile and swap in the real banner if one is set,
  // removing the blur/scale overrides via inline styles.

  function injectProfileBanners() {
    const candidates = document.querySelectorAll(
      'img[draggable="false"][alt^="@"]:not([data-wingspan-banner])'
    );
    for (const img of candidates) {
      const container = img.parentElement;
      if (!container?.style?.backgroundColor) continue; // UserHeroCoverContainer has inline bg
      const userId = img.getAttribute('alt');
      if (!userId) continue;
      img.setAttribute('data-wingspan-banner', 'loading');
      applyProfileBanner(img, container, userId);
    }
  }

  async function applyProfileBanner(img, container, userId) {
    if (!creds?.hsUrl || !creds?.accessToken) return;
    try {
      const profileRes = await fetch(
        `${creds.hsUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${creds.accessToken}` } }
      );
      if (!profileRes.ok) return;
      const profile = await profileRes.json();

      const bannerMxc = profile['m.banner_uri']
                     || profile['chat.commet.profile_banner']
                     || profile['eu.cyrneko.msc4427.banner_uri'];
      if (!bannerMxc?.startsWith('mxc://')) {
        img.setAttribute('data-wingspan-banner', 'none');
        return;
      }

      const path = bannerMxc.slice(6); // strip "mxc://"

      // Newer Synapse (v1.105+) requires auth for media — fetch as blob and use object URL.
      // Try the authenticated v1 endpoint first, fall back to the legacy v3 endpoint.
      let blob = null;
      for (const url of [
        `${creds.hsUrl}/_matrix/client/v1/media/download/${path}`,
        `${creds.hsUrl}/_matrix/media/v3/download/${path}`,
      ]) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
        if (r.ok) { blob = await r.blob(); break; }
      }
      if (!blob || !document.contains(img)) return;

      const objectUrl = URL.createObjectURL(blob);
      img.src             = objectUrl;
      img.style.filter    = 'none';
      img.style.transform = 'none';
      img.style.objectFit = 'cover';
      img.style.width     = '100%';
      img.style.height    = '100%';
      container.style.filter = 'none';
      img.setAttribute('data-wingspan-banner', 'loaded');

      // Revoke the blob URL once the profile card is closed
      new MutationObserver(() => {
        if (!document.contains(img)) {
          URL.revokeObjectURL(objectUrl);
        }
      }).observe(document.body, { childList: true, subtree: false });
    } catch (_) {
      img.setAttribute('data-wingspan-banner', 'error');
    }
  }

  // ─── Image viewer scroll-to-zoom ─────────────────────────────────────────
  // vanilla-extract outputs pure hashes in production so class-based selectors
  // are unreliable. Instead we anchor on the stable aria-label attributes that
  // Cinny's JSX sets explicitly on the zoom buttons.

  function injectImageViewerZoom() {
    const zoomInBtn = document.querySelector('[aria-label="Zoom In"]:not([data-wingspan-zoom])');
    if (!zoomInBtn) return;
    zoomInBtn.dataset.wingspanZoom = 'true';
    attachViewerZoom(zoomInBtn);
  }

  function attachViewerZoom(zoomInBtn) {
    let lastFire = 0;

    function onWheel(e) {
      // Self-clean when viewer closes
      if (!document.contains(zoomInBtn)) {
        window.removeEventListener('wheel', onWheel, { capture: true });
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (now - lastFire < 35) return;
      lastFire = now;

      // Click 3× per event for a larger zoom step (Cinny's native step is 0.2×)
      const label = e.deltaY < 0 ? 'Zoom In' : 'Zoom Out';
      const btn = document.querySelector(`[aria-label="${label}"]`);
      btn?.click(); btn?.click(); btn?.click();
    }

    // Capture phase on window: bypasses overflow:hidden and any inner stopPropagation
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  }

  // ─── Room categories in spaces ────────────────────────────────────────────
  //
  // Lets the user group rooms within a space under named categories, drag
  // rooms between categories, reorder categories, and collapse them. All
  // state is clientside in localStorage keyed by space ID.

  const ROOM_CAT_KEY = 'wingspan_room_categories';

  // Per-space data shape:
  //   { categories: [{ id, name, collapsed }], roomToCategory: { roomId: catId } }
  // Categories' array order is their visual order.
  function loadAllCatData() {
    try { return JSON.parse(localStorage.getItem(ROOM_CAT_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function saveAllCatData(data) {
    try { localStorage.setItem(ROOM_CAT_KEY, JSON.stringify(data)); } catch (_) {}
  }
  function loadSpaceCatData(spaceId) {
    const all = loadAllCatData();
    const s = all[spaceId] || { categories: [], roomToCategory: {} };
    if (!Array.isArray(s.categories))    s.categories    = [];
    if (typeof s.roomToCategory !== 'object' || !s.roomToCategory) s.roomToCategory = {};
    return s;
  }
  function saveSpaceCatData(spaceId, data) {
    const all = loadAllCatData();
    all[spaceId] = data;
    saveAllCatData(all);
  }

  // Returns the current space identifier — either an opaque room ID (`!…`)
  // or a canonical alias (`#…:server`). Both routings exist in Cinny: ID-
  // routed spaces have hrefs like `/!Xxx.../!Yyy...`; alias-routed spaces
  // have hrefs like `/%23alias%3Aserver/%23room%3Aserver` (the `#` must be
  // URL-encoded since it would otherwise be the fragment delimiter).
  function currentSpaceIdFromUrl() {
    const path = window.location.pathname || '';
    const hash = window.location.hash     || '';
    let route;
    if (path && path !== '/') {
      route = path;
    } else if (hash) {
      route = hash.startsWith('#') ? hash.slice(1) : hash;
    } else {
      return null;
    }
    let decoded;
    try { decoded = decodeURIComponent(route); } catch (_) { decoded = route; }
    const segs = decoded.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!segs.length) return null;
    const first = segs[0];
    return (first.startsWith('!') || first.startsWith('#')) ? first : null;
  }

  // Find all sidebar room links belonging to the given space. Handles both
  // !-room-ID and #-alias forms in the same code path by decoding the href
  // and matching every identifier-prefixed segment.
  function getRoomLinksInSpace(spaceId) {
    const result = [];
    // Catch both raw `/!` (room IDs are URL-safe) and the encoded `/%23`
    // (alias prefix). `/%21` is a defensive include in case some Cinny
    // build percent-encodes `!` too.
    const anchors = document.querySelectorAll(
      'a[href*="/!"], a[href*="/%21"], a[href*="/%23"]'
    );
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      let decoded;
      try { decoded = decodeURIComponent(href); } catch (_) { continue; }
      const ids = decoded.match(/[!#][^/?#\s]+/g);
      if (!ids || ids.length < 2) continue;
      const parsedSpace = ids[0];
      const parsedRoom  = ids[ids.length - 1];
      if (parsedSpace !== spaceId || parsedRoom === spaceId) continue;
      result.push({ anchor: a, roomId: parsedRoom });
    }
    return result;
  }

  // Find the virtualized room-list container. Cinny tags each virtualized
  // row with a `data-index` attribute, so the container is the element whose
  // direct children have that attribute. Falls back to the deepest common
  // ancestor of the anchors when no virtualization markers are present.
  function findRoomListContainer(anchorObjs) {
    if (!anchorObjs.length) return null;
    let el = anchorObjs[0].anchor.parentElement;
    while (el) {
      for (const c of el.children) {
        if (c.hasAttribute('data-index')) return el;
      }
      el = el.parentElement;
    }
    return deepestCommonAncestor(anchorObjs.map(a => a.anchor));
  }

  function deepestCommonAncestor(els) {
    if (!els.length) return null;
    let anc = els[0].parentElement;
    while (anc) {
      let containsAll = true;
      for (let i = 1; i < els.length; i++) {
        if (!anc.contains(els[i])) { containsAll = false; break; }
      }
      if (containsAll) return anc;
      anc = anc.parentElement;
    }
    return null;
  }

  // For each anchor, the "row" is the highest ancestor that is still a direct
  // child of the shared container. That's the element we reorder / mark.
  function buildRows(anchors, container) {
    const rows = [];
    const seen = new Set();
    for (const { anchor, roomId } of anchors) {
      let row = anchor;
      while (row.parentElement && row.parentElement !== container) row = row.parentElement;
      if (row.parentElement !== container) continue;
      if (seen.has(row)) continue;
      seen.add(row);
      rows.push({ row, anchor, roomId });
    }
    return rows;
  }

  function randomCatId() {
    return 'cat-' + Math.random().toString(36).slice(2, 10);
  }

  let applyingCategories = false;
  let openInlineRenameCatId = null;       // suppress redraws while user edits the name

  function applyRoomCategories() {
    if (applyingCategories) return;
    const spaceId = currentSpaceIdFromUrl();
    if (!spaceId) return;

    const anchors = getRoomLinksInSpace(spaceId);
    if (!anchors.length) return;

    const container = findRoomListContainer(anchors);
    if (!container) return;

    const rows = buildRows(anchors, container);
    if (!rows.length) return;

    const data = loadSpaceCatData(spaceId);

    applyingCategories = true;
    try {
      layoutContainer(container, rows, data, spaceId);
    } finally {
      applyingCategories = false;
    }
  }

  function layoutContainer(container, rows, data, spaceId) {
    // Mark the container so a CSS rule with high specificity can back up the
    // inline position/height overrides below — belt-and-braces against any
    // Cinny class that fights us.
    container.setAttribute('data-wingspan-room-list', '1');

    // ── Build desired sequence of interesting elements ──
    const knownCatIds = new Set(data.categories.map(c => c.id));
    const isCategorized = (roomId) => knownCatIds.has(data.roomToCategory[roomId]);

    const uncategorized = rows.filter(r => !isCategorized(r.roomId));
    const desired = uncategorized.map(r => r.row);

    // Reset previous end-of-group markers
    for (const r of rows) r.row.removeAttribute('data-wingspan-end-margin');

    // Last uncategorized room: gives the gap between the loose rooms and the
    // first category. Only meaningful when there *is* a first category.
    if (uncategorized.length && data.categories.length) {
      uncategorized[uncategorized.length - 1].row.setAttribute('data-wingspan-end-margin', '1');
    }

    // Sweep up any stranded headers from previous runs whose DCA-detection
    // landed inside a row wrapper. We only want category headers as direct
    // children of the current container.
    for (const h of document.querySelectorAll('[data-wingspan-cat-id]')) {
      if (h.parentElement !== container) h.remove();
    }

    // Reuse existing headers when possible
    const existingHeaders = new Map();
    for (const h of container.querySelectorAll(':scope > [data-wingspan-cat-id]')) {
      existingHeaders.set(h.getAttribute('data-wingspan-cat-id'), h);
    }

    for (const cat of data.categories) {
      let header = existingHeaders.get(cat.id);
      if (header) {
        updateCategoryHeader(header, cat, spaceId);
      } else {
        header = createCategoryHeader(cat, spaceId);
        container.appendChild(header);
      }
      existingHeaders.delete(cat.id); // mark as still-in-use
      desired.push(header);
      const catRows = rows.filter(r => data.roomToCategory[r.roomId] === cat.id);
      if (catRows.length) {
        catRows[catRows.length - 1].row.setAttribute('data-wingspan-end-margin', '1');
      }
      for (const r of catRows) desired.push(r.row);
    }

    // Drop headers whose category was deleted
    for (const orphan of existingHeaders.values()) orphan.remove();

    // ── Neuter Cinny's virtualized absolute positioning ──
    // Cinny's virtualizer assigns each row `position: absolute; top: Npx`, so
    // flexbox `order` has no effect. We force every container child back into
    // normal flow with !important; Cinny's inline `top` then becomes a no-op
    // and `order` takes over. We override the container's inline `height` for
    // the same reason — Cinny pins it to the virtualizer's computed height.
    // We also re-assert `display: flex` because Cinny's reconciler will drop
    // it from the inline `style` attribute on subsequent renders, and that
    // silently breaks `order`.
    container.style.setProperty('display', 'flex', 'important');
    container.style.setProperty('flex-direction', 'column', 'important');
    container.style.setProperty('height', 'auto', 'important');
    const roomRowSet = new Set(rows.map(r => r.row));
    for (const child of container.children) {
      if (child.hasAttribute('data-wingspan-cat-id')) continue;
      child.style.setProperty('position', 'static', 'important');
      child.style.setProperty('top', 'auto', 'important');
      if (!roomRowSet.has(child) && child.style.order !== '0') child.style.order = '0';
    }

    // Position rows + headers via CSS order. Cinny never touches `order`, so
    // this survives the React reconciler. 1-based so unmanaged children
    // (e.g., the "Rooms" collapsible heading row with data-index="0") keep
    // their default order:0 and render above our managed block.
    for (let i = 0; i < desired.length; i++) {
      const want = String(i + 1);
      if (desired[i].style.order !== want) desired[i].style.order = want;
    }

    // ── Mark rows that should be hidden because their category is collapsed ──
    const collapsedCats = new Set(data.categories.filter(c => c.collapsed).map(c => c.id));
    for (const r of rows) {
      const catId = data.roomToCategory[r.roomId];
      if (catId && collapsedCats.has(catId)) r.row.setAttribute('data-wingspan-hidden-cat', '1');
      else                                   r.row.removeAttribute('data-wingspan-hidden-cat');
      r.row.setAttribute('data-wingspan-room', r.roomId);
      attachRowDrag(r.row, r.roomId, spaceId);
    }

    attachContainerDnd(container, spaceId);
    attachContainerContextMenu(container, spaceId);
    attachUncategorizeDropTarget(container, spaceId);
    injectAddCategoryButton(container, spaceId);
  }

  // Dropping a room onto Cinny's "Rooms" collapsible heading row removes it
  // from its category — a natural "move back to the top-level list" gesture.
  function attachUncategorizeDropTarget(container, spaceId) {
    const heading = container.querySelector(':scope > [data-index="0"]');
    if (!heading || heading._wingspanUncatHooked) return;
    heading._wingspanUncatHooked = true;

    heading.addEventListener('dragover', (e) => {
      if (document.body.getAttribute('data-wingspan-dragging-room') !== '1') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      heading.classList.add('wingspan-drop-hover');
    });
    heading.addEventListener('dragleave', () => heading.classList.remove('wingspan-drop-hover'));
    heading.addEventListener('drop', (e) => {
      heading.classList.remove('wingspan-drop-hover');
      const roomId = e.dataTransfer.getData('application/x-wingspan-room');
      if (!roomId) return;
      e.preventDefault();
      assignRoomToCategory(spaceId, roomId, null);
    });
  }

  // Walk upward from the room list container looking for the element whose
  // OWN direct text is "Rooms". We don't recurse into matched aggregates so we
  // land on the actual label, not a wrapping container that also reports the
  // text by aggregation.
  function findRoomsHeading(container) {
    function directText(el) {
      let s = '';
      for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
      return s.trim().toLowerCase();
    }
    let parent = container.parentElement;
    for (let depth = 0; depth < 6 && parent; depth++) {
      for (const el of parent.querySelectorAll('*')) {
        if (container.contains(el)) continue;
        if (directText(el) === 'rooms') return el;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function injectAddCategoryButton(container, spaceId) {
    const heading = findRoomsHeading(container);
    if (!heading) return;

    // Walk past button/anchor ancestors — putting a <button> inside another
    // <button> is invalid HTML and the browser silently drops the inner one.
    // For Cinny that means landing in the <header> element.
    let host = heading.parentElement;
    while (host && (host.tagName === 'BUTTON' || host.tagName === 'A')) {
      host = host.parentElement;
    }
    if (!host) return;

    // Sweep up any stranded buttons from an earlier bad injection
    for (const b of document.querySelectorAll('[data-wingspan="add-cat-btn"]')) {
      if (b.parentElement !== host) b.remove();
    }
    if (host.querySelector(':scope > [data-wingspan="add-cat-btn"]')) return;

    const btn = document.createElement('button');
    btn.setAttribute('data-wingspan', 'add-cat-btn');
    btn.className = 'wingspan-add-cat-btn';
    btn.type = 'button';
    btn.title = 'New category';
    btn.textContent = '+';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptAndCreate(spaceId);
    });
    host.appendChild(btn);
  }

  // ─── Category header element ────────────────────────────────────────────────

  function createCategoryHeader(cat, spaceId) {
    const el = document.createElement('div');
    el.setAttribute('data-wingspan-cat-id', cat.id);
    el.setAttribute('data-wingspan', 'cat-header');
    el.className = 'wingspan-cat-header';
    el.draggable = true;
    // Match Cinny's own "Rooms" collapsible chevron SVG so categories blend in.
    el.innerHTML = `
      <svg class="wingspan-cat-chevron" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 17.1421L19.0711 10.0711L18.0104 9.01041L12 15.0208L5.98959 9.01041L4.92893 10.0711L12 17.1421Z" fill="currentColor"></path>
      </svg>
      <span class="wingspan-cat-name"></span>
    `;
    updateCategoryHeader(el, cat, spaceId);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.wingspan-cat-name-input')) return;
      toggleCategoryCollapsed(spaceId, cat.id);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCatHeaderMenu(e.clientX, e.clientY, spaceId, cat.id);
    });

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('application/x-wingspan-cat', cat.id); } catch (_) {}
      document.body.setAttribute('data-wingspan-dragging-cat', '1');
    });
    el.addEventListener('dragend', () => {
      document.body.removeAttribute('data-wingspan-dragging-cat');
      el.classList.remove('wingspan-drop-hover');
    });

    el.addEventListener('dragover', (e) => {
      // Browsers hide custom MIME data in dataTransfer.types during dragover
      // as a security measure, so we rely on the body attribute set by our
      // dragstart handler instead. Without preventDefault here, the `drop`
      // event never fires.
      if (document.body.getAttribute('data-wingspan-dragging-room') !== '1' &&
          document.body.getAttribute('data-wingspan-dragging-cat')  !== '1') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('wingspan-drop-hover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wingspan-drop-hover'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wingspan-drop-hover');
      const roomId = e.dataTransfer.getData('application/x-wingspan-room');
      const draggedCat = e.dataTransfer.getData('application/x-wingspan-cat');
      if (roomId) {
        e.preventDefault();
        assignRoomToCategory(spaceId, roomId, cat.id);
      } else if (draggedCat && draggedCat !== cat.id) {
        e.preventDefault();
        // Drop above or below depending on mouse Y relative to header midpoint
        const rect = el.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        reorderCategory(spaceId, draggedCat, cat.id, before);
      }
    });

    return el;
  }

  function updateCategoryHeader(el, cat, spaceId) {
    el.setAttribute('data-collapsed', cat.collapsed ? 'true' : 'false');
    const nameEl = el.querySelector('.wingspan-cat-name');
    // Don't clobber an active inline rename
    if (nameEl && openInlineRenameCatId !== cat.id) {
      if (nameEl.textContent !== cat.name) nameEl.textContent = cat.name;
    }
  }

  // ─── State mutations ────────────────────────────────────────────────────────

  function createCategory(spaceId, name) {
    const data = loadSpaceCatData(spaceId);
    const cat = { id: randomCatId(), name: name || 'New category', collapsed: false };
    data.categories.push(cat);
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
    return cat;
  }

  function renameCategory(spaceId, catId, newName) {
    const data = loadSpaceCatData(spaceId);
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.name = newName.trim() || cat.name;
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
  }

  function deleteCategory(spaceId, catId) {
    const data = loadSpaceCatData(spaceId);
    data.categories = data.categories.filter(c => c.id !== catId);
    for (const rid of Object.keys(data.roomToCategory)) {
      if (data.roomToCategory[rid] === catId) delete data.roomToCategory[rid];
    }
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
  }

  function toggleCategoryCollapsed(spaceId, catId) {
    const data = loadSpaceCatData(spaceId);
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.collapsed = !cat.collapsed;
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
  }

  function assignRoomToCategory(spaceId, roomId, catId) {
    const data = loadSpaceCatData(spaceId);
    if (catId) data.roomToCategory[roomId] = catId;
    else       delete data.roomToCategory[roomId];
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
  }

  function reorderCategory(spaceId, draggedId, targetId, before) {
    const data = loadSpaceCatData(spaceId);
    const from = data.categories.findIndex(c => c.id === draggedId);
    if (from < 0) return;
    const [moved] = data.categories.splice(from, 1);
    let to = data.categories.findIndex(c => c.id === targetId);
    if (to < 0) { data.categories.push(moved); }
    else        { data.categories.splice(before ? to : to + 1, 0, moved); }
    saveSpaceCatData(spaceId, data);
    applyRoomCategories();
  }

  // ─── Drag wiring on room rows ───────────────────────────────────────────────

  function attachRowDrag(row, roomId, spaceId) {
    // The row is a Cinny <div> wrapper — divs aren't draggable by default.
    // The inner <a> is, so we attach there. Cinny may replace the anchor on
    // re-render, so we flag the *anchor* itself (not the row wrapper) to
    // avoid the situation where the flag persists but the listener is gone.
    const draggable = row.matches?.('a[href]') ? row : row.querySelector('a[href]');
    const target = draggable || row;
    if (target._wingspanRowDragHooked) return;
    target._wingspanRowDragHooked = true;
    if (!draggable) target.draggable = true;

    target.addEventListener('dragstart', (e) => {
      try { e.dataTransfer.setData('application/x-wingspan-room', roomId); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
      document.body.setAttribute('data-wingspan-dragging-room', '1');
    });
    target.addEventListener('dragend', () => {
      document.body.removeAttribute('data-wingspan-dragging-room');
    });
  }

  // ─── Container-level drag (drop on empty area = uncategorize) ───────────────

  function attachContainerDnd(container, spaceId) {
    if (container._wingspanDndHooked) return;
    container._wingspanDndHooked = true;

    container.addEventListener('dragover', (e) => {
      if (document.body.getAttribute('data-wingspan-dragging-room') !== '1') return;
      // Only act when dragging over the container's own padding, not a row
      // or category header that already handles the drop itself.
      if (e.target !== container) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    container.addEventListener('drop', (e) => {
      if (e.target !== container) return;
      const roomId = e.dataTransfer.getData('application/x-wingspan-room');
      if (!roomId) return;
      e.preventDefault();
      assignRoomToCategory(spaceId, roomId, null);
    });
  }

  // ─── Right-click context menus ──────────────────────────────────────────────

  let activeCatMenu = null;
  function closeCatMenu() {
    if (activeCatMenu) { activeCatMenu.remove(); activeCatMenu = null; }
  }
  function openCatMenu(x, y, items) {
    closeCatMenu();
    const menu = document.createElement('div');
    menu.className = 'wingspan-cat-menu';
    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'wingspan-cat-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it.label;
      if (it.danger) btn.classList.add('wingspan-danger');
      btn.addEventListener('click', () => { closeCatMenu(); it.onClick(); });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth  - rect.width  - 4);
    const py = Math.min(y, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(4, px)}px`;
    menu.style.top  = `${Math.max(4, py)}px`;
    activeCatMenu = menu;
    setTimeout(() => {
      document.addEventListener('click',       closeCatMenu, { once: true });
      document.addEventListener('contextmenu', closeCatMenu, { once: true });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCatMenu(); }, { once: true });
    }, 0);
  }

  function openCatHeaderMenu(x, y, spaceId, catId) {
    openCatMenu(x, y, [
      { label: 'Rename',       onClick: () => startInlineRename(spaceId, catId) },
      { label: 'New category', onClick: () => promptAndCreate(spaceId) },
      { separator: true },
      { label: 'Delete',       danger: true, onClick: () => deleteCategory(spaceId, catId) },
    ]);
  }

  // Listen at document level in capture phase. A bubble-phase listener on the
  // container is unreliable because Cinny child handlers can stopPropagation
  // before the event reaches us.
  let docContextMenuHooked = false;
  function attachContainerContextMenu(container, spaceId) {
    if (docContextMenuHooked) return;
    docContextMenuHooked = true;
    document.addEventListener('contextmenu', (e) => {
      const sid = currentSpaceIdFromUrl();
      if (!sid) return;

      // Resolve the current room-list container fresh each time — the user
      // may have navigated between spaces since hook-up.
      const anchors = getRoomLinksInSpace(sid);
      if (!anchors.length) return;
      const c = findRoomListContainer(anchors);
      if (!c || !c.contains(e.target)) return;

      // Defer to category headers (their own listener handles rename/delete)
      // and pass through on room links (let Cinny's native menu show).
      if (e.target.closest('a[href]'))             return;
      if (e.target.closest('[data-wingspan-cat-id]')) return;

      e.preventDefault();
      e.stopPropagation();
      openCatMenu(e.clientX, e.clientY, [
        { label: 'New category', onClick: () => promptAndCreate(sid) },
      ]);
    }, true);
  }

  function promptAndCreate(spaceId) {
    // Create immediately, then drop the user into inline rename so they don't
    // have to deal with a window.prompt dialog.
    const cat = createCategory(spaceId, 'New category');
    // After render, find header and start inline rename
    requestAnimationFrame(() => startInlineRename(spaceId, cat.id, true));
  }

  function startInlineRename(spaceId, catId, selectAll = true) {
    const header = document.querySelector(`[data-wingspan-cat-id="${catId}"]`);
    if (!header) return;
    const nameEl = header.querySelector('.wingspan-cat-name');
    if (!nameEl || header.querySelector('.wingspan-cat-name-input')) return;

    const data = loadSpaceCatData(spaceId);
    const cat = data.categories.find(c => c.id === catId);
    if (!cat) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = cat.name;
    input.className = 'wingspan-cat-name-input';
    nameEl.replaceWith(input);
    openInlineRenameCatId = catId;

    const finish = (commit) => {
      openInlineRenameCatId = null;
      const newName = input.value;
      const span = document.createElement('span');
      span.className = 'wingspan-cat-name';
      span.textContent = commit ? (newName.trim() || cat.name) : cat.name;
      input.replaceWith(span);
      if (commit) renameCategory(spaceId, catId, newName);
    };

    input.addEventListener('blur',     ()  => finish(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); finish(true);  input.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); input.blur(); }
    });
    // Stop click-toggle-collapse from firing while the input is focused
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.focus();
    if (selectAll) input.select();
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
