// Espectro de magnitud al cuadrado de longitud EXACTA, para cualquier N.
//
// El radix-2 de welch.js obliga a rellenar con ceros hasta la potencia de dos
// siguiente, y para feq eso no sirve: con N=3000 → 4096 el padding desplaza la
// media ponderada por f² hasta un 12%.
//
// Camino principal: Cooley-Tukey mixed-radix recursivo, que hace la DFT de
// longitud exacta descomponiendo N en sus factores primos. Las dos longitudes
// del master son 5-smooth (3000 = 2³·3·5³, 10000 = 2⁴·5⁴), así que caen
// enteras por aquí.
//
// Camino de respaldo: si N tiene un factor primo grande (p.ej. N primo), la
// descomposición degenera en O(p²) y se usa Bluestein (chirp-z), que convierte
// la DFT en una convolución resoluble con el radix-2 de welch.js.

import { fftRadix2 } from './welch.js'

const MAX_DIRECT_PRIME = 31 // por encima de esto, sale más barato Bluestein
const cache = new Map() // N -> plan

function factorize(n) {
  const f = []
  let m = n
  while (m % 2 === 0) {
    f.push(2)
    m /= 2
  }
  for (let p = 3; p * p <= m; p += 2) {
    while (m % p === 0) {
      f.push(p)
      m /= p
    }
  }
  if (m > 1) f.push(m)
  return f
}

// --- Plan mixed-radix --------------------------------------------------------

function makeMixedPlan(N, factors) {
  // Tabla global de twiddles W_N^i. Cualquier sub-DFT de longitud n | N usa
  // W_n^{lk} = W_N^{lk·(N/n)}, así que basta con esta.
  const twRe = new Float64Array(N)
  const twIm = new Float64Array(N)
  for (let i = 0; i < N; i += 1) {
    const ang = (-2 * Math.PI * i) / N
    twRe[i] = Math.cos(ang)
    twIm[i] = Math.sin(ang)
  }

  const maxP = factors.reduce((a, b) => Math.max(a, b), 2)

  return {
    kind: 'mixed',
    N,
    factors,
    twRe,
    twIm,
    srcRe: new Float64Array(N),
    srcIm: new Float64Array(N),
    dstRe: new Float64Array(N),
    dstIm: new Float64Array(N),
    tRe: new Float64Array(maxP),
    tIm: new Float64Array(maxP),
    out: new Float64Array((N >> 1) + 1),
  }
}

// DIT recursivo: separa la entrada en p subsecuencias con paso `stride`,
// transforma cada una y las recombina con una DFT de tamaño p por cada k.
function rec(plan, dstOff, srcOff, stride, n, depth) {
  const { factors, twRe, twIm, srcRe, srcIm, dstRe, dstIm, tRe, tIm, N } = plan

  if (n === 1) {
    dstRe[dstOff] = srcRe[srcOff]
    dstIm[dstOff] = srcIm[srcOff]
    return
  }

  const p = factors[depth]
  const m = n / p

  for (let l = 0; l < p; l += 1) {
    rec(plan, dstOff + l * m, srcOff + l * stride, stride * p, m, depth + 1)
  }

  // X[j·m + k] = Σ_l ( Y_l[k]·W_N^{l·k·(N/n)} ) · W_p^{l·j}
  const step = N / n
  const pStep = N / p

  for (let k = 0; k < m; k += 1) {
    // Twiddle de los resultados parciales
    for (let l = 0; l < p; l += 1) {
      const idx = dstOff + l * m + k
      const re = dstRe[idx]
      const im = dstIm[idx]
      if (l === 0) {
        tRe[0] = re
        tIm[0] = im
      } else {
        const w = (l * k * step) % N
        const wr = twRe[w]
        const wi = twIm[w]
        tRe[l] = re * wr - im * wi
        tIm[l] = re * wi + im * wr
      }
    }

    // DFT de tamaño p sobre t
    if (p === 2) {
      const ar = tRe[0]
      const ai = tIm[0]
      const br = tRe[1]
      const bi = tIm[1]
      dstRe[dstOff + k] = ar + br
      dstIm[dstOff + k] = ai + bi
      dstRe[dstOff + m + k] = ar - br
      dstIm[dstOff + m + k] = ai - bi
    } else {
      for (let j = 0; j < p; j += 1) {
        let sr = 0
        let si = 0
        for (let l = 0; l < p; l += 1) {
          const w = (l * j * pStep) % N
          const wr = twRe[w]
          const wi = twIm[w]
          sr += tRe[l] * wr - tIm[l] * wi
          si += tRe[l] * wi + tIm[l] * wr
        }
        dstRe[dstOff + j * m + k] = sr
        dstIm[dstOff + j * m + k] = si
      }
    }
  }
}

