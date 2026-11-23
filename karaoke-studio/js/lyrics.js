// Lyrics: parsing/exporting LRC & SRT, and finding the current line for a time.

export function fmtTime(t, sep = '.') {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0').replace('.', sep);
}

export function textToLines(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => ({ t: null, text: s }));
}

export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    let body = raw.replace(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g, '').trim();
    // enhanced LRC word tags <mm:ss.xx>
    const wordTags = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g)];
    let words = null;
    if (wordTags.length) {
      words = wordTags.map(w => ({ t: +w[1] * 60 + parseFloat(w[2]), text: w[3].trim() })).filter(w => w.text);
      body = words.map(w => w.text).join(' ');
    }
    for (const tg of tags) {
      const t = +tg[1] * 60 + parseFloat(tg[2].replace(':', '.')) - offset;
      lines.push({ t: Math.max(0, t), text: body, words });
    }
  }
  return lines.filter(l => l.text).sort((a, b) => a.t - b.t);
}

function srtTime(s) {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
}

export function parseSRT(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const lines = [];
  for (const b of blocks) {
    const rows = b.split('\n').filter(r => r.trim() !== '');
    const ti = rows.findIndex(r => r.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = rows[ti].split('-->');
    const t = srtTime(a), end = srtTime(z);
    const body = rows.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (t != null && body) lines.push({ t, end, text: body });
  }
  return lines.sort((a, b) => a.t - b.t);
}

export function toLRC(lines, meta = {}, offset = 0) {
  const out = [];
  if (meta.title) out.push(`[ti:${meta.title}]`);
  if (meta.artist) out.push(`[ar:${meta.artist}]`);
  out.push('[re:Karaoke Studio]');
  for (const l of lines) {
    if (l.t == null) continue;
    let body = l.text;
    if (l.words && l.words.length) body = l.words.map(w => `<${fmtTime(w.t + offset)}>${w.text}`).join(' ');
    out.push(`[${fmtTime(l.t + offset)}]${body}`);
  }
  return out.join('\n') + '\n';
}

function srtStamp(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  const p = (n, k = 2) => String(n).padStart(k, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(Math.min(ms, 999), 3)}`;
}

export function toSRT(lines, offset = 0, duration = Infinity) {
  const timed = lines.filter(l => l.t != null);
  return timed.map((l, i) => {
    const next = timed[i + 1];
    const end = lineEnd(timed, i, duration);
    const stop = Math.min(end, next ? next.t : end);
    return `${i + 1}\n${srtStamp(l.t + offset)} --> ${srtStamp(Math.max(stop, l.t + 0.5) + offset)}\n${l.text}\n`;
  }).join('\n');
}

export function lineEnd(lines, i, duration = Infinity) {
  const l = lines[i];
  const next = lines[i + 1];
  if (l.end != null) return l.end;
  let e = next ? next.t : Math.min(l.t + 6, duration);
  if (l.words && l.words.length) e = Math.min(e, l.words[l.words.length - 1].t + 2.5);
  return Math.min(e, l.t + 8);
}

// Returns {index, line, next, progress, wordIndex, gap}
export function lyricState(lines, time, offset = 0) {
  const timed = lines.filter(l => l.t != null);
  let i = -1;
  for (let k = 0; k < timed.length; k++) { if (timed[k].t + offset <= time) i = k; else break; }
  const next = timed[i + 1] || null;
  const cur = i >= 0 ? timed[i] : null;
  let active = false, wordIndex = -1;
  if (cur) {
    const end = lineEnd(timed, i) + offset;
    active = time < end;
    if (cur.words) for (let w = 0; w < cur.words.length; w++) if (cur.words[w].t + offset <= time) wordIndex = w;
  }
  const untilNext = next ? next.t + offset - time : null;
  return { index: i, cur, next, active, wordIndex, untilNext, timed };
}
