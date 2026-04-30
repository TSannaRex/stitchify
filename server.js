import express from 'express';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '30mb' }));
app.use(express.static(__dirname + '/public'));

const HOOPS = [
  { label: '3" Hoop', mm: 76.2  },
  { label: '4" Hoop', mm: 101.6 },
  { label: '5" Hoop', mm: 127.0 },
  { label: '6" Hoop', mm: 152.4 },
  { label: '7" Hoop', mm: 177.8 },
  { label: '8" Hoop', mm: 203.2 },
];

// ── Gemini retry helper ────────────────────────────────────────────────────
// Retries a Gemini API call up to maxRetries times with exponential backoff.
// Catches 429 (rate limit) and 503 (overload) errors automatically.
async function geminiWithRetry(fn, maxRetries = 4) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || '';
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Resource exhausted');
      const is503 = msg.includes('503') || msg.includes('UNAVAILABLE');
      if ((is429 || is503) && attempt < maxRetries) {
        console.warn(`Gemini rate limit hit (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2; // exponential backoff: 2s, 4s, 8s, 16s
      } else {
        throw err;
      }
    }
  }
}

app.post('/api/convert', upload.single('image'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Auto-crop: remove dark/transparent borders so the design fills the frame.
    // This prevents the hoop circle from clipping designs that sit in a padded canvas.
    const croppedBuffer = await (async () => {
      const { data: raw, info } = await sharp(req.file.buffer)
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { width, height, channels } = info;
      let minX = width, minY = height, maxX = 0, maxY = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * channels;
          const r = raw[i], g = raw[i+1], b = raw[i+2];
          // Consider a pixel "content" if it's not near-black or near-white background
          // Near-black: all channels < 40 (transparent/black bg)
          // For white-bg images we skip this — just crop near-black
          if (!(r < 40 && g < 40 && b < 40)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // Add a small padding around the detected content
      const pad = Math.round(Math.min(width, height) * 0.03);
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(width - 1, maxX + pad);
      maxY = Math.min(height - 1, maxY + pad);

      const cropW = maxX - minX + 1;
      const cropH = maxY - minY + 1;

      // Only crop if we found a meaningful content area (> 20% of original)
      if (cropW > width * 0.2 && cropH > height * 0.2 && (cropW < width * 0.95 || cropH < height * 0.95)) {
        return sharp(req.file.buffer)
          .rotate()
          .extract({ left: minX, top: minY, width: cropW, height: cropH })
          .png()
          .toBuffer();
      }
      // No meaningful crop found, use original
      return req.file.buffer;
    })();

    const originalB64 = croppedBuffer.toString('base64');
    const originalMime = 'image/png';

    // 1. Gemini text analysis
    const response = await geminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: originalMime, data: originalB64 } },
        { text: `You are an expert embroidery pattern designer. Analyse this image carefully.
Return a JSON object with these exact fields:
{
  "title": "short descriptive title of the main subject",
  "description": "one warm sentence describing what this embroidery pattern depicts",
  "dmcColors": [{ "code": "DMC code", "name": "color name", "hex": "#hexcode", "area": "what part" }],
  "stitchSuggestions": "2-3 sentences suggesting stitches",
  "difficulty": "Beginner / Intermediate / Advanced"
}
Suggest 3-6 DMC thread colors. Use real DMC codes and accurate hex values. Return ONLY the JSON.` }
      ]}],
    }));

    let patternData;
    try {
      patternData = JSON.parse(response.text.replace(/```json|```/g, '').trim());
    } catch (e) {
      patternData = {
        title: 'My Embroidery Pattern',
        description: 'A beautiful hand embroidery pattern ready to stitch.',
        dmcColors: [{ code: '310', name: 'Black', hex: '#000000', area: 'Outlines' }],
        stitchSuggestions: 'Use back stitch for outlines, satin stitch for fills, French knots for texture.',
        difficulty: 'Beginner'
      };
    }

    // 2. Embroidery preview is generated on-demand via /api/preview endpoint
    // to avoid burning 3x quota on every single convert request.
    const embroideryPreviewB64 = null;

    // Small pause between API calls to stay within per-minute rate limits
    await new Promise(r => setTimeout(r, 1000));

    // 3. Pattern processing - ask Gemini to generate a coloring page version.
    // gemini-3.1-flash-image-preview supports image input + image output.
    let patternImageB64 = null;
    try {
      const patternResponse = await geminiWithRetry(() => ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: originalMime, data: originalB64 } },
          { text: 'Turn this into a circular embroidery pattern coloring page. IMPORTANT: compose ALL elements of the design within a circle shape, leaving white space in the corners outside the circle. The entire design must fit within a circular boundary. White background, black outlines only, no fills, no shading, no grey. Every element must be clearly visible inside the circle.' }
        ]}],
        generationConfig: { responseModalities: ['IMAGE'] },
      }));

      for (const part of patternResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          patternImageB64 = part.inlineData.data;
          break;
        }
      }
      if (!patternImageB64) console.warn('Pattern gen: no image part in response');
    } catch (patErr) {
      console.error('Pattern generation FAILED:', patErr.message);
      console.error('Pattern generation error details:', JSON.stringify(patErr, null, 2));
    }

    // Fallback: if Gemini image gen failed, use simple Sharp threshold
    if (!patternImageB64) {
      const sensitivity = parseInt(req.body.sensitivity) || 128;
      const binaryThreshold = Math.round(240 - ((sensitivity - 50) / 170) * 180);
      const fallbackBuffer = await sharp(req.file.buffer)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .greyscale()
        .normalise()
        .threshold(binaryThreshold)
        .png()
        .toBuffer();
      patternImageB64 = fallbackBuffer.toString('base64');
    }

        // Use the already-cropped buffer for the original preview too
    const originalResized = await sharp(croppedBuffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png().toBuffer();

    res.json({
      patternData,
      patternImageB64,
      originalImageB64:    originalResized.toString('base64'),
      embroideryPreviewB64,
    });

  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: err.message || 'Conversion failed.' });
  }
});

// On-demand embroidery preview — only called when user clicks the Embroidered tab
app.post('/api/preview', upload.single('image'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const originalB64 = req.file.buffer.toString('base64');
    const originalMime = req.file.mimetype;

    const imgResponse = await geminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: originalMime, data: originalB64 } },
        { text: `Transform this image into a photo-realistic hand embroidery artwork on natural linen fabric stretched in a wooden embroidery hoop. The embroidery should use colorful silk threads with visible stitch texture - satin stitch for filled areas, back stitch for outlines, French knots for details. The wooden hoop should be clearly visible around the edge. The linen fabric should have a natural off-white texture. Soft, warm studio lighting. Professional embroidery photography style.` }
      ]}],
      generationConfig: { responseModalities: ['IMAGE'] },
    }));

    let embroideryPreviewB64 = null;
    for (const part of imgResponse.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        embroideryPreviewB64 = part.inlineData.data;
        break;
      }
    }

    if (!embroideryPreviewB64) return res.status(500).json({ error: 'No image generated.' });
    res.json({ embroideryPreviewB64 });

  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.list();
    const names = [];
    for await (const m of result) names.push(m.name);
    res.json(names);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { patternData: pd, patternImageB64, originalImageB64, embroideryPreviewB64 } = req.body;
    const origSrc  = 'data:image/png;base64,' + originalImageB64;
    const patSrc   = 'data:image/png;base64,' + patternImageB64;
    const embSrc   = embroideryPreviewB64 ? 'data:image/png;base64,' + embroideryPreviewB64 : origSrc;

    const colorsHtml = (pd.dmcColors || []).map(c => `
      <div class="color-chip">
        <div class="swatch" style="background:${c.hex || '#ccc'}"></div>
        <div class="color-info">
          <span class="color-code">DMC ${c.code}</span>
          <span class="color-name">${c.name}</span>
        </div>
      </div>`).join('');

    const hoopPages = HOOPS.map(h => {
      const px = (mm) => (mm * 3.7795).toFixed(1);
      return `
      <div class="page hoop-page">
        <div class="page-top-bar"></div>
        <div class="hoop-header">
          <div class="hoop-brand">Stitchify<span class="hoop-subtitle">${pd.title || 'My Pattern'}</span></div>
          <div class="hoop-size-label">${h.label}</div>
        </div>
        <div class="hoop-sep"></div>
        <div class="hoop-center">
          <div style="width:${px(h.mm + 14)}px;height:${px(h.mm + 14)}px;border-radius:50%;background:conic-gradient(#d4a84b,#c8973a,#e8c06a,#c8973a,#d4a84b);display:flex;align-items:center;justify-content:center;">
            <div style="width:${px(h.mm + 4)}px;height:${px(h.mm + 4)}px;border-radius:50%;background:#b8842a;display:flex;align-items:center;justify-content:center;">
              <div style="width:${px(h.mm)}px;height:${px(h.mm)}px;border-radius:50%;background:#f9f6f0;overflow:hidden;border:1px dashed #c8b09a;">
                <img src="${patSrc}" style="width:100%;height:100%;object-fit:contain;display:block;">
              </div>
            </div>
          </div>
          <div class="hoop-label">${h.label}</div>
        </div>
        <div class="hoop-footer">
          <p>Print on A4 - choose "Fit to Page". The hoop guide above is true to size.</p>
          <p>Happy stitching! We hope you enjoy making this.</p>
        </div>
        <div class="page-bottom-bar"></div>
      </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing:border-box; margin:0; padding:0; font-family:'Poppins',sans-serif; }
.page { width:210mm; min-height:297mm; background:#faf7f4; display:flex; flex-direction:column; page-break-after:always; }
.page-top-bar { height:8mm; background:#5c7a52; flex-shrink:0; }
.page-bottom-bar { height:6mm; background:#5c7a52; flex-shrink:0; }
.cover { align-items:center; }
.cover-brand { font-size:22pt; font-weight:700; color:#5c7a52; margin:4mm 0 1mm; }
.cover-sub { font-size:9pt; color:#7a6558; margin-bottom:3mm; }
.cover-img { width:130mm; height:130mm; object-fit:cover; border-radius:4mm; margin-bottom:3mm; background:#fff; }
.cover-title { font-size:15pt; font-weight:700; color:#2d2018; margin-bottom:2mm; text-align:center; padding:0 15mm; }
.cover-desc { font-size:9pt; color:#7a6558; text-align:center; padding:0 18mm; margin-bottom:2mm; line-height:1.5; }
.cover-badge { background:#edf4ea; color:#5c7a52; font-size:8pt; font-weight:600; padding:1.5mm 5mm; border-radius:10mm; margin-bottom:3mm; }
.colors-section { width:100%; padding:0 14mm; margin-bottom:2mm; }
.section-title { font-size:9pt; font-weight:700; color:#2d2018; margin-bottom:2mm; }
.colors-grid { display:flex; flex-wrap:wrap; gap:2mm; }
.color-chip { display:flex; align-items:center; gap:2mm; background:#f5efe8; border-radius:10mm; padding:1.5mm 3mm; }
.swatch { width:7mm; height:7mm; border-radius:50%; border:0.3mm solid rgba(0,0,0,0.12); flex-shrink:0; }
.color-info { display:flex; flex-direction:column; }
.color-code { font-size:8pt; font-weight:600; color:#2d2018; }
.color-name { font-size:7pt; color:#7a6558; }
.stitch-section { width:100%; padding:0 14mm; }
.stitch-text { font-size:8pt; color:#7a6558; line-height:1.5; }
.cover-personal { font-size:7pt; color:#c0a898; text-align:center; margin:2mm 0 2mm; }
.hoop-header { display:flex; justify-content:space-between; align-items:flex-start; padding:5mm 14mm 3mm; }
.hoop-brand { font-size:12pt; font-weight:700; color:#5c7a52; display:flex; flex-direction:column; }
.hoop-subtitle { font-size:9pt; font-weight:400; color:#7a6558; }
.hoop-size-label { font-size:14pt; font-weight:700; color:#2d2018; }
.hoop-sep { height:0.3mm; background:#d4c4b8; margin:0 14mm; }
.hoop-center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:6mm 0; }
.hoop-label { font-size:11pt; font-weight:700; color:#2d2018; margin-top:5mm; }
.hoop-footer { text-align:center; padding:0 14mm 3mm; }
.hoop-footer p { font-size:7pt; color:#a89080; line-height:1.8; }
</style></head><body>
<div class="page cover">
  <div class="page-top-bar"></div>
  <div class="cover-brand">Stitchify</div>
  <div class="cover-sub">Hand Embroidery Pattern</div>
  <img class="cover-img" src="${embSrc}">
  <div class="cover-title">${pd.title || 'My Embroidery Pattern'}</div>
  <div class="cover-desc">${pd.description || ''}</div>
  <div class="cover-badge">Difficulty: ${pd.difficulty || 'Beginner'}</div>
  <div class="colors-section">
    <div class="section-title">DMC Thread Colors</div>
    <div class="colors-grid">${colorsHtml}</div>
  </div>
  <div class="stitch-section">
    <div class="section-title" style="margin-top:2mm">Stitch Suggestions</div>
    <div class="stitch-text">${pd.stitchSuggestions || ''}</div>
  </div>
  <div class="cover-personal">Happy stitching! We hope you have so much fun bringing this pattern to life.</div>
  <div class="page-bottom-bar"></div>
</div>
${hoopPages}
<div class="page cover">
  <div class="page-top-bar"></div>
  <div class="cover-brand" style="font-size:18pt;margin-top:8mm">Colour Reference</div>
  <div class="cover-sub">Use this page to guide your thread colour choices while you stitch</div>
  <img class="cover-img" src="${origSrc}" style="width:170mm;height:170mm;margin-top:6mm;object-fit:contain;">
  <div class="cover-personal" style="margin-top:auto">Happy stitching! 🧵</div>
  <div class="page-bottom-bar"></div>
</div>
</body></html>`;

    let browser = null;
    try {
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font'].includes(req.resourceType()) && !req.url().includes('fonts.googleapis') && !req.url().includes('fonts.gstatic')) {
          req.abort();
        } else {
          req.continue();
        }
      });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 2000));
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
      });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': pdfBuffer.length });
      res.send(pdfBuffer);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: err.message || 'PDF generation failed.' });
  }
});

app.get('/beginners-guide.pdf', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'beginners-guide.pdf'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stitchify running on port ${PORT}`));
