import { Engine, FX_PRESETS, takeStart } from './engine.js?v=3';
import { store, isQuotaError } from './store.js?v=3';
import { encodeWav, bufferToWav, peakOf } from './wav.js?v=3';
import { makeZip, readZip } from './zip.js?v=3';
import { fmtTime, textToLines, parseLRC, parseSRT, toLRC, toSRT, lyricState } from './lyrics.js?v=3';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => (s || '').normalize('NFD').replace(/[֑-ׇ̀-ͯ]/g, '').toLowerCase().trim();
const detectLang = s => /[֐-׿]/.test(s) ? 'he' : /[a-z]/i.test(s) ? 'en' : 'other';
const ls = {
  get(k, d) { try { const v = localStorage.getItem('ks-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ks-' + k, JSON.stringify(v)); } catch {} },
};

const engine = new Engine();
window.__ks = { engine, store }; // for automated tests
let catalog = [];
let projects = [];
let current = null;
const S = { view: null, tab: 'mix', tap: null, recording: false, counting: false, saveTimer: null, refreshTimer: null, favs: new Set(ls.get('favs', [])), favOnly: false, dragging: false, lastLyricKey: '' };

// ---------------- helpers ----------------
function msg(el, text, kind = '') { el = typeof el === 'string' ? $(el) : el; el.textContent = text; el.className = 'msg ' + kind; }
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function dialog(title, bodyHTML, okLabel = 'אישור') {
  return new Promise(res => {
    $('#dlgTitle').textContent = title; $('#dlgBody').innerHTML = bodyHTML; $('#dlgOk').textContent = okLabel;
    $('#dialog').hidden = false;
    const first = $('#dlgBody input'); (first || $('#dlgOk')).focus();
    const done = ok => { $('#dialog').hidden = true; $('#dlgOk').onclick = $('#dlgCancel').onclick = null; res(ok); };
    $('#dlgOk').onclick = () => done(true); $('#dlgCancel').onclick = () => done(false);
  });
}
function setSaveStatus(text, kind = '') { const el = $('#saveStatus'); el.textContent = text; el.style.color = kind === 'err' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : ''; }

function newProject(fields) {
  return Object.assign({
    format: 'karaoke-studio-project', version: 1, id: uid(), title: '', artist: '', lang: 'he',
    createdAt: Date.now(), source: { kind: 'user' }, tracks: [], takes: [],
    lyrics: { lines: [], offset: 0 }, mix: { playback: 1, vocals: 1, master: 0.9 },
  }, fields);
}

async function saveNow() {
  if (!current) return false;
  clearTimeout(S.saveTimer);
  try {
    await store.putProject(current);
    store.persist();
    const t = new Date();
    setSaveStatus('נשמר במכשיר · ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), 'ok');
    return true;
  } catch (e) {
    setSaveStatus(isQuotaError(e) ? 'אין מספיק מקום במכשיר – השמירה נכשלה. מחקו פרויקטים ישנים או ייצאו קובץ פרויקט.' : 'השמירה נכשלה: ' + (e.message || e), 'err');
    return false;
  }
}
function markDirty() { setSaveStatus('שומר…'); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(saveNow, 600); }
function refreshSoon() { clearTimeout(S.refreshTimer); S.refreshTimer = setTimeout(() => engine.refresh(), 160); }

async function loadProject(p, statusEl) {
  engine.stop();
  engine.buffers.clear();
  const keys = [...p.tracks.map(t => t.fileKey), ...p.takes.map(t => t.fileKey)];
  let n = 0;
  for (const k of keys) {
    if (statusEl) msg(statusEl, `טוען שמע… (${++n}/${keys.length})`);
    const blob = await store.getFile(p.id, k);
    if (!blob) { console.warn('missing file', k); continue; }
    try { engine.buffers.set(k, await engine.decode(blob)); } catch (e) { console.warn('decode failed', k, e); }
  }
  current = p;
  engine.setProject(p);
  ls.set('last', p.id);
  if (statusEl) msg(statusEl, '');
  return p;
}

// ---------------- catalog & library ----------------
async function loadCatalog() {
  try {
    const r = await fetch('catalog.json', { cache: 'no-cache' });
    const j = await r.json();
    catalog = (j.items || []).filter(i => i.id && i.title);
  } catch (e) { catalog = []; console.warn('catalog failed', e); }
}

async function openCatalogItem(item) {
  let p = await store.getProject(item.id);
  if (!p) {
    msg('#importMsg', 'מכין את השיר במכשיר…');
    const song = await (await fetch(item.project.song)).json();
    const tracks = [];
    for (const [i, t] of item.project.tracks.entries()) {
      const blob = await (await fetch(t.file)).blob();
      const key = `track-${i}-${t.role}.${t.file.split('.').pop()}`;
      await store.putFile(item.id, key, blob);
      tracks.push({ id: 'tr' + i, name: t.name, role: t.role, fileKey: key, gain: 1, mute: !!t.mute, solo: false });
    }
    p = newProject({ id: item.id, title: item.title, artist: item.artist, lang: item.lang, tracks,
      source: { kind: 'catalog', catalogId: item.id, name: item.source, license: item.license, url: item.url },
      lyrics: { lines: song.lyrics, offset: 0 } });
    await store.putProject(p);
  }
  await loadProject(p, '#importMsg');
  return p;
}

async function refreshProjects() { try { projects = await store.listProjects(); } catch { projects = []; } }

function libraryItems() {
  const items = catalog.map(c => {
    const p = projects.find(x => x.id === c.id);
    return { key: c.id, title: c.title, artist: c.artist, lang: c.lang, type: c.type, source: c.source, license: c.license, catalog: c, takes: p ? p.takes.length : 0, local: !!p };
  });
  for (const p of projects) {
    if (catalog.some(c => c.id === p.id)) continue;
    items.push({ key: p.id, title: p.title || 'ללא שם', artist: p.artist, lang: p.lang, type: 'studio', source: p.source && p.source.kind === 'imported' ? 'קובץ פרויקט מיובא' : 'ייבוא מהמכשיר', project: p, takes: p.takes.length, local: true });
  }
  return items;
}

function renderLibrary() {
  const q = norm($('#q').value), lang = $('#langFilter').value;
  const list = libraryItems().filter(it => {
    if (S.favOnly && !S.favs.has(it.key)) return false;
    if (lang && (it.lang || 'other') !== lang) return false;
    if (q && !norm(it.title + ' ' + it.artist).includes(q)) return false;
    return true;
  });
  $('#songList').innerHTML = list.map(it => `
    <li class="song" data-key="${esc(it.key)}">
      <div class="art" aria-hidden="true">${esc((it.title || '?').trim().charAt(0))}</div>
      <div>
        <div class="name" dir="auto">${esc(it.title)}</div>
        <div class="by" dir="auto">${esc(it.artist || '')}</div>
        <div class="badges">
          <span class="badge rec">שירה והקלטה באולפן</span>
          <span class="badge">${esc(it.source || '')}</span>
          ${it.local ? '<span class="badge">שמור במכשיר</span>' : ''}
          ${it.takes ? `<span class="badge">${it.takes} טייקים</span>` : ''}
        </div>
        ${it.license ? `<div class="by small">שימוש: ${esc(it.license)}</div>` : ''}
      </div>
      <div class="acts">
        <button class="fav" data-act="fav" aria-pressed="${S.favs.has(it.key)}" aria-label="מועדף">${S.favs.has(it.key) ? '★' : '☆'}</button>
        <button class="btn ghost small" data-act="studio">אולפן</button>
        <button class="btn small" data-act="sing">לשיר</button>
      </div>
    </li>`).join('');
  $('#emptyList').hidden = list.length > 0;
}

async function openLibraryItem(key, target) {
  try {
    const c = catalog.find(x => x.id === key);
    if (c) await openCatalogItem(c);
    else { const p = await store.getProject(key); await loadProject(p, '#importMsg'); }
    location.hash = target;
  } catch (e) {
    console.error(e);
    msg('#importMsg', 'לא הצלחנו לפתוח את השיר. בדקו חיבור לרשת (בפעם הראשונה) ונסו שוב.', 'err');
  }
}

$('#songList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const key = b.closest('.song').dataset.key;
  if (b.dataset.act === 'fav') {
    S.favs.has(key) ? S.favs.delete(key) : S.favs.add(key);
    ls.set('favs', [...S.favs]); renderLibrary();
  } else openLibraryItem(key, b.dataset.act);
});
$('#q').addEventListener('input', renderLibrary);
$('#langFilter').addEventListener('change', renderLibrary);
$('#favFilter').addEventListener('click', e => { S.favOnly = !S.favOnly; e.currentTarget.setAttribute('aria-pressed', S.favOnly); renderLibrary(); });

