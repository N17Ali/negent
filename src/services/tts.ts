import {
  AUDIO_MODEL,
  AUDIO_VOICE,
  AUDIO_SAMPLE_RATE,
  AUDIO_MAX_CHARS,
  AUDIO_CHUNK_CHARS,
} from '../utils/constants';
import { base64ToBytes, concatBytes, pcmToWav } from '../utils/audio';

// gemini-2.5-flash-native-audio-latest is a Live API model — reachable only over a
// WebSocket (BidiGenerateContent), NOT the generateContent REST endpoint the rest of
// the code uses. Cloudflare Workers support outbound client WebSockets via
// fetch(url, { headers: { Upgrade: 'websocket' } }) → response.webSocket.accept().
//
// Per-chunk flow: connect → send `setup` (audio modality + voice + pronunciation
// system instruction) → wait for `setupComplete` → send the text turn (`clientContent`,
// turnComplete) → collect base64 PCM from each `serverContent.modelTurn.parts[].inlineData`
// until `turnComplete`/`generationComplete` → close. Long summaries are split into
// paragraph-sized chunks (long single generations drift in quality) and each chunk's PCM
// is concatenated before one WAV wrap.
//
// NOTE: exact Live API field names verified against
// https://ai.google.dev/gemini-api/docs/live-api/capabilities
//
// The URL uses the https:// scheme, NOT wss://. Cloudflare Workers' fetch() rejects
// ws:// / wss:// with "Fetch API cannot load: wss://..."; with the Upgrade: websocket
// header the runtime performs the WebSocket handshake internally over https.

const WS_URL =
  'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Tight per-chunk timeouts: a scheduled Worker has a bounded run duration, so a single
// stalled Live API turn must not sit for a minute. These bound one chunk; delivery voices
// one article per cron tick (cron/deliver.ts), so a whole article stays well within limits.
const CONNECT_TIMEOUT_MS = 10000;
const GENERATION_TIMEOUT_MS = 30000;

// Persian, informal reading + delivery guidance and pronunciation guidance so the TTS
// says abbreviations and English tech terms correctly instead of spelling them out or
// translating them. Each chunk is read as a separate turn, so these rules apply per chunk.
const SYSTEM_INSTRUCTION = `این متن خبری فارسی رو با لحن صمیمی، دوستانه و محاوره‌ای بخون، انگار داری برای یه دوست تعریف می‌کنی.

نحوه‌ی خوندن:
- تند و پرانرژی بخون، با ریتم سریع؛ کش نده و آروم نخون. هدف اینه که متن رو در زمان کمتر و با کلمات بیشتر در دقیقه بخونی.
- طبیعی و روان بخون، ولی سریع.
- مکث‌ها رو کوتاه نگه دار.
- روی ایده‌های مهم تأکید بذار.
- خلاصه نکن؛ چیزی به متن اضافه یا کم نکن.
- کل متن رو تا آخر و کامل بخون.

راهنمای تلفظ:
- مخفف‌ها رو حرف‌به‌حرف فارسی بخون: CPU را «سی پی یو»، GPU را «جی پی یو»، API را «ای پی آی»، JSON را «جِی‌سان»، SQL را «اس کیو ال»، URL را «یو آر ال»، AI را «ای آی»، LLM را «ال ال ام».
- اصطلاح‌های فنی انگلیسی رو به انگلیسی و با تلفظ درست بخون، ترجمه‌شون نکن: Kubernetes, Docker, Go, Redis, PostgreSQL, TypeScript, JavaScript, React, Python, Rust, GitHub, Linux, API.
- اعداد و نسخه‌ها رو طبیعی و واضح و به انگلیسی بخون.`;

/**
 * Generate a spoken-Persian WAV reading of `text`, or null on any failure.
 * `title` is embedded as WAV metadata (artist = negent, title = article title).
 * Callers treat audio as best-effort — a null here must not block text delivery.
 */
