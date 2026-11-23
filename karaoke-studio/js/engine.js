// Audio engine: synchronized multitrack playback, recording, and offline render.
// The same graph builder is used for live preview and for export, so the exported
// file contains exactly the volumes, offsets and effects the user heard.

export const FX_PRESETS = {
  none:  { label: 'ללא אפקט' },
  clean: { label: 'קול נקי', hp: 90,  low: 0,  mid: 0,  pres: 2.5, air: 1.5, thr: -20, ratio: 3, wet: 0.12, decay: 1.2 },
  warm:  { label: 'קול חם',  hp: 70,  low: 3,  mid: -1, pres: 0.5, air: -2,  thr: -22, ratio: 4, wet: 0.18, decay: 1.8 },
  hall:  { label: 'אולם',    hp: 90,  low: 0,  mid: 0,  pres: 1.5, air: 1,   thr: -18, ratio: 3, wet: 0.38, decay: 3.2 },
};

function seededNoise(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; };
}

function makeImpulse(ctx, decay) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * decay);
  const ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const rnd = seededNoise(1234 + c * 77);
    const d = ir.getChannelData(c);
    const pre = Math.floor(sr * 0.012);
    for (let i = pre; i < len; i++) d[i] = rnd() * Math.pow(1 - (i - pre) / (len - pre), 3.2);
  }
  return ir;
}

// Builds the vocal chain for one take; returns {input, output}
function buildFx(ctx, fx, irCache) {
  const p = FX_PRESETS[fx && fx.preset] || FX_PRESETS.none;
  const amt = fx && fx.amount != null ? fx.amount : 1;
  const input = ctx.createGain();
  const output = ctx.createGain();
  // Base cleanup EQ is always available, effect-specific values scale with amount
  const eq = fx && fx.eq ? fx.eq : { low: 0, mid: 0, high: 0 };
  let node = input;
  const chain = n => { node.connect(n); node = n; };
  if (p.hp) { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hp; hp.Q.value = 0.7; chain(hp); }
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = (p.low || 0) * amt + eq.low; chain(low);
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 900; mid.Q.value = 0.9; mid.gain.value = (p.mid || 0) * amt + eq.mid; chain(mid);
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.8; pres.gain.value = (p.pres || 0) * amt + eq.high; chain(pres);
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = (p.air || 0) * amt; chain(air);
  if (p.thr) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = p.thr * amt; comp.ratio.value = 1 + (p.ratio - 1) * amt;
    comp.attack.value = 0.008; comp.release.value = 0.18; comp.knee.value = 8;
    chain(comp);
    const makeup = ctx.createGain(); makeup.gain.value = Math.pow(10, (-p.thr * amt * 0.25) / 20); chain(makeup);
  }
  node.connect(output);
  if (p.wet && amt > 0) {
    const key = p.decay;
    if (!irCache.has(key)) irCache.set(key, makeImpulse(ctx, p.decay));
    const conv = ctx.createConvolver(); conv.buffer = irCache.get(key);
    const wet = ctx.createGain(); wet.gain.value = p.wet * amt;
    node.connect(conv); conv.connect(wet); wet.connect(output);
  }
  return { input, output, tail: p.wet ? p.decay : 0 };
}

export function trackGainOf(project, t) {
  const anySolo = project.tracks.some(x => x.solo);
  if (anySolo) return t.solo ? t.gain : 0;
  return t.mute ? 0 : t.gain;
}

export function takeStart(take) {
  return (take.start || 0) + (take.offsetMs || 0) / 1000;
}

function buildMaster(ctx, dest, project) {
  const master = ctx.createGain();
  master.gain.value = project.mix.master;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  master.connect(lim); lim.connect(dest);
  const playbackBus = ctx.createGain(); playbackBus.gain.value = project.mix.playback; playbackBus.connect(master);
  const vocalBus = ctx.createGain(); vocalBus.gain.value = project.mix.vocals; vocalBus.connect(master);
  return { master, lim, playbackBus, vocalBus };
}