// ---------------- importing audio ----------------
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'mp4', 'ogg', 'oga', 'opus', 'flac', 'webm'];
function audioCheck(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!(file.type.startsWith('audio/') || AUDIO_EXT.includes(ext))) return { ok: false, text: 'זה לא קובץ אודיו נתמך. אפשר לייבא MP3, WAV או M4A.' };
  return { ok: true, ext: AUDIO_EXT.includes(ext) ? ext : 'audio' };
}
async function decodeOrExplain(file, el) {
  try { return await engine.decode(file); }
  catch (e) {
    msg(el, 'הדפדפן במכשיר הזה לא מצליח לפענח את הקובץ' + (/m4a|aac|mp4/i.test(file.name) ? ' (M4A/AAC)' : '') + '. המירו אותו ל-MP3 או WAV ונסו שוב.', 'err');
    return null;
  }
}

$('#importPlayback').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const chk = audioCheck(file);
  if (!chk.ok) return msg('#importMsg', chk.text, 'err');
  msg('#importMsg', 'בודק את הקובץ…');
  const buf = await decodeOrExplain(file, '#importMsg'); if (!buf) return;
  const base = file.name.replace(/\.[^.]+$/, '');
  const ok = await dialog('פלייבק חדש', `<label>שם השיר<input id="dT" dir="auto" value="${esc(base)}"></label><label>אמן<input id="dA" dir="auto" value=""></label>
    <label class="switch"><input id="dR" type="checkbox" checked> הקובץ שלי או שיש לי רשות להשתמש בו</label>`, 'יצירת פרויקט');
  if (!ok) return msg('#importMsg', '');
  if (!$('#dR').checked) return msg('#importMsg', 'אפשר לייבא רק קבצים שיש לכם רשות להשתמש בהם.', 'err');
  const title = $('#dT').value.trim() || base, artist = $('#dA').value.trim();
  const p = newProject({ title, artist, lang: detectLang(title + artist), source: { kind: 'user', file: file.name } });
  const key = 'playback.' + chk.ext;
  try {
    await store.putFile(p.id, key, file);
    p.tracks.push({ id: 'tr0', name: 'פלייבק', role: 'playback', fileKey: key, gain: 1, mute: false, solo: false });
    await store.putProject(p);
  } catch (err) { return msg('#importMsg', isQuotaError(err) ? 'אין מספיק מקום במכשיר לשמירת הקובץ.' : 'שמירת הקובץ נכשלה.', 'err'); }
  current = p; engine.buffers.clear(); engine.buffers.set(key, buf); engine.setProject(p); ls.set('last', p.id);
  msg('#importMsg', '');
  S.tab = 'lyrics'; location.hash = 'studio';
});

