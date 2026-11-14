// Vercel Node function: turns one image into the next stage of the portrait.
// POST { step, image } → { image: "data:<mime>;base64,..." }

export const config = { maxDuration: 60 };

const MODEL_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent';

const PROMPTS = {
  portrait:
    "Transform this photo into an oil portrait painted in London around 1890, in the style of a flattering Victorian society portrait. Paint the sitter idealised and in the full bloom of youth, around twenty years old: smooth, luminous skin, bright eyes, radiant and beautiful, while keeping their face and features clearly recognisable as them. Head and shoulders, three-quarter view, dark muted background, warm candlelit lighting, visible brushwork, fine craquelure. Dress them in elegant 1890s attire suited to how they present in the photo. Portrait orientation. No frame, no text, no signature.",
  'level-1':
    "This is a Victorian oil portrait. Make a subtle but unmistakable change to the expression only. Lower the brows very slightly and draw their inner ends a fraction closer together. The eyes stop smiling: no crinkles, no warmth, just a flat, steady, appraising stare. Keep the exact same eye colour. The smile shrinks to a thin, closed-lip curl at one corner of the mouth only, faintly contemptuous. The overall effect is someone quietly amused by another person's pain. Do not make the smile bigger. Keep everything else exactly the same: face shape, eye colour, skin, hair, clothing, pose, background, lighting and brushwork.",
  'level-2':
    'This is a Victorian oil portrait. Repaint it to show the sitter after years of opium dens, absinthe, brandy and debauchery. Age them by twenty years. Make the skin sallow and yellowed, blotched with broken red veins, and the eyes heavy-lidded, bloodshot and dull. Add yellowed, decaying teeth bared in a knowing, predatory leer, and streak the hair with grey. Keep the composition, pose, clothing, background, lighting and brushwork. Grotesque, but not bloody. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a leering, predatory grin, never friendly or kind.',
  'level-3':
    'This is a Victorian oil portrait. Repaint it to show the sitter after committing murder. Make them gaunt and sunken, with the cheekbones jutting, the skin grey and mottled, the hair thin and grey, and the eyes cold, glittering and cruel. One hand is now coated in wet, glistening crimson, as if the canvas itself were sweating blood: bright red liquid beading on the skin and running down between the fingers in fresh drips. The skin of the hand is unbroken, with no wounds and no gore. Keep the composition, pose, clothing, background, lighting and brushwork. Grotesque and menacing. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a leering, predatory grin, never friendly or kind. Keep the exact same eye colour as the input image.',
  'level-4':
    "This is a Victorian oil portrait. Repaint it to show the sitter's soul in final ruin, after a hypocritical good deed. Still a face of flesh, never a skeleton or exposed skull: withered, ancient and rotting, the skin grey-green, sagging, cracked and blotched with decay, the lips thin and peeling over rotten teeth, lank wisps of grey hair. The eyes hold a look of sly cunning, and the mouth has the curved wrinkle of the hypocrite. The face of a monster, yet the faintest trace of the original features remains. The wet crimson on the hand remains, darker and spreading. Keep the composition, pose, clothing, background, lighting and brushwork. Horrifying. Whatever the previous expression, make it more sinister than before: the eyes never smile and hold no warmth, and any smile becomes a sneer or a leering, predatory grin, never friendly or kind. Keep the exact same eye colour as the input image.",
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
