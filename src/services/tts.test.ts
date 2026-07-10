import { describe, it, expect } from 'vitest';
import { chunkText, trimToSentence } from './tts';

describe('chunkText', () => {
  it('returns the text as a single chunk when under the limit', () => {
    expect(chunkText('short text', 1500)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries', () => {
    const para = 'a'.repeat(800);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
  });

  it('breaks an oversized single paragraph on sentence boundaries', () => {
    const sentence = 'این یک جمله است. ';
    const big = sentence.repeat(200); // ~3400 chars, no paragraph breaks
    const chunks = chunkText(big, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
    // No content lost (ignoring whitespace).
    expect(chunks.join('').replace(/\s/g, '')).toBe(big.replace(/\s/g, ''));
  });

  it('never returns empty chunks', () => {
    const chunks = chunkText('x'.repeat(5000), 1500);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });
});

describe('trimToSentence', () => {
  it('returns the text unchanged when under the cap', () => {
    expect(trimToSentence('کوتاه است.', 1500)).toBe('کوتاه است.');
  });

  it('cuts at the last sentence boundary within the cap, never mid-sentence', () => {
    const s = 'جمله یک. جمله دو. جمله سه که خیلی طولانی است و از حد می‌گذرد';
    const out = trimToSentence(s, 20);
    // Ends on a terminator, and is a prefix of the original (no invented text).
    expect(/[.!?؟۔]$/.test(out)).toBe(true);
    expect(s.startsWith(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('handles Persian sentence terminators', () => {
    const s = 'این جمله اول است؟ این جمله دوم است که باید حذف شود چون طولانی است';
    const out = trimToSentence(s, 25);
    expect(out.endsWith('؟')).toBe(true);
  });

  it('falls back to the raw slice when no sentence break fits', () => {
    const s = 'یک جمله بسیار طولانی بدون هیچ نقطه‌ای که تا آخر ادامه دارد';
    const out = trimToSentence(s, 15);
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out.length).toBeGreaterThan(0);
    expect(s.startsWith(out)).toBe(true);
  });
});