$('#importProject').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  msg('#importMsg', 'פותח קובץ פרויקט…');
  try {
    const files = await readZip(file);
    if (!files['project.json']) throw new Error('not-project');
    const p = JSON.parse(new TextDecoder().decode(files['project.json']));
    if (p.format !== 'karaoke-studio-project') throw new Error('not-project');
    const exists = await store.getProject(p.id);
    if (exists) { p.id = uid(); p.title = (p.title || '') + ' (עותק)'; }
    p.source = Object.assign({}, p.source, { importedAt: Date.now() });
    const types = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
    for (const k of [...p.tracks.map(t => t.fileKey), ...p.takes.map(t => t.fileKey)]) {
      const data = files['files/' + k];
      if (!data) throw new Error('missing:' + k);
      await store.putFile(p.id, k, new Blob([data], { type: types[k.split('.').pop()] || '' }));
    }
    await store.putProject(p);
    await loadProject(p, '#importMsg');
    msg('#importMsg', 'הפרויקט נפתח.', 'ok');
    location.hash = 'studio';
  } catch (err) {
    console.error(err);
    const m = String(err.message || '');
    msg('#importMsg', m.startsWith('missing') ? 'קובץ הפרויקט חסר חלק מקבצי השמע.' : isQuotaError(err) ? 'אין מספיק מקום במכשיר לפתיחת הפרויקט.' : 'זה לא קובץ פרויקט של קריוקי סטודיו.', 'err');
  }
});

// ---------------- routing ----------------
async function show(view) {
  if (!['library', 'sing', 'studio'].includes(view)) view = 'library';
  if (S.recording && view !== 'sing') await finishRec('nav');
  if (S.tap && view !== 'studio') endTap();
  if (view === 'library') engine.pause();
  S.view = view;
  for (const v of ['library', 'sing', 'studio']) $('#view-' + v).hidden = v !== view;
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === view || (view === 'sing' && a.dataset.nav === 'library')));
  if (view === 'library') { await refreshProjects(); renderLibrary(); }
  if ((view === 'sing' || view === 'studio') && !current) {
    $('#lineCur').className = 'line-cur idle'; $('#lineCur').textContent = 'טוען את השיר…';
    const last = ls.get('last');
    if (last) { const p = await store.getProject(last).catch(() => null); if (p) await loadProject(p); }
  }
  if (view === 'sing') renderSing();
  if (view === 'studio') renderStudio();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));

// ---------------- sing view ----------------
function renderSing() {
  if (!current) { location.hash = 'library'; return; }
  $('#singTitle').textContent = current.title;
  $('#singArtist').textContent = current.artist || '';
  const voc = current.tracks.filter(t => t.role === 'vocals');
  $('#guideBtn').hidden = !voc.length;
  updateGuideBtn();
  S.lastLyricKey = '';
  msg('#singMsg', '');
}
function updateGuideBtn() {
  if (!current) return;
  const voc = current.tracks.filter(t => t.role === 'vocals');
  const on = voc.some(t => !t.mute);
  $('#guideBtn').textContent = 'קול הזמר: ' + (on ? 'פועל' : 'מושתק');
  $('#guideBtn').setAttribute('aria-pressed', on);
  $('#muteVocals').hidden = !voc.length;
  $('#muteVocals').setAttribute('aria-pressed', !on);
}
function toggleVocals() {
  const voc = current.tracks.filter(t => t.role === 'vocals');
  const on = voc.some(t => !t.mute);
  voc.forEach(t => t.mute = on);
  engine.updateGains(); updateGuideBtn(); markDirty(); if (S.view === 'studio') renderTracks();
}
$('#guideBtn').addEventListener('click', toggleVocals);
$('#muteVocals').addEventListener('click', toggleVocals);

async function togglePlay() {
  if (!current) return;
  if (S.recording) return finishRec('user');
  engine.playing ? engine.pause() : await engine.play();
}
$('#playBtn').addEventListener('click', togglePlay);
$('#sPlay').addEventListener('click', togglePlay);
$('#back5').addEventListener('click', () => !S.recording && engine.seek(engine.position() - 5));
$('#fwd5').addEventListener('click', () => !S.recording && engine.seek(engine.position() + 5));
for (const id of ['#seek', '#sSeek']) {
  const el = $(id);
  el.addEventListener('pointerdown', () => S.dragging = true);
  el.addEventListener('input', () => { S.dragging = true; $(id === '#seek' ? '#tCur' : '#sTime').textContent = fmtTime(+el.value).slice(0, 5); });
  el.addEventListener('change', async () => { if (!S.recording) await engine.seek(+el.value); S.dragging = false; });
}
engine.onended = () => { if (S.recording) finishRec('end'); };
engine.onInterrupt = reason => { if (S.recording) finishRec(reason); };
document.addEventListener('visibilitychange', () => { if (document.hidden && S.recording) finishRec('hidden'); });
window.addEventListener('pagehide', () => { if (S.recording) finishRec('hidden'); });

function micError(e) {
  const n = e && (e.code || e.name);
  if (n === 'insecure') return 'הקלטה אפשרית רק כשהאתר נפתח בכתובת מאובטחת (https) או מ-localhost.';
  if (n === 'unsupported') return 'הדפדפן הזה לא תומך בהקלטה. נסו Chrome, Safari, Edge או Firefox בגרסה עדכנית.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'הגישה למיקרופון נדחתה. כדי להקליט, אפשרו מיקרופון בהגדרות האתר בדפדפן (בדרך כלל דרך סמל המנעול ליד הכתובת), ואז לחצו שוב על הקלטה.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'לא נמצא מיקרופון במכשיר.';
  if (n === 'NotReadableError') return 'המיקרופון תפוס על ידי אפליקציה אחרת. סגרו אותה ונסו שוב.';
  return 'לא הצלחנו להפעיל את המיקרופון: ' + (e && e.message || e);
}

