'use strict';

// Wingspan background worker — fetches link target pages and extracts Open
// Graph / Twitter / standard meta tags so the content script can render
// Discord-style link previews. Cross-origin HTML can't be fetched from a
// content script under MV3, so it's done here (host_permissions grant it).

const OG_CACHE = new Map();              // url -> { ts, og: object|null }
const OG_TTL   = 30 * 60 * 1000;         // 30 min
const MAX_BYTES = 96 * 1024;             // only the <head> is needed
const TIMEOUT_MS = 8000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'wingspan_og' || !msg.url) return;
  fetchOg(msg.url)
    .then((og) => sendResponse({ ok: true, og }))
    .catch(() => sendResponse({ ok: false, og: null }));
  return true; // async response
});

async function fetchOg(url) {
  const cached = OG_CACHE.get(url);
  if (cached && Date.now() - cached.ts < OG_TTL) return cached.og;

  let og = null;

  // Some sites (YouTube, Vimeo, …) serve a consent/bot wall to plain fetches, so
  // scraping their HTML yields no usable tags. Use their oEmbed endpoint instead.
  const oembed = oembedEndpoint(url);
  if (oembed) {
    try { og = await fetchOEmbed(oembed, url); } catch (_) { og = null; }
  }

  if (!og) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        credentials: 'omit',
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
      });
      clearTimeout(timer);

      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('text/html')) {
        const html = await readCapped(res);
        og = parseOg(html, res.url || url);
      }
    } catch (_) {
      og = null;
    }
  }

  OG_CACHE.set(url, { ts: Date.now(), og });
  return og;
}

// Returns a JSON oEmbed endpoint for providers that block plain scraping.
function oembedEndpoint(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const h = u.hostname.replace(/^www\./, '');
  const enc = encodeURIComponent(url);
  if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be' ||
      h.endsWith('.youtube.com')) {
    return `https://www.youtube.com/oembed?format=json&url=${enc}`;
  }
  if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) {
    return `https://vimeo.com/api/oembed.json?url=${enc}`;
  }
  return null;
}

async function fetchOEmbed(endpoint, originalUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || !j.title) return null;
    return {
      title: j.title,
      desc:  '',
      image: j.thumbnail_url || '',
      site:  j.provider_name || j.author_name || '',
      url:   originalUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Read only enough of the body to cover the <head> (meta tags live there).
async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return (await res.text()).slice(0, MAX_BYTES * 2);

  const decoder = new TextDecoder('utf-8');
  let out = '', bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BYTES || /<\/head>/i.test(out)) break;
  }
  try { reader.cancel(); } catch (_) {}
  return out;
}

function parseOg(html, baseUrl) {
  const metas = (prop) => [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
  ];
  const pick = (...res) => {
    for (const re of res) {
      const m = html.match(re);
      if (m && m[1] && m[1].trim()) return decodeEntities(m[1].trim());
    }
    return '';
  };

  const title = pick(...metas('og:title'), ...metas('twitter:title'),
                     /<title[^>]*>([^<]*)<\/title>/i);
  const desc  = pick(...metas('og:description'), ...metas('twitter:description'),
                     ...metas('description'));
  let image   = pick(...metas('og:image:secure_url'), ...metas('og:image'),
                     ...metas('og:image:url'), ...metas('twitter:image'),
                     ...metas('twitter:image:src'));
  const site  = pick(...metas('og:site_name'));

  if (image) { try { image = new URL(image, baseUrl).href; } catch (_) {} }
  if (!title && !image && !desc) return null;

  let host = '';
  try { host = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch (_) {}

  return { title, desc, image, site: site || host, url: baseUrl };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}
