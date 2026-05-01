import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { GoogleGenAI } from '@google/genai';
import puppeteerLib from 'puppeteer-core';
import chromiumLib from '@sparticuz/chromium';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Frustum math (server-side copy) ────────────────────────────────────────
const Frustum = require('./public/frustum.js');

// ─── Gemini analysis ─────────────────────────────────────────────────────────
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype;
    const sizeKey = req.body.sizeKey || '16oz';
    const params = Frustum.compute(sizeKey, 10);

    const prompt = `You are analyzing a design image that will be printed as a tumbler wrap for a ${params.label} cup.
The wrap will be ${Math.round(params.outerArc)}mm wide at the top and ${Math.round(params.innerArc)}mm wide at the bottom, ${Math.round(params.slant)}mm tall.
The image resolution is approximately ${req.file.size > 500000 ? 'high' : 'low'} based on file size.

Respond ONLY with valid JSON, no markdown, no backticks:
{
  "style": "2-4 word style description (e.g. 'boho floral watercolor')",
  "colors": ["#hex1","#hex2","#hex3","#hex4","#hex5"],
  "colorNames": ["name1","name2","name3","name4","name5"],
  "mood": "one sentence describing the feel of the design",
  "printQuality": "good|fair|low",
  "printNote": "one sentence about print quality for this wrap size",
  "recommendation": "one practical tip for best print result"
}`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data: b64 } },
          { text: prompt }
        ]
      }]
    });

    let json;
    try {
      const text = result.candidates[0].content.parts[0].text.trim()
        .replace(/```json/g,'').replace(/```/g,'').trim();
      json = JSON.parse(text);
    } catch {
      json = {
        style: 'Custom design',
        colors: ['#e8b4b8','#a8d8ea','#f7e7ce','#cce2cb','#b8b3c8'],
        colorNames: ['Rose','Sky','Cream','Sage','Lavender'],
        mood: 'A beautiful design ready to wrap your tumbler.',
        printQuality: 'good',
        printNote: 'Design looks good for this wrap size.',
        recommendation: 'Ensure your image is at least 150dpi for crisp results.'
      };
    }
    res.json(json);
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Generate PDF + SVG + ZIP ─────────────────────────────────────────────────
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    const sizeKey   = req.body.sizeKey || '16oz';
    const overlapMm = parseFloat(req.body.overlapMm) || 10;
    const analysisJson = req.body.analysis ? JSON.parse(req.body.analysis) : null;

    const params = Frustum.compute(sizeKey, overlapMm);
    const b64Image = req.file.buffer.toString('base64');
    const mime = req.file.mimetype;

    // ── Generate SVG cutfile ──────────────────────────────────────────────────
    const { compute, arcPath, boundingBox } = Frustum;
    const bbox  = boundingBox(params);
    const scale = 3.7795; // mm to px at 96dpi
    const sw    = bbox.width  * scale;
    const sh    = bbox.height * scale;
    const cx    = bbox.cx     * scale;
    const cy    = bbox.cy     * scale;

    const paths = arcPath(params, scale);

    const svgCutfile = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" 
     width="${sw.toFixed(1)}px" height="${sh.toFixed(1)}px"
     viewBox="0 0 ${sw.toFixed(1)} ${sh.toFixed(1)}"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
  <title>Tumbler Wrap Cutfile - ${params.label}</title>
  <desc>Annular sector cut path for ${params.label} tumbler. Top arc: ${Math.round(params.outerArc)}mm, Bottom arc: ${Math.round(params.innerArc)}mm, Height: ${Math.round(params.slant)}mm. Overlap: ${overlapMm}mm.</desc>
  <g transform="translate(${cx.toFixed(1)}, ${cy.toFixed(1)})">
    <!-- Cut line -->
    <path d="${paths.d}" 
          fill="none" 
          stroke="#000000" 
          stroke-width="0.5"
          inkscape:label="Cut line"/>
    <!-- Overlap indicator (score/fold line) -->
    <path d="${paths.overlapLine}"
          fill="none"
          stroke="#000000"
          stroke-width="0.5"
          stroke-dasharray="4,3"
          inkscape:label="Overlap fold line"/>
  </g>