// Schedules all sources at context time `when`, starting from song position `pos`.
function schedule(ctx, project, buffers, opts) {
  const { when, pos, dest, includeTracks = true, includeTakes = true, takeIds = null, fx = true, original = false } = opts;
  const bus = buildMaster(ctx, dest, project);
  const sources = [];
  const trackGains = new Map();
  const takeGains = new Map();
  const irCache = new Map();
  let tail = 0;
  const place = (buffer, songStart, from, to, out) => {
    const b0 = Math.max(from, pos - songStart);
    if (b0 >= to) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    const delay = Math.max(0, songStart + b0 - pos);
    src.start(when + delay, b0, to - b0);
    sources.push(src);
  };
  if (includeTracks) {
    for (const t of project.tracks) {
      const buf = buffers.get(t.fileKey);
      if (!buf) continue;
      const g = ctx.createGain();
      g.gain.value = original ? 1 : trackGainOf(project, t);
      g.connect(bus.playbackBus);
      trackGains.set(t.id, g);
      place(buf, 0, 0, buf.duration, g);
    }
  }
  if (includeTakes && !original) {
    for (const tk of project.takes) {
      if (takeIds ? !takeIds.includes(tk.id) : tk.mute) continue;
      const buf = buffers.get(tk.fileKey);
      if (!buf) continue;
      const g = ctx.createGain(); g.gain.value = tk.gain;
      g.connect(bus.vocalBus);
      takeGains.set(tk.id, g);
      let input = g;
      if (fx && tk.fx && tk.fx.preset !== 'none') {
        const chain = buildFx(ctx, tk.fx, irCache);
        chain.output.connect(g); input = chain.input; tail = Math.max(tail, chain.tail);
      } else if (fx && tk.fx && tk.fx.eq && (tk.fx.eq.low || tk.fx.eq.mid || tk.fx.eq.high)) {
        const chain = buildFx(ctx, { preset: 'none', eq: tk.fx.eq }, irCache);
        chain.output.connect(g); input = chain.input;
      }
      const end = tk.trimEnd != null ? Math.min(tk.trimEnd, buf.duration) : buf.duration;
      place(buf, takeStart(tk), tk.trimStart || 0, end, input);
    }
  }
  return { sources, bus, trackGains, takeGains, tail };
}

