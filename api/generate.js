// Vercel Node function: turns one image into the next stage of the portrait.
// POST { step, image } → { image: "data:<mime>;base64,..." }

export const config = { maxDuration: 60 };

const MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent';

const PROMPTS = {
  portrait:
    "Transform this photo into an oil portrait painted in London around 1890, in the style of a flattering Victorian society portrait. Repose the sitter as for a formal portrait sitting: body turned three-quarters away from the viewer, head turned back towards the viewer, shoulders relaxed. Do not copy the pose, angle or crop of the photo. Paint the sitter idealised and in the full bloom of youth, around twenty years old: smooth, luminous skin, bright eyes, radiant and beautiful, while keeping their face and features clearly recognisable as them. Half-length, set in a richly furnished Victorian drawing room: heavy velvet drapery to one side, a gilt-framed painting on the dark panelled wall behind, warm candlelight. Visible brushwork, fine craquelure. Dress them in elegant 1890s attire suited to how they present in the photo. Portrait orientation. No frame, no text, no signature.",
  'level-1':
    "This is a Victorian oil portrait. Make a subtle but unmistakable change so the sitter becomes quietly creepy. Keep the mouth exactly as it is. The eyes go dead: no crinkles at the corners, flat lower lids, a fixed and unblinking stare. Remove all catchlights and reflections from the eyes, and make the pupils slightly larger. The eyes now look directly out of the canvas at the viewer, even though the body stays turned away. Give the eyebrows a slightly higher, more pronounced arch at their outer ends, without lowering or furrowing them. The overall effect is a pleasant face with something not alive behind the eyes. Not angry, not frowning, not sad, not petulant: the brows stay relaxed and the expression stays calm. Keep everything else exactly the same: face shape, eye colour, skin, hair, clothing, pose, background, lighting and brushwork.",
  'level-2':
    'This is a Victorian oil portrait. Repaint it to show the sitter after years of opium dens, absinthe, brandy and debauchery. Age them by twenty years. Make the skin sallow and yellowed, blotched with broken red veins, and the eyes heavy-lidded, bloodshot and dull. Add yellowed, decaying teeth bared in a knowing, leering smile, and streak the hair with grey. Keep the composition, pose, clothing, background, lighting and brushwork. Grotesque, but not bloody. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a knowing, leering grin, never friendly or kind. Ordinary human teeth, no fangs.',
  'level-3':
    "This is a Victorian oil portrait. Repaint it to show the sitter after committing murder. Keep the skin tone, hair colour and degree of ageing exactly as in the input image: do not make the skin grey, green or more sallow. The change is in the expression and the hand. The face is harder and leaner, and the eyes cold, glittering and cruel. One hand is now coated in wet, glistening crimson, as if the canvas itself were sweating blood: bright red liquid beading on the skin and running down between the fingers in fresh drips. If no hand is visible, bring one hand up to rest on the chest. The skin of the hand is unbroken, with no wounds and no gore. Keep the composition, pose, clothing, background, lighting and brushwork. Menacing. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a knowing, leering grin, never friendly or kind. Ordinary human teeth, no fangs. Keep the exact same eye colour as the input image.",
  'level-4':
    "This is a Victorian oil portrait. This is the most shocking transformation of the series: the decay arrives all at once. Repaint it to show the sitter's soul in final ruin, after a hypocritical good deed. Still a face of flesh, never a skeleton or exposed skull: withered, ancient and rotting, the skin grey-green, sagging, cracked and blotched with decay, the lips thin and peeling over rotten teeth, lank wisps of grey hair. The eyes hold a look of sly cunning, and the mouth has the curved wrinkle of the hypocrite. The face of a monster, yet the faintest trace of the original features remains. The wet crimson on the hand remains, darker and spreading. Keep the composition, pose, clothing, background, lighting and brushwork. Horrifying. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a knowing, leering grin, never friendly or kind. Ordinary human teeth, no fangs. Keep the exact same eye colour as the input image.",
  slash:
    "Keep this as a realistic photograph with the same pose, clothing and background. Transform the person into a withered, loathsome, decaying version of themselves, as if a lifetime of hidden vice had caught up with them at once. Still a face of flesh, never a skeleton or exposed skull: ancient, sagging grey-green skin, cracked and blotched with decay, sunken eyes, thin peeling lips over rotten teeth, lank wisps of grey hair. The faintest trace of their original features remains. Horrifying.",
};

const DATA_URL = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/* ---------- Rate limit (Upstash Redis REST) ---------- */

const DAILY_LIMIT = 30;
const WINDOW_SECONDS = 24 * 60 * 60;

async function redis(url, token, command) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  return (await r.json()).result;
}

function visitorIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
}

// True when this visitor has used up today's generations. Without Redis
// configured (local dev) there is no limit; if Redis is unreachable, let the
// request through rather than lock everyone out.
async function overLimit(req) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const key = `gen:${visitorIp(req)}`;
    const count = await redis(url, token, ['INCR', key]);
    if (count === 1) await redis(url, token, ['EXPIRE', key, WINDOW_SECONDS]);
    return count > DAILY_LIMIT;
  } catch (err) {
    console.error(`rate limit check failed: ${err?.message ?? 'Error'}`);
    return false;
  }
}

/* ---------- Handler ---------- */

async function readBody(req) {
  // Vercel pre-parses JSON into req.body; the local dev server does too,
  // but fall back to reading the stream in case neither did.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'method not allowed' });
  }

  try {
    if (await overLimit(req)) return send(res, 429, { error: 'limit' });

    const { step, image } = await readBody(req);
    const prompt = PROMPTS[step];
    const match = typeof image === 'string' && image.match(DATA_URL);
    if (!prompt || !match) return send(res, 502, { error: 'failed' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY is not set');
      return send(res, 502, { error: 'failed' });
    }

    const upstream = await fetch(MODEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, { inlineData: { mimeType: match[1], data: match[2] } }],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '3:4', imageSize: '1K' },
        },
      }),
      signal: AbortSignal.timeout(55_000),
    });

    if (!upstream.ok) {
      // Log status only server-side; never forward upstream bodies to the client.
      console.error(`Gemini ${step}: HTTP ${upstream.status}`);
      const body = upstream.status === 429 ? await upstream.text().catch(() => '') : '';
      if (upstream.status === 402 || body.includes('RESOURCE_EXHAUSTED')) {
        return send(res, 503, { error: 'closed' });
      }
      return send(res, 502, { error: 'failed' });
    }

    const data = await upstream.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);

    if (!inline) {
      const reason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? 'no image';
      console.error(`Gemini ${step}: refused (${reason})`);
      return send(res, 422, { error: 'refused' });
    }

    const mime = inline.mimeType ?? inline.mime_type ?? 'image/png';
    return send(res, 200, { image: `data:${mime};base64,${inline.data}` });
  } catch (err) {
    console.error(`generate failed: ${err?.name ?? 'Error'}`);
    return send(res, 502, { error: 'failed' });
  }
}