</svg>`;

    // ── Generate PDF via Puppeteer ────────────────────────────────────────────
    const chromium = chromiumLib;
    const puppeteer = puppeteerLib;

    const styleBlock = analysisJson ? analysisJson.colors.slice(0,5).map((c,i) =>
      `.swatch-${i} { background: ${c}; }`
    ).join('\n') : '';

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Poppins', sans-serif; background: white; width: 210mm; min-height: 297mm; }
  .page { padding: 14mm 14mm 10mm; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8mm; border-bottom: 0.3mm solid #e5e5e5; padding-bottom: 5mm; }
  .brand { font-size: 9pt; font-weight: 600; color: #5C5BD4; letter-spacing: 0.06em; text-transform: uppercase; }
  .size-badge { background: #EEEDFE; color: #3C3489; font-size: 8pt; font-weight: 600; padding: 3px 10px; border-radius: 12px; }

  /* Wrap canvas area */
  .wrap-canvas { width: 100%; background: #f9f9fb; border: 0.3mm solid #e5e5e5; border-radius: 3mm; padding: 8mm; display: flex; align-items: center; justify-content: center; margin-bottom: 6mm; position: relative; min-height: 80mm; }
  .wrap-svg { display: block; }

  /* Specs row */
  .specs { display: flex; gap: 4mm; margin-bottom: 6mm; }
  .spec { flex: 1; background: #f4f4f8; border-radius: 2mm; padding: 4mm; }
  .spec-label { font-size: 6.5pt; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 1.5mm; }
  .spec-value { font-size: 9pt; font-weight: 500; color: #1a1a2e; }

  /* AI analysis panel */
  .ai-panel { background: #EEEDFE; border-radius: 3mm; padding: 5mm 6mm; margin-bottom: 6mm; }
  .ai-label { font-size: 6.5pt; font-weight: 600; color: #534AB7; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3mm; }
  .ai-row { display: flex; align-items: flex-start; gap: 6mm; }
  .ai-swatches { display: flex; gap: 2mm; align-items: center; }
  .swatch { width: 10mm; height: 10mm; border-radius: 1.5mm; border: 0.2mm solid rgba(0,0,0,0.1); }
  .ai-text { flex: 1; }
  .ai-style { font-size: 8.5pt; font-weight: 500; color: #3C3489; margin-bottom: 1.5mm; }
  .ai-mood  { font-size: 7.5pt; color: #534AB7; line-height: 1.5; margin-bottom: 1.5mm; }
  .ai-note  { font-size: 7pt; color: #7B7AE0; }

  /* Quality badge */
  .quality-good  { background: #EAF3DE; color: #27500A; padding: 2px 8px; border-radius: 10px; font-size: 7pt; font-weight: 600; display: inline-block; }
  .quality-fair  { background: #FAEEDA; color: #633806; padding: 2px 8px; border-radius: 10px; font-size: 7pt; font-weight: 600; display: inline-block; }
  .quality-low   { background: #FCEBEB; color: #501313; padding: 2px 8px; border-radius: 10px; font-size: 7pt; font-weight: 600; display: inline-block; }

  /* Print tip */
  .tip { border-left: 0.6mm solid #5C5BD4; padding-left: 3.5mm; margin-bottom: 6mm; }
  .tip-label { font-size: 6.5pt; font-weight: 600; color: #5C5BD4; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 1mm; }
  .tip-text  { font-size: 7.5pt; color: #555; line-height: 1.5; }

  /* Footer */
  .footer { border-top: 0.3mm solid #e5e5e5; padding-top: 4mm; display: flex; justify-content: space-between; align-items: center; }
  .footer-text { font-size: 6.5pt; color: #aaa; }

  ${styleBlock}

  /* Page 2: design-only sheet */
  .page2 { page-break-before: always; padding: 10mm; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 297mm; background: white; }
  .page2-label { font-size: 7.5pt; color: #888; margin-bottom: 5mm; text-transform: uppercase; letter-spacing: 0.06em; }
  .page2 img { max-width: 100%; max-height: 240mm; display: block; }
  .cut-note { margin-top: 5mm; font-size: 7pt; color: #aaa; text-align: center; }

  /* Crop marks */
  .cropmark { position: absolute; width: 3mm; height: 0.2mm; background: #999; }
  .cropmark-v { width: 0.2mm; height: 3mm; }
</style>
</head>
<body>

<!-- PAGE 1: Info + wrap preview -->
<div class="page">
  <div class="header">
    <div class="brand">Tumblerify</div>
    <div class="size-badge">${params.label} Tumbler Wrap</div>
  </div>

  <!-- Wrap arc SVG preview with design clipped inside -->
  <div class="wrap-canvas">
    ${generateWrapSVGForPDF(params, b64Image, mime)}
  </div>

  <!-- Specs -->
  <div class="specs">
    <div class="spec">
      <div class="spec-label">Top circumference</div>
      <div class="spec-value">${Math.round(params.outerArc)} mm</div>
    </div>
    <div class="spec">
      <div class="spec-label">Bottom circumference</div>
      <div class="spec-value">${Math.round(params.innerArc)} mm</div>
    </div>
    <div class="spec">
      <div class="spec-label">Wrap height (slant)</div>
      <div class="spec-value">${Math.round(params.slant)} mm</div>
    </div>
    <div class="spec">
      <div class="spec-label">Overlap tab</div>
      <div class="spec-value">${overlapMm} mm</div>
    </div>
  </div>

  ${analysisJson ? `
  <!-- AI panel -->
  <div class="ai-panel">
    <div class="ai-label">AI Design Analysis</div>
    <div class="ai-row">
      <div class="ai-swatches">
        ${analysisJson.colors.slice(0,5).map((c,i) => `<div class="swatch" style="background:${c};"></div>`).join('')}
      </div>
      <div class="ai-text">
        <div class="ai-style">${analysisJson.style} &nbsp;
          <span class="quality-${analysisJson.printQuality}">${analysisJson.printQuality === 'good' ? 'Print ready' : analysisJson.printQuality === 'fair' ? 'Check resolution' : 'Low resolution'}</span>
        </div>
        <div class="ai-mood">${analysisJson.mood}</div>
        <div class="ai-note">${analysisJson.printNote}</div>
      </div>
    </div>
  </div>

  <!-- Tip -->
  <div class="tip">
    <div class="tip-label">Print tip</div>
    <div class="tip-text">${analysisJson.recommendation}</div>
  </div>
  ` : ''}

  <div class="footer">
    <div class="footer-text">Generated by Tumblerify &bull; ${params.label} &bull; Arc angle: ${params.sweepDeg.toFixed(1)}°</div>
    <div class="footer-text">Print at 100% scale — do not scale to fit</div>
  </div>
</div>

<!-- PAGE 2: Full-bleed design for cutting/printing -->
<div class="page2">
  <div class="page2-label">Print & cut sheet — scale 1:1</div>
  ${generateWrapSVGForPDF(params, b64Image, mime, true)}
  <div class="cut-note">Cut along outer edge &bull; Score dashed line (overlap tab) &bull; ${overlapMm}mm overlap included</div>
</div>

</body>
</html>`;

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
        if (['image', 'stylesheet', 'font'].includes(req.resourceType()) &&
            !req.url().includes('fonts.googleapis') &&
            !req.url().includes('fonts.gstatic')) {
          req.abort();
        } else {
          req.continue();
        }
      });
      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 2000));
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 }
      });

    // ── ZIP both files ────────────────────────────────────────────────────────
    const sizeName = sizeKey.replace('/','');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="tumblerify-${sizeName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    archive.append(pdfBuffer, { name: `tumbler-wrap-${sizeName}.pdf` });
    archive.append(Buffer.from(svgCutfile), { name: `tumbler-cutfile-${sizeName}.svg` });
    await archive.finalize();

  } catch (err) {
    console.error('Generate error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── SVG helper — used inside the PDF HTML ────────────────────────────────────
function generateWrapSVGForPDF(params, b64Image, mime, fullBleed = false) {
  const { arcPath, boundingBox } = Frustum;

  // Scale to fit nicely on page (A4 inner width ~182mm @ 3.7795px/mm)
  const maxW = fullBleed ? 182 : 160;
  const bbox  = boundingBox(params);
  const scale = Math.min((maxW / bbox.width) * 3.7795, fullBleed ? 5 : 3.5);

  const sw = bbox.width  * scale;
  const sh = bbox.height * scale;
  const cx = bbox.cx     * scale;
  const cy = bbox.cy     * scale;

  const paths = arcPath(params, scale);
  const clipId = 'wrapClip_' + params.sizeKey + (fullBleed ? '_fb' : '');

  return `<svg xmlns="http://www.w3.org/2000/svg" 
    width="${sw.toFixed(0)}px" height="${sh.toFixed(0)}px"
    viewBox="0 0 ${sw.toFixed(0)} ${sh.toFixed(0)}">
  <defs>
    <clipPath id="${clipId}">
      <path d="${paths.d}" transform="translate(${cx.toFixed(0)},${cy.toFixed(0)})"/>
    </clipPath>
  </defs>
  <g transform="translate(${cx.toFixed(0)},${cy.toFixed(0)})">
    <!-- Design image clipped to arc shape -->
    <image href="data:${mime};base64,${b64Image}"
           x="${(-cx).toFixed(0)}" y="0"
           width="${sw.toFixed(0)}" height="${sh.toFixed(0)}"
           preserveAspectRatio="xMidYMid slice"
           clip-path="url(#${clipId})"/>
    <!-- Cut outline -->
    <path d="${paths.d}" fill="none" stroke="${fullBleed ? '#000' : '#5C5BD4'}" stroke-width="${fullBleed ? 1 : 1.5}"/>
    <!-- Overlap dashed line -->
    <path d="${paths.overlapLine}" fill="none" stroke="${fullBleed ? '#444' : '#9999e0'}" stroke-width="1" stroke-dasharray="5,4"/>
  </g>
</svg>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tumblerify running on port ${PORT}`));
