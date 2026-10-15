/* Multipitch CH – app logic. No build step; plain browser JS. */
(() => {
'use strict';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// WGS84 -> Swiss LV95 (swisstopo approximate formulas, ~1 m)
function toLV95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return { E: Math.round(E), N: Math.round(N) };
}

// ---------- storage (IndexedDB) ----------
const DB = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('multipitch-ch', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('topos')) d.createObjectStore('topos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('spots')) d.createObjectStore('spots', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    all: s => run(s, 'readonly', st => st.getAll()),
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
  };
})();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- OSM data ----------
const OSM_QUERY = '[out:json][timeout:150];area["ISO3166-1"="CH"][admin_level=2]->.ch;(nwr["climbing"~"^(route|route_bottom|crag|area)$"](area.ch);nwr["climbing:multipitch"="yes"](area.ch););out center tags;';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const RIDGE = /(grat|kante|pfeiler|arête|arete|spigolo|cresta|direttissima|verschneidung|pilier|nordwand|südwand|ostwand|westwand)/i;
const DROP = /^(source|fixme|note|check_date|sport|outdoor|fee|access|opening_hours|wheelchair|leisure|highway|incline|safety_rope|natural|handrail|lit|smoothness|stroller|trail_visibility|surface|sac_scale)$/;
function isMultipitch(g) {
  if (g.indoor === 'yes' || g['climbing:indoor'] === 'yes') return false;
  return g['climbing:multipitch'] === 'yes' || +g['climbing:pitches'] >= 2 ||
    parseFloat(g['climbing:length']) >= 60 || parseFloat(g['climbing:length:max']) >= 60 ||
    (/^route/.test(g.climbing || '') && RIDGE.test(g.name || ''));
}
function compact(elements) {
  const out = [];
  for (const e of elements) {
    const g = e.tags || {};
    if (!isMultipitch(g)) continue;
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    const t = {};
    for (const [k, v] of Object.entries(g)) if (!DROP.test(k)) t[k] = v;
    out.push([e.type[0], e.id, +lat.toFixed(5), +lon.toFixed(5), t]);
  }
  return out;
}
let osm = ls.get('osmCache', null);
if (!osm || !Array.isArray(osm.els)) osm = window.SNAPSHOT;

async function refreshOSM(manual) {
  if (manual) toast('Loading OpenStreetMap data… this can take a minute', 60000);
  for (const url of ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(OSM_QUERY),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const j = await r.json();
      const els = compact(j.elements || []);
      if (els.length < 10) continue; // mirror without area index → try next
      osm = { date: new Date().toISOString().slice(0, 10), els };
      ls.set('osmCache', osm);
      rebuild();
      if (manual) toast(`Updated: ${els.length} multipitch entries from OSM`);
      return true;
    } catch (e) { /* next endpoint */ }
  }
  if (manual) toast('Could not reach OpenStreetMap right now. Try again later.');
  return false;
}

// ---------- user data ----------
let mySpots = [], topos = [];
async function loadUser() {
  try { [mySpots, topos] = await Promise.all([DB.all('spots'), DB.all('topos')]); }
  catch (e) { mySpots = []; topos = []; toast('Storage unavailable. Your topos cannot be saved in this browser mode.'); }
}

// ---------- build spots & groups ----------
const MERGE_M = 350;
let groups = [], groupById = new Map(), keyToGroup = new Map();