export async function generateAudio(
  text: string,
  title: string,
  apiKey: string
): Promise<Uint8Array | null> {
  const trimmed = trimToSentence(text.trim(), AUDIO_MAX_CHARS);
  if (!trimmed) return null;

  const chunks = chunkText(trimmed, AUDIO_CHUNK_CHARS);
  const pcmParts: Uint8Array[] = [];

  console.log(`tts: generating audio for ${trimmed.length} chars in ${chunks.length} chunk(s)`);

  for (let i = 0; i < chunks.length; i++) {
    console.log(`tts: starting chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    let pcm = await synthesizeChunk(chunks[i], apiKey);
    if (!pcm) {
      // The Live API occasionally stalls a single turn (generation timeout) even though the
      // surrounding chunks stream fine. A dropped middle chunk leaves an audible gap, so give
      // it one more try on a fresh session before accepting the hole.
      console.warn(`tts: chunk ${i + 1}/${chunks.length} produced no audio, retrying once`);
      pcm = await synthesizeChunk(chunks[i], apiKey);
    }
    if (pcm) {
      pcmParts.push(pcm);
      console.log(`tts: chunk ${i + 1}/${chunks.length} ok (${pcm.length} PCM bytes)`);
    } else {
      console.warn(`tts: chunk ${i + 1}/${chunks.length} produced no audio after retry`);
      // First chunk failing twice (likely auth/model error) → give up; a later chunk failing
      // still yields a partial-but-usable reading of what we have.
      if (i === 0) return null;
    }
  }

  if (!pcmParts.length) return null;
  return pcmToWav(concatBytes(pcmParts), AUDIO_SAMPLE_RATE, 1, {
    artist: 'negent',
    title,
  });
}

/**
 * Cap the spoken text at `maxChars` WITHOUT cutting mid-sentence. If the text is already
 * within the cap, return it whole. Otherwise take as many complete sentences as fit under
 * the cap; if not even one sentence fits (a single very long sentence), fall back to the raw
 * slice so we still read something. Sentence terminators cover Latin (.!?) and Persian (؟ ۔).
 */
export function trimToSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);
  // Last sentence terminator inside the window (any of . ! ? ؟ ۔), keeping the terminator.
  let cut = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if ('.!?؟۔'.includes(window[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= 0) return window.slice(0, cut + 1).trim();
  return window.trim(); // no sentence break found — read the raw slice rather than nothing
}

/**
 * Split text into chunks no longer than maxChars, preferring paragraph (\n\n) then
 * sentence boundaries so a chunk never ends mid-sentence.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };

  for (const para of text.split(/\n\n+/)) {
    if (para.length > maxChars) {
      // A single oversized paragraph: break it on sentence boundaries.
      flush();
      const sentences = para.match(/[^.!?؟۔]+[.!?؟۔]+|\S[^.!?؟۔]*$/g) || [para];
      for (const s of sentences) {
        if (current.length + s.length > maxChars) flush();
        current += s;
      }
      flush();
      continue;
    }
    if (current.length + para.length + 2 > maxChars) flush();
    current += (current ? '\n\n' : '') + para;
  }
  flush();
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

/** Run one WebSocket session and return the concatenated PCM for `text`, or null. */
async function synthesizeChunk(text: string, apiKey: string): Promise<Uint8Array | null> {
  let ws: WebSocket;
  try {
    console.log(`tts: connecting to Live API...`);
    const resp = await fetch(`${WS_URL}?key=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    const socket = resp.webSocket;
    if (!socket) {
      console.error(`tts: no webSocket in response (status ${resp.status})`);
      return null;
    }
    socket.accept();
    ws = socket;
    console.log(`tts: WebSocket connected`);
  } catch (err) {
    console.error('tts: connect failed:', err instanceof Error ? err.message : err);
    return null;
  }

  try {
    return await runSession(ws, text);
  } catch (err) {
    console.error('tts: session failed:', err instanceof Error ? err.message : err);
    try {
      ws.close();
    } catch { }
    return null;
  }
}

function runSession(ws: WebSocket, text: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const pcmChunks: Uint8Array[] = [];
    let setupDone = false;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error('generation timeout'));
    }, GENERATION_TIMEOUT_MS);
    const connectTimer = setTimeout(() => {
      if (!setupDone) fail(new Error('setup timeout'));
    }, CONNECT_TIMEOUT_MS);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      try {
        ws.close();
      } catch { }
      console.log(`tts: session finished, pcmChunks=${pcmChunks.length}`);
      resolve(pcmChunks.length ? concatBytes(pcmChunks) : null);
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      try {
        ws.close();
      } catch { }
      reject(err);
    }

    ws.addEventListener('message', (event) => {
      let raw: string;
      let msg: any;
      try {
        raw =
          typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        msg = JSON.parse(raw);
      } catch {
        return; // ignore unparseable frames
      }

      if (msg.setupComplete) {
        setupDone = true;
        clearTimeout(connectTimer);
        console.log(`tts: setup complete, sending text turn`);
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text }] }],
              turnComplete: true,
            },
          })
        );
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          const data = p?.inlineData?.data;
          if (data) pcmChunks.push(base64ToBytes(data));
        }
      }

      const done = msg.serverContent?.turnComplete || msg.serverContent?.generationComplete;

      // Surface any frame that carries neither audio nor a turn signal — this is where
      // the Live API reports setup/argument errors (e.g. bad voice name) that would
      // otherwise vanish, leaving us with a silent empty result.
      const hadAudio = Array.isArray(parts) && parts.some((p: any) => p?.inlineData?.data);
      if (!done && !hadAudio && !msg.serverContent?.modelTurn) {
        console.warn(`tts: unexpected server frame: ${raw.slice(0, 500)}`);
      }

      if (done) {
        console.log(`tts: turn complete, pcmChunks=${pcmChunks.length}`);
        finish();
      }
    });

    ws.addEventListener('close', (event: any) => {
      if (!settled) {
        console.warn(
          `tts: socket closed before completion (setupDone=${setupDone}, ` +
          `pcmChunks=${pcmChunks.length}, code=${event?.code}, reason=${event?.reason || 'none'})`
        );
      }
      finish();
    });
    ws.addEventListener('error', () => fail(new Error('websocket error')));

    // Kick off the session.
    console.log(`tts: sending setup...`);
    ws.send(
      JSON.stringify({
        setup: {
          model: `models/${AUDIO_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: AUDIO_VOICE } },
            },
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        },
      })
    );
  });
}
