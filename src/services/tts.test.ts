import { describe, it, expect } from 'vitest';
import { chunkText } from './tts';

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