function buildItems() {
  const items = [];
  for (const [t, id, lat, lon, tags] of osm.els)
    items.push({ key: `osm:${t}${id}`, kind: 'osm', lat, lon, tags, name: tags.name || '', osmType: { n: 'node', w: 'way', r: 'relation' }[t], osmId: id });
  for (const c of window.CURATED)
    items.push({ key: 'cur:' + c.id, kind: 'cur', lat: c.lat, lon: c.lon, name: c.name, cur: c });
  for (const s of mySpots)
    items.push({ key: 'my:' + s.id, kind: 'my', lat: s.lat, lon: s.lon, name: s.name, my: s });
  const byKey = new Map(items.map(i => [i.key, i]));
  (window.TOPO_LINKS || []).forEach((l, n) => {
    const a = l.anchor && byKey.get(l.anchor);
    if (a) items.push({ key: 'lnk:' + n, kind: 'link', lat: a.lat, lon: a.lon, name: l.place || '', link: l });
    else if (l.lat != null) items.push({ key: 'lnk:' + n, kind: 'link', lat: l.lat, lon: l.lon, name: l.place || '', link: l });
  });
  const keys = new Set(items.map(i => i.key));
  for (const tp of topos) if (!keys.has(tp.spotKey) && tp.lat != null) {
    keys.add(tp.spotKey);
    items.push({ key: tp.spotKey, kind: 'orphan', lat: tp.lat, lon: tp.lon, name: tp.spotName || tp.route || 'Saved topo' });
  }
  return items;
}
function rank(i) {
  if (i.kind === 'osm' && /^(crag|area)$/.test(i.tags.climbing || '') && i.name) return 0;
  if (i.kind === 'cur') return 1;
  if (i.kind === 'my') return 2;
  if (i.kind === 'osm' && i.name && !/^route/.test(i.tags.climbing || '')) return 3;
  if (i.kind === 'link' && i.name) return 4;
  if (i.kind === 'osm' && i.name) return 5;
  if (i.kind === 'orphan') return 6;
  return 7;
}
function buildGroups() {
  const items = buildItems();
  const parent = items.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (haversine(items[i], items[j]) < MERGE_M) parent[find(i)] = find(j);
  const buckets = new Map();
  items.forEach((it, i) => { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(it); });
  groups = []; groupById = new Map(); keyToGroup = new Map();
  for (const its of buckets.values()) {
    its.sort((a, b) => rank(a) - rank(b));
    const head = its[0];
    const named = its.find(i => i.name);
    const g = {
      id: head.key, items: its, primaryKey: head.key,
      lat: its.reduce((s, i) => s + i.lat, 0) / its.length,
      lon: its.reduce((s, i) => s + i.lon, 0) / its.length,
      name: (named && named.name) || 'Unnamed multipitch spot',
    };
    // a curated summit should keep its own position (more meaningful than an average)
    const anchor = its.find(i => i.kind === 'cur' || i.kind === 'my');
    if (anchor && its.length === 1) { g.lat = anchor.lat; g.lon = anchor.lon; }
    groups.push(g); groupById.set(g.id, g);
    for (const it of its) keyToGroup.set(it.key, g);
  }
}
const INFO_KEYS = /^(climbing:grade|climbing:pitches|climbing:length|climbing:routes|description|url|website|climbing:url|wikimedia_commons|image)/;
function toposFor(g) { const ks = new Set(g.items.map(i => i.key)); return topos.filter(t => ks.has(t.spotKey)); }
function hasData(g) {
  if (toposFor(g).length) return true;
  if (g.items.some(i => i.kind === 'link')) return true;
  return g.items.some(i => i.kind === 'osm' && Object.keys(i.tags).some(k => INFO_KEYS.test(k)));
}
function isMine(g) { return g.items.every(i => i.kind === 'my' || i.kind === 'orphan'); }
function linksFor(g) { return g.items.filter(i => i.kind === 'link').map(i => i.link); }

// ---------- map ----------
const CH_BOUNDS = [[45.82, 5.96], [47.81, 10.49]];
const map = L.map('map', {
  zoomControl: false, minZoom: 7, maxZoom: 18, preferCanvas: true,
  maxBounds: [[45.2, 5.0], [48.4, 11.4]], maxBoundsViscosity: 0.7, tap: true
});
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
const savedView = ls.get('view', null);
if (savedView) map.setView([savedView.lat, savedView.lon], savedView.z); else map.fitBounds(CH_BOUNDS);
map.on('moveend', () => { const c = map.getCenter(); ls.set('view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); });

const attrib = '© <a href="https://www.swisstopo.admin.ch">swisstopo</a> · Climbing data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const layers = {
  map: L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', { maxNativeZoom: 18, maxZoom: 18, attribution: attrib }),
  aerial: L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', { maxNativeZoom: 19, maxZoom: 18, attribution: attrib })
};
let layerName = ls.get('layer', 'map');
if (!layers[layerName]) layerName = 'map';
layers[layerName].addTo(map);
$('#btnLayer').addEventListener('click', () => {
  map.removeLayer(layers[layerName]);
  layerName = layerName === 'map' ? 'aerial' : 'map';
  layers[layerName].addTo(map); ls.set('layer', layerName);
  toast(layerName === 'map' ? 'swisstopo map' : 'swisstopo aerial photo', 1400);
});

const renderer = L.canvas({ padding: 0.5, tolerance: 12 });
const markerLayer = L.layerGroup().addTo(map);
let selected = null; // group id
const RED = '#c8221a', BLUE = '#1f6fd1';
function styleFor(g, sel) {
  const mine = isMine(g), full = hasData(g);
  const r = sel ? 11 : 7.5;
  if (mine) return { radius: r, color: '#fff', weight: 2.5, fillColor: BLUE, fillOpacity: 1, renderer };
  return full
    ? { radius: r, color: '#fff', weight: 2.5, fillColor: RED, fillOpacity: 1, renderer }
    : { radius: r - 0.5, color: RED, weight: 3.5, fillColor: '#fff', fillOpacity: 1, renderer };
}
const markerById = new Map();
function drawMarkers() {
  markerLayer.clearLayers(); markerById.clear();
  for (const g of groups) {
    const m = L.circleMarker([g.lat, g.lon], styleFor(g, g.id === selected));
    m.on('click', e => { L.DomEvent.stopPropagation(e); openGroup(g.id); });
    m.addTo(markerLayer); markerById.set(g.id, m);
  }
}
function rebuild() {
  buildGroups(); drawMarkers();
  if ($('#topoForm') || $('#spotForm')) return; // don't wipe a form the user is filling in
  if (selected) { const g = groupById.get(selected) || findGroupByKeys(lastKeys); if (g) { selected = g.id; renderGroup(g); } else closeSheet(); }
}
let lastKeys = [];
function findGroupByKeys(keys) { for (const k of keys) { const g = keyToGroup.get(k); if (g) return g; } return null; }

// location
let meMarker = null;
$('#btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available on this device'); return; }
  toast('Finding your location…', 8000);
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
    else meMarker.setLatLng(ll);
    map.setView(ll, Math.max(map.getZoom(), 12)); $('#toast').hidden = true;
  }, () => toast('Location permission denied or unavailable'), { enableHighAccuracy: true, timeout: 15000 });
});