async function startRec() {
  if (!current || S.recording || S.counting) return;
  msg('#singMsg', '');
  try { await engine.openMic({ processing: !$('#optPhones').checked }); }
  catch (e) { engine.closeMic(); return msg('#singMsg', micError(e), 'err'); }
  if ($('#optCount').checked) {
    S.counting = true;
    const cd = $('#countdown'); cd.hidden = false;
    for (let i = 3; i > 0; i--) { cd.textContent = i; await new Promise(r => setTimeout(r, 1000)); if (!S.counting) { cd.hidden = true; engine.closeMic(); return; } }
    cd.hidden = true; S.counting = false;
  }
  await engine.startRecording();
  S.recording = true;
  $('#recBtn').classList.add('on'); $('#recBtn').setAttribute('aria-label', 'עצירת הקלטה');
  $('#recState').hidden = false;
}

async function finishRec(reason) {
  if (!S.recording) return;
  S.recording = false;
  $('#recBtn').classList.remove('on'); $('#recBtn').setAttribute('aria-label', 'הקלטה'); $('#recState').hidden = true;
  const r = await engine.stopRecording();
  engine.closeMic();
  $('#meterBar').style.width = '0';
  if (!r || r.samples.length < r.sampleRate * 0.5) return msg('#singMsg', 'הטייק קצר מדי ולא נשמר.', 'err');
  const p = current;
  const take = { id: uid(), name: 'טייק ' + (p.takes.length + 1), fileKey: '', start: r.start, latency: r.latency, offsetMs: 0, gain: 1, mute: false,
    trimStart: 0, trimEnd: null, fx: { preset: 'none', amount: 0.7, eq: { low: 0, mid: 0, high: 0 } }, createdAt: Date.now(), source: 'mic' };
  take.fileKey = 'take-' + take.id + '.wav';
  const buf = engine.ctx.createBuffer(1, r.samples.length, r.sampleRate);
  buf.copyToChannel(r.samples, 0);
  engine.buffers.set(take.fileKey, buf);
  p.takes.forEach(t => t.mute = true);
  p.takes.push(take);
  const blob = encodeWav([r.samples], r.sampleRate, 16);
  let saved = false;
  try { await store.putFile(p.id, take.fileKey, blob); saved = await saveNow(); }
  catch (e) { setSaveStatus(isQuotaError(e) ? 'אין מספיק מקום במכשיר לשמירת הטייק.' : 'שמירת הטייק נכשלה.', 'err'); }
  const why = { hidden: ' ההקלטה נעצרה כי האפליקציה עברה לרקע או שהמסך ננעל.', 'mic-ended': ' ההקלטה נעצרה כי המיקרופון נותק.', 'audio-interrupted': ' ההקלטה נעצרה בגלל הפרעה במערכת השמע.', end: ' השיר הסתיים.', nav: '' }[reason] || '';
  const secs = (r.samples.length / r.sampleRate).toFixed(1);
  if (saved) msg('#singMsg', `${take.name} נשמר (${secs} שניות).${why} אפשר לשמוע ולכוון אותו באולפן.`, 'ok');
  else { msg('#singMsg', `${take.name} הוקלט אבל לא נשמר במכשיר.${why} ייצאו אותו עכשיו מהאולפן כדי לא לאבד אותו.`, 'err'); }
}
$('#recBtn').addEventListener('click', () => { if (S.counting) { S.counting = false; return; } S.recording ? finishRec('user') : startRec(); });

function renderLyricStage(t) {
  const L = current.lyrics;
  const cur = $('#lineCur'), next = $('#lineNext');
  if (!L.lines.length || !L.lines.some(l => l.t != null)) {
    if (S.lastLyricKey !== 'none') { cur.className = 'line-cur idle'; cur.textContent = L.lines.length ? 'המילים עוד לא מתוזמנות – אפשר לתזמן באולפן' : 'אין מילים לשיר הזה עדיין – אפשר להוסיף באולפן'; next.textContent = ''; S.lastLyricKey = 'none'; }
    return;
  }
  const st = lyricState(L.lines, t, L.offset || 0);
  let key, html, cls, nextText;
  if (st.cur && st.active) {
    key = st.index + ':' + st.wordIndex;
    if (st.cur.words && st.cur.words.length) { html = st.cur.words.map((w, i) => `<span class="w${i <= st.wordIndex ? ' on' : ''}">${esc(w.text)}</span>`).join(' '); cls = 'line-cur'; }
    else { html = esc(st.cur.text); cls = 'line-cur lit'; }
    nextText = st.next ? st.next.text : '';
  } else if (st.next) {
    const wait = st.untilNext;
    if (wait > 3.5) {
      const n = Math.ceil(wait);
      key = 'wait' + st.index + ':' + n;
      html = (st.index < 0 ? 'מתחילים בעוד ' : '♪ הפסקה מוזיקלית · השורה הבאה בעוד ') + n;
      cls = 'line-cur idle'; nextText = st.next.text;
    } else {
      key = 'pre' + st.index;
      const w = st.next.words;
      html = w && w.length ? w.map(x => `<span class="w">${esc(x.text)}</span>`).join(' ') : esc(st.next.text);
      cls = 'line-cur';
      const after = st.timed[st.index + 2];
      nextText = after ? after.text : '';
    }
  } else { key = 'end'; html = 'סוף השיר'; cls = 'line-cur idle'; nextText = ''; }
  if (key !== S.lastLyricKey) { cur.className = cls; cur.innerHTML = html; next.textContent = nextText; S.lastLyricKey = key; }
}

