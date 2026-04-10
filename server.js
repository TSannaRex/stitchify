import express from 'express';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname + '/public'));

// ─── HOOP SIZES (diameter in mm, for A4 printing) ────────────────────────────
const HOOPS = [
  { label: '3" Hoop',  mm: 76.2  },
  { label: '4" Hoop',  mm: 101.6 },
  { label: '5" Hoop',  mm: 127.0 },
  { label: '6" Hoop',  mm: 152.4 },
  { label: '7" Hoop',  mm: 177.8 },
  { label: '8" Hoop',  mm: 203.2 },
];

// ─── MAIN CONVERSION ENDPOINT ────────────────────────────────────────────────
app.post('/api/convert', upload.single('image'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Step 1: Convert image to greyscale and get base64
    const processedBuffer = await sharp(req.file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .toBuffer();

    const originalB64 = req.file.buffer.toString('base64');
    const originalMime = req.file.mimetype;

    // Step 2: Use Gemini to analyse and describe the image for line-art conversion
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: originalMime,
              data: originalB64
            }
          },
          {
            text: `You are an expert embroidery pattern designer. Analyse this image carefully.

Return a JSON object with these exact fields:
{
  "title": "short descriptive title of the main subject (e.g. 'Highland Cow', 'Baby Elephant')",
  "description": "one warm sentence describing what this embroidery pattern depicts",
  "dmcColors": [
    { "code": "DMC code as string", "name": "color name", "hex": "#hexcode", "area": "what part of the design this color is for" }
  ],
  "stitchSuggestions": "2-3 sentences suggesting which stitches to use for the main elements (back stitch for outlines, satin stitch for fills, etc.)",
  "difficulty": "Beginner / Intermediate / Advanced"
}

Suggest 3-6 DMC thread colors that would work beautifully for this design. Use real DMC color codes and accurate hex values.
Return ONLY the JSON, no other text.`
          }
        ]
      }],
    });

    let patternData;
    try {
      const text = response.text.replace(/```json|```/g, '').trim();
      patternData = JSON.parse(text);
    } catch (e) {
      patternData = {
        title: 'My Embroidery Pattern',
        description: 'A beautiful hand embroidery pattern ready to stitch.',
        dmcColors: [
          { code: '310', name: 'Black', hex: '#000000', area: 'Outlines' },
          { code: '3865', name: 'Winter White', hex: '#F5F5F0', area: 'Highlights' }
        ],
        stitchSuggestions: 'Use back stitch for all outlines. Fill large areas with satin stitch. Add French knots for texture.',
        difficulty: 'Beginner'
      };
    }

    // Step 3: Process image for pattern
    // sensitivity slider: higher value = more detail (lower threshold = more dark pixels)
    const sensitivity = parseInt(req.body.sensitivity) || 128;
    // Map sensitivity (50-220) to threshold (200-60): more sensitivity = lower threshold = more lines
    const thresholdVal = Math.round(200 - ((sensitivity - 50) / 170) * 140);

    const patternBuffer = await sharp(req.file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .normalise()               // stretch contrast to full range
      .gamma(1.5)                // darken mid-tones to make lines more visible
      .linear(2.0, -40)          // aggressive contrast boost
      .threshold(thresholdVal)   // black lines on white background — NO negate
      .png()
      .toBuffer();

    const patternB64 = patternBuffer.toString('base64');
    const originalResized = await sharp(req.file.buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const originalResizedB64 = originalResized.toString('base64');

    res.json({
      patternData,
      patternImageB64: patternB64,
      originalImageB64: originalResizedB64,
    });

  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: err.message || 'Conversion failed.' });
  }
});

// Serve beginners guide
app.get('/beginners-guide.pdf', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'beginners-guide.pdf'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stitchify running on port ${PORT}`));
