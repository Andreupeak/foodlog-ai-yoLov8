// server.js - Node + Express backend (CommonJS)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const replicate = require('./utils/replicate-seg');
const { estimatePortionFromMaskFraction } = require('./utils/portion');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads (test UI uses this)
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Helpers ----------
function bufferToDataUrl(buffer, mime = 'image/jpeg') {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

// ---------- OpenAI helpers ----------
async function identifyFoodWithOpenAI(imageDataUrl) {
  // Returns a short food name (string)
  const prompt = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: "Identify the primary food or dish in this image. Reply with a short name only, e.g. 'chicken curry with rice'. No extra explanation." }
      ]
    }
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: prompt,
    temperature: 0.0
  });

  const text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
  return text.trim();
}

async function getDensityEstimateFromOpenAI(foodName) {
  // We ask OpenAI for an estimated density in g/ml (float).
  const prompt = `Estimate the typical density (mass per volume) in grams per milliliter for "${foodName}" (e.g., water=1.0). Reply with a single number only, with up to two decimal places. If unsure, give a reasonable typical value.`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.0
  });
  const out = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
  const match = out.match(/[\d]+(?:\.\d+)?/);
  const num = match ? parseFloat(match[0]) : 1.0;
  return num;
}

// ---------- Routes ----------

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// POST /api/identify - FormData file upload -> identifies food name
app.post('/api/identify', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file' });
    const dataUrl = bufferToDataUrl(req.file.buffer, req.file.mimetype || 'image/jpeg');
    const foodName = await identifyFoodWithOpenAI(dataUrl);
    res.json({ foodName });
  } catch (err) {
    console.error('identify error', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/segment - returns segmentation info from Replicate
// Accepts JSON: { imageBase64: "<data:image/...>" } or form-data file upload
app.post('/api/segment', upload.single('image'), async (req, res) => {
  try {
    let dataUrl;
    if (req.file) {
      dataUrl = bufferToDataUrl(req.file.buffer, req.file.mimetype || 'image/jpeg');
    } else if (req.body && req.body.imageBase64) {
      dataUrl = req.body.imageBase64;
    } else {
      return res.status(400).json({ error: 'Missing image' });
    }

    // replicate-seg module expects dataUrl (data:image/...)
    const segResult = await replicate.runModelVersion(dataUrl);
    // segResult should contain maskUrl or outputs - see utils/replicate-seg.js
    res.json({ segResult });
  } catch (err) {
    console.error('segment error', err.response?.data || err.message || err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/estimate-portion
// JSON body expected:
// {
//   imageBase64: "data:...",
//   maskUrl: "https://... or data:... (mask PNG)",
//   foodName: "chicken curry"
// }
// This endpoint will:
//  - compute density via OpenAI (g/ml)
//  - take frontend-provided pixel fraction OR compute naive fallback
//  - return portion estimates and math
app.post('/api/estimate-portion', async (req, res) => {
  try {
    const { imageBase64, maskUrl, foodName, pixelFraction } = req.body;
    if (!imageBase64 || !maskUrl || !foodName) {
      return res.status(400).json({ error: 'Missing fields (imageBase64, maskUrl, foodName)' });
    }

    // If frontend sent pixelFraction (foodPixels / imagePixels), use it.
    // Otherwise, we could try to fetch the mask and compute on server (left as TODO).
    const fraction = (typeof pixelFraction === 'number' && pixelFraction > 0 && pixelFraction <= 1) ? pixelFraction : null;
    if (!fraction) {
      // If no fraction from frontend, ask user to enable frontend pixel fraction (it is faster & works client-side).
      return res.status(400).json({ error: 'Missing pixelFraction. Frontend should compute mask pixel fraction and send it.' });
    }

    // Convert pixel fraction -> estimated grams
    // Heuristic: assume a standard plate diameter and an average food height
    // volume_ml = area_fraction * plate_area_cm2 * height_cm
    // grams = volume_ml * density_g_per_ml (density ~ g/ml)
    // Defaults:
    const defaultPlateDiameterCm = 25; // avg dinner plate ~25 cm diameter
    const defaultHeightCm = 2.5;       // typical food height to approximate volume
    const plateAreaCm2 = Math.PI * Math.pow(defaultPlateDiameterCm / 2.0, 2); // cm^2

    // volume in milliliters (1 ml ≈ 1 cm^3)
    const estimatedVolumeMl = fraction * plateAreaCm2 * defaultHeightCm;

    // ask OpenAI for density
    const density_g_per_ml = await getDensityEstimateFromOpenAI(foodName);

    const rawPortionGrams = estimatedVolumeMl * density_g_per_ml;

    // Build response
    res.json({
      foodName,
      pixelFraction: fraction,
      plateAssumptions: {
        plateDiameterCm: defaultPlateDiameterCm,
        assumedHeightCm: defaultHeightCm,
        plateAreaCm2: Number(plateAreaCm2.toFixed(2))
      },
      estimatedVolumeMl: Number(estimatedVolumeMl.toFixed(2)),
      density_g_per_ml: Number(density_g_per_ml.toFixed(2)),
      portionEstimate_g: Number(rawPortionGrams.toFixed(1))
    });

  } catch (err) {
    console.error('estimate-portion error', err.response?.data || err.message || err);
    res.status(500).json({ error: String(err) });
  }
});

// fallback root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