// ---------------- studio ----------------
function renderStudio() {
  $('#studioEmpty').hidden = !!current; $('#studioMain').hidden = !current;
  if (!current) return;
  $('#pTitle').value = current.title; $('#pArtist').value = current.artist || '';
  for (const [id, k] of [['busPlay', 'playback'], ['busVox', 'vocals'], ['busMaster', 'master']]) { $('#' + id).value = current.mix[k]; $('#' + id + 'V').textContent = Math.round(current.mix[k] * 100) + '%'; }
  $('#cmpOriginal').setAttribute('aria-pressed', engine.opts.original);
  $('#cmpFx').setAttribute('aria-pressed', !engine.opts.fx);
  updateGuideBtn(); renderTracks(); renderTakes(); renderLines(); setTab(S.tab); storageInfo();
}
function setTab(tab) {
  S.tab = tab;
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  for (const t of ['mix', 'lyrics', 'export']) $('#tab-' + t).hidden = t !== tab;
}
$$('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#pTitle').addEventListener('change', e => { current.title = e.target.value.trim() || current.title; markDirty(); });
$('#pArtist').addEventListener('change', e => { current.artist = e.target.value.trim(); markDirty(); });
for (const [id, k] of [['busPlay', 'playback'], ['busVox', 'vocals'], ['busMaster', 'master']]) {
  $('#' + id).addEventListener('input', e => { current.mix[k] = +e.target.value; $('#' + id + 'V').textContent = Math.round(current.mix[k] * 100) + '%'; engine.updateGains(); markDirty(); });
}
$('#cmpOriginal').addEventListener('click', e => { engine.opts.original = !engine.opts.original; e.currentTarget.setAttribute('aria-pressed', engine.opts.original); engine.refresh(); });
$('#cmpFx').addEventListener('click', e => { engine.opts.fx = !engine.opts.fx; e.currentTarget.setAttribute('aria-pressed', !engine.opts.fx); engine.refresh(); });

function renderTracks() {
  $('#trackList').innerHTML = current.tracks.map(t => `
    <li class="track" data-id="${t.id}">
      <span dir="auto">${esc(t.name)}</span>
      <button class="ms m" data-act="mute" aria-pressed="${t.mute}" aria-label="השתקה של ${esc(t.name)}">M</button>
      <button class="ms s" data-act="solo" aria-pressed="${t.solo}" aria-label="סולו של ${esc(t.name)}">S</button>
      <input type="range" min="0" max="1.5" step="0.01" value="${t.gain}" data-act="gain" aria-label="עוצמה של ${esc(t.name)}">
    </li>`).join('');
}
$('#trackList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const t = current.tracks.find(x => x.id === b.closest('.track').dataset.id);
  t[b.dataset.act] = !t[b.dataset.act];
  b.setAttribute('aria-pressed', t[b.dataset.act]);
  engine.updateGains(); updateGuideBtn(); markDirty();
});
$('#trackList').addEventListener('input', e => {
  if (e.target.dataset.act !== 'gain') return;
  const t = current.tracks.find(x => x.id === e.target.closest('.track').dataset.id);
  t.gain = +e.target.value; engine.updateGains(); markDirty();
});

function renderTakes() {
  const takes = current.takes;
  $('#noTakes').hidden = takes.length > 0;
  $('#takeList').innerHTML = takes.map(tk => {
    const b = engine.buffers.get(tk.fileKey);
    const dur = b ? b.duration : 0;
    const opts = Object.entries(FX_PRESETS).map(([k, v]) => `<option value="${k}" ${tk.fx.preset === k ? 'selected' : ''}>${v.label}</option>`).join('');
    const eq = tk.fx.eq || { low: 0, mid: 0, high: 0 };
    return `<li class="take" data-id="${tk.id}">
      <div class="take-head">
        <span class="nm">${esc(tk.name)}</span>
        <span class="muted small t">${fmtTime(dur).slice(0, 5)}</span>
        <button class="ms m" data-act="mute" aria-pressed="${tk.mute}" aria-label="השתקת ${esc(tk.name)}">M</button>
        <button class="chip" data-act="hear">▶ מהטייק</button>
        <button class="chip" data-act="dl">ייצוא</button>
        <button class="chip" data-act="del">מחיקה</button>
      </div>
      <div class="slider-row"><label>עוצמה</label><input type="range" min="0" max="2" step="0.01" value="${tk.gain}" data-act="gain"><output>${Math.round(tk.gain * 100)}%</output></div>
      <div class="slider-row"><label>היסט (מ״ש)</label><input type="range" min="-1000" max="1000" step="1" value="${tk.offsetMs}" data-act="offset"><input type="number" min="-5000" max="5000" step="1" value="${tk.offsetMs}" data-act="offsetN" aria-label="היסט במילישניות"></div>
      <div class="row wrap small">
        <button class="chip" data-act="trim">חיתוך שקט</button>
        ${tk.trimStart || tk.trimEnd != null ? `<span class="muted">נחתך: ${tk.trimStart.toFixed(2)}–${(tk.trimEnd ?? dur).toFixed(2)} ש׳</span><button class="chip" data-act="untrim">ביטול חיתוך</button>` : ''}
      </div>
      <div class="slider-row"><label>אפקט</label><select data-act="preset" aria-label="הגדרה מוכנה">${opts}</select><span></span></div>
      <div class="slider-row"><label>כמות אפקט</label><input type="range" min="0" max="1" step="0.01" value="${tk.fx.amount}" data-act="amount"><output>${Math.round(tk.fx.amount * 100)}%</output></div>
      <div class="slider-row"><label>EQ נמוכים</label><input type="range" min="-9" max="9" step="0.5" value="${eq.low}" data-act="eq-low"><output>${eq.low} dB</output></div>
      <div class="slider-row"><label>EQ אמצע</label><input type="range" min="-9" max="9" step="0.5" value="${eq.mid}" data-act="eq-mid"><output>${eq.mid} dB</output></div>
      <div class="slider-row"><label>EQ גבוהים</label><input type="range" min="-9" max="9" step="0.5" value="${eq.high}" data-act="eq-high"><output>${eq.high} dB</output></div>
    </li>`;
  }).join('');
}
function takeOf(el) { return current.takes.find(x => x.id === el.closest('.take').dataset.id); }
$('#takeList').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const tk = takeOf(b);
  const act = b.dataset.act;
  if (act === 'mute') { tk.mute = !tk.mute; b.setAttribute('aria-pressed', tk.mute); refreshSoon(); markDirty(); }
  if (act === 'hear') { if (tk.mute) { tk.mute = false; renderTakes(); } await engine.seek(Math.max(0, takeStart(tk) + (tk.trimStart || 0) - 1)); if (!engine.playing) await engine.play(); else refreshSoon(); }
  if (act === 'trim') {
    const buf = engine.buffers.get(tk.fileKey); if (!buf) return;
    const [a, z] = findVoiceBounds(buf);
    tk.trimStart = a; tk.trimEnd = z; renderTakes(); refreshSoon(); markDirty();
  }
  if (act === 'untrim') { tk.trimStart = 0; tk.trimEnd = null; renderTakes(); refreshSoon(); markDirty(); }
  if (act === 'dl') { setTab('export'); exportAudio('take', tk); }
  if (act === 'del') {
    if (!await dialog('מחיקת טייק', `<p>למחוק את ${esc(tk.name)}? אי אפשר לבטל.</p>`, 'מחיקה')) return;
    current.takes = current.takes.filter(x => x !== tk);
    engine.buffers.delete(tk.fileKey);
    await store.deleteFile(current.id, tk.fileKey).catch(() => {});
    renderTakes(); refreshSoon(); saveNow();
  }
});
$('#takeList').addEventListener('input', e => {
  const el = e.target, act = el.dataset.act; if (!act) return;
  const tk = takeOf(el);
  const out = el.parentElement.querySelector('output');
  if (act === 'gain') { tk.gain = +el.value; out.textContent = Math.round(tk.gain * 100) + '%'; engine.updateGains(); }
  if (act === 'offset' || act === 'offsetN') {
    tk.offsetMs = Math.round(+el.value || 0);
    const li = el.closest('.take');
    if (act === 'offset') li.querySelector('[data-act=offsetN]').value = tk.offsetMs; else li.querySelector('[data-act=offset]').value = tk.offsetMs;
    refreshSoon();
  }
  if (act === 'amount') { tk.fx.amount = +el.value; out.textContent = Math.round(tk.fx.amount * 100) + '%'; refreshSoon(); }
  if (act.startsWith('eq-')) { tk.fx.eq = tk.fx.eq || { low: 0, mid: 0, high: 0 }; tk.fx.eq[act.slice(3)] = +el.value; out.textContent = el.value + ' dB'; refreshSoon(); }
  markDirty();
});
$('#takeList').addEventListener('change', e => {
  if (e.target.dataset.act !== 'preset') return;
  takeOf(e.target).fx.preset = e.target.value; refreshSoon(); markDirty();
});

