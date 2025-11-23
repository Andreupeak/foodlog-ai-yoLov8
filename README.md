# FoodLog AI — YOLOv8-Seg + OpenAI (beginner friendly)

## Overview
This demo identifies a dish (OpenAI), segments food using a YOLOv8-Seg hosted model (Replicate), computes pixel fraction (frontend), then estimates portion (volume→grams) by asking OpenAI for density.

## Setup
1. Copy `.env.example` to `.env` and fill:
   - OPENAI_API_KEY
   - REPLICATE_API_TOKEN
   - REPLICATE_MODEL_VERSION (copy "version" string from Replicate model Run snippet)

2. Install deps:
   npm install

3. Start:
   npm start

4. Open `http://localhost:3001` (or deploy to Render / GitHub Pages for static files + server on Render).

## Notes
- The segmentation model output format varies by Replicate model version. If `maskUrl` returns null, open `utils/replicate-seg.js` and inspect `prediction.output` to adapt the mask extraction heuristics.
- This is a prototype; portion estimates are heuristic, not clinical-grade.
