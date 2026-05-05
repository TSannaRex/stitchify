// Tumblerify v3 — adds Gemini image generation + smart fit endpoints.
// Static files for the SPA, plus three API routes:
//   GET  /api/config         — tells the client whether AI features are available
//   POST /api/generate-image — text → image via Nano Banana 2
//   POST /api/extend-image   — image + target ratio → outpainted image

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';

// Nano Banana 2 — better quality, supports more aspect ratios up to 4K
const MODEL = 'gemini-3.1-flash-image-preview';
const ENDPOINT = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

app.use(express.json({ limit: '20mb' }));   // big enough for base64 images
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ─── Health & config ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, version: '3.0.0' }));
app.get('/api/config', (_req, res) => res.json({
  aiEnabled: !!API_KEY,
  model: MODEL
}));

// ─── Helper: call Gemini image API ───────────────────────────────────────────
async function callGemini({ prompt, inputImageDataUrl, aspectRatio, imageSize = '2K' }) {
  if (!API_KEY) throw new Error('GOOGLE_API_KEY not configured on server');

  const parts = [{ text: prompt }];
  if (inputImageDataUrl) {
    const m = inputImageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid input image data URL');
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }

  // Gemini's REST API uses snake_case for these fields (camelCase often silently ignored)
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['Image'],
      image_config: {
        aspect_ratio: aspectRatio,
        image_size: imageSize
      }
    }
  };

  const r = await fetch(ENDPOINT(MODEL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Gemini API ${r.status}: ${txt.slice(0, 500)}`);
  }
  const data = await r.json();

  // Find the first inline_data block with an image
  for (const c of (data.candidates || [])) {
    for (const p of (c.content?.parts || [])) {
      const inline = p.inline_data || p.inlineData;
      if (inline?.data) {
        const mime = inline.mime_type || inline.mimeType || 'image/png';
        return `data:${mime};base64,${inline.data}`;
      }
    }
  }
  throw new Error('Gemini returned no image: ' + JSON.stringify(data).slice(0, 400));
}

// ─── Generate from prompt ────────────────────────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, aspectRatio = '1:1', imageSize = '2K' } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });

    const augmented = `${prompt.trim()}. Sublimation tumbler wrap design, focal subject centered, clean composition suitable for printing on a stainless steel tumbler.`;

    const dataUrl = await callGemini({ prompt: augmented, aspectRatio, imageSize });
    res.json({ dataUrl });
  } catch (err) {
    console.error('generate-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Extend / outpaint an uploaded image to a new aspect ratio ───────────────
app.post('/api/extend-image', async (req, res) => {
  try {
    const { imageDataUrl, aspectRatio, imageSize = '2K' } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({ error: 'imageDataUrl required' });

    const prompt = `Extend this image to fill a ${aspectRatio} aspect ratio. Continue the existing artwork seamlessly into the new edge areas, matching style, colors, and content. Do not change the original subject or content — only extend the background and edges naturally.`;

    const dataUrl = await callGemini({ prompt, inputImageDataUrl: imageDataUrl, aspectRatio, imageSize });
    res.json({ dataUrl });
  } catch (err) {
    console.error('extend-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Tumblerify v3 listening on :${PORT}  (AI ${API_KEY ? 'enabled' : 'DISABLED — set GOOGLE_API_KEY'})`);
});
