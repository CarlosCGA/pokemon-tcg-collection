/* Mis Cartas Pokémon - v2 (backend Supabase)
   Datos: TCGdex (gratis). Reconocimiento: proxy en Supabase Edge Function
   (la clave de TCGAPIs ya no va en el cliente). Colección: backend con sesión,
   localStorage para invitados (migra al backend en el primer login). */
'use strict';

/* TCGdex sirve /v2/{lang}: en es fr de it pt ja ko zh-tw. Ids de set compartidos
   entre idiomas occidentales; los asiáticos (SV2a, M4...) son sets propios.
   Orden de preferencia: español primero (colección de Carlos), luego inglés y japonés. */
const TCGDEX_LANGS = ['es', 'en', 'ja', 'fr', 'de', 'it', 'pt', 'ko', 'zh-tw'];
const tcgBase = (lang) => 'https://api.tcgdex.net/v2/' + (lang || 'en');
const TCGDEX = tcgBase('en');
/* setId (minúsculas) -> idiomas en que TCGdex sirve ese set (derivado de aliases.js) */
let SET_ID_LANGS = null;
function langsForSet(setId) {
  if (!SET_ID_LANGS) {
    SET_ID_LANGS = {};
    if (typeof SET_ALIASES !== 'undefined') {
      for (const code of Object.keys(SET_ALIASES)) for (const e of SET_ALIASES[code]) {
        const k = e.s.toLowerCase();
        (SET_ID_LANGS[k] = SET_ID_LANGS[k] || new Set());
        e.langs.forEach(l => SET_ID_LANGS[k].add(l));
      }
    }
  }
  const s = SET_ID_LANGS[String(setId || '').toLowerCase()];
  const langs = s ? TCGDEX_LANGS.filter(l => s.has(l)) : TCGDEX_LANGS.slice();
  return langs.length ? langs : TCGDEX_LANGS.slice();
}
const SB_URL = 'https://mazlbhjdmrwwttinuwjk.supabase.co';
const SB_PUB = 'sb_publishable_pyYlHA1s2smF1cCWBWghiw_4z86g5gi';
const RECOG_FN = SB_URL + '/functions/v1/recognize';

const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(SB_URL, SB_PUB);

/* ---------- Utilidades ---------- */
const eur = (n) => n == null ? '—' : n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d && d.status && d.status >= 400) throw new Error('API error');
  return d;
}

