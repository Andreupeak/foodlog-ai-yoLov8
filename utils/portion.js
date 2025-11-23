// utils/portion.js
// Small helpers and formulas if you want server-side portion math in the future.

function estimatePortionFromMaskFraction(pixelFraction, opts = {}) {
  // Same heuristic as server uses in /api/estimate-portion
  const defaultPlateDiameterCm = opts.plateDiameterCm || 25;
  const defaultHeightCm = opts.heightCm || 2.5;
  const plateAreaCm2 = Math.PI * Math.pow(defaultPlateDiameterCm / 2.0, 2);
  const estimatedVolumeMl = pixelFraction * plateAreaCm2 * defaultHeightCm;
  return {
    plateAreaCm2,
    estimatedVolumeMl,
    rawGramsForDensity: (density_g_per_ml) => estimatedVolumeMl * density_g_per_ml
  };
}

module.exports = {
  estimatePortionFromMaskFraction
};