function findVoiceBounds(buf) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, win = Math.floor(sr * 0.02);
  let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = Math.max(peak * 0.06, 0.004);
  let first = -1, last = -1;
  for (let i = 0; i + win <= d.length; i += win) {
    let s = 0; for (let k = i; k < i + win; k++) s += d[k] * d[k];
    if (Math.sqrt(s / win) > thr * 0.5) { if (first < 0) first = i; last = i + win; }
  }
  if (first < 0) return [0, null];
  return [Math.max(0, first / sr - 0.15), Math.min(buf.duration, last / sr + 0.3)];
}

$('#importTake').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !current) return;
  const chk = audioCheck(file);
  const el = $('#exportMsg');
  if (!chk.ok) { setTab('export'); return msg(el, chk.text, 'err'); }
  const buf = await decodeOrExplain(file, el); if (!buf) { setTab('export'); return; }
  const take = { id: uid(), name: 'הקלטה מיובאת ' + (current.takes.length + 1), fileKey: '', start: 0, latency: 0, offsetMs: 0, gain: 1, mute: false, trimStart: 0, trimEnd: null,
    fx: { preset: 'none', amount: 0.7, eq: { low: 0, mid: 0, high: 0 } }, createdAt: Date.now(), source: 'import', file: file.name };
  take.fileKey = 'take-' + take.id + '.' + chk.ext;
  try { await store.putFile(current.id, take.fileKey, file); } catch (err) { setTab('export'); return msg(el, 'אין מספיק מקום במכשיר.', 'err'); }
  engine.buffers.set(take.fileKey, buf);
  current.takes.push(take); renderTakes(); refreshSoon(); saveNow();
});