export function projectDuration(project, buffers, withTakes = true) {
  let d = 0;
  for (const t of project.tracks) { const b = buffers.get(t.fileKey); if (b) d = Math.max(d, b.duration); }
  if (withTakes) for (const tk of project.takes) {
    const b = buffers.get(tk.fileKey); if (!b || tk.mute) continue;
    const end = tk.trimEnd != null ? Math.min(tk.trimEnd, b.duration) : b.duration;
    d = Math.max(d, takeStart(tk) + end);
  }
  return d;
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.project = null;
    this.playing = false;
    this.pos = 0;
    this.startCtx = 0;
    this.live = null;
    this.opts = { fx: true, original: false };
    this.onended = null;
    this.rec = null;
  }

  // iPhone: by default Web Audio is silenced by the ring/silent switch.
  // 'playback' makes it play like a music app (Safari 17+).
  setSession(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {} }

  ensureCtx() {
    if (!this.ctx) {
      this.setSession('playback');
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.addEventListener('statechange', () => {
        if (this.ctx.state === 'interrupted' || this.ctx.state === 'suspended') {
          if (this.rec && this.rec.active && this.onInterrupt) this.onInterrupt('audio-interrupted');
        }
      });
    }
    return this.ctx;
  }

  async decode(blob) {
    const ctx = this.ensureCtx();
    const ab = await blob.arrayBuffer();
    return await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  setProject(project) { this.stop(); this.project = project; this.pos = 0; }

  get duration() { return this.project ? projectDuration(this.project, this.buffers) : 0; }

  get outLatency() {
    const c = this.ctx; if (!c) return 0;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  position() {
    if (!this.playing) return this.pos;
    return Math.max(0, this.pos + (this.ctx.currentTime - this.startCtx));
  }
  // what the listener hears right now (compensates output latency)
  heardPosition() {
    if (!this.playing) return this.pos;
    return Math.max(0, this.position() - this.outLatency);
  }

  async play() {
    if (this.playing || !this.project) return;
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') await ctx.resume();
    if (this.pos >= this.duration - 0.05) this.pos = 0;
    this.startCtx = ctx.currentTime + 0.06;
    this.live = schedule(ctx, this.project, this.buffers, { when: this.startCtx, pos: this.pos, dest: ctx.destination, ...this.opts });
    this.playing = true;
    clearTimeout(this.endTimer);
    this.watchEnd();
  }

  watchEnd() {
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      if (!this.playing) return;
      if (this.position() >= this.duration + 0.1) { this.pause(); this.pos = this.duration; if (this.onended) this.onended(); }
      else this.watchEnd();
    }, 200);
  }

  stopSources() {
    if (!this.live) return;
    for (const s of this.live.sources) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
    try { this.live.bus.master.disconnect(); this.live.bus.lim.disconnect(); } catch {}
    this.live = null;
  }

  pause() {
    if (!this.playing) return;
    this.pos = this.position();
    this.playing = false;
    this.stopSources();
  }

  stop() { this.pause(); this.pos = 0; }

  async seek(t) {
    const was = this.playing;
    this.pause();
    this.pos = Math.max(0, Math.min(t, this.duration));
    if (was) await this.play();
  }

  // Re-schedules everything at current position (used after offsets/fx change).
  async refresh() { if (this.playing) await this.seek(this.position()); }

  updateGains() {
    if (!this.live || !this.project) return;
    const p = this.project, c = this.ctx, now = c.currentTime;
    for (const t of p.tracks) { const g = this.live.trackGains.get(t.id); if (g) g.gain.setTargetAtTime(this.opts.original ? 1 : trackGainOf(p, t), now, 0.015); }
    for (const tk of p.takes) { const g = this.live.takeGains.get(tk.id); if (g) g.gain.setTargetAtTime(tk.gain, now, 0.015); }
    this.live.bus.playbackBus.gain.setTargetAtTime(p.mix.playback, now, 0.015);
    this.live.bus.vocalBus.gain.setTargetAtTime(p.mix.vocals, now, 0.015);
    this.live.bus.master.gain.setTargetAtTime(p.mix.master, now, 0.015);
  }

  // ---------- recording ----------
  async openMic({ processing = false } = {}) {
    if (!window.isSecureContext) { const e = new Error('insecure'); e.code = 'insecure'; throw e; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error('unsupported'); e.code = 'unsupported'; throw e; }
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') await ctx.resume();
    if (!ctx.audioWorklet) { const e = new Error('unsupported'); e.code = 'unsupported'; throw e; }
    if (!this.workletLoaded) { await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url)); this.workletLoaded = true; }
    this.setSession('play-and-record');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing, channelCount: 1 },
    });
    const src = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    const silent = ctx.createGain(); silent.gain.value = 0;
    src.connect(tap); src.connect(analyser); tap.connect(silent); silent.connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.rec = { stream, src, tap, analyser, silent, track, chunks: [], first: null, active: false, inLatency: typeof settings.latency === 'number' ? settings.latency : 0.01 };
    tap.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'data') this.rec && this.rec.chunks.push(m.data);
      if (m.type === 'first') this.rec && (this.rec.first = m.time);
      if (m.type === 'stopped' && this.rec && this.rec.onStopped) this.rec.onStopped();
    };
    track.addEventListener('ended', () => { if (this.rec && this.rec.active && this.onInterrupt) this.onInterrupt('mic-ended'); });
    return this.rec;
  }

  level() {
    if (!this.rec) return 0;
    const a = this.rec.analyser, d = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d);
    let p = 0; for (const x of d) p = Math.max(p, Math.abs(x));
    return p;
  }

  async startRecording() {
    if (!this.rec) throw new Error('mic-not-open');
    if (this.playing) this.pause();
    const pos0 = this.pos;
    await this.play();
    this.rec.pos0 = pos0;
    this.rec.startCtx = this.startCtx;
    this.rec.chunks = []; this.rec.first = null; this.rec.active = true;
    this.rec.tap.port.postMessage({ cmd: 'start', at: this.startCtx });
  }

  async stopRecording() {
    const r = this.rec;
    if (!r || !r.active) return null;
    r.active = false;
    await new Promise(res => { r.onStopped = res; r.tap.port.postMessage({ cmd: 'stop' }); setTimeout(res, 800); });
    this.pause();
    const total = r.chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0; for (const c of r.chunks) { samples.set(c, o); o += c.length; }
    const latency = r.inLatency + this.outLatency;
    const first = r.first != null ? r.first : r.startCtx;
    const start = r.pos0 + (first - r.startCtx) - latency;
    return { samples, sampleRate: this.ctx.sampleRate, start, latency };
  }

  closeMic() {
    const r = this.rec; if (!r) return;
    try { r.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { r.src.disconnect(); r.tap.disconnect(); r.silent.disconnect(); } catch {}
    this.rec = null;
    this.setSession('playback');
  }

  // ---------- export ----------
  async render({ includeTracks = true, includeTakes = true, takeIds = null, fx = true, project = this.project } = {}) {
    const sr = this.ensureCtx().sampleRate;
    let end = 0;
    if (includeTracks) for (const t of project.tracks) { const b = this.buffers.get(t.fileKey); if (b && trackGainOf(project, t) > 0) end = Math.max(end, b.duration); }
    let tailNeed = 0.25;
    if (includeTakes) for (const tk of project.takes) {
      if (takeIds ? !takeIds.includes(tk.id) : tk.mute) continue;
      const b = this.buffers.get(tk.fileKey); if (!b) continue;
      const e = tk.trimEnd != null ? Math.min(tk.trimEnd, b.duration) : b.duration;
      end = Math.max(end, takeStart(tk) + e);
      if (fx && tk.fx && FX_PRESETS[tk.fx.preset] && FX_PRESETS[tk.fx.preset].decay) tailNeed = Math.max(tailNeed, FX_PRESETS[tk.fx.preset].decay);
    }
    if (end <= 0) throw new Error('empty');
    const len = Math.ceil((end + tailNeed) * sr);
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(2, len, sr);
    // For export start at song time 0, but if takes begin before 0 shift by nothing (clipped).
    schedule(off, project, this.buffers, { when: 0, pos: 0, dest: off.destination, includeTracks, includeTakes, takeIds, fx });
    const out = await off.startRendering();
    return out;
  }
}