// ---------- formatting ----------
function gradeOf(g) {
  const sys = [['uiaa', 'UIAA '], ['french', ''], ['saxon', 'Sax '], ['yds_class', 'YDS ']];
  for (const [s, p] of sys) if (g['climbing:grade:' + s]) return p + g['climbing:grade:' + s];
  for (const [s, p] of sys) {
    const a = g[`climbing:grade:${s}:min`], b = g[`climbing:grade:${s}:max`];
    if (a || b) return p + (a && b ? `${a}–${b}` : (a || b));
  }
  return '';
}
function lengthOf(g) {
  const L0 = g['climbing:length'], a = g['climbing:length:min'], b = g['climbing:length:max'];
  if (a && b && a !== b) return `${a}–${b} m`;
  if (b && +b > +(L0 || 0)) return `up to ${b} m`;
  if (L0) return `${L0} m`;
  return '';
}
const ROCK = { limestone: 'Limestone', granite: 'Granite', gneiss: 'Gneiss', conglomerate: 'Conglomerate', sandstone: 'Sandstone' };
function factsHTML(g) {
  const f = [];
  const gr = gradeOf(g); if (gr) f.push(`<span class="chip grade"><b>${esc(gr)}</b></span>`);
  if (g['climbing:pitches']) f.push(`<span class="chip"><b>${esc(g['climbing:pitches'])}</b> pitches</span>`);
  const len = lengthOf(g); if (len) f.push(`<span class="chip">${esc(len)}</span>`);
  if (g['climbing:routes']) f.push(`<span class="chip">${esc(g['climbing:routes'])} routes</span>`);
  if (g['climbing:rock']) f.push(`<span class="chip">${esc(ROCK[g['climbing:rock'].toLowerCase()] || g['climbing:rock'])}</span>`);
  if (g['climbing:orientation']) f.push(`<span class="chip">Faces ${esc(g['climbing:orientation'].replace(/;/g, ', '))}</span>`);
  const style = [];
  if (g['climbing:sport'] && g['climbing:sport'] !== 'no') style.push('sport');
  if (g['climbing:trad'] === 'yes') style.push('trad');
  if (g['climbing:bolted'] === 'yes' || g['climbing:bolts'] === 'yes') style.push('bolted');
  if (style.length) f.push(`<span class="chip">${style.join(' · ')}</span>`);
  if (g.ele && +g.ele > 100) f.push(`<span class="chip">${esc(g.ele)} m a.s.l.</span>`);
  return f.length ? `<div class="chips">${f.join('')}</div>` : '';
}
const TYPE_LABEL = { route: 'Route', route_bottom: 'Route start', crag: 'Crag', area: 'Area' };
function commonsFiles(g) {
  return Object.entries(g).filter(([k]) => /^wikimedia_commons(:\d+)?$/.test(k)).map(([, v]) => v).flatMap(v => v.split(';')).map(s => s.trim()).filter(s => /^File:/i.test(s));
}
function linkBtn(href, label) { return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`; }
function hostLabel(u) { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h.includes('thecrag') ? 'theCrag' : h.includes('sac-cas') ? 'SAC Tourenportal' : h.includes('hikr') ? 'Hikr' : h; } catch { return 'Link'; } }

// ---------- sheet ----------
const sheet = $('#sheet');
function openSheet() { sheet.classList.remove('closed'); }
function closeSheet() {
  sheet.classList.add('closed');
  if (tmpMarker) { map.removeLayer(tmpMarker); tmpMarker = null; }
  const prev = selected; selected = null;
  const g = prev && groupById.get(prev); const m = prev && markerById.get(prev);
  if (g && m) m.setStyle(styleFor(g, false));
  revokeURLs();
}
$('#sClose').addEventListener('click', closeSheet);
map.on('click', e => { if (addMode) return pickSpot(e.latlng); if (!sheet.classList.contains('closed')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#viewer').hidden) closeViewer(); else closeSheet(); } });

let objectURLs = [];
function blobURL(p) { const u = URL.createObjectURL(new Blob([p.data], { type: p.type || 'image/jpeg' })); objectURLs.push(u); return u; }
function revokeURLs() { objectURLs.forEach(u => URL.revokeObjectURL(u)); objectURLs = []; }

function openGroup(id, fly) {
  const g = groupById.get(id); if (!g) return;
  if (selected && selected !== id) { const pg = groupById.get(selected), pm = markerById.get(selected); if (pg && pm) pm.setStyle(styleFor(pg, false)); }
  selected = id; lastKeys = g.items.map(i => i.key);
  const m = markerById.get(id); if (m) { m.setStyle(styleFor(g, true)); m.bringToFront(); }
  if (fly) map.flyTo([g.lat, g.lon], Math.max(map.getZoom(), 13), { duration: 0.8 });
  renderGroup(g); openSheet();
}

function renderGroup(g) {
  revokeURLs();
  const cur = g.items.find(i => i.kind === 'cur');
  const osmItems = g.items.filter(i => i.kind === 'osm');
  const my = g.items.find(i => i.kind === 'my');
  const tps = toposFor(g).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const subParts = [];
  if (cur) subParts.push(cur.cur.region);
  const ele = osmItems.map(i => i.tags.ele).find(e => e && +e > 100);
  if (ele) subParts.push(`${ele} m`);
  if (my && my.my.note) subParts.push('Your spot');
  else if (my) subParts.push('Your spot');
  subParts.push(`${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}`);
  $('#sTitle').textContent = g.name;
  $('#sSub').textContent = subParts.join(' · ');

  let mine = `<div class="sec"><h3>Your topos</h3>`;
  if (tps.length) mine += tps.map(t => topoCard(t)).join('');
  else mine += `<p class="note">${hasData(g) ? 'No topo of your own here yet.' : 'No route data from open sources yet. Add the first topo for this spot.'}</p>`;
  mine += `<div class="row" style="margin-top:10px"><button class="btn primary" data-act="add-topo">Add topo</button></div></div>`;
  // Topos posted online by huts, clubs and route setters (linked, not copied)
  const lks = linksFor(g);
  let online = '';
  if (lks.length) {
    const imgs = lks.filter(l => l.kind === 'image');
    const docs = lks.filter(l => l.kind !== 'image');
    const sources = [...new Set(lks.map(l => l.source))];
    online = `<div class="sec"><h3>Topos online</h3><div class="card">
      ${imgs.length ? `<div class="photos">${imgs.map(l => `<img loading="lazy" src="${esc(l.url)}" data-full="${esc(l.url)}" alt="${esc(l.title)}" title="${esc(l.title)}">`).join('')}</div>
        <span class="attr">${imgs.map(l => esc(l.title)).join(' · ')}</span>` : ''}
      ${docs.length ? `<ul class="doclist">${docs.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener"><span class="tag">${l.kind === 'pdf' ? 'PDF' : 'Web'}</span><span>${esc(l.title)}<small>${esc(l.source)}</small></span></a></li>`).join('')}</ul>` : ''}
      <span class="attr">From ${esc(sources.join(', '))}. Opens the original file${lks.some(l => l.approx) ? ' · marker position approximate' : ''}.</span>
    </div></div>`;
    const reg = lks.find(l => l.region);
    if (reg && !cur) { const s = $('#sSub'); s.textContent = reg.region + ' · ' + s.textContent; }
  }

  // own topos first; when there are none, show the open route data first
  let h = tps.length ? mine + online : online;
  if (!tps.length && (lks.length || !osmItems.length)) h += mine;

  // OSM info
  if (osmItems.length) {
    const sorted = osmItems.slice().sort((a, b) => rank(a) - rank(b));
    h += `<div class="sec"><h3>From OpenStreetMap</h3>`;
    for (const it of sorted) {
      const t = it.tags;
      const links = [];
      for (const k of ['url', 'website', 'climbing:url:thecrag']) if (t[k] && /^https?:/.test(t[k])) links.push(linkBtn(t[k], hostLabel(t[k])));
      if (t.image && /^https?:/.test(t.image) && !/\.(jpe?g|png|webp)$/i.test(t.image)) links.push(linkBtn(t.image, hostLabel(t.image)));
      if (t.wikidata) links.push(linkBtn('https://www.wikidata.org/wiki/' + t.wikidata, 'Wikidata'));
      links.push(linkBtn(`https://www.openstreetmap.org/${it.osmType}/${it.osmId}`, 'OSM'));
      const imgs = commonsFiles(t).map(f => {
        const name = f.replace(/^File:/i, '');
        return `<img loading="lazy" data-full="https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=2000" src="https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=400" alt="${esc(name)}">`;
      });
      if (t.image && /\.(jpe?g|png|webp)$/i.test(t.image)) imgs.push(`<img loading="lazy" data-full="${esc(t.image)}" src="${esc(t.image)}" alt="">`);
      h += `<div class="card">
        <h4>${esc(t.name || 'Unnamed')}<small>${esc(TYPE_LABEL[t.climbing] || 'Climbing spot')}</small></h4>
        ${factsHTML(t)}
        ${t.description ? `<p class="text">${esc(t.description)}</p>` : ''}
        ${imgs.length ? `<div class="photos">${imgs.join('')}</div><span class="attr">Photos: Wikimedia Commons (see file page for licence)</span>` : ''}
        <div class="links">${links.join('')}</div>
      </div>`;
    }
    h += `</div>`;
    if (!tps.length && !lks.length) h += mine;
  }

  if (cur) {
    const c = cur.cur;
    h += `<div class="sec"><h3>Area</h3><div class="card">
      <h4>${esc(c.name)}<small>${esc(c.region)}</small></h4>
      ${c.rock ? `<div class="chips"><span class="chip">${esc(ROCK[c.rock] || c.rock)}</span></div>` : ''}
      <p class="note">${lks.length ? 'Known multipitch area. Topos above are what huts and route setters post online; for the classics, look them up below' : "Known multipitch area. Open sources don't have route details here yet"}${c.approx ? '; marker position is approximate' : ''}. Save your own topo when you climb here.</p>
    </div></div>`;
  }
  if (my && my.my.note) h += `<div class="sec"><h3>Your note</h3><p class="text">${esc(my.my.note)}</p></div>`;

  // Look up elsewhere
  const qName = g.name.replace(/^Gastlosen – /, '');
  const ddg = s => 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  const lv = toLV95(g.lat, g.lon);
  h += `<div class="sec"><h3>Look up &amp; navigate</h3><div class="links">
    ${linkBtn(ddg(`site:thecrag.com ${qName}`), 'theCrag')}
    ${linkBtn(ddg(`site:hikr.org ${qName} klettern`), 'Hikr reports')}
    ${linkBtn(ddg(`${qName} Mehrseillängen Topo`), 'Web search')}
    ${linkBtn(`https://map.geo.admin.ch/?lang=de&E=${lv.E}&N=${lv.N}&zoom=10&crosshair=marker`, 'map.geo.admin')}
    ${linkBtn(`https://maps.apple.com/?daddr=${g.lat},${g.lon}&q=${encodeURIComponent(g.name)}`, 'Directions')}
  </div></div>`;

  if (my) h += `<div class="sec"><div class="row"><button class="btn small danger" data-act="del-spot" data-id="${esc(my.my.id)}">Delete this spot</button></div></div>`;

  const body = $('#sBody'); body.innerHTML = h; body.scrollTop = 0;
  body.querySelectorAll('[data-photos]').forEach(wrap => {
    const t = topos.find(x => x.id === wrap.dataset.photos); if (!t) return;
    wrap.innerHTML = (t.photos || []).map((p, i) => `<img src="${blobURL(p)}" data-idx="${i}" alt="Topo photo ${i + 1}">`).join('');
  });
}

function topoCard(t) {
  const chips = [];
  if (t.grade) chips.push(`<span class="chip grade"><b>${esc(t.grade)}</b></span>`);
  if (t.pitches) chips.push(`<span class="chip"><b>${esc(t.pitches)}</b> pitches</span>`);
  if (t.length) chips.push(`<span class="chip">${esc(t.length)} m</span>`);
  const kv = [['Gear', t.gear], ['Approach', t.approach], ['Descent', t.descent], ['Notes', t.notes]].filter(([, v]) => v);
  return `<div class="card">
    <h4>${esc(t.route || 'Topo')}</h4>
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
    ${t.photos && t.photos.length ? `<div class="photos" data-photos="${esc(t.id)}"></div>` : ''}
    ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${t.link ? `<div class="links">${linkBtn(t.link, hostLabel(t.link))}</div>` : ''}
    <div class="row"><button class="btn small" data-act="edit-topo" data-id="${esc(t.id)}">Edit</button><button class="btn small danger" data-act="del-topo" data-id="${esc(t.id)}">Delete</button></div>
  </div>`;
}

// sheet actions
$('#sBody').addEventListener('click', async e => {
  const img = e.target.closest('.photos img');
  if (img) { const imgs = [...img.parentElement.querySelectorAll('img')]; openViewer(imgs.map(i => i.dataset.full || i.src), imgs.indexOf(img)); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const g = groupById.get(selected);
  const act = b.dataset.act;
  if (act === 'add-topo' && g) renderForm(g, null);
  if (act === 'edit-topo' && g) renderForm(g, topos.find(t => t.id === b.dataset.id));
  if (act === 'del-topo' || act === 'del-spot') {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = act === 'del-topo' ? 'Delete' : 'Delete this spot'; } }, 3500); return; }
    if (act === 'del-topo') { await DB.del('topos', b.dataset.id); topos = topos.filter(t => t.id !== b.dataset.id); toast('Topo deleted'); }
    else {
      const id = b.dataset.id; const key = 'my:' + id;
      for (const t of topos.filter(t => t.spotKey === key)) await DB.del('topos', t.id);
      topos = topos.filter(t => t.spotKey !== key);
      await DB.del('spots', id); mySpots = mySpots.filter(s => s.id !== id);
      closeSheet(); toast('Spot deleted');
    }
    rebuild();
  }
});

// ---------- topo form ----------
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 2200, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return { type: 'image/jpeg', data: await blob.arrayBuffer() };
  } finally { URL.revokeObjectURL(url); }
}

function renderForm(g, t) {
  revokeURLs();
  const editing = !!t;
  t = t || { id: uid(), spotKey: g.primaryKey, route: '', grade: '', pitches: '', length: '', gear: '', approach: '', descent: '', notes: '', link: '', photos: [] };
  let photos = (t.photos || []).slice();
  const routeNames = [...new Set(g.items.filter(i => i.kind === 'osm' && i.name).map(i => i.name))];
  $('#sTitle').textContent = editing ? 'Edit topo' : 'Add topo';
  $('#sSub').textContent = g.name;
  const v = k => esc(t[k] ?? '');
  $('#sBody').innerHTML = `<form class="topo" id="topoForm" novalidate>
    <div class="field"><label for="f-route">Route name</label><input id="f-route" list="f-routes" value="${v('route')}" placeholder="e.g. Südgrat" required>
      <datalist id="f-routes">${routeNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
    <div class="grid3">
      <div class="field"><label for="f-grade">Grade</label><input id="f-grade" value="${v('grade')}" placeholder="6a / 5+"></div>
      <div class="field"><label for="f-pitches">Pitches</label><input id="f-pitches" inputmode="numeric" value="${v('pitches')}" placeholder="8"></div>
      <div class="field"><label for="f-length">Length (m)</label><input id="f-length" inputmode="numeric" value="${v('length')}" placeholder="300"></div>
    </div>
    <div class="field"><label>Topo photos</label><div class="thumbs" id="f-thumbs"></div>
      <input type="file" id="f-files" accept="image/*" multiple hidden></div>
    <div class="field"><label for="f-gear">Gear</label><input id="f-gear" value="${v('gear')}" placeholder="12 QD, cams 0.3–2, 2×50 m"></div>
    <div class="field"><label for="f-approach">Approach</label><textarea id="f-approach" placeholder="From the hut, 45 min">${v('approach')}</textarea></div>
    <div class="field"><label for="f-descent">Descent</label><textarea id="f-descent" placeholder="Abseil the route / walk off north">${v('descent')}</textarea></div>
    <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" placeholder="Best season, conditions, your ascent…">${v('notes')}</textarea></div>
    <div class="field"><label for="f-link">Link</label><input id="f-link" type="url" inputmode="url" value="${v('link')}" placeholder="https://"></div>
    <div class="row"><button class="btn primary" type="submit" id="f-save">Save topo</button><button class="btn" type="button" id="f-cancel">Cancel</button></div>
  </form>`;
  const thumbs = $('#f-thumbs'), files = $('#f-files');
  function drawThumbs() {
    thumbs.innerHTML = photos.map((p, i) => `<div class="thumb"><img src="${blobURL(p)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove photo">×</button></div>`).join('') +
      `<label class="pick" for="f-files" aria-label="Add photos">+</label>`;
  }
  drawThumbs();
  thumbs.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { photos.splice(+b.dataset.rm, 1); drawThumbs(); } });
  files.addEventListener('change', async () => {
    const list = [...files.files]; files.value = '';
    if (!list.length) return;
    toast('Adding photos…', 10000);
    for (const f of list) { try { photos.push(await compress(f)); } catch { toast('One photo could not be read'); } }
    $('#toast').hidden = true; drawThumbs();
  });
  $('#f-cancel').addEventListener('click', () => renderGroup(g));
  $('#topoForm').addEventListener('submit', async e => {
    e.preventDefault();
    const val = id => $(id).value.trim();
    const route = val('#f-route');
    if (!route && !photos.length) { toast('Add a route name or at least one photo'); $('#f-route').focus(); return; }
    let link = val('#f-link'); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    const rec = { ...t, route, grade: val('#f-grade'), pitches: val('#f-pitches'), length: val('#f-length'), gear: val('#f-gear'),
      approach: val('#f-approach'), descent: val('#f-descent'), notes: val('#f-notes'), link, photos,
      lat: g.lat, lon: g.lon, spotName: g.name, created: t.created || Date.now(), updated: Date.now() };
    $('#f-save').disabled = true;
    try {
      await DB.put('topos', rec);
      topos = topos.filter(x => x.id !== rec.id).concat(rec);
      toast(editing ? 'Topo updated' : 'Topo saved');
      rebuild(); const ng = keyToGroup.get(rec.spotKey); if (ng) openGroup(ng.id);
    } catch (err) {
      $('#f-save').disabled = false;
      toast('Could not save. Your phone may be out of storage.');
    }
  });
}

// ---------- add spot ----------
let addMode = false, tmpMarker = null;
function setAddMode(on) {
  addMode = on; $('#addBanner').hidden = !on; $('#btnAdd').classList.toggle('on', on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) closeSheet();
}
$('#btnAdd').addEventListener('click', () => setAddMode(!addMode));
$('#addCancel').addEventListener('click', () => setAddMode(false));
function pickSpot(ll) {
  setAddMode(false);
  tmpMarker = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 2.5, fillColor: BLUE, fillOpacity: 1, renderer }).addTo(map);
  $('#sTitle').textContent = 'New spot';
  $('#sSub').textContent = `${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`;
  $('#sBody').innerHTML = `<form class="topo" id="spotForm" novalidate>
    <div class="field"><label for="p-name">Name</label><input id="p-name" placeholder="e.g. Plattenwand Sustenpass" required></div>
    <div class="field"><label for="p-note">Note</label><textarea id="p-note" placeholder="Optional"></textarea></div>
    <div class="row"><button class="btn primary" type="submit">Save spot</button><button class="btn" type="button" id="p-cancel">Cancel</button></div>
  </form>`;
  openSheet(); setTimeout(() => $('#p-name').focus(), 250);
  const done = () => { if (tmpMarker) { map.removeLayer(tmpMarker); tmpMarker = null; } };
  $('#p-cancel').addEventListener('click', closeSheet);
  $('#spotForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#p-name').value.trim(); if (!name) { toast('Give the spot a name'); return; }
    const s = { id: uid(), name, note: $('#p-note').value.trim(), lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6), created: Date.now() };
    try { await DB.put('spots', s); } catch { toast('Could not save the spot'); return; }
    mySpots.push(s); done(); rebuild();
    const g = keyToGroup.get('my:' + s.id); if (g) { openGroup(g.id); renderForm(g, null); }
  });
}

// ---------- search ----------
const q = $('#q'), results = $('#results');
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
q.addEventListener('input', () => {
  const s = norm(q.value.trim());
  if (s.length < 2) { results.hidden = true; return; }
  const hits = [];
  for (const g of groups) {
    const names = g.items.map(i => i.name).concat(g.items.filter(i => i.kind === 'cur').map(i => i.cur.region)).concat(toposFor(g).map(t => t.route)).concat(linksFor(g).map(l => l.title)).concat(linksFor(g).map(l => l.region || ''));
    const m = names.find(n => norm(n).includes(s));
    if (m) hits.push({ g, m });
    if (hits.length >= 10) break;
  }
  results.innerHTML = hits.length
    ? hits.map(({ g, m }) => `<button data-g="${esc(g.id)}"><i class="dot ${isMine(g) ? 'mine' : hasData(g) ? 'full' : 'empty'}"></i><span>${esc(g.name)}${m !== g.name ? `<small>${esc(m)}</small>` : ''}</span></button>`).join('')
    : `<button disabled><span>No match. Tap + to add your own spot.</span></button>`;
  results.hidden = false;
});
results.addEventListener('click', e => {
  const b = e.target.closest('[data-g]'); if (!b) return;
  results.hidden = true; q.blur(); q.value = '';
  openGroup(b.dataset.g, true);
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) results.hidden = true; });

// ---------- menu ----------
$('#btnMenu').addEventListener('click', () => {
  if (!sheet.classList.contains('closed')) closeSheet();
  revokeURLs();
  const nOsm = groups.filter(g => g.items.some(i => i.kind === 'osm')).length;
  $('#sTitle').textContent = 'Multipitch CH';
  $('#sSub').textContent = `${groups.length} spots on the map`;
  $('#sBody').innerHTML = `
    <div class="sec"><h3>Your data</h3>
      <dl class="kv"><dt>Topos</dt><dd>${topos.length}</dd><dt>Own spots</dt><dd>${mySpots.length}</dd></dl>
      <p class="note" style="margin-top:8px">Saved on this phone only. Export a backup now and then (to iCloud Drive or Files) so you never lose them.</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-m="export">Export backup</button><button class="btn" data-m="import">Import backup</button></div>
    </div>
    <div class="sec"><h3>Route data</h3>
      <dl class="kv"><dt>OSM spots</dt><dd>${nOsm}</dd><dt>Curated areas</dt><dd>${window.CURATED.length}</dd><dt>Topos online</dt><dd>${(window.TOPO_LINKS || []).length} from huts &amp; route setters</dd><dt>OSM data from</dt><dd>${esc(osm.date || '–')}</dd></dl>
      <div class="row" style="margin-top:10px"><button class="btn" data-m="refresh">Update OSM data</button></div>
      <p class="note" style="margin-top:8px">Missing a route? Add it to OpenStreetMap (e.g. with openclimbing.org) and it will show up for every climber after the next update.</p>
    </div>
    <div class="sec"><h3>Sources &amp; licences</h3>
      <p class="note">Base map and aerial photos © swisstopo (free geodata). Climbing data © OpenStreetMap contributors, ODbL. Topo photos from Wikimedia Commons under their file licences. Curated area positions are OSM summit points. Topos posted by SAC huts (Bergsee, Salbit, Albigna, Gelmer, Sewen, Voralp), the Wiwannihütte, Bergsportschule Grischa, the SAC first-ascents list and LACRUX are linked, not copied, and stay with their authors. Descriptions from theCrag and guidebooks are linked too.</p>
    </div>`;
  openSheet();
});
$('#sBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  if (b.dataset.m === 'refresh') { b.disabled = true; await refreshOSM(true); b.disabled = false; }
  if (b.dataset.m === 'export') exportBackup();
  if (b.dataset.m === 'import') $('#importFile').click();
});

// ---------- backup ----------
function abToB64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToAb(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
async function exportBackup() {
  const data = { app: 'multipitch-ch', version: 1, exported: new Date().toISOString(), spots: mySpots,
    topos: topos.map(t => ({ ...t, photos: (t.photos || []).map(p => ({ type: p.type, b64: abToB64(p.data) })) })) };
  const name = `multipitch-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'multipitch-ch') throw new Error('not a backup');
    for (const s of d.spots || []) await DB.put('spots', s);
    for (const t of d.topos || []) await DB.put('topos', { ...t, photos: (t.photos || []).map(p => ({ type: p.type, data: b64ToAb(p.b64) })) });
    await loadUser(); rebuild(); closeSheet();
    toast(`Imported ${(d.topos || []).length} topos and ${(d.spots || []).length} spots`);
  } catch { toast('That file is not a Multipitch CH backup'); }
});

