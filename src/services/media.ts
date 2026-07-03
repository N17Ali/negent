export function extractMedia(itemXml: string): {
  mediaUrl: string | null;
  mediaType: 'photo' | 'video' | null;
} {
  let url: string | null = null;
  let type: 'photo' | 'video' | null = null;

  const enclosure = itemXml.match(/<enclosure[^>]+>/);
  if (enclosure) {
    url = attr(enclosure[0], 'url');
    const mime = attr(enclosure[0], 'type') || '';
    if (mime.startsWith('image/')) type = 'photo';
    else if (mime.startsWith('video/')) type = 'video';
    else if (url) type = guessType(url);
  }

  if (!url) {
    const mc = itemXml.match(/<media:content[^>]+>/);
    if (mc) {
      url = attr(mc[0], 'url');
      const medium = attr(mc[0], 'medium');
      if (medium === 'image') type = 'photo';
      else if (medium === 'video') type = 'video';
      else if (url) type = guessType(url);
    }
  }

  if (!url) {
    const thumb = itemXml.match(/<media:thumbnail[^>]+>/);
    if (thumb) {
      url = attr(thumb[0], 'url');
      type = 'photo';
    }
  }

  if (!url) {
    const img = itemXml.match(/<img[^>]+src=["']([^"']+)["']/);
    if (img) {
      url = img[1];
      type = 'photo';
    }
  }

  return { mediaUrl: url, mediaType: type };
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`));
  return m ? m[1] : null;
}

function guessType(url: string): 'photo' | 'video' | null {
  const l = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg)/.test(l)) return 'photo';
  if (/\.(mp4|webm|mov)/.test(l)) return 'video';
  return 'photo';
}
