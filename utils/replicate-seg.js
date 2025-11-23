// utils/replicate-seg.js
// Simple helper to call Replicate API for a model version that performs segmentation (YOLOv8-Seg).
// NOTE: Put REPLICATE_MODEL_VERSION in your .env (Replicate model version ID or "model:version" string).
// The helper assumes the model accepts an "image" input (either URL or data URL) and returns an output
// where one of the items is a mask image URL (data URL or hosted URL). If the model's output format
// differs, adapt the parsing below.

const axios = require('axios');
require('dotenv').config();

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;

if (!REPLICATE_API_TOKEN) {
  console.warn('Warning: REPLICATE_API_TOKEN is not set in .env - segmentation will fail until set.');
}
if (!REPLICATE_MODEL_VERSION) {
  console.warn('Warning: REPLICATE_MODEL_VERSION is not set in .env - set it to your chosen YOLOv8-seg model version.');
}

async function runModelVersion(dataUrl) {
  if (!REPLICATE_API_TOKEN) throw new Error('Missing REPLICATE_API_TOKEN in environment');
  if (!REPLICATE_MODEL_VERSION) throw new Error('Missing REPLICATE_MODEL_VERSION in environment');

  // Replicate expects either "version" or "model" depending on Run API usage.
  // We will send { version: REPLICATE_MODEL_VERSION, input: { image: dataUrl } }
  // If your model expects a field with a different name (e.g., "image" or "img"), adapt input object.
  const url = 'https://api.replicate.com/v1/predictions';

  const body = {
    version: REPLICATE_MODEL_VERSION,
    input: {
      image: dataUrl
    }
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Token ${REPLICATE_API_TOKEN}`
  };

  const resp = await axios.post(url, body, { headers });

  // The prediction is asynchronous; poll until status != "starting"/"processing"
  const predictionUrl = resp.data && resp.data.urls && resp.data.urls.get;
  let prediction = resp.data;

  if (predictionUrl) {
    // Poll loop
    let tries = 0;
    while ((prediction.status === 'starting' || prediction.status === 'processing') && tries < 60) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await axios.get(predictionUrl, { headers });
      prediction = poll.data;
      tries++;
    }
  } else {
    // Some versions return the full object immediately
    prediction = resp.data;
  }

  if (prediction.status === 'failed') {
    throw new Error('Replicate prediction failed: ' + JSON.stringify(prediction));
  }

  // Many Replicate segmentation models produce prediction.output which may contain:
  //  - a URL to a mask or overlay image (prediction.output[0] or prediction.output.mask)
  //  - an object with "masks" or "segmentation" keys
  // We'll try to find a mask-like URL in the outputs.
  const output = prediction.output;

  // Heuristics to find mask URL:
  function findMaskUrl(out) {
    if (!out) return null;
    if (typeof out === 'string' && (out.startsWith('http') || out.startsWith('data:'))) {
      // sometimes it's directly an image url
      const ext = out.split('?')[0].split('.').pop();
      if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) || out.startsWith('data:')) return out;
    }
    if (Array.isArray(out)) {
      for (const o of out) {
        const v = findMaskUrl(o);
        if (v) return v;
      }
    }
    if (typeof out === 'object') {
      // common keys
      for (const k of ['mask', 'masks', 'segmentation', 'segmented_image', 'overlay']) {
        if (out[k]) {
          const v = findMaskUrl(out[k]);
          if (v) return v;
        }
      }
      // check for nested fields
      for (const key of Object.keys(out)) {
        const v = findMaskUrl(out[key]);
        if (v) return v;
      }
    }
    return null;
  }

  const maskUrl = findMaskUrl(output);

  // Return whole prediction plus maskUrl for convenience
  return {
    prediction,
    maskUrl
  };
}

module.exports = {
  runModelVersion
};
