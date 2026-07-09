// Dependency-free audio helpers. The Gemini Live API returns raw 16-bit mono PCM;
// Telegram won't play raw PCM, so we wrap it in a minimal 44-byte WAV/RIFF container
// (pure byte writing, no encoder library — keeps the zero-runtime-deps rule).

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Wrap raw little-endian 16-bit signed PCM samples in a WAV container.
 * @param pcm       raw PCM bytes (16-bit LE, `channels`-interleaved)
 * @param sampleRate samples per second (e.g. 24000)
 * @param channels  channel count (1 = mono)
 * @param meta      optional artist/title tags, embedded as a trailing LIST/INFO chunk
 *
 * When `meta` is omitted the output is byte-identical to a bare 44-byte-header WAV. When
 * present, an INFO LIST chunk (IART = artist, INAM = title) is APPENDED after the `data`
 * chunk — so the header layout and PCM-at-offset-44 stay intact, and the RIFF size at
 * offset 4 grows to cover the appended chunk. Readers that ignore LIST still play fine.
 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels = 1,
  meta?: { artist?: string; title?: string }
): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const listChunk = meta ? buildInfoListChunk(meta) : new Uint8Array(0);

  const buffer = new ArrayBuffer(44 + dataSize + listChunk.length);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize + listChunk.length, true); // chunk size = file size - 8
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer);
  bytes.set(pcm, 44);
  if (listChunk.length) bytes.set(listChunk, 44 + dataSize);
  return bytes;
}

/**
 * Build a RIFF LIST/INFO chunk carrying IART (artist) and INAM (title) tags. Each field
 * is a NUL-terminated string, padded to an even length per the RIFF spec. UTF-8 encoded
 * so Persian titles survive.
 */
function buildInfoListChunk(meta: { artist?: string; title?: string }): Uint8Array {
  const enc = new TextEncoder();
  const fields: [string, string][] = [];
  if (meta.artist) fields.push(['IART', meta.artist]);
  if (meta.title) fields.push(['INAM', meta.title]);
  if (!fields.length) return new Uint8Array(0);

  const subChunks: Uint8Array[] = [];
  for (const [id, value] of fields) {
    const data = enc.encode(value);
    const size = data.length + 1; // include NUL terminator
    const padded = size + (size % 2); // pad to even
    const chunk = new Uint8Array(8 + padded);
    chunk.set(enc.encode(id), 0);
    new DataView(chunk.buffer).setUint32(4, size, true);
    chunk.set(data, 8);
    // remaining bytes (NUL + optional pad) are already zero
    subChunks.push(chunk);
  }

  const bodyLen = subChunks.reduce((n, c) => n + c.length, 0);
  const list = new Uint8Array(12 + bodyLen);
  const view = new DataView(list.buffer);
  list.set(enc.encode('LIST'), 0);
  view.setUint32(4, 4 + bodyLen, true); // size covers 'INFO' + subchunks
  list.set(enc.encode('INFO'), 8);
  let offset = 12;
  for (const c of subChunks) {
    list.set(c, offset);
    offset += c.length;
  }
  return list;
}