/* ---------- Estado local (invitados y cachés) ---------- */
const store = {
  get(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
let collection = store.get('pk.collection', []);
let priceCache = store.get('pk.prices', {});
// v4: los patrones reverse leen primero las claves *-holo (precio real).
// Borra una sola vez valores calculados con reglas anteriores.
if (store.get('pk.patternPriceCacheVersion', 0) < 4) {
  Object.keys(priceCache).filter(k => /:reverse_(pokeball|masterball)$/.test(k)).forEach(k => delete priceCache[k]);
  store.set('pk.prices', priceCache);
  store.set('pk.patternPriceCacheVersion', 4);
}
let setsCache = store.get('pk.sets', null);
let session = null;
let migrated = store.get('pk.migrated', false);

function saveLocalCollection() { store.set('pk.collection', collection); }

async function loadSets(force = false) {
  if (!force && setsCache && Date.now() - setsCache.ts < 7 * 864e5) return setsCache.list;
  const list = await fetchJSON(TCGDEX + '/sets');
  setsCache = { ts: Date.now(), list };
  store.set('pk.sets', setsCache);
  return list;
}

/* ---------- TCGdex ---------- */
async function searchCards(name, lang) {
  const d = await fetchJSON(tcgBase(lang || 'en') + '/cards?name=' + encodeURIComponent(name));
  const arr = Array.isArray(d) ? d : [];
  if (lang && lang !== 'en') arr.forEach(b => { b._lang = lang; });
  return arr;
}
/* Los listados de TCGdex devuelven briefs sin imagen; hidrata a cartas completas con concurrencia limitada */
async function hydrateCards(briefs, limit = 12, lang) {
  const out = [];
  const slice = briefs.slice(0, limit);
  for (let i = 0; i < slice.length; i += 6) {
    const chunk = await Promise.all(slice.slice(i, i + 6).map(b =>
      getCard(b.id, b._lang || lang).then(c => { if (c && (b._lang || lang)) c._lang = b._lang || lang; return c; }).catch(() => null)));
    out.push(...chunk.filter(c => c && c.id));
  }
  return out;
}
async function getCard(id, lang) { return fetchJSON(tcgBase(lang) + '/cards/' + encodeURIComponent(id)); }
async function getSetCards(setId, lang) {
  const d = await fetchJSON(tcgBase(lang) + '/sets/' + encodeURIComponent(setId));
  return d.cards || [];
}
/* TCGdex aún no tiene imagen para algunos sets recientes (MEP, SVE): usa la foto del escáner */
function withScanImage(card, hit) {
  if (card && !card.image && hit && hit.product && hit.product.image) card._externalImage = hit.product.image;
  return card;
}
/* El rescate por nombre busca en inglés (los nombres de TCGAPIs son ingleses);
   si la carta mapeada existe en español, prefiere esa versión (nombre y datos es). */
async function preferEs(card) {
  if (!card || card._lang) return card;
  const es = await getCard(card.id, 'es').catch(() => null);
  if (es) { es._lang = 'es'; es._externalImage = card._externalImage; return es; }
  return card;
}
function inferredImageBase(card, lang) {
  if (!card || card.image) return card && card.image;
  const locale = lang || card._lang;
  // TCGdex puede tener los assets publicados aunque el campo `image` de la API sea null
  // (p. ej. las 100 cartas de SV5M). Para sets japoneses construimos su ruta canónica;
  // el onerror existente conserva icon.svg si el asset tampoco existe realmente.
  const id = String(card.id || '');
  const cut = id.lastIndexOf('-');
  if (cut < 1) return null;
  const setId = String((card.set && card.set.id) || id.slice(0, cut));
  const localId = String(card.localId || id.slice(cut + 1)).padStart(3, '0');
  const alpha = (setId.match(/^[A-Za-z]+/) || [])[0];
  if (!alpha) return null;
  // Promos como `svp` no incluyen número, así que el prefijo alfabético completo
  // no es la carpeta de era: su ruta real sigue siendo /sv/svp/…
  const era = /^svp$/i.test(setId) ? 'sv' : /^mep$/i.test(setId) ? 'me' : alpha;
  if (locale === 'ja') return 'https://assets.tcgdex.net/ja/' + era.toUpperCase() + '/' + setId + '/' + localId;
  // En cartas occidentales localizadas, TCGdex suele publicar primero el scan inglés.
  // Si el metadato localizado está vacío, la ruta inglesa permite mostrar ese scan;
  // si aún no existe (p. ej. MEP), el onerror mantiene el placeholder.
  if (locale && TCGDEX_LANGS.includes(locale)) {
    return 'https://assets.tcgdex.net/en/' + era.toLowerCase() + '/' + setId.toLowerCase() + '/' + localId;
  }
  return null;
}
function cardImg(c) { const b = inferredImageBase(c); return b ? imgLow(b) : 'icon.svg'; }
const imgLow = (b) => b + '/low.webp';
const imgHigh = (b) => b + '/high.webp';

/* ---------- Búsqueda por código impreso ---------- */
function parseCodeQuery(q) {
  q = q.trim();
  let m = q.match(/^([a-z0-9]{2,8})-([a-z0-9]{1,6})$/i);
  if (m) return { setIds: [{ s: m[1].toLowerCase(), langs: TCGDEX_LANGS }], num: m[2], lang: null };
  m = q.match(/^([A-Za-z0-9]{2,8})[\s\-.:/]+(?:(en|es|fr|de|it|pt|ja|ko|zh-tw|zh)[\s\-.:/]+)?([A-Za-z]{0,3}\d{1,4}[A-Za-z]{0,2})$/i);
  let langHint = null;
  if (m) langHint = m[2] ? m[2].toLowerCase().replace(/^zh$/, 'zh-tw') : null;
  if (!m) m = q.match(/^([A-Za-z]{2,6}\d{0,2}[A-Za-z]{0,2})(\d{3}[A-Za-z]{0,2})$/);
  if (m) {
    const code = m[1].toUpperCase(), num = (m[3] || m[2]).toUpperCase();
    const setIds = (typeof SET_ALIASES !== 'undefined' && SET_ALIASES[code]) ? SET_ALIASES[code] : [];
    return { code, setIds, num, lang: langHint };
  }
  return null;
}
function localIdCandidates(code, num) {
  const stripped = num.replace(/^0+(?=\d)/, '');
  const out = [num, stripped, stripped.padStart(3, '0')];
  if (code) out.push(code + num, code + stripped, code + stripped.padStart(3, '0'));
  return [...new Set(out)];
}
async function searchByCode(parsed) {
  const found = [];
  let entries = parsed.setIds;
  if (!entries.length && parsed.code) {
    const c = parsed.code;
    // Sets asiáticos: su código impreso ES el id en TCGdex (con mayúsculas tipo SV2a)
    entries = [...new Set([c, c.toLowerCase(), c.toLowerCase().replace(/^sv/i, 'SV')])]
      .map(s => ({ s, langs: TCGDEX_LANGS }));
  }
  for (const e of entries) {
    let langs = TCGDEX_LANGS.filter(l => e.langs.includes(l));
    if (parsed.lang && e.langs.includes(parsed.lang)) langs = [parsed.lang, ...langs.filter(l => l !== parsed.lang)];
    if (!langs.length) langs = TCGDEX_LANGS.slice();
    for (const lang of langs) {
      let briefs = null;
      try { briefs = await getSetCards(e.s, lang); } catch { continue; }
      const cands = localIdCandidates(parsed.code, parsed.num).map(s => s.toUpperCase());
      const hit = briefs.find(b => cands.includes(String(b.localId).toUpperCase()));
      if (hit && !found.some(f => f.id === hit.id)) {
        try {
          const card = await getCard(hit.id, lang);
          card._lang = lang;
          found.push(card);
        } catch { hit._lang = lang; found.push(hit); }
      }
      break; // el set existe en este idioma: no seguir probando
    }
  }
  return found;
}
/* Expansiones TCGAPIs cuyo nombre no casa con TCGdex: mapeo curado a set id */
const EXPANSION_SET_IDS = {
  'memegaevolutionpromo': 'mep',
  'memegaevolutionenergy': 'mee'
};
function cleanScanName(n) {
  return (n || '').split('(')[0].replace(/\s*-\s*#?\d{1,4}[a-z]{0,2}\s*$/i, '').replace(/^basic\s+/i, '').trim();
}
function scanNumber(hit) {
  const parts = (hit.product.number || '').split('/');
  return { num: (parts[0] || '').trim().replace(/^0+(?=\d)/, ''), total: (parts[1] || '').trim() };
}
function resolveScanSetId(hit, sets) {
  const exp = hit.product.expansionName || '';
  const target = norm(exp);
  // 1) mapeo curado
  if (EXPANSION_SET_IDS[target]) return EXPANSION_SET_IDS[target];
  // 2) nombre exacto
  let set = sets.find(s => norm(s.name) === target);
  if (set) return set.id;
  // 3) prefijo tipo "ME04:" que ya es un set id de TCGdex
  const prefix = exp.split(':')[0].trim().toLowerCase();
  if (/^[a-z0-9]{2,8}$/.test(prefix)) {
    const exact = sets.find(s => s.id.toLowerCase() === prefix);
    if (exact) return exact.id;
    // 4) prefijo con letra+dígito: probable set japonés (no sale en la lista /en; se prueba /ja luego)
    if (/[a-z]/.test(prefix) && /\d/.test(prefix)) return prefix;
  }
  // 5) nombre por subcadena (lo más laxo; al final para no robar sets, p. ej. "151" o "Scarlet & Violet")
  set = sets.find(s => target && (norm(s.name).includes(target) || target.includes(norm(s.name))));
  if (set) return set.id;
  return null;
}
/* Devuelve {card} | {choices:[cartas]} | null */
async function mapToTcgdex(hit) {
  const sets = await loadSets();
  const setId = resolveScanSetId(hit, sets);
  const { num, total } = scanNumber(hit);
  const lids = num ? localIdCandidates('', num).map(s => s.toUpperCase()) : [];
  // 1) set + número: id directo en /en y /ja, luego listado del set
  if (setId && num) {
    for (const lang of langsForSet(setId)) {
      let setExists = false;
      for (const lid of lids) {
        try {
          const card = await fetchJSON(tcgBase(lang) + '/cards/' + encodeURIComponent(setId + '-' + lid));
          if (card && card.id) {
            card._lang = lang;
            return { card: withScanImage(card, hit) };
          }
        } catch { }
      }
      try {
        const briefs = await getSetCards(setId, lang);
        setExists = true;
        const b = briefs.find(x => lids.includes(String(x.localId).toUpperCase()));
        if (b) {
          const card = await getCard(b.id, lang).catch(() => null);
          if (card) { card._lang = lang; return { card: withScanImage(card, hit) }; }
        }
      } catch { }
      if (setExists) break; // el set existe en este idioma y el número no está
    }
  }
  // 2) rescate global: nombre limpio + número impreso (y total impreso para desambiguar)
  const clean = cleanScanName(hit.product.name);
  if (clean) {
    let briefs = [];
    try { briefs = await searchCards(clean); } catch { }
    if (setId) {
      const inSet = briefs.filter(c => c.id.toLowerCase().startsWith(setId.toLowerCase() + '-'));
      if (inSet.length) briefs = inSet;
    }
    let m = briefs;
    if (num) {
      const filtered = briefs.filter(c => lids.includes(String(c.localId || '').toUpperCase()));
      if (filtered.length) m = filtered;
    }
    if (m.length > 1 && total) {
      const full = await hydrateCards(m, 6);
      const byTotal = full.filter(c => c.set && c.set.cardCount && Number(c.set.cardCount.official) === Number(total));
      if (byTotal.length === 1) return { card: withScanImage(await preferEs(byTotal[0]), hit) };
      if (full.length) m = byTotal.length > 1 ? byTotal : full;
    }
    if (m.length === 1) {
      const card = await getCard(m[0].id).catch(() => null);
      if (card) return { card: withScanImage(await preferEs(card), hit) };
    } else if (m.length > 1) {
      const full = m[0].image ? m : await hydrateCards(m, 8);
      if (full.length === 1) return { card: withScanImage(await preferEs(full[0]), hit) };
      if (full.length > 1) return { choices: await Promise.all(full.slice(0, 8).map(async c => withScanImage(await preferEs(c), hit))) };
    }
  }
  return null;
}

/* ---------- Cuenta (Supabase Auth) ---------- */
function accountStatus(msg, isError) {
  const s = $('account-status');
  s.hidden = false; s.className = 'status' + (isError ? ' error' : '');
  s.textContent = msg;
}
function paintAccount() {
  const loggedIn = !!session;
  $('account-logged-out').hidden = loggedIn;
  $('account-logged-in').hidden = !loggedIn;
  const btn = $('btn-account');
  btn.classList.toggle('logged', loggedIn);
  btn.textContent = loggedIn ? (session.user.email[0] || '👤').toUpperCase() : '👤';
  if (loggedIn) {
    $('account-user').textContent = session.user.email;
    $('account-sync').textContent = 'Colección sincronizada en la nube ✓';
    const month = new Date().toISOString().slice(0, 7);
    sb.from('scan_usage').select('used').eq('month', month).maybeSingle()
      .then(({ data }) => { $('account-scans').textContent = 'Escaneos este mes: ' + (data?.used ?? 0) + ' / 25'; });
  }
}
/* Candado del escaneo: sin sesión no se puede escanear ni subir fotos
   (el reconocimiento consume el límite mensual del servidor) */
function paintScanGate() {
  const locked = !session;
  $('scan-locked').hidden = !locked;
  $('scan-controls').hidden = locked;
  if (locked) stopCamera();
}
$('btn-scan-login').addEventListener('click', () => {
  $('account-status').hidden = true;
  paintAccount();
  $('account-modal').hidden = false;
});

$('btn-account').addEventListener('click', () => {
  $('account-status').hidden = true;
  paintAccount();
  $('account-modal').hidden = false;
});
$('account-close').addEventListener('click', () => $('account-modal').hidden = true);
$('account-modal').addEventListener('click', (e) => { if (e.target === $('account-modal')) $('account-modal').hidden = true; });

$('btn-login').addEventListener('click', async () => {
  const email = $('account-email').value.trim(), password = $('account-password').value;
  if (!email || !password) return accountStatus('Escribe email y contraseña.', true);
  accountStatus('Entrando…');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return accountStatus('No se pudo entrar: ' + error.message, true);
  $('account-modal').hidden = true;
});
$('btn-signup').addEventListener('click', async () => {
  const email = $('account-email').value.trim(), password = $('account-password').value;
  if (!email || password.length < 6) return accountStatus('Email válido y contraseña de 6+ caracteres.', true);
  accountStatus('Creando cuenta…');
  const { error } = await sb.auth.signUp({ email, password });
  if (error) return accountStatus('No se pudo crear: ' + error.message, true);
  $('account-modal').hidden = true;
});
$('btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  $('account-modal').hidden = true;
});

sb.auth.onAuthStateChange(async (_event, s) => {
  session = s ?? null;
  paintAccount();
  paintScanGate();
  loadSetsPreference();
  if (session) {
    if (!migrated) await migrateLocalToBackend();
    await loadCollectionFromBackend();
    renderCollection();
  } else {
    collection = store.get('pk.collection', []);
    renderCollection();
  }
  // La sesión cambia la clave de preferencia (guest -> user_id): repinta Sets
  // después de restaurarla, no solo el checkbox.
  if ($('tab-sets') && $('tab-sets').classList.contains('active')) renderSets();
});

async function migrateLocalToBackend() {
  const local = store.get('pk.collection', []);
  migrated = true; store.set('pk.migrated', true);
  if (!local.length) return;
  for (const e of local) {
    try {
      const { data: existing } = await sb.from('collections').select('qty').eq('card_id', e.id).eq('lang', e.lang || '').eq('variant', e.variant || 'normal').maybeSingle();
      const qty = Math.min(99, (existing?.qty ?? 0) + (e.qty || 1));
      await sb.from('collections').upsert({
        card_id: e.id, tcgdex_id: e.tcgdexId, name: e.name, set_name: e.setName || '',
        local_id: e.localId || '', image: e.image || '', qty, lang: e.lang || '',
        variant: e.variant || 'normal'
      }, { onConflict: 'user_id,card_id,lang,variant' });
    } catch { }
  }
}

async function loadCollectionFromBackend() {
  const { data, error } = await sb.from('collections').select('*');
  if (error) { console.warn('collections load', error); return; }
  collection = (data || []).map(r => ({
    id: r.card_id, tcgdexId: r.tcgdex_id, name: r.name, setName: r.set_name, lang: r.lang || null,
    variant: r.variant || 'normal',
    localId: r.local_id, image: r.image, qty: r.qty, addedAt: Date.parse(r.added_at) || Date.now()
  }));
}

/* ---------- Colección: escritura dual (backend si hay sesión) ---------- */
async function collAdd(entry) {
  if (session) {
    const { data: existing } = await sb.from('collections').select('qty').eq('card_id', entry.id).eq('lang', entry.lang || '').eq('variant', entry.variant || 'normal').maybeSingle();
    const qty = Math.min(99, (existing?.qty ?? 0) + entry.qty);
    await sb.from('collections').upsert({
      card_id: entry.id, tcgdex_id: entry.tcgdexId, name: entry.name, set_name: entry.setName || '',
      local_id: entry.localId || '', image: entry.image || '', qty, lang: entry.lang || '',
      variant: entry.variant || 'normal'
    }, { onConflict: 'user_id,card_id,lang,variant' });
    await loadCollectionFromBackend();
  } else {
    const existing = collection.find(c => c.id === entry.id && (c.lang || '') === (entry.lang || '') && (c.variant || 'normal') === (entry.variant || 'normal'));
    if (existing) existing.qty = Math.min(99, existing.qty + entry.qty);
    else collection.push(entry);
    saveLocalCollection();
  }
  maybeRenderSets();
}
async function collSetQty(entry, qty) {
  if (session) {
    await sb.from('collections').update({ qty }).eq('card_id', entry.id).eq('lang', entry.lang || '').eq('variant', entry.variant || 'normal');
    await loadCollectionFromBackend();
  } else {
    entry.qty = qty; saveLocalCollection();
  }
  maybeRenderSets();
}
async function collDelete(entry) {
  if (session) {
    await sb.from('collections').delete().eq('card_id', entry.id).eq('lang', entry.lang || '').eq('variant', entry.variant || 'normal');
    await loadCollectionFromBackend();
  } else {
    collection = collection.filter(c => c !== entry); saveLocalCollection();
  }
  maybeRenderSets();
}

/* ---------- Sets (catálogo completo + progreso personal) ---------- */
const SETS_CATALOG = window.SETS_CATALOG || [];
let setsFilter = '';
let hideAsianSets = false;
let detailSetLang = 'all';
let currentSetDetail = null;
const asianSetLang = lang => ['ja', 'ko', 'zh-tw'].includes(lang);
const setsAccountKey = suffix => 'pk.' + suffix + '.' + (session && session.user ? session.user.id : 'guest');
const setsPrefKey = () => setsAccountKey('hideAsianSets');
function loadSetsPreference() {
  hideAsianSets = store.get(setsPrefKey(), false) === true;
  if ($('sets-hide-asian')) $('sets-hide-asian').checked = hideAsianSets;
}
function updateDetailLangEdges() {
  const box = $('set-detail-langs'), shell = $('set-detail-langs-shell');
  if (!box || !shell || shell.hidden) return;
  const max = Math.max(0, box.scrollWidth - box.clientWidth);
  shell.classList.toggle('can-scroll-left', box.scrollLeft > 3);
  shell.classList.toggle('can-scroll-right', box.scrollLeft < max - 3);
}
function paintDetailLangs(serie, set) {
  const box = $('set-detail-langs'), shell = $('set-detail-langs-shell');
  const langs = langsForSet(set.id);
  box.innerHTML = '';
  shell.hidden = langs.length <= 1;
  shell.classList.remove('can-scroll-left', 'can-scroll-right');
  if (langs.length <= 1) { detailSetLang = langs[0] || set.lang; return; }
  if (detailSetLang !== 'all' && !langs.includes(detailSetLang)) detailSetLang = 'all';
  [['all', 'Todos']].concat(langs.map(lang => [lang, (LANG_FLAGS[lang] || '🌐') + ' ' + (LANG_LABELS[lang] || lang)])).forEach(([lang, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sets-lang-chip' + (detailSetLang === lang ? ' active' : '');
    b.textContent = label; b.dataset.lang = lang;
    b.addEventListener('click', () => { detailSetLang = lang; openSetDetail(serie, set, true); });
    box.appendChild(b);
  });
  box.onscroll = updateDetailLangEdges;
  box.onwheel = ev => {
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && box.scrollWidth > box.clientWidth) {
      ev.preventDefault();
      box.scrollBy({ left: ev.deltaY, behavior: 'smooth' });
    }
  };
  $('set-detail-langs-prev').onclick = () => box.scrollBy({ left: -Math.max(180, box.clientWidth * .7), behavior: 'smooth' });
  $('set-detail-langs-next').onclick = () => box.scrollBy({ left: Math.max(180, box.clientWidth * .7), behavior: 'smooth' });
  requestAnimationFrame(() => {
    const active = box.querySelector('.sets-lang-chip.active');
    if (active) active.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    updateDetailLangEdges();
  });
}
function ownedBySet() {
  const map = new Map();
  for (const e of collection) {
    if (!e.tcgdexId) continue;
    const sid = e.tcgdexId.split('-')[0];
    if (!map.has(sid)) map.set(sid, { cards: new Set(), qty: 0 });
    const o = map.get(sid);
    o.cards.add(e.tcgdexId);
    o.qty += e.qty;
  }
  return map;
}
const setAssetBase = (set, serieId) => 'https://assets.tcgdex.net/' + set.lang + '/' + serieId + '/' + set.id;
function setVisualMarkup(set, serieId, big = false) {
  const label = String(set.code || set.id || 'PKM').slice(0, 8);
  return '<span class="set-visual' + (big ? ' big' : '') + '">' +
    '<span class="set-logo-fallback" aria-hidden="true">' + esc(label) + '</span>' +
    '<img class="set-logo' + (big ? ' big' : '') + '" src="' + setAssetBase(set, serieId) + '/logo.webp" alt="" loading="lazy" ' +
      'onload="this.previousElementSibling.hidden=true" onerror="this.remove()">' +
    '</span>';
}

function renderSets() {
  const list = $('sets-list'), summary = $('sets-summary');
  if (!list) return;
  currentSetDetail = null;
  $('set-detail').hidden = true;
  list.hidden = false;
  $('sets-filter-wrap').hidden = false;
  summary.hidden = false;
  const owned = ownedBySet();
  let started = 0, complete = 0, ownedCards = 0;
  const q = norm(setsFilter);
  list.innerHTML = '';
  for (const serie of SETS_CATALOG) {
    const det = document.createElement('details');
    det.className = 'serie';
    let serieOwnedSets = 0;
    const rows = [];
    const visibleSets = serie.sets.filter(set => !(hideAsianSets && asianSetLang(set.lang)));
    for (const set of visibleSets) {
      const o = owned.get(set.id);
      const n = o ? o.cards.size : 0;
      if (n > 0) { serieOwnedSets++; started++; ownedCards += n; if (set.total && n >= set.total) complete++; }
      if (q && !norm(serie.serie + ' ' + set.name + ' ' + set.id + ' ' + set.code).includes(q)) continue;
      const pct = set.total ? Math.min(100, Math.round(100 * n / set.total)) : 0;
      const row = document.createElement('button');
      row.className = 'set-row' + (n ? ' owned' : '') + (set.total && n >= set.total && n > 0 ? ' complete' : '');
      row.innerHTML =
        setVisualMarkup(set, serie.serieId) +
        '<span class="set-info"><b>' + esc(set.name) + '</b>' +
        '<small>' + esc(set.code) + ' · ' + (set.date ? formatDate(set.date) : '¿?') + ' · ' + (set.total || '?') + ' cartas</small></span>' +
        '<span class="set-prog"><span class="set-prog-num">' + (n ? n + '/' + (set.total || '?') : '') + '</span>' +
        '<span class="set-bar"><span class="set-bar-fill" style="width:' + pct + '%"></span></span></span>';
      row.addEventListener('click', () => openSetDetail(serie, set));
      rows.push(row);
    }
    if (!rows.length) continue;
    const sum = document.createElement('summary');
    sum.innerHTML = '<span>' + esc(serie.serie) + '</span><span class="serie-count">' + (serieOwnedSets ? serieOwnedSets + ' empezados · ' : '') + visibleSets.length + ' sets</span>';
    det.appendChild(sum);
    rows.forEach(r => det.appendChild(r));
    if (q || serieOwnedSets) det.open = true;
    list.appendChild(det);
  }
  summary.innerHTML = collection.length
    ? '<b>' + started + '</b> sets empezados · <b>' + complete + '</b> completos · <b>' + ownedCards + '</b> cartas distintas'
    : 'Escanea o busca cartas para empezar tu progreso por set.';
}

async function openSetDetail(serie, set, keepLang = false) {
  if (!keepLang || !currentSetDetail || currentSetDetail.set.id !== set.id) detailSetLang = 'all';
  currentSetDetail = { serie, set };
  $('sets-list').hidden = true;
  $('sets-filter-wrap').hidden = true;
  $('sets-summary').hidden = true;
  const det = $('set-detail');
  det.hidden = false;
  const head = $('set-detail-head');
  const grid = $('set-detail-grid');
  paintDetailLangs(serie, set);
  const scopedEntries = collection.filter(e => e.tcgdexId && e.tcgdexId.split('-')[0] === set.id && (detailSetLang === 'all' || e.lang === detailSetLang));
  const ownedCards = new Set(scopedEntries.map(e => e.tcgdexId));
  const n = ownedCards.size;
  const pct = set.total ? Math.min(100, Math.round(100 * n / set.total)) : 0;
  head.innerHTML =
    setVisualMarkup(set, serie.serieId, true) +
    '<h2>' + esc(set.name) + '</h2>' +
    '<p class="muted">' + esc(serie.serie) + ' · ' + esc(set.code) + ' · ' + formatDate(set.date) + '</p>' +
    '<p class="set-prog-line">' + (n ? 'Tienes <b>' + n + '</b> de ' + (set.total || '?') + ' (' + pct + '%)' : 'Aún no tienes cartas de este set') + '</p>' +
    '<span class="set-bar big"><span class="set-bar-fill" style="width:' + pct + '%"></span></span>';
  grid.innerHTML = '<p class="status">Cargando cartas…</p>';
  let briefs = [];
  // "Todos" usa inglés cuando el set existe en inglés; los sets exclusivos
  // asiáticos usan su idioma canónico. Antes forzábamos inglés también para
  // SV2a, cuyo endpoint en inglés es 404, y el detalle quedaba vacío.
  const setLangs = langsForSet(set.id);
  const displayLang = detailSetLang === 'all'
    ? (setLangs.includes('en') ? 'en' : (set.lang || setLangs[0] || 'en'))
    : detailSetLang;
  try { briefs = await getSetCards(set.id, displayLang); } catch { }
  if (!currentSetDetail || currentSetDetail.set !== set) return;
  if (!briefs.length) { grid.innerHTML = '<p class="empty">No se pudo cargar el listado de cartas.</p>'; return; }
  briefs = [...briefs].sort((a, b) => String(a.localId).localeCompare(String(b.localId), 'es', { numeric: true }));
  grid.innerHTML = '';
  for (const b of briefs) {
    const own = ownedCards.has(b.id);
    const qty = own ? scopedEntries.filter(c => c.tcgdexId === b.id).reduce((sum, c) => sum + c.qty, 0) : 0;
    const div = document.createElement('div');
    div.className = 'grid-card' + (own ? ' owned' : '');
    div.innerHTML =
      '<img src="' + (inferredImageBase(b, displayLang) ? imgLow(inferredImageBase(b, displayLang)) : 'icon.svg') + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'icon.svg\'">' +
      '<div class="gname">' + esc(b.name) + '</div>' +
      '<div class="gset">#' + esc(b.localId) + (own ? ' · ×' + qty : '') + '</div>';
    div.addEventListener('click', async () => {
      try {
        const c = await getCard(b.id, displayLang);
        c._lang = displayLang;
        openModal(c);
      } catch { }
    });
    grid.appendChild(div);
  }
}

function maybeRenderSets() {
  if (!$('tab-sets') || !$('tab-sets').classList.contains('active')) return;
  if (currentSetDetail) openSetDetail(currentSetDetail.serie, currentSetDetail.set, true);
  else renderSets();
}

/* ---------- Pestañas ---------- */
const TAB_IDS = ['scan', 'search', 'collection', 'sets'];

function activateTab(id, updateUrl = true) {
  if (!TAB_IDS.includes(id)) id = 'scan';
  const btn = document.querySelector('.tab[data-tab="' + id + '"]');
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + id));
  store.set('pk.activeTab', id);
  if (updateUrl && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  if (id === 'collection') renderCollection();
  if (id === 'sets') renderSets();
  document.documentElement.removeAttribute('data-initial-tab');
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});
window.addEventListener('hashchange', () => activateTab(location.hash.slice(1), false));

// El hash permite enlazar una pestaña; localStorage conserva la última como respaldo.
const initialTab = TAB_IDS.includes(location.hash.slice(1))
  ? location.hash.slice(1)
  : store.get('pk.activeTab', 'scan');
activateTab(initialTab);

$('set-detail-back').addEventListener('click', () => { $('sets-summary').hidden = false; renderSets(); });
$('sets-filter').addEventListener('input', (e) => { setsFilter = e.target.value; renderSets(); });
$('sets-hide-asian').addEventListener('change', (e) => {
  hideAsianSets = e.target.checked;
  store.set(setsPrefKey(), hideAsianSets);
  renderSets();
});
loadSetsPreference();

/* ---------- Escanear ---------- */
let stream = null;
let identifying = false;

function videoReady(video, ms = 4000) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

$('btn-start-camera').addEventListener('click', async () => {
  const status = $('scan-status');
  status.hidden = false; status.className = 'status';
  status.textContent = 'Abriendo la cámara…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    const video = $('camera');
    video.srcObject = stream;
    await videoReady(video);
    $('camera-placeholder').hidden = true;
    $('frame-guide').hidden = false;
    $('btn-capture').hidden = false;
    $('btn-start-camera').hidden = true;
    $('btn-stop-camera').hidden = false;
    status.textContent = 'Encuadra la carta y pulsa el botón amarillo IDENTIFICAR.';
  } catch (e) {
    stopCamera();
    status.hidden = false;
    status.className = 'status error';
    status.textContent = 'No pude abrir la cámara (' + (e.name || e.message || 'error') + '). Da permiso a la cámara o usa "sube una foto".';
  }
});

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('camera').srcObject = null;
  $('camera-placeholder').hidden = false;
  $('frame-guide').hidden = true;
  $('btn-capture').hidden = true;
  $('btn-stop-camera').hidden = true;
  $('btn-start-camera').hidden = false;
}
$('btn-stop-camera').addEventListener('click', stopCamera);