// --- Plan Bluestein (respaldo para N con factores primos grandes) ------------
//
//   n·k = (n² + k² − (k−n)²) / 2
//   X_k = e^{−iπk²/N} · Σ_n [ x_n·e^{−iπn²/N} ] · e^{+iπ(k−n)²/N}
//
// El factor de fuera tiene módulo 1, así que para |X_k|² se puede omitir.

function makeBluesteinPlan(N) {
  let M = 1
  while (M < 2 * N - 1) M <<= 1

  const chirpRe = new Float64Array(N)
  const chirpIm = new Float64Array(N)
  for (let n = 0; n < N; n += 1) {
    // n² se reduce módulo 2N antes del coseno: sin eso se pierde precisión.
    const m = (n * n) % (2 * N)
    const ang = (-Math.PI * m) / N
    chirpRe[n] = Math.cos(ang)
    chirpIm[n] = Math.sin(ang)
  }

  const bRe = new Float64Array(M)
  const bIm = new Float64Array(M)
  bRe[0] = chirpRe[0]
  bIm[0] = -chirpIm[0]
  for (let n = 1; n < N; n += 1) {
    bRe[n] = chirpRe[n]
    bIm[n] = -chirpIm[n]
    bRe[M - n] = chirpRe[n]
    bIm[M - n] = -chirpIm[n]
  }
  fftRadix2(bRe, bIm)

  return {
    kind: 'bluestein',
    N,
    M,
    chirpRe,
    chirpIm,
    bFftRe: bRe,
    bFftIm: bIm,
    aRe: new Float64Array(M),
    aIm: new Float64Array(M),
    out: new Float64Array((N >> 1) + 1),
  }
}

function getPlan(N) {
  let p = cache.get(N)
  if (p) return p
  const factors = factorize(N)
  const maxP = factors.reduce((a, b) => Math.max(a, b), 2)
  p = maxP <= MAX_DIRECT_PRIME ? makeMixedPlan(N, factors) : makeBluesteinPlan(N)
  cache.set(N, p)
  return p
}

// Devuelve |X_k|² para k = 0..floor(N/2) (one-sided, como numpy.fft.rfft),
// con la DFT de longitud exacta N. El buffer devuelto se reutiliza entre
// llamadas: cópialo si necesitas conservarlo.
export function magSquaredSpectrum(x, mean = 0) {
  const N = x.length
  const plan = getPlan(N)
  const half = N >> 1
  const { out } = plan

  if (plan.kind === 'mixed') {
    const { srcRe, srcIm, dstRe, dstIm } = plan
    for (let i = 0; i < N; i += 1) srcRe[i] = x[i] - mean
    srcIm.fill(0)
    rec(plan, 0, 0, 1, N, 0)
    for (let k = 0; k <= half; k += 1) {
      out[k] = dstRe[k] * dstRe[k] + dstIm[k] * dstIm[k]
    }
    return out
  }

  const { M, chirpRe, chirpIm, bFftRe, bFftIm, aRe, aIm } = plan
  aRe.fill(0)
  aIm.fill(0)
  for (let n = 0; n < N; n += 1) {
    const v = x[n] - mean
    aRe[n] = v * chirpRe[n]
    aIm[n] = v * chirpIm[n]
  }
  fftRadix2(aRe, aIm)
  // Producto puntual con B, luego FFT inversa vía conjugado:
  // ifft(z) = conj(fft(conj(z)))/M
  for (let i = 0; i < M; i += 1) {
    const re = aRe[i] * bFftRe[i] - aIm[i] * bFftIm[i]
    const im = aRe[i] * bFftIm[i] + aIm[i] * bFftRe[i]
    aRe[i] = re
    aIm[i] = -im
  }
  fftRadix2(aRe, aIm)
  const inv2 = 1 / (M * M)
  for (let k = 0; k <= half; k += 1) {
    out[k] = (aRe[k] * aRe[k] + aIm[k] * aIm[k]) * inv2
  }
  return out
}
