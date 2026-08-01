// Welch's method, matched to scipy.signal.welch(..., scaling='spectrum').
// Steps: split into overlapping segments, detrend (remove mean), apply a
// periodic Hann window, FFT each segment, scale by 1/(Σw)² (spectrum scaling),
// make it one-sided (×2 except DC/Nyquist), average the periodograms.
// The returned magnitude is sqrt(power) => linear amplitude (RMS), i.e.
// sqrt(scipy welch spectrum). A tone of amplitude A reads as A/√2 (RMS),
// identical to scipy's default.

// In-place iterative radix-2 FFT (complex). Length must be a power of two.
export function fftRadix2(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wlenRe = Math.cos(ang)
    const wlenIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < half; k += 1) {
        const a = i + k
        const b = a + half
        const vRe = re[b] * wRe - im[b] * wIm
        const vIm = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nwRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nwRe
      }
    }
  }
}

// Periodic Hann window (fftbins=True), matching scipy's get_window default.
function hannPeriodic(n) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

function largestPow2LEQ(v) {
  let p = 1
  while (p * 2 <= v) p *= 2
  return p
}

export function welchSpectrum(y, fs, opts = {}) {
  const overlap = opts.overlap ?? 0.5
  const detrend = opts.detrend ?? true
  let N = opts.nperseg ?? 512
  if (y.length < N) N = largestPow2LEQ(y.length) // clamp to a usable power of two
  const step = Math.max(1, Math.floor(N * (1 - overlap)))

  const win = hannPeriodic(N)
  let winSum = 0
  for (let i = 0; i < N; i += 1) winSum += win[i]
  const scale = 1 / (winSum * winSum) // 'spectrum' scaling

  const nBins = (N >> 1) + 1
  const acc = new Float64Array(nBins)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  let nSeg = 0

  for (let start = 0; start + N <= y.length; start += step) {
    let mean = 0
    if (detrend) {
      for (let k = 0; k < N; k += 1) mean += y[start + k]
      mean /= N
    }
    for (let k = 0; k < N; k += 1) {
      re[k] = (y[start + k] - mean) * win[k]
      im[k] = 0
    }
    fftRadix2(re, im)
    for (let k = 0; k < nBins; k += 1) {
      let p = (re[k] * re[k] + im[k] * im[k]) * scale
      if (k !== 0 && k !== N >> 1) p *= 2 // one-sided
      acc[k] += p
    }
    nSeg += 1
  }
  if (nSeg === 0) nSeg = 1

  const freq = new Float64Array(nBins)
  const mag = new Float32Array(nBins)
  for (let k = 0; k < nBins; k += 1) {
    freq[k] = (k * fs) / N
    mag[k] = Math.sqrt(acc[k] / nSeg) // linear magnitude (RMS amplitude)
  }
  return { freq, mag, nperseg: N, nSegments: nSeg }
}