function captureFromCamera() {
  if (identifying) return;
  const video = $('camera');
  if (!stream || video.readyState < 2 || !video.videoWidth) {
    const status = $('scan-status');
    status.hidden = false; status.className = 'status error';
    status.textContent = 'La cámara aún no está lista, espera un segundo y vuelve a pulsar.';
    return;
  }
  const canvas = $('snapshot');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(b => b && identifyCard(b), 'image/jpeg', 0.92);
}
$('btn-capture').addEventListener('click', captureFromCamera);
$('camera').addEventListener('click', captureFromCamera);

$('file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) identifyCard(f);
  e.target.value = '';
});

async function identifyCard(blob) {
  if (!session) { paintScanGate(); return; }
  if (identifying) return;
  identifying = true;
  $('btn-capture').disabled = true;
  const status = $('scan-status'), out = $('scan-results');
  out.innerHTML = '';
  status.hidden = false; status.className = 'status';
  status.textContent = 'Identificando la carta…';

  try {
    let data = null;
    try { data = await callProxy(blob); }
    catch (e) {
      if (e.message === 'limit') {
        status.className = 'status error';
        status.textContent = 'Has llegado al límite de 25 escaneos este mes. El día 1 se renueva, o búscala por nombre/código.';
        return;
      }
    }

    if (data && data.success && data.results && data.results.length) {
      const rem = data.usage && data.usage.remaining;
      status.textContent = 'Estas son mis mejores apuestas, confirma cuál es:' +
        (rem != null && session ? ' (te quedan ' + rem + ' escaneos este mes)' : '');
      renderScanCandidates(data.results.slice(0, 3));
    } else {
      status.textContent = 'El reconocedor no ha podido. Pruebo con lectura de texto (OCR)…';
      const names = await ocrNames(blob);
      if (names.length) {
        let found = [];
        for (const n of names.slice(0, 3)) {
          try { found = found.concat(await searchCards(n)); } catch { }
          if (found.length >= 8) break;
        }
        const seen = new Set(); found = found.filter(c => !seen.has(c.id) && seen.add(c.id)).slice(0, 8);
        found = await hydrateCards(found, 8);
        if (found.length) {
          status.textContent = 'No estoy seguro, ¿es alguna de estas?';
          renderTcgdexCandidates(found);
          return;
        }
      }
      status.className = 'status error';
      status.textContent = 'No he logrado identificarla. Prueba con más luz y la carta centrada, o búscala por nombre o código en la pestaña Buscar.';
    }
  } finally {
    identifying = false;
    $('btn-capture').disabled = false;
  }
}

