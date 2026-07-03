import { describe, it, expect } from 'vitest';
import { extractMedia } from './media';

describe('extractMedia', () => {
  it('extracts image from <enclosure> with image mime', () => {
    const xml = `<enclosure url="https://img.example.com/p.jpg" type="image/jpeg" length="123"/>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/p.jpg');
    expect(r.mediaType).toBe('photo');
  });

  it('extracts video from <enclosure> with video mime', () => {
    const xml = `<enclosure url="https://cdn.example.com/v.mp4" type="video/mp4"/>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://cdn.example.com/v.mp4');
    expect(r.mediaType).toBe('video');
  });

  it('guesses photo when enclosure has no mime but image extension', () => {
    const xml = `<enclosure url="https://img.example.com/p.png"/>`;
    const r = extractMedia(xml);
    expect(r.mediaType).toBe('photo');
  });

  it('extracts from <media:content> with medium=image', () => {
    const xml = `<media:content url="https://img.example.com/m.jpg" medium="image"/>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/m.jpg');
    expect(r.mediaType).toBe('photo');
  });

  it('extracts from <media:content> with medium=video', () => {
    const xml = `<media:content url="https://cdn.example.com/m.mp4" medium="video"/>`;
    const r = extractMedia(xml);
    expect(r.mediaType).toBe('video');
  });

  it('extracts from <media:thumbnail>', () => {
    const xml = `<media:thumbnail url="https://img.example.com/t.jpg"/>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/t.jpg');
    expect(r.mediaType).toBe('photo');
  });

  it('falls back to first <img> src', () => {
    const xml = `<description><img src="https://img.example.com/embed.jpg" alt="x"/></description>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/embed.jpg');
    expect(r.mediaType).toBe('photo');
  });

  it('returns null when no media present', () => {
    const xml = `<description>just text</description>`;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBeNull();
    expect(r.mediaType).toBeNull();
  });

  it('prefers enclosure over media:content over thumbnail over img', () => {
    const xml = `
      <img src="https://img.example.com/img-tag.jpg"/>
      <media:thumbnail url="https://img.example.com/thumb.jpg"/>
      <media:content url="https://img.example.com/content.jpg" medium="image"/>
      <enclosure url="https://img.example.com/enclosure.jpg" type="image/jpeg"/>
    `;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/enclosure.jpg');
  });

  it('prefers media:content over thumbnail over img when no enclosure', () => {
    const xml = `
      <img src="https://img.example.com/img-tag.jpg"/>
      <media:thumbnail url="https://img.example.com/thumb.jpg"/>
      <media:content url="https://img.example.com/content.jpg" medium="image"/>
    `;
    const r = extractMedia(xml);
    expect(r.mediaUrl).toBe('https://img.example.com/content.jpg');
  });

  it('guesses photo for unknown extension', () => {
    const xml = `<enclosure url="https://example.com/file.unknown"/>`;
    const r = extractMedia(xml);
    expect(r.mediaType).toBe('photo');
  });
});
