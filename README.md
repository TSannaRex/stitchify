[README (1).md](https://github.com/user-attachments/files/27389104/README.1.md)
# Tumblerify v3

AI-generated or uploaded designs → print-ready tumbler wraps at any size.

## What's new in v3

- **AI design generation** via Gemini 2.5 / Nano Banana 2 — describe a tumbler design, get back a print-ready file at the correct size.
- **Smart fit for uploads** — when an uploaded image's aspect doesn't match the cup, choose between Crop, Mirror Extend, or AI Outpaint.
- **Straight / Warped preview toggle** instead of a fake tumbler mockup. Shows the actual print files as the customer's print provider will see them.
- **Style presets** for AI generation: Watercolor, Vintage, Bold Modern, Floral, Boho, Minimalist.

## How it works

### Mode 1: AI generation
1. User picks a tumbler size (e.g. 20oz Skinny → 9.3"×8.2").
2. App maps that to the closest Gemini-supported aspect ratio (5:4 for 20oz Skinny).
3. User writes a prompt; app augments it with tumbler-specific context invisibly.
4. Gemini returns an image at 2K; app cover-fits to exact 2790×2460 px.
5. User sees Straight/Warped preview, downloads PNGs.

### Mode 2: Upload
1. User uploads any image (e.g. AI art generated elsewhere, stock graphics).
2. App detects aspect mismatch with cup, shows fit options:
   - **Crop to fit** — fastest, loses edges
   - **Mirror extend** — free, instant, best for symmetric/abstract
   - **AI extend ✨** — Gemini outpaints the missing edges naturally
3. Same Straight/Warped preview, same downloads.

## Setup

```bash
npm install
export GOOGLE_API_KEY=your-gemini-key   # or GEMINI_API_KEY, both work
npm start
# → http://localhost:3000
```

Without the API key the app still works for upload-only mode; the AI tab and AI extend are locked.

## Deploy to Render

1. Push to GitHub.
2. New → Web Service → connect repo.
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Add environment variable: `GOOGLE_API_KEY` = your key
6. Node version: 18+

## Cost notes

Gemini Nano Banana 2 (gemini-3.1-flash-image-preview) is priced per generated image — at the time of writing, ~$0.04 per 2K image. A user who generates an AI design and AI-extends counts as 2 images = ~$0.08. Worth budgeting if you're integrating into CF Studio for free-tier users; consider gating AI features behind your existing subscription tiers.

## Architecture

```
tumblerify/
├── server.js          # ~110 lines — static + 2 Gemini API endpoints
├── package.json
├── public/
│   └── index.html     # the app — UI, canvas processing, fit strategies
└── README.md
```

Server endpoints:
- `GET  /api/config`         — exposes whether AI is enabled
- `POST /api/generate-image` — text → image (Nano Banana 2, 2K)
- `POST /api/extend-image`   — image → outpainted image at target ratio

All flat/tapered processing remains client-side via Canvas API; only generation and outpainting hit the API.

## Tumbler size config

Industry-standard sublimation specs at 300 DPI for: 11oz Mug, 12oz Skinny, 15oz Mug, 16oz Pint, **20oz Skinny**, 22oz Fatty, 30oz Tumbler, 40oz Quencher.

Each size has an `aiRatio` field mapping it to its closest Gemini-supported aspect ratio for AI generation. Edit `TUMBLER_SIZES` at the top of `<script>` in `public/index.html` to adjust.