/* Escaneo con sesión: pasa por el backend (clave oculta + contador por usuario) */
async function callProxy(blob) {
  const fd = new FormData();
  fd.append('image', blob, 'carta.jpg');
  const r = await fetch(RECOG_FN, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + session.access_token, 'apikey': SB_PUB },
    body: fd
  });
  if (r.status === 429) throw new Error('limit');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (!d.success) throw new Error(d.error || 'fallo');
  return d;
}

/* Escaneo sin sesión: endpoint demo gratuito de TCGAPIs (10/día) */
async function callRecognize(url, blob) {
  const fd = new FormData();
  fd.append('image', blob, 'carta.jpg');
  fd.append('limit', '3');
  const r = await fetch(url, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (!d.success) throw new Error(d.error || 'fallo');
  return d;
}

function renderScanCandidates(results) {
  const out = $('scan-results');
  out.innerHTML = '';
  results.forEach(hit => {
    const p = hit.product;
    const div = document.createElement('div');
    div.className = 'candidate';
    div.innerHTML =
      '<img src="' + p.image + '" alt="" loading="lazy">' +
      '<div class="info"><b>' + esc(p.name) + '</b>' +
      '<small>' + esc(p.expansionName) + ' · ' + esc(p.number || '') + ' · ' + esc(p.rarity || '') + '</small>' +
      '<span class="score">confianza ' + Math.round(hit.score) + '%</span></div>' +
      '<button class="btn primary">Es esta</button>';
    div.querySelector('button').addEventListener('click', async () => {
      const btn = div.querySelector('button');
      btn.textContent = '…'; btn.disabled = true;
      let res = null;
      try { res = await mapToTcgdex(hit); } catch { }
      if (res && res.card) openModal(res.card);
      else if (res && res.choices && res.choices.length) {
        const status = $('scan-status');
        status.hidden = false; status.className = 'status';
        status.textContent = 'La foto apunta a ' + cleanScanName(p.name) + ', pero hay varias impresiones posibles: elige la exacta.';
        renderTcgdexCandidates(res.choices);
      } else {
        btn.textContent = 'Es esta'; btn.disabled = false;
        openModal({
          id: null, name: cleanScanName(p.name), image: null, _externalImage: p.image,
          set: { name: p.expansionName }, localId: (p.number || '').split('/')[0],
          rarity: p.rarity, _noPrice: true
        });
      }
    });
    out.appendChild(div);
  });
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.style.cssText = 'text-align:center;font-size:.85rem;margin-top:.4rem';
  hint.textContent = '¿Ninguna es? Búscala por nombre o código en la pestaña Buscar.';
  out.appendChild(hint);
}

function renderTcgdexCandidates(briefs) {
  const out = $('scan-results');
  out.innerHTML = '';
  briefs.forEach(b => {
    const div = document.createElement('div');
    div.className = 'candidate';
    div.innerHTML =
      '<img src="' + cardImg(b) + '" alt="" loading="lazy">' +
      '<div class="info"><b>' + esc(b.name) + '</b><small>' + esc(b.id) + '</small></div>' +
      '<button class="btn primary">Es esta</button>';
    div.querySelector('button').addEventListener('click', async () => {
      div.querySelector('button').textContent = '…';
      try { openModal(await getCard(b.id)); } catch { }
    });
    out.appendChild(div);
  });
}

/* OCR de respaldo con Tesseract.js (carga perezosa) */
let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return tesseractPromise;
}
async function ocrNames(blob) {
  try {
    await loadTesseract();
    const { data } = await Tesseract.recognize(blob, 'eng');
    const lines = (data.text || '').split('\n')
      .map(l => l.replace(/[^A-Za-z' .-]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(l => l.length >= 4 && /[A-Z]/.test(l) && !/ENERGY|TRAINER|HP|STAGE|ILLUS|WEAK|RETREAT/i.test(l));
    return [...new Set(lines)].slice(0, 5);
  } catch { return []; }
}

/* ---------- Buscar ---------- */
let lastResults = {};

function saveSearchState(q, cards) {
  store.set('pk.searchState', { q, cards, ts: Date.now() });
  const url = new URL(location.href);
  url.searchParams.set('q', q);
  history.replaceState(null, '', url.pathname + url.search + location.hash);
}

async function runSearch(q, updateState = true) {
  q = String(q || '').trim();
  if (!q) return;
  $('search-input').value = q;
  const status = $('search-status'), grid = $('search-results');
  grid.innerHTML = '';
  status.hidden = false; status.className = 'status';
  status.textContent = 'Buscando…';
  try {
    const parsed = parseCodeQuery(q);
    if (parsed) {
      const cards = await searchByCode(parsed);
      if (!cards.length) {
        status.className = 'status error';
        status.textContent = 'No encuentro ' + q.toUpperCase() + '. Revisa el código o prueba con el nombre.';
        if (updateState) saveSearchState(q, []);
        return;
      }
      status.hidden = true;
      renderSearchGrid(cards, grid);
      if (updateState) saveSearchState(q, cards);
      return;
    }
    let briefs = [];
    try { briefs = await searchCards(q, 'es'); } catch { }
    try {
      const enBriefs = await searchCards(q, 'en');
      const seenIds = new Set(briefs.map(b => b.id));
      briefs = briefs.concat(enBriefs.filter(b => !seenIds.has(b.id)));
    } catch { }
    if (!briefs.length) {
      status.className = 'status error';
      status.textContent = 'Sin resultados para "' + q + '". Prueba con el nombre (español o inglés) o con el código impreso (p. ej. SSP ES 058).';
      if (updateState) saveSearchState(q, []);
      return;
    }
    status.textContent = briefs.length > 24 ? 'Cargando 24 de ' + briefs.length + ' resultados…' : 'Cargando resultados…';
    const cards = await hydrateCards(briefs, 24);
    status.hidden = true;
    renderSearchGrid(cards, grid);
    if (updateState) saveSearchState(q, cards);
  } catch {
    status.className = 'status error';
    status.textContent = 'Error de red buscando. Inténtalo de nuevo.';
  } finally {
    document.documentElement.removeAttribute('data-initial-search');
  }
}

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await runSearch($('search-input').value, true);
});

function renderSearchGrid(cards, grid) {
  lastResults = {};
  cards.forEach(c => { if (c.pricing || c.rarity || c.hp) lastResults[c.id] = c; });
  cards.forEach(c => {
    const div = document.createElement('div');
    div.className = 'grid-card';
    div.innerHTML = '<img src="' + cardImg(c) + '" alt="' + esc(c.name) + '" loading="lazy" onerror="this.onerror=null;this.src=\'icon.svg\'">' +
      '<div class="gname">' + esc(c.name) + '</div>' +
      '<div class="gset">' + esc(c.id) + '</div>';
    div.addEventListener('click', async () => {
      try { openModal(lastResults[c.id] || await getCard(c.id)); } catch { }
    });
    grid.appendChild(div);
  });
}

/* ---------- Modal de carta ---------- */
// Restauración inmediata: pinta el último resultado cacheado y lo refresca en segundo plano.
(function restoreSearch() {
  const urlQ = new URLSearchParams(location.search).get('q');
  const saved = store.get('pk.searchState', null);
  const q = urlQ || (saved && saved.q);
  if (!q) return;
  $('search-input').value = q;
  if (saved && saved.q === q && Array.isArray(saved.cards) && saved.cards.length) {
    $('search-status').hidden = true;
    renderSearchGrid(saved.cards, $('search-results'));
    document.documentElement.removeAttribute('data-initial-search');
  }
  runSearch(q, true);
})();

let modalCard = null, modalQty = 1, modalLangBusy = false, modalVariant = 'normal';

const VARIANT_LABELS = { normal: 'Normal', reverse: 'Reverse', reverse_pokeball: 'Reverse Poké Ball', reverse_masterball: 'Reverse Master Ball', holo: 'Holo' };
const LANG_FLAGS = { es: '🇪🇸', en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', ja: '🇯🇵', ko: '🇰🇷', 'zh-tw': '🇹🇼' };

// Efecto foil aislado y reversible: la carta original nunca se modifica.
function foilClass(variant) {
  return variant === 'holo' ? ' foil-holo' : variant === 'reverse' || variant === 'reverse_pokeball' || variant === 'reverse_masterball' ? ' foil-reverse' : '';
}
function paintModalFoil() {
  const wrap = $('modal-foil');
  if (wrap) wrap.className = 'foil-card' + foilClass(modalVariant);
}

function detailedPatternVariant(card, variant) {
  const foil = variant === 'reverse_pokeball' ? 'pokeball' : variant === 'reverse_masterball' ? 'masterball' : null;
  if (!foil || !Array.isArray(card && card.variants_detailed)) return null;
  return card.variants_detailed.find(v => v && v.type === 'reverse' && String(v.foil || '').toLowerCase() === foil) || null;
}
function detailedVariant(card, type, foil) {
  if (!Array.isArray(card && card.variants_detailed)) return null;
  return card.variants_detailed.find(v => v && v.type === type &&
    (foil == null ? !v.foil : String(v.foil || '').toLowerCase() === foil)) || null;
}
function availableVariants(card) {
  const patterns = ['reverse_pokeball', 'reverse_masterball'].filter(v => detailedPatternVariant(card, v));
  const list = ['normal'];
  // En TCGdex, variants.reverse es el paraguas de todos los reverses. Si
  // variants_detailed ya enumera patrones concretos, no inventamos además una
  // Reverse genérica que no corresponde a ningún producto físico.
  if (!patterns.length) list.push('reverse');
  list.push(...patterns, 'holo');
  return list.filter(v => v.startsWith('reverse_') || card.variants && card.variants[v]);
}
function setupVariants(card) {
  const box = $('modal-variants');
  let list = availableVariants(card);
  if (!list.length) list = ['normal'];
  if (!list.includes(modalVariant)) modalVariant = list.includes('normal') ? 'normal' : list[0];
  box.innerHTML = '';
  list.forEach(v => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'variant-btn variant-' + v + (v === modalVariant ? ' active' : '');
    b.textContent = VARIANT_LABELS[v];
    b.addEventListener('click', () => {
      modalVariant = v;
      box.querySelectorAll('.variant-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      paintPrices(modalCard);
      paintAddBtn(modalCard);
      paintModalImage(modalCard);
      paintModalFoil();
    });
    box.appendChild(b);
  });
}

function usefulPriceFamily(cm, suffix) {
  const vals = ['trend', 'avg30', 'avg'].map(k => cm[k + suffix]).filter(v => typeof v === 'number' && v > 0);
  return { score: vals.length, trend: cm['trend' + suffix], avg30: cm['avg30' + suffix], avg: cm['avg' + suffix], low: cm['low' + suffix] };
}
function bestCardmarketFamily(cm) {
  if (!cm) return null;
  const base = usefulPriceFamily(cm, ''), holo = usefulPriceFamily(cm, '-holo');
  // Preferimos la familia con más señales de mercado útiles; en empate, la base.
  // Así cubrimos patrones donde las claves base tienen precio normal y casos aún
  // incompletos donde solo *-holo contiene tendencia/media real.
  const chosen = holo.score > base.score ? holo : base;
  if (!chosen.score && !(typeof chosen.low === 'number' && chosen.low > 0)) return null;
  return chosen;
}
function detailedPatternPrices(card, variant) {
  const detail = detailedPatternVariant(card, variant);
  const cm = detail && detail.pricing && detail.pricing.cardmarket;
  if (!cm) return null;
  // Estos productos son reverse holo y en Cardmarket su precio real vive en las
  // claves *-holo; las claves base vienen obsoletas o vacías (verificado contra
  // la web el 14/09/2026: Bulbasaur V1/V2 trend 1,13/105,11 e Ivysaur V1/V2
  // 0,37/40,26 = las *-holo de TCGdex; las base decían 0,25/38,99/8/0).
  const holo = usefulPriceFamily(cm, '-holo');
  if (holo.score || (typeof holo.low === 'number' && holo.low > 0)) return holo;
  const base = usefulPriceFamily(cm, '');
  return base.score || (typeof base.low === 'number' && base.low > 0) ? base : null;
}
// Misma detección de etiquetas cruzadas que rige los precios: si el producto
// marcado Master Ball vale menos que el Poké Ball, TCGdex tiene la pareja al
// revés (002, 005, 008…). Precios e imágenes se intercambian con el mismo
// criterio para que nunca se muestren mezclados.
function patternDetailsSwapped(card) {
  const pokeValue = representativePatternPrice(detailedPatternPrices(card, 'reverse_pokeball'));
  const masterValue = representativePatternPrice(detailedPatternPrices(card, 'reverse_masterball'));
  return pokeValue > 0 && masterValue > 0 && masterValue < pokeValue;
}
function cardmarketProductImage(card, detail, additional) {
  const idProduct = detail && ((detail.thirdParty && detail.thirdParty.cardmarket) ||
    (detail.pricing && detail.pricing.cardmarket && detail.pricing.cardmarket.idProduct));
  if (!idProduct || !card.id) return null;
  const setId = String(card.id).split('-')[0].toLowerCase();
  // Producto base: slug del set (sv2a). Patrones: expansión Additionals, 'x'+set
  // (xsv2a). Si otro set no sigue esa regla, el onerror conserva el scan TCGdex.
  const productSet = (additional ? 'x' : '') + setId;
  return SB_URL + '/functions/v1/card-image?set=' + productSet + '&product=' + encodeURIComponent(idProduct);
}
function variantProductImage(card, variant) {
  let detail = null, additional = false;
  if (variant === 'normal') detail = detailedVariant(card, 'normal', null);
  else if (variant === 'reverse') detail = detailedVariant(card, 'reverse', null);
  else {
    detail = detailedPatternVariant(card, variant);
    additional = true;
    if (detail && patternDetailsSwapped(card)) {
      detail = detailedPatternVariant(card, variant === 'reverse_pokeball' ? 'reverse_masterball' : 'reverse_pokeball');
    }
  }
  return cardmarketProductImage(card, detail, additional);
}
function resolvedVariantImage(card, variant) {
  const imageBase = inferredImageBase(card);
  const fallback = card._externalImage || (imageBase ? imgHigh(imageBase) : 'icon.svg');
  return { primary: variantProductImage(card, variant) || fallback, fallback };
}
function applyResolvedVariantImage(img, card, variant) {
  const sources = resolvedVariantImage(card, variant);
  img.onerror = () => {
    if (img.src !== sources.fallback && sources.fallback !== 'icon.svg') {
      img.src = sources.fallback;
      return;
    }
    img.onerror = null;
    img.src = 'icon.svg';
  };
  img.src = sources.primary;
  return sources;
}
function paintModalImage(card) {
  applyResolvedVariantImage($('modal-img'), card, modalVariant);
}
function representativePatternPrice(p) {
  return p && (p.trend || p.avg30 || p.avg || p.low);
}
function cardmarketPrices(card, variant) {
  const detail = detailedPatternVariant(card, variant);
  if (detail) {
    // Cada patrón lleva su propio producto Cardmarket y se lee con la regla
    // *-holo primero de detailedPatternPrices. TCGdex tiene algunas parejas de
    // SV2a etiquetadas al revés (p. ej. 002, 005 y 008): el producto marcado
    // Master Ball vale céntimos y el Poké Ball decenas de euros. En 151 la
    // Master Ball es siempre el patrón escaso (1/caja), así que si ambos datos
    // existen y Master < Poké intercambiamos solo precios.
    const poke = detailedPatternPrices(card, 'reverse_pokeball');
    const master = detailedPatternPrices(card, 'reverse_masterball');
    const upstreamLabelsReversed = patternDetailsSwapped(card);
    if (upstreamLabelsReversed) return variant === 'reverse_pokeball' ? master : poke;
    return variant === 'reverse_pokeball' ? poke : master;
  }
  const cm = card && card.pricing && card.pricing.cardmarket;
  if (!cm) return null;
  if (variant !== 'holo') return usefulPriceFamily(cm, '');
  const variants = card.variants;
  const holoOnly = variants && variants.holo && !variants.normal && !variants.reverse;
  if (holoOnly) return usefulPriceFamily(cm, '');
  const holo = usefulPriceFamily(cm, '-holo');
  return holo.score || (typeof holo.low === 'number' && holo.low > 0) ? holo : null;
}

function paintPrices(card) {
  const prices = $('modal-prices');
  prices.innerHTML = '';
  if (card._noPrice) {
    prices.innerHTML = '<p class="muted">Carta identificada por foto; sin enlace a precios.</p>';
    return;
  }
  const p = cardmarketPrices(card, modalVariant);
  if (!p) {
    prices.innerHTML = '<p class="muted price-unavailable">Sin datos de precio para ' + esc(VARIANT_LABELS[modalVariant] || 'esta variante') + '.</p>';
    return;
  }
  prices.innerHTML =
    prow('Tendencia (Cardmarket)', eur(p.trend || p.avg30 || p.avg || p.low)) +
    prow('Media 30 días', eur(p.avg30 ?? p.avg)) +
    prow('Mínimo', eur(p.low));
}

function paintAddBtn(card) {
  $('modal-add').textContent = card.id && collection.some(c =>
    c.id === card.id && (c.lang || '') === (card._lang || '') && (c.variant || 'normal') === modalVariant) ? 'Añadir más copias' : 'Añadir a mi colección';
}

const LANG_LABELS = {
  es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  pt: 'Português', ja: '日本語', ko: '한국어', 'zh-tw': '繁體中文'
};

function setupLangSelector(card) {
  const sel = $('modal-lang'), note = $('modal-lang-note');
  note.hidden = true;
  const setId = card.id ? card.id.split('-')[0] : null;
  if (!setId) {
    sel.disabled = true;
    sel.innerHTML = '<option>—</option>';
    note.textContent = 'El idioma se elige en cartas identificadas del catálogo.';
    note.hidden = false;
    return;
  }
  const langs = langsForSet(setId);
  const cur = card._lang && langs.includes(card._lang) ? card._lang
    : (langs.includes('es') ? 'es' : langs[0]);
  sel.innerHTML = langs.map(l =>
    '<option value="' + l + '"' + (l === cur ? ' selected' : '') + '>' + LANG_LABELS[l] + '</option>').join('');
  sel.disabled = langs.length < 2;
}

$('modal-lang').addEventListener('change', async (e) => {
  const lang = e.target.value;
  if (!modalCard || !modalCard.id || modalLangBusy) return;
  if ((modalCard._lang || null) === lang) return;
  modalLangBusy = true;
  const sel = e.target, note = $('modal-lang-note');
  sel.disabled = true; note.hidden = true;
  try {
    let card = null;
    try { card = await getCard(modalCard.id, lang); } catch { }
    if (!card) {
      note.textContent = 'Este set no existe en ' + LANG_LABELS[lang] + '.';
      note.hidden = false;
      sel.value = modalCard._lang || 'es';
    } else {
      card._lang = lang;
      let fallbackNote = '';
      if (!card.image) {
        if (lang !== 'en') {
          try {
            const en = await getCard(modalCard.id, 'en');
            if (en && en.image) { card.image = en.image; fallbackNote = 'Sin escaneo en ' + LANG_LABELS[lang] + ': imagen en inglés.'; }
          } catch { }
        }
        if (!card.image) fallbackNote = 'Aún no hay escaneo en ' + LANG_LABELS[lang] + '.';
      }
      modalCard = card;
      setupVariants(card);
      paintModal(card);
      if (fallbackNote) { note.textContent = fallbackNote; note.hidden = false; }
    }
  } finally {
    modalLangBusy = false;
    sel.disabled = false;
  }
});

async function openModal(card, variant) {
  modalCard = card; modalQty = 1; modalVariant = variant || 'normal';
  $('qty-value').textContent = '1';
  $('modal-added').hidden = true;
  // Si llega una ficha breve (sin variants), hidrata para variantes/precios completos
  if (card.id && !card.variants) {
    try {
      const full = await getCard(card.id, card._lang);
      if (card._lang) full._lang = card._lang;
      if (card._externalImage) full._externalImage = card._externalImage;
      card = modalCard = full;
    } catch { }
  }
  setupLangSelector(card);
  setupVariants(card);
  paintModal(card);
  $('card-modal').hidden = false;
  // Carta sin escaneo en su idioma: respaldo a la imagen inglesa con aviso sutil
  if (card.id && !card.image && !card._externalImage && card._lang && card._lang !== 'en') {
    (async () => {
      const en = await getCard(card.id, 'en').catch(() => null);
      if (modalCard !== card) return;
      const note = $('modal-lang-note');
      const enImage = en && inferredImageBase(en, 'en');
      if (enImage) {
        card.image = enImage;
        paintModal(card);
        note.textContent = 'Sin escaneo en ' + LANG_LABELS[card._lang] + ': imagen en inglés.';
      } else {
        note.textContent = 'Aún no hay escaneo en ' + LANG_LABELS[card._lang] + '.';
      }
      note.hidden = false;
    })();
  }
}
function paintModal(card) {
  paintModalImage(card);
  paintModalFoil();
  $('modal-name').textContent = card.name;
  $('modal-set').textContent = (card.set && card.set.name ? card.set.name : '') + (card.localId ? ' · #' + card.localId : '');
  $('modal-rarity').textContent = card.rarity || '';
  paintPrices(card);
  paintAddBtn(card);
}
const prow = (k, v) => '<div class="prow"><span>' + k + '</span><span>' + v + '</span></div>';

$('modal-close').addEventListener('click', () => $('card-modal').hidden = true);
$('card-modal').addEventListener('click', (e) => { if (e.target === $('card-modal')) $('card-modal').hidden = true; });
$('qty-minus').addEventListener('click', () => { modalQty = Math.max(1, modalQty - 1); $('qty-value').textContent = modalQty; });
$('qty-plus').addEventListener('click', () => { modalQty = Math.min(99, modalQty + 1); $('qty-value').textContent = modalQty; });

$('modal-add').addEventListener('click', async () => {
  if (!modalCard) return;
  await collAdd({
    id: modalCard.id || ('ext:' + modalCard.name + ':' + (modalCard.set && modalCard.set.name || '')),
    tcgdexId: modalCard.id || null,
    lang: modalCard._lang || null,
    name: modalCard.name,
    setName: modalCard.set && modalCard.set.name || '',
    localId: modalCard.localId || '',
    image: modalCard._externalImage || (inferredImageBase(modalCard) ? imgLow(inferredImageBase(modalCard)) : ''),
    variant: modalVariant,
    qty: modalQty,
    addedAt: Date.now()
  });
  // collAdd actualiza el estado/backend; si estamos en Colección, repinta el grid
  // antes de cerrar la ficha para que la nueva entrada aparezca sin F5.
  if ($('tab-collection').classList.contains('active')) await renderCollection();
  $('modal-added').hidden = false;
  setTimeout(() => { $('card-modal').hidden = true; }, 700);
});

/* ---------- Histórico de valor ---------- */
const localDateKey = (date = new Date()) => {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
};
const dateDaysAgo = days => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return localDateKey(d); };
let valueHistory = [];

async function loadValueHistory() {
  if (!session) { valueHistory = []; renderValueHistory(); return; }
  const { data, error } = await sb.from('collection_value_history')
    .select('value_date,total_cents,approximate').order('value_date', { ascending: true });
  if (error) { console.warn('value history load', error); return renderValueHistory(true); }
  valueHistory = (data || []).map(r => ({ date: r.value_date, value: Number(r.total_cents) / 100, approximate: !!r.approximate }));
  renderValueHistory();
}

async function saveValueSnapshot(total, avg30Total, avg30Priced) {
  if (!session || !Number.isFinite(total)) return;
  // Escalabilidad: el histórico es append/upsert diario, nunca se recalcula hacia atrás.
  // Si el volumen lo exige: conservar detalle diario ~90 días y compactar lo anterior
  // a puntos semanales y, más adelante, mensuales mediante un job de base de datos.
  if (!valueHistory.length && avg30Priced > 0 && Number.isFinite(avg30Total)) {
    await sb.from('collection_value_history').upsert({
      user_id: session.user.id, value_date: dateDaysAgo(30), total_cents: Math.max(0, Math.round(avg30Total * 100)), approximate: true
    }, { onConflict: 'user_id,value_date' });
  }
  const { error } = await sb.from('collection_value_history').upsert({
    user_id: session.user.id, value_date: localDateKey(), total_cents: Math.max(0, Math.round(total * 100)), approximate: false
  }, { onConflict: 'user_id,value_date' });
  if (error) console.warn('value history save', error);
  await loadValueHistory();
}

function renderValueHistory(loadError = false) {
  const chart = $('value-history-chart'), summary = $('value-history-summary'), change = $('value-history-change'), legend = $('value-history-legend');
  if (!chart) return;
  change.hidden = true; legend.hidden = true;
  if (!session) {
    summary.textContent = 'Inicia sesión para guardar tu histórico de forma permanente.';
    chart.innerHTML = '<div class="value-history-empty">Tu evolución aparecerá aquí cuando tengas una cuenta y actualices los precios.</div>';
    return;
  }
  if (loadError) {
    summary.textContent = 'No se pudo cargar el histórico ahora mismo.';
    chart.innerHTML = '<div class="value-history-empty">El histórico sigue guardado. Vuelve a intentarlo más tarde.</div>';
    return;
  }
  const points = valueHistory.filter(p => Number.isFinite(p.value));
  if (!points.length) {
    summary.textContent = 'Actualiza los precios para guardar el primer punto.';
    chart.innerHTML = '<div class="value-history-empty">La gráfica empezará con una referencia aproximada de hace 30 días y el valor de hoy.</div>';
    return;
  }
  const first = points[0], last = points[points.length - 1], delta = last.value - first.value;
  summary.textContent = points.length + (points.length === 1 ? ' punto guardado' : ' puntos guardados') + ' · desde ' + formatDate(first.date);
  if (points.length > 1) {
    change.hidden = false;
    change.className = 'value-change' + (delta < 0 ? ' down' : '');
    change.textContent = (delta >= 0 ? '+' : '') + eur(delta);
  }
  const W = 640, H = 220, L = 54, R = 18, T = 18, B = 35, iw = W - L - R, ih = H - T - B;
  const values = points.map(p => p.value), rawMin = Math.min(...values), rawMax = Math.max(...values);
  const pad = Math.max((rawMax - rawMin) * .14, rawMax * .035, 1);
  const min = Math.max(0, rawMin - pad), max = rawMax + pad, span = Math.max(max - min, 1);
  const times = points.map(p => new Date(p.date + 'T12:00:00').getTime()), t0 = Math.min(...times), t1 = Math.max(...times);
  const x = (i) => points.length === 1 ? L + iw / 2 : L + ((times[i] - t0) / Math.max(t1 - t0, 1)) * iw;
  const y = (v) => T + (1 - (v - min) / span) * ih;
  const coords = points.map((p, i) => [x(i), y(p.value)]);
  const line = coords.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
  const area = line + ' L ' + coords[coords.length - 1][0].toFixed(1) + ' ' + (T + ih) + ' L ' + coords[0][0].toFixed(1) + ' ' + (T + ih) + ' Z';
  const grids = [0, .5, 1].map(q => { const gy = T + q * ih, val = max - q * span; return '<line class="value-chart-grid" x1="' + L + '" y1="' + gy + '" x2="' + (W-R) + '" y2="' + gy + '"/><text class="value-chart-axis" x="' + (L-8) + '" y="' + (gy+4) + '" text-anchor="end">' + esc(eur(val)) + '</text>'; }).join('');
  const dots = points.map((p, i) => '<circle class="value-chart-dot' + (p.approximate ? ' approx' : '') + '" cx="' + coords[i][0].toFixed(1) + '" cy="' + coords[i][1].toFixed(1) + '" r="5"><title>' + esc(formatDate(p.date) + ': ' + eur(p.value) + (p.approximate ? ' (aprox.)' : '')) + '</title></circle>').join('');
  const dateLabels = '<text class="value-chart-axis" x="' + coords[0][0].toFixed(1) + '" y="' + (H-9) + '" text-anchor="start">' + esc(formatDate(first.date)) + '</text>' + (points.length > 1 ? '<text class="value-chart-axis" x="' + coords[coords.length-1][0].toFixed(1) + '" y="' + (H-9) + '" text-anchor="end">' + esc(formatDate(last.date)) + '</text>' : '');
  chart.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><defs><linearGradient id="value-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd45e" stop-opacity=".28"/><stop offset="1" stop-color="#ffd45e" stop-opacity=".02"/></linearGradient></defs>' + grids + '<path class="value-chart-area" d="' + area + '"/><path class="value-chart-line" d="' + line + '"/>' + dots + dateLabels + '</svg>';
  legend.hidden = false;
}

/* ---------- Colección ---------- */
async function priceFor(entry, force = false, loadedCard = null) {
  if (!entry.tcgdexId) return null;
  const key = entry.tcgdexId + ':' + (entry.variant || 'normal');
  const cached = priceCache[key];
  if (!force && cached && Date.now() - cached.fetchedAt < 864e5) return cached;
  try {
    const card = loadedCard || await getCard(entry.tcgdexId, entry.lang);
    const p = cardmarketPrices(card, entry.variant || 'normal');
    if (p) {
      priceCache[key] = { trend: p.trend || p.avg30 || p.avg || p.low, avg: p.avg30 ?? p.avg, low: p.low, fetchedAt: Date.now() };
      store.set('pk.prices', priceCache);
      return priceCache[key];
    }
  } catch { }
  return cached || null;
}

let collectionRenderGeneration = 0;
async function renderCollection(forcePrices = false) {
  const generation = ++collectionRenderGeneration;
  const grid = $('collection-grid'), empty = $('collection-empty'), status = $('collection-status');
  grid.innerHTML = '';
  empty.hidden = collection.length > 0;
  $('collection-total').textContent = '—';
  if (!collection.length) {
    renderValueHistory();
    empty.textContent = session
      ? 'Aún no tienes cartas guardadas. Escanea o busca tu primera carta.'
      : 'Aún no tienes cartas guardadas. Crea una cuenta (botón 👤 arriba) para sincronizar tu colección entre dispositivos.';
    return;
  }
  status.hidden = false; status.className = 'status';
  status.textContent = 'Cargando precios…';

  let total = 0, priced = 0, avg30Total = 0, avg30Priced = 0;
  for (const entry of [...collection]) {
    let card = null;
    if (entry.tcgdexId) {
      try {
        card = await getCard(entry.tcgdexId, entry.lang || 'en');
        card._lang = entry.lang || 'en';
        if (!card.image && entry.image) card._externalImage = entry.image;
      } catch { }
    }
    const p = await priceFor(entry, forcePrices, card);
    if (generation !== collectionRenderGeneration) return;
    const unit = p && p.trend;
    if (unit != null) { total += unit * entry.qty; priced++; }
    if (p && p.avg != null) { avg30Total += p.avg * entry.qty; avg30Priced++; }
    const div = document.createElement('div');
    div.className = 'grid-card';
    div.innerHTML =
      '<div class="foil-card grid-foil' + foilClass(entry.variant || 'normal') + '">' +
        '<img alt="' + esc(entry.name) + '" loading="lazy">' +
        '<span class="foil-layer" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></span>' +
        '<span class="lang-flag" title="' + esc(LANG_LABELS[entry.lang] || entry.lang || 'Idioma sin registrar') + '" aria-label="' + esc(LANG_LABELS[entry.lang] || entry.lang || 'Idioma sin registrar') + '"><span aria-hidden="true">' + esc(LANG_FLAGS[entry.lang] || '🌐') + '</span></span>' +
      '</div>' +
      '<div class="gname">' + esc(entry.name) + '</div>' +
      '<div class="gset">' + esc(entry.setName) + '</div>' +
      '<div class="gprice">' + (unit != null ? eur(unit) + ' /u' : '—') + '</div>' +
      '<span class="gqty">×' + entry.qty + '</span>' +
      '<div class="qty-controls">' +
      '<button data-a="minus">−</button><button data-a="plus">+</button><button data-a="del">🗑</button>' +
      '</div>';
    const thumb = div.querySelector('.grid-foil > img');
    if (card) applyResolvedVariantImage(thumb, card, entry.variant || 'normal');
    else {
      thumb.onerror = () => { thumb.onerror = null; thumb.src = 'icon.svg'; };
      thumb.src = entry.image || 'icon.svg';
    }
    div.querySelectorAll('button').forEach(b => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (b.dataset.a === 'plus') await collSetQty(entry, Math.min(99, entry.qty + 1));
      if (b.dataset.a === 'minus') await collSetQty(entry, Math.max(1, entry.qty - 1));
      if (b.dataset.a === 'del') await collDelete(entry);
      renderCollection();
    }));
    div.addEventListener('click', async () => {
      if (entry.tcgdexId) {
        try {
          // La entrada concreta manda: ficha localizada (legacy sin lang → inglés)
          // y variante guardada preseleccionada en el modal.
          const entryLang = entry.lang || 'en';
          const c = await getCard(entry.tcgdexId, entryLang);
          c._lang = entryLang;
          if (!c.image && entry.image) c._externalImage = entry.image;
          openModal(c, entry.variant || 'normal');
        } catch { }
      }
    });
    grid.appendChild(div);
  }
  if (generation !== collectionRenderGeneration) return;
  status.hidden = true;
  $('collection-total').textContent = priced ? eur(total) : '—';
  if (forcePrices && priced) await saveValueSnapshot(total, avg30Total, avg30Priced);
  else await loadValueHistory();
}

$('btn-refresh-prices').addEventListener('click', () => renderCollection(true));

/* ---------- misc ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : (value || '');
}
loadSets().catch(() => { });