// ---------- photo viewer (pinch / pan / double-tap) ----------
const viewer = $('#viewer'), vImg = $('#vImg');
let vList = [], vIdx = 0, sc = 1, tx = 0, ty = 0;
const pts = new Map(); let startDist = 0, startSc = 1, lastTap = 0, swipeX = null;
function applyT() { vImg.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${sc})`; }
function showV(i) { vIdx = (i + vList.length) % vList.length; sc = 1; tx = ty = 0; vImg.src = vList[vIdx]; applyT(); $('#vCount').textContent = vList.length > 1 ? `${vIdx + 1} / ${vList.length} · swipe for next` : 'Pinch to zoom'; }
function openViewer(list, i) { vList = list; viewer.hidden = false; showV(i); }
function closeViewer() { viewer.hidden = true; vImg.src = ''; }
$('#vClose').addEventListener('click', closeViewer);
viewer.addEventListener('pointerdown', e => {
  if (e.target.closest('.close')) return;
  viewer.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) { const [a, b] = [...pts.values()]; startDist = Math.hypot(a.x - b.x, a.y - b.y); startSc = sc; swipeX = null; }
  else { swipeX = sc === 1 ? e.clientX : null; const now = Date.now(); if (now - lastTap < 300) { sc = sc > 1 ? 1 : 2.5; tx = ty = 0; applyT(); } lastTap = now; }
});
viewer.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) { const [a, b] = [...pts.values()]; sc = Math.min(6, Math.max(1, startSc * Math.hypot(a.x - b.x, a.y - b.y) / startDist)); if (sc === 1) { tx = ty = 0; } applyT(); }
  else if (sc > 1) { tx += e.clientX - prev.x; ty += e.clientY - prev.y; applyT(); }
});
const endP = e => {
  if (pts.size === 1 && swipeX != null && vList.length > 1) { const dx = e.clientX - swipeX; if (Math.abs(dx) > 60) showV(vIdx + (dx < 0 ? 1 : -1)); }
  pts.delete(e.pointerId); if (pts.size === 0) swipeX = null;
};
viewer.addEventListener('pointerup', endP); viewer.addEventListener('pointercancel', endP);

// ---------- start ----------
(async () => {
  await loadUser();
  buildGroups(); drawMarkers();
  // refresh OSM in the background when the cached copy is older than 30 days
  const age = (Date.now() - Date.parse(osm.date || '2000-01-01')) / 864e5;
  if (age > 30 && navigator.onLine !== false) refreshOSM(false);
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
