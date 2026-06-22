'use strict';

const DEFAULT_DOMAINS = [
  'app.cinny.in',
  'dev.cinny.in',
  'localhost',
  '127.0.0.1',
];

const DEFAULTS = {
  klipyKey:        '',
  pauseChatGifs:   true,
  renderLinkImages: true,
  linkPreviewMode:    'trusted',
  linkPreviewTrusted: [],
  showPresence:    true,
  userBanners:     true,
  roomNicknames:   true,
  spaceCategories: true,
  fadeNoise:       true,
  uiRedesign:      true,
  domains:         DEFAULT_DOMAINS.slice(),
};

function parseDomains(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  // ── Load saved settings ─────────────────────────────────────────────────
  chrome.storage.local.get(DEFAULTS, (s) => {
    $('klipyKey').value             = s.klipyKey || '';
    $('pauseChatGifs').checked      = s.pauseChatGifs;
    $('renderLinkImages').checked   = s.renderLinkImages;
    $('linkPreviewMode').value      = s.linkPreviewMode || 'trusted';
    $('linkPreviewTrusted').value   = (Array.isArray(s.linkPreviewTrusted) ? s.linkPreviewTrusted : []).join('\n');
    $('showPresence').checked       = s.showPresence;
    $('userBanners').checked        = s.userBanners;
    $('roomNicknames').checked      = s.roomNicknames;
    $('spaceCategories').checked    = s.spaceCategories;
    $('fadeNoise').checked          = s.fadeNoise;
    $('uiRedesign').checked         = s.uiRedesign;
    $('domains').value              = (Array.isArray(s.domains) ? s.domains : DEFAULT_DOMAINS).join('\n');
  });

  // ── Show / hide API key ──────────────────────────────────────────────────
  $('toggleKey').addEventListener('click', () => {
    const inp = $('klipyKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // ── Save ─────────────────────────────────────────────────────────────────
  $('save').addEventListener('click', () => {
    const settings = {
      klipyKey:        $('klipyKey').value.trim(),
      pauseChatGifs:   $('pauseChatGifs').checked,
      renderLinkImages: $('renderLinkImages').checked,
      linkPreviewMode:    $('linkPreviewMode').value,
      linkPreviewTrusted: parseDomains($('linkPreviewTrusted').value),
      showPresence:    $('showPresence').checked,
      userBanners:     $('userBanners').checked,
      roomNicknames:   $('roomNicknames').checked,
      spaceCategories: $('spaceCategories').checked,
      fadeNoise:       $('fadeNoise').checked,
      uiRedesign:      $('uiRedesign').checked,
      domains:         parseDomains($('domains').value),
    };

    chrome.storage.local.set(settings, () => {
      const el = $('status');
      el.textContent = 'Saved!';
      setTimeout(() => { el.textContent = ''; }, 2000);
    });
  });

  // ── Add this site ────────────────────────────────────────────────────────
  $('addThisSite').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs?.[0]?.url || '';
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}

      const status = $('status');
      if (!host) {
        status.textContent = 'No site detected';
        setTimeout(() => { status.textContent = ''; }, 2000);
        return;
      }

      const ta = $('domains');
      const existing = parseDomains(ta.value);
      if (existing.includes(host)) {
        status.textContent = `${host} already in list`;
        setTimeout(() => { status.textContent = ''; }, 2000);
        return;
      }

      existing.push(host);
      ta.value = existing.join('\n');
      status.textContent = `Added ${host} — click Save`;
      setTimeout(() => { status.textContent = ''; }, 3000);
    });
  });

  // Save on Enter inside the key field
  $('klipyKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save').click();
  });
});
