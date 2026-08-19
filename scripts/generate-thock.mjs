import fs from "fs";
import path from "path";

function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE( Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

function thock(freq, dur) {
  const sr = 44100;
  const n = Math.floor(sr * dur);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 40) * 0.6 + Math.exp(-t * 100) * 0.4;
  }
  return encodeWAV(out, sr);
}

const dir = "apps/desktop/src-tauri/assets/audio";
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "thock-press.wav"), thock(80, 0.12));
fs.writeFileSync(path.join(dir, "thock-deep.wav"), thock(55, 0.2));
fs.writeFileSync(path.join(dir, "thock-release.wav"), thock(100, 0.08));
console.log("done");