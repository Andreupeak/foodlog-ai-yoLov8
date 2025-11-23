// app.js - frontend logic to upload, show image, call identification, segmentation, compute pixel fraction
const fileInput = document.getElementById('fileInput');
const identifyBtn = document.getElementById('identifyBtn');
const segmentBtn = document.getElementById('segmentBtn');
const estimateBtn = document.getElementById('estimateBtn');
const status = document.getElementById('status');
const canvas = document.getElementById('canvas');
const info = document.getElementById('info');
const resultPre = document.getElementById('resultPre');

let currentImageDataUrl = null;
let currentFoodName = null;
let currentMaskUrl = null;
let currentPixelFraction = null;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function drawImageToCanvas(img) {
  const ctx = canvas.getContext('2d');
  // size canvas to image but limit to 800px wide for display
  const maxW = 800;
  let w = img.width, h = img.height;
  if (w > maxW) {
    const scale = maxW / w;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(img, 0, 0, w, h);
}

async function overlayMaskOnCanvas(maskUrl) {
  if (!maskUrl) return;
  return new Promise((resolve) => {
    const maskImg = new Image();
    maskImg.crossOrigin = "anonymous";
    maskImg.onload = () => {
      const ctx = canvas.getContext('2d');
      // draw mask as semi-transparent red on top of image
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
      // create semi-transparent overlay for mask pixels:
      const imgd = ctx.getImageData(0,0,canvas.width,canvas.height);
      const data = imgd.data;
      for (let i=0;i<data.length;i+=4) {
        // if mask pixel is not transparent (alpha > 10), tint with red
        if (data[i+3] > 10) {
          // red tint
          data[i] = 255;
          // keep green/blue low
          data[i+1] = Math.round(data[i+1] * 0.2);
          data[i+2] = Math.round(data[i+2] * 0.2);
          data[i+3] = 160; // semi-transparent
        } else {
          // keep original alpha (fully transparent for mask)
        }
      }
      ctx.putImageData(imgd, 0, 0);
      resolve();
    };
    maskImg.onerror = () => resolve(); // don't block on mask load errors
    maskImg.src = maskUrl;
  });
}

function computeMaskPixelFraction(maskUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // draw mask to an offscreen canvas same size as display canvas
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(img, 0, 0, off.width, off.height);
      const d = ctx.getImageData(0,0,off.width,off.height).data;
      let total = 0, maskPixels = 0;
      for (let i=0;i<d.length;i+=4) {
        total++;
        const alpha = d[i+3];
        // treat as mask if alpha > 10 or color non-black
        if (alpha > 10) maskPixels++;
        else {
          // some masks encode white pixels; check brightness
          const r = d[i], g = d[i+1], b = d[i+2];
          if (r+g+b > 10) maskPixels++;
        }
      }
      const fraction = maskPixels / total;
      resolve(fraction);
    };
    img.onerror = (e) => reject(e);
    img.src = maskUrl;
  });
}

identifyBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return alert('Choose an image first');
  status.textContent = 'Identifying...';
  try {
    const fd = new FormData();
    fd.append('image', file);
    const r = await fetch('/api/identify', { method:'POST', body: fd });
    const data = await r.json();
    if (data.error) {
      status.textContent = 'Error: ' + data.error;
      return;
    }
    currentFoodName = data.foodName;
    status.textContent = 'Detected: ' + currentFoodName;
    // display image
    currentImageDataUrl = await readFileAsDataUrl(file);
    const img = new Image();
    img.onload = () => drawImageToCanvas(img);
    img.src = currentImageDataUrl;
    info.textContent = 'Image loaded. Now click Segment.';
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
  }
});

segmentBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return alert('Choose an image first');
  status.textContent = 'Segmenting (YOLOv8-Seg via Replicate)...';
  try {
    const fd = new FormData();
    fd.append('image', file);
    const r = await fetch('/api/segment', { method:'POST', body: fd });
    const data = await r.json();
    if (data.error) {
      status.textContent = 'Error: ' + data.error;
      return;
    }
    // segResult.maskUrl expected
    const maskUrl = data.segResult && data.segResult.maskUrl;
    if (!maskUrl) {
      status.textContent = 'No mask returned by model. Check REPLICATE_MODEL_VERSION output format.';
      console.debug('segResult', data.segResult);
      return;
    }
    currentMaskUrl = maskUrl;
    currentImageDataUrl = await readFileAsDataUrl(file);
    // draw original image then overlay mask
    const img = new Image();
    img.onload = async () => {
      drawImageToCanvas(img);
      await overlayMaskOnCanvas(maskUrl);
      status.textContent = 'Segmentation done. Click Estimate Portion.';
      info.textContent = 'Detected: ' + (currentFoodName || 'unknown');
    };
    img.src = currentImageDataUrl;
  } catch (err) {
    console.error(err);
    status.textContent = 'Failed: ' + err.message;
  }
});

estimateBtn.addEventListener('click', async () => {
  if (!currentImageDataUrl || !currentMaskUrl) return alert('Run Identify and Segment first.');
  status.textContent = 'Computing pixel fraction...';
  try {
    const fraction = await computeMaskPixelFraction(currentMaskUrl);
    currentPixelFraction = fraction;
    status.textContent = `Mask fraction: ${(fraction*100).toFixed(2)}%`;
    // Send to server to refine via OpenAI density
    const payload = {
      imageBase64: currentImageDataUrl,
      maskUrl: currentMaskUrl,
      foodName: currentFoodName || 'unknown',
      pixelFraction: fraction
    };
    const res = await fetch('/api/estimate-portion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.error) {
      resultPre.textContent = 'Error: ' + result.error;
    } else {
      resultPre.textContent = JSON.stringify(result, null, 2);
    }
  } catch (err) {
    console.error(err);
    status.textContent = 'Error computing fraction: ' + err.message;
  }
});