// ---------------- lyrics editor ----------------
function renderLines() {
  const L = current.lyrics;
  $('#shiftV').textContent = (L.offset >= 0 ? '+' : '') + (L.offset || 0).toFixed(2);
  $('#lineList').innerHTML = L.lines.map((l, i) => {
    const prev = L.lines[i - 1];
    const flag = l.t == null ? 'לא מתוזמן' : prev && prev.t != null && l.t < prev.t ? 'לבדיקה: לפני השורה הקודמת' : '';
    return `<li data-i="${i}">
      <div class="tm"><button data-act="minus" aria-label="מוקדם יותר">−</button><span class="t ${l.t == null ? 'none' : ''}">${l.t == null ? '--:--' : fmtTime(l.t)}</span><button data-act="plus" aria-label="מאוחר יותר">+</button></div>
      <div><input class="txt" dir="auto" value="${esc(l.text)}" aria-label="שורה ${i + 1}">${flag ? `<div class="flag">${flag}</div>` : ''}</div>
      <div class="ops">
        <button data-act="play" aria-label="השמעה מהשורה">▶</button>
        <button data-act="now">קבע לעכשיו</button>
        <button data-act="split">פצל</button>
        <button data-act="merge" ${i === L.lines.length - 1 ? 'disabled' : ''}>אחד עם הבאה</button>
        <button data-act="del">מחק</button>
      </div></li>`;
  }).join('');
  $('#lyricsText').value = L.lines.map(l => l.text).join('\n');
  S.lineNow = -1;
}
$('#lineList').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const li = b.closest('li'), i = +li.dataset.i, L = current.lyrics, l = L.lines[i];
  const act = b.dataset.act;
  if (act === 'minus' || act === 'plus') { l.t = Math.max(0, (l.t ?? engine.heardPosition()) + (act === 'plus' ? 0.05 : -0.05)); if (l.words) shiftWords(l); }
  if (act === 'play') { await engine.seek(Math.max(0, (l.t ?? 0) + (L.offset || 0) - 1)); if (!engine.playing) await engine.play(); return; }
  if (act === 'now') { l.t = Math.max(0, engine.heardPosition() - (L.offset || 0)); l.words = null; }
  if (act === 'split') {
    const inp = li.querySelector('.txt'); const pos = inp.selectionStart || Math.floor(l.text.length / 2);
    const a = l.text.slice(0, pos).trim(), z = l.text.slice(pos).trim();
    if (!a || !z) return;
    const nextT = L.lines[i + 1] && L.lines[i + 1].t;
    const mid = l.t != null ? (nextT != null ? (l.t + nextT) / 2 : l.t + 2) : null;
    L.lines.splice(i, 1, { t: l.t, text: a }, { t: mid, text: z });
  }
  if (act === 'merge') { const n = L.lines[i + 1]; L.lines.splice(i, 2, { t: l.t ?? n.t, text: l.text + ' ' + n.text }); }
  if (act === 'del') L.lines.splice(i, 1);
  renderLines(); markDirty(); S.lastLyricKey = '';
});
function shiftWords(l) { if (!l.words || !l.words.length) return; const d = l.t - l.words[0].t; l.words.forEach(w => w.t += d); }
$('#lineList').addEventListener('change', e => {
  if (!e.target.classList.contains('txt')) return;
  const l = current.lyrics.lines[+e.target.closest('li').dataset.i];
  l.text = e.target.value.trim(); l.words = null; markDirty(); S.lastLyricKey = '';
});
$('#applyText').addEventListener('click', async () => {
  const lines = textToLines($('#lyricsText').value);
  const L = current.lyrics;
  if (L.lines.some(l => l.t != null)) {
    if (!await dialog('להחליף את המילים?', '<p>השורות הקיימות והתזמון שלהן יוחלפו בטקסט החדש.</p>', 'החלפה')) return;
  }
  L.lines = lines; renderLines(); markDirty();
});
$('#importLyrics').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const text = await file.text();
  let lines = /\.srt$/i.test(file.name) || text.includes('-->') ? parseSRT(text) : parseLRC(text);
  if (!lines.length) return dialog('לא נמצאו שורות מתוזמנות', '<p>הקובץ לא נראה כמו LRC או SRT תקין.</p>');
  current.lyrics.lines = lines; current.lyrics.offset = 0; renderLines(); markDirty();
});
$$('[data-shift]').forEach(b => b.addEventListener('click', () => {
  const L = current.lyrics; L.offset = Math.round(((L.offset || 0) + +b.dataset.shift) * 100) / 100;
  $('#shiftV').textContent = (L.offset >= 0 ? '+' : '') + L.offset.toFixed(2); markDirty(); S.lastLyricKey = '';
}));

