import { describe, it, expect } from 'vitest';
import { base64ToBytes, concatBytes, pcmToWav } from './audio';

describe('base64ToBytes', () => {
  it('decodes base64 to the original bytes', () => {
    // "AQIDBA==" is [1,2,3,4]
    expect(Array.from(base64ToBytes('AQIDBA=='))).toEqual([1, 2, 3, 4]);
  });

  it('returns empty for empty input', () => {
    expect(base64ToBytes('').length).toBe(0);
  });
});

describe('concatBytes', () => {
  it('concatenates chunks in order', () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles an empty list', () => {
    expect(concatBytes([]).length).toBe(0);
  });
});

describe('pcmToWav', () => {
  const pcm = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const wav = pcmToWav(pcm, 24000, 1);
  const view = new DataView(wav.buffer);
  const str = (o: number, n: number) =>
    String.fromCharCode(...Array.from(wav.slice(o, o + n)));

  it('prepends a 44-byte header', () => {
    expect(wav.length).toBe(44 + pcm.length);
  });

  it('writes the RIFF/WAVE/fmt/data magic', () => {
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(str(36, 4)).toBe('data');
  });

  it('encodes PCM format, mono, 24kHz, 16-bit', () => {
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate = rate * blockAlign
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('sets chunk sizes relative to the data length', () => {
    expect(view.getUint32(4, true)).toBe(36 + pcm.length); // RIFF chunk size
    expect(view.getUint32(40, true)).toBe(pcm.length); // data chunk size
  });

  it('appends the raw PCM after the header', () => {
    expect(Array.from(wav.slice(44))).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  describe('with metadata', () => {
    const tagged = pcmToWav(pcm, 24000, 1, { artist: 'negent', title: 'Hello' });
    const tview = new DataView(tagged.buffer);
    const tstr = (o: number, n: number) =>
      String.fromCharCode(...Array.from(tagged.slice(o, o + n)));
    const asText = String.fromCharCode(...Array.from(tagged));

    it('leaves the header and PCM region byte-identical', () => {
      // Header (0-44) + data unchanged; only a trailing chunk is appended.
      expect(tstr(0, 4)).toBe('RIFF');
      expect(tstr(36, 4)).toBe('data');
      expect(tview.getUint32(40, true)).toBe(pcm.length); // data chunk size unchanged
      expect(Array.from(tagged.slice(44, 44 + pcm.length))).toEqual([0x11, 0x22, 0x33, 0x44]);
    });

    it('grows the RIFF size to cover the appended LIST chunk', () => {
      expect(tagged.length).toBeGreaterThan(44 + pcm.length);
      expect(tview.getUint32(4, true)).toBe(tagged.length - 8);
    });

    it('embeds a LIST/INFO chunk with artist and title', () => {
      expect(asText).toContain('LIST');
      expect(asText).toContain('INFO');
      expect(asText).toContain('IART');
      expect(asText).toContain('negent');
      expect(asText).toContain('INAM');
      expect(asText).toContain('Hello');
    });
  });
});
