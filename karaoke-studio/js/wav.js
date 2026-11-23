// WAV encoding helpers (PCM 16/24-bit, interleaved)

export function encodeWav(channels, sampleRate, bitDepth = 16) {
  const numCh = channels.length;
  const len = channels[0].length;
  const bytes = bitDepth / 8;
  const dataSize = len * numCh * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytes, true); v.setUint16(32, numCh * bytes, true);
  v.setUint16(34, bitDepth, true); str(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        // TPDF dither
        const d = (Math.random() - Math.random()) / 32768;
        let s = Math.max(-1, Math.min(1, channels[c][i] + d));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
      }
    }
  } else {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff); o += 3;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function bufferToWav(audioBuffer, bitDepth = 24) {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  return encodeWav(chans, audioBuffer.sampleRate, bitDepth);
}

export function peakOf(audioBuffer) {
  let p = 0;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}