// tap timing
$('#tapStart').addEventListener('click', async () => {
  if (S.tap) return endTap();
  const L = current.lyrics;
  if (!L.lines.length) return dialog('אין שורות', '<p>הדביקו קודם את המילים ולחצו "צור שורות מהטקסט".</p>');
  let i = L.lines.findIndex(l => l.t == null); if (i < 0) i = 0;
  S.tap = { i, history: [] };
  $('#tapStart').textContent = 'סיום סימון'; $('#tapMark').disabled = false;
  await engine.seek(i > 0 && L.lines[i - 1].t != null ? Math.max(0, L.lines[i - 1].t + (L.offset || 0) - 0.5) : 0);
  if (!engine.playing) await engine.play();
  markTapRow();
});
function tapMark() {
  if (!S.tap) return;
  const L = current.lyrics, l = L.lines[S.tap.i];
  if (!l) return endTap();
  S.tap.history.push({ i: S.tap.i, t: l.t, words: l.words });
  l.t = Math.max(0, engine.heardPosition() - (L.offset || 0)); l.words = null;
  S.tap.i++;
  $('#tapUndo').disabled = false;
  renderLines(); markTapRow(); markDirty();
  if (S.tap.i >= L.lines.length) endTap('כל השורות סומנו. אפשר לכוון כל שורה עם − / +.');
}
function markTapRow() { $$('#lineList li').forEach(li => li.classList.toggle('next-mark', S.tap && +li.dataset.i === S.tap.i)); const r = $(`#lineList li[data-i="${S.tap && S.tap.i}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); }
function endTap(text) {
  S.tap = null; $('#tapStart').textContent = 'התחל סימון'; $('#tapMark').disabled = true;
  markTapRow(); if (text) dialog('התזמון הושלם', `<p>${esc(text)}</p>`);
}
$('#tapMark').addEventListener('click', tapMark);
$('#tapUndo').addEventListener('click', () => {
  if (!S.tap || !S.tap.history.length) return;
  const h = S.tap.history.pop(); const l = current.lyrics.lines[h.i]; l.t = h.t; l.words = h.words; S.tap.i = h.i;
  $('#tapUndo').disabled = !S.tap.history.length; renderLines(); markTapRow(); markDirty();
});
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
  if (typing) return;
  if (S.tap && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); tapMark(); return; }
  if (e.code === 'Space' && (S.view === 'sing' || S.view === 'studio') && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
});

// ---------------- export ----------------
const safeName = () => (current.title || 'karaoke').trim();
async function exportAudio(kind, take) {
  const el = $('#exportMsg');
  $$('[data-export]').forEach(b => b.disabled = true);
  msg(el, 'מכין את הקובץ…');
  try {
    let opts, name;
    if (kind === 'mix') { opts = {}; name = `${safeName()} - מיקס.wav`; }
    if (kind === 'playback') { opts = { includeTakes: false }; name = `${safeName()} - פלייבק.wav`; }
    if (kind === 'take') {
      take = take || current.takes.find(t => !t.mute) || current.takes[current.takes.length - 1];
      if (!take) throw new Error('no-take');
      opts = { includeTracks: false, takeIds: [take.id], fx: $('#exportTakeFx').checked };
      name = `${safeName()} - ${take.name}${opts.fx ? '' : ' (ללא אפקטים)'}.wav`;
    }
    if (kind === 'mix' && !current.takes.some(t => !t.mute)) msg(el, 'אין טייק פעיל – המיקס יכיל רק את הפלייבק. מכין…');
    const out = await engine.render(opts);
    const peak = peakOf(out);
    let note = '';
    if (peak > 0.995) {
      const g = 0.989 / peak;
      for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
      note = ` העוצמה הונמכה ב-${(-20 * Math.log10(g)).toFixed(1)} dB כדי למנוע עיוות.`;
    }
    const blob = bufferToWav(out, 24);
    window.__ks.lastExport = { kind, blob, duration: out.duration, peak, name };
    download(blob, name);
    msg(el, `הקובץ "${name}" מוכן (${fmtTime(out.duration).slice(0, 5)}, ${(blob.size / 1048576).toFixed(1)} MB).${note}`, 'ok');
  } catch (e) {
    console.error(e);
    msg(el, e.message === 'no-take' ? 'אין עדיין טייק לייצוא. הקליטו קודם במסך השירה.' : e.message === 'empty' ? 'אין מה לייצא – כל הערוצים מושתקים.' : 'הייצוא נכשל: ' + (e.message || e) + '. הטייקים שלכם עדיין שמורים בפרויקט.', 'err');
  } finally { $$('[data-export]').forEach(b => b.disabled = false); }
}
async function exportProject() {
  const el = $('#exportMsg');
  msg(el, 'אורז את הפרויקט…');
  try {
    await saveNow();
    const files = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(current, null, 1)) }];
    for (const k of [...current.tracks.map(t => t.fileKey), ...current.takes.map(t => t.fileKey)]) {
      const blob = await store.getFile(current.id, k);
      if (blob) files.push({ name: 'files/' + k, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const zip = makeZip(files);
    const name = `${safeName()}.karaoke.zip`;
    window.__ks.lastExport = { kind: 'project', blob: zip, name };
    download(zip, name);
    msg(el, `קובץ הפרויקט "${name}" מוכן (${(zip.size / 1048576).toFixed(1)} MB). העבירו אותו לטלפון (AirDrop, וואטסאפ לעצמכם, Drive) ופתחו דרך "פתיחת קובץ פרויקט".`, 'ok');
  } catch (e) { msg(el, 'ייצוא הפרויקט נכשל: ' + (e.message || e), 'err'); }
}
$('#tab-export').addEventListener('click', e => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  const k = b.dataset.export;
  if (k === 'lrc' || k === 'srt') {
    const L = current.lyrics;
    if (!L.lines.some(l => l.t != null)) return msg('#exportMsg', 'אין עדיין שורות מתוזמנות לייצוא.', 'err');
    const text = k === 'lrc' ? toLRC(L.lines, current, L.offset || 0) : toSRT(L.lines, L.offset || 0, engine.duration);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    window.__ks.lastExport = { kind: k, blob, name: safeName() + '.' + k };
    download(blob, safeName() + '.' + k);
    return msg('#exportMsg', 'קובץ המילים מוכן.', 'ok');
  }
  if (k === 'project') return exportProject();
  exportAudio(k);
});
$('#saveNow').addEventListener('click', saveNow);
$('#deleteProject').addEventListener('click', async () => {
  if (!await dialog('מחיקת הפרויקט', `<p>למחוק את "${esc(current.title)}" וכל הטייקים שלו מהמכשיר? מומלץ לייצא קובץ פרויקט קודם.</p>`, 'מחיקה')) return;
  engine.stop(); await store.deleteProject(current); current = null; ls.set('last', null); location.hash = 'library';
});
async function storageInfo() {
  const e = await store.estimate();
  $('#storageInfo').textContent = e && e.quota ? `נפח בשימוש באתר: ${(e.usage / 1048576).toFixed(0)} MB מתוך כ-${(e.quota / 1048576).toFixed(0)} MB זמינים לדפדפן.` : '';
}

// ---------------- frame loop ----------------
function tick() {
  requestAnimationFrame(tick);
  if (!current) return;
  const t = engine.heardPosition(), d = engine.duration;
  const playIcon = engine.playing ? '❚❚' : '▶';
  if (S.view === 'sing') {
    if ($('#playBtn').textContent !== playIcon) $('#playBtn').textContent = playIcon;
    if (!S.dragging) { const s = $('#seek'); s.max = d.toFixed(2); s.value = t; $('#tCur').textContent = fmtTime(t).slice(0, 5); }
    $('#tDur').textContent = fmtTime(d).slice(0, 5);
    renderLyricStage(t);
    if (engine.rec) $('#meterBar').style.width = Math.min(100, engine.level() * 140) + '%';
  } else if (S.view === 'studio') {
    if ($('#sPlay').textContent !== playIcon) $('#sPlay').textContent = playIcon;
    if (!S.dragging) { const s = $('#sSeek'); s.max = d.toFixed(2); s.value = t; $('#sTime').textContent = fmtTime(t).slice(0, 5); }
    $('#sDur').textContent = fmtTime(d).slice(0, 5);
    if (S.tab === 'lyrics' && !S.tap) {
      const st = lyricState(current.lyrics.lines, t, current.lyrics.offset || 0);
      const idx = st.cur ? current.lyrics.lines.indexOf(st.cur) : -1;
      if (idx !== S.lineNow) { S.lineNow = idx; $$('#lineList li').forEach(li => li.classList.toggle('now', +li.dataset.i === idx)); }
    }
  }
}

// ---------------- boot ----------------
(async function boot() {
  await loadCatalog();
  await show(location.hash.slice(1) || 'library');
  requestAnimationFrame(tick);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
