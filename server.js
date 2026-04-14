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

app.post('/api/convert', upload.single('image'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const originalB64 = req.file.buffer.toString('base64');
    const originalMime = req.file.mimetype;

    // 1. Gemini text analysis
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
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
    });

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

    // 2. Gemini image generation - photo-realistic embroidery preview (best-effort)
    let embroideryPreviewB64 = null;
    try {
      const imgResponse = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: originalMime, data: originalB64 } },
          { text: `Transform this image into a photo-realistic hand embroidery artwork on natural linen fabric stretched in a wooden embroidery hoop. The embroidery should use colorful silk threads with visible stitch texture - satin stitch for filled areas, back stitch for outlines, French knots for details. The wooden hoop should be clearly visible around the edge. The linen fabric should have a natural off-white texture. Soft, warm studio lighting. Professional embroidery photography style.` }
        ]}],
        generationConfig: { responseModalities: ['IMAGE'] },
      });

      for (const part of imgResponse.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          embroideryPreviewB64 = part.inlineData.data;
          break;
        }
      }
    } catch (imgErr) {
      console.warn('Embroidery preview generation failed:', imgErr.message);
    }

    // 3. Pattern processing - ask Gemini to generate a coloring page version.
    // gemini-3.1-flash-image-preview supports image input + image output.
    let patternImageB64 = null;
    try {
      const patternResponse = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: originalMime, data: originalB64 } },
          { text: 'Turn this into a coloring page. White background, black outlines only, no fills, no shading.' }
        ]}],
        generationConfig: { responseModalities: ['IMAGE'] },
      });

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

        const originalResized = await sharp(req.file.buffer)
      .rotate()
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
                <img src="${patSrc}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">
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
.cover-brand { font-size:26pt; font-weight:700; color:#5c7a52; margin:6mm 0 2mm; }
.cover-sub { font-size:10pt; color:#7a6558; margin-bottom:5mm; }
.cover-img { width:150mm; height:115mm; object-fit:contain; border-radius:3mm; margin-bottom:5mm; background:#fff; }
.cover-title { font-size:18pt; font-weight:700; color:#2d2018; margin-bottom:3mm; text-align:center; padding:0 15mm; }
.cover-desc { font-size:10pt; color:#7a6558; text-align:center; padding:0 18mm; margin-bottom:4mm; line-height:1.6; }
.cover-badge { background:#edf4ea; color:#5c7a52; font-size:9pt; font-weight:600; padding:2mm 6mm; border-radius:10mm; margin-bottom:5mm; }
.colors-section { width:100%; padding:0 14mm; margin-bottom:4mm; }
.section-title { font-size:10pt; font-weight:700; color:#2d2018; margin-bottom:3mm; }
.colors-grid { display:flex; flex-wrap:wrap; gap:2mm; }
.color-chip { display:flex; align-items:center; gap:2mm; background:#f5efe8; border-radius:10mm; padding:2mm 3mm; }
.swatch { width:7mm; height:7mm; border-radius:50%; border:0.3mm solid rgba(0,0,0,0.12); flex-shrink:0; }
.color-info { display:flex; flex-direction:column; }
.color-code { font-size:8pt; font-weight:600; color:#2d2018; }
.color-name { font-size:7pt; color:#7a6558; }
.stitch-section { width:100%; padding:0 14mm; }
.stitch-text { font-size:9pt; color:#7a6558; line-height:1.6; }
.cover-personal { font-size:7pt; color:#c0a898; text-align:center; margin:auto 0 3mm; }
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
    <div class="section-title" style="margin-top:4mm">Stitch Suggestions</div>
    <div class="stitch-text">${pd.stitchSuggestions || ''}</div>
  </div>
  <div class="cover-personal">Happy stitching! We hope you have so much fun bringing this pattern to life.</div>
  <div class="page-bottom-bar"></div>
</div>
${hoopPages}
<div class="page cover">
  <div class="page-top-bar"></div>
  <div class="cover-brand" style="font-size:18pt;margin-top:8mm">Original Image</div>
  <div class="cover-sub">Your source image for reference</div>
  <img class="cover-img" src="${origSrc}" style="width:160mm;height:140mm;margin-top:4mm">
  <div class="cover-personal" style="margin-top:auto">Use this page as a colour reference while you stitch. 🧵</div>
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
