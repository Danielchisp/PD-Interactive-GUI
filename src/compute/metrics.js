// Módulo de cálculo de 22 métricas estadísticas, temporales, espectrales y de eventos en JS

import { magSquaredSpectrum } from './fft.js'

export const METRICS = {
  feq: { key: 'feq', label: 'Frecuencia Eq.', unit: 'Hz' },
  vmax: { key: 'vmax', label: 'Vmax', unit: 'V' },
  vpp: { key: 'vpp', label: 'VPP', unit: 'V' },
  rms: { key: 'rms', label: 'Valor RMS', unit: 'V' },
  crest: { key: 'crest', label: 'Factor de Cresta', unit: '' },
  log5_crest: { key: 'log5_crest', label: 'Log5 Factor de Cresta', unit: '' },
  kurtosis: { key: 'kurtosis', label: 'Kurtosis', unit: '' },
  skewness: { key: 'skewness', label: 'Skewness', unit: '' },
  f_stat: { key: 'f_stat', label: 'Análisis F (Crest × Kurt)', unit: '' },
  risetime: { key: 'risetime', label: 'Rise Time', unit: 'ns' },
  teq: { key: 'teq', label: 'Tiempo Eq.', unit: 'µs' },
  zcr: { key: 'zcr', label: 'ZCR', unit: '' },
  f_aprox: { key: 'f_aprox', label: 'Frec. Aprox.', unit: 'Hz' },
  erel: { key: 'erel', label: 'Energía Relativa', unit: '' },
  energia_v2s: { key: 'energia_v2s', label: 'Energía V²s', unit: 'V²s' },
  energia_j: { key: 'energia_j', label: 'Energía Joules (50Ω)', unit: 'J' },
  shannon: { key: 'shannon', label: 'Entropía Shannon', unit: 'bits' },
  dt: { key: 'dt', label: 'Delta T', unit: 's' },
  logdt: { key: 'logdt', label: 'Log Delta T', unit: '' },
  tasa_pulsos: { key: 'tasa_pulsos', label: 'Tasa de Pulsos', unit: 'Hz' },
  tasa_energia: { key: 'tasa_energia', label: 'Tasa de Energía', unit: 'rel/s' },
}

export function computeMetricForSignal(key, v, timestamps, index, totalSignals, fs = 3e9, R = 50.0) {
  const N = v.length
  if (N === 0) return 0

  let v_max_val = -Infinity
  let v_min_val = Infinity
  let abs_max_val = 0
  let sum_sq = 0
  let sum_v = 0

  for (let i = 0; i < N; i++) {
    const val = v[i]
    if (val > v_max_val) v_max_val = val
    if (val < v_min_val) v_min_val = val
    const abs_v = Math.abs(val)
    if (abs_v > abs_max_val) abs_max_val = abs_v
    sum_v += val
    sum_sq += val * val
  }

  const mean = sum_v / N
  const rms = Math.sqrt(sum_sq / N)
  const safe_rms = rms === 0 ? 1e-15 : rms

  switch (key) {
    case 'vmax':
      return abs_max_val

    case 'vpp':
      return v_max_val - v_min_val

    case 'rms':
      return rms

    case 'crest': {
      return abs_max_val / safe_rms
    }

    case 'log5_crest': {
      const cf = abs_max_val / safe_rms
      const safe_cf = Math.max(cf, 1e-15)
      return Math.log(safe_cf) / Math.log(5.0)
    }

    case 'kurtosis': {
      let m4 = 0
      let m2 = 0
      for (let i = 0; i < N; i++) {
        const diff = v[i] - mean
        m2 += diff * diff
        m4 += diff * diff * diff * diff
      }
      m2 /= N
      m4 /= N
      if (m2 === 0) return 0
      return m4 / (m2 * m2) - 3.0 // Fisher kurtosis
    }

    case 'skewness': {
      let m3 = 0
      let m2 = 0
      for (let i = 0; i < N; i++) {
        const diff = v[i] - mean
        m2 += diff * diff
        m3 += diff * diff * diff
      }
      m2 /= N
      m3 /= N
      if (m2 === 0) return 0
      return m3 / Math.pow(m2, 1.5)
    }

    case 'f_stat': {
      const cf = abs_max_val / safe_rms
      let m4 = 0
      let m2 = 0
      for (let i = 0; i < N; i++) {
        const diff = v[i] - mean
        m2 += diff * diff
        m4 += diff * diff * diff * diff
      }
      m2 /= N
      m4 /= N
      const kurt = m2 === 0 ? 0 : (m4 / (m2 * m2) - 3.0)
      return cf * kurt
    }

    case 'risetime': {
      if (abs_max_val === 0) return 0
      const v10 = 0.1 * abs_max_val
      const v90 = 0.9 * abs_max_val
      let idx_max = 0
      for (let i = 0; i < N; i++) {
        if (Math.abs(v[i]) === abs_max_val) {
          idx_max = i
          break
        }
      }
      let idx10 = -1
      let idx90 = -1
      for (let i = 0; i <= idx_max; i++) {
        const abs_v = Math.abs(v[i])
        if (idx10 === -1 && abs_v >= v10) idx10 = i
        if (idx90 === -1 && abs_v >= v90) idx90 = i
      }
      if (idx10 !== -1 && idx90 !== -1) {
        return Math.max(0, ((idx90 - idx10) / fs) * 1e9) // ns
      }
      return 0
    }

    case 'teq': {
      if (sum_sq === 0) return 0
      let t0_num = 0
      for (let i = 0; i < N; i++) {
        const t = i / fs
        t0_num += t * (v[i] * v[i])
      }
      const t0 = t0_num / sum_sq
      let t_diff_sq_sum = 0
      for (let i = 0; i < N; i++) {
        const t = i / fs
        const diff = t - t0
        t_diff_sq_sum += (diff * diff) * (v[i] * v[i])
      }
      const t_eq = Math.sqrt(t_diff_sq_sum / sum_sq)
      return t_eq * 1e6 // µs
    }

    case 'zcr': {
      let crossings = 0
      let prev_sign = Math.sign(v[0]) || 1
      for (let i = 1; i < N; i++) {
        let s = Math.sign(v[i]) || 1
        if (s !== prev_sign) {
          crossings++
          prev_sign = s
        }
      }
      return crossings / (N - 1)
    }

    case 'f_aprox': {
      let crossings = 0
      let prev_sign = Math.sign(v[0]) || 1
      for (let i = 1; i < N; i++) {
        let s = Math.sign(v[i]) || 1
        if (s !== prev_sign) {
          crossings++
          prev_sign = s
        }
      }
      const zcr_val = crossings / (N - 1)
      return (zcr_val * fs) / 2.0 // Hz
    }

    case 'erel':
      return sum_sq

    case 'energia_v2s':
      return (1.0 / fs) * sum_sq

    case 'energia_j':
      return (1.0 / (fs * R)) * sum_sq

    case 'shannon': {
      if (abs_max_val === 0) return 0
      const bins = 64
      const counts = new Int32Array(bins)
      for (let i = 0; i < N; i++) {
        const y = v[i] / abs_max_val
        let b = Math.floor(((y + 1.0) / 2.0) * bins)
        if (b >= bins) b = bins - 1
        if (b < 0) b = 0
        counts[b]++
      }
      let H = 0
      for (let b = 0; b < bins; b++) {
        if (counts[b] > 0) {
          const p = counts[b] / N
          H -= p * (Math.log(p) / Math.LN2)
        }
      }
      return H / Math.log2(bins)
    }

    case 'dt': {
      if (!timestamps || index === 0) return 0
      return Math.max(0, timestamps[index] - timestamps[index - 1])
    }

    case 'logdt': {
      if (!timestamps || index === 0) return Math.log(1e-9)
      const dt_val = Math.max(0, timestamps[index] - timestamps[index - 1])
      return Math.log(dt_val + 1e-9)
    }

    case 'tasa_pulsos': {
      if (!timestamps || timestamps.length <= 1) return 0
      const Tw = Math.max(timestamps[timestamps.length - 1] - timestamps[0], 1e-12)
      return totalSignals / Tw
    }

    case 'tasa_energia': {
      if (!timestamps || timestamps.length <= 1) return 0
      const Tw = Math.max(timestamps[timestamps.length - 1] - timestamps[0], 1e-12)
      return sum_sq / Tw
    }

    case 'feq':
      return computeFeq(v, fs)

    default:
      return rms
  }
}

// --- Frecuencia equivalente --------------------------------------------------
// feq = sqrt( Σ f²·|X(f)|² / Σ |X(f)|² ) sobre el espectro one-sided, con la
// DFT de longitud EXACTA (ver fft.js: rellenar hasta la potencia de dos
// siguiente desviaba feq un 12% en UHF, donde N=3000 → 4096).
export function computeFeq(v, fs, mean = null) {
  const N = v.length
  if (N === 0) return 0

  // Se quita la media: el bin DC no aporta a f² pero sí infla Σ|X|² y sesga feq
  // a la baja. Importa en UHF, cuyas señales vienen rectificadas (no negativas).
  let mu = mean
  if (mu === null) {
    let sum = 0
    for (let i = 0; i < N; i += 1) sum += v[i]
    mu = sum / N
  }

  const p = magSquaredSpectrum(v, mu)
  const df = fs / N
  let num = 0
  let den = 0
  for (let k = 1; k < p.length; k += 1) {
    const f = k * df
    num += f * f * p[k]
    den += p[k]
  }
  if (den === 0) return 0
  return Math.sqrt(num / den)
}

// --- Kernel fusionado --------------------------------------------------------
// Las 12 métricas no redundantes, en orden fijo. Este orden define las columnas
// del sidecar, así que NO debe reordenarse una vez que hay archivos escritos.
export const METRIC_KEYS_12 = [
  'rms',
  'vmax',
  'vpp',
  'crest',
  'kurtosis',
  'skewness',
  'risetime',
  'teq',
  'zcr',
  'shannon',
  'energia_j',
  'feq',
]

const SHANNON_BINS = 64
const shannonCounts = new Int32Array(SHANNON_BINS)

// Calcula las 12 métricas de una señal en DOS pasadas en vez de las 12 que
// costaría llamar a computeMetricForSignal una vez por clave. Escribe el
// resultado en `out` (Float64Array de 12) siguiendo METRIC_KEYS_12.
// Las unidades coinciden con computeMetricForSignal: risetime en ns, teq en µs.
export function computeAllMetrics(v, fs, out, R = 50.0) {
  const N = v.length
  if (N === 0) {
    out.fill(0)
    return out
  }

  // --- Pasada A: extremos, momentos de primer orden, ZCR y centroide temporal
  let vMax = -Infinity
  let vMin = Infinity
  let absMax = 0
  let sum = 0
  let sumSq = 0
  let crossings = 0
  let t0Num = 0
  let prevSign = Math.sign(v[0]) || 1

  for (let i = 0; i < N; i += 1) {
    const val = v[i]
    if (val > vMax) vMax = val
    if (val < vMin) vMin = val
    const a = val < 0 ? -val : val
    if (a > absMax) absMax = a
    sum += val
    const sq = val * val
    sumSq += sq
    t0Num += (i / fs) * sq
    if (i > 0) {
      const s = Math.sign(val) || 1
      if (s !== prevSign) {
        crossings += 1
        prevSign = s
      }
    }
  }

  const mean = sum / N
  const rms = Math.sqrt(sumSq / N)
  const safeRms = rms === 0 ? 1e-15 : rms
  const t0 = sumSq === 0 ? 0 : t0Num / sumSq

  // --- Pasada B: momentos centrales, histograma, dispersión temporal, risetime
  const v10 = 0.1 * absMax
  const v90 = 0.9 * absMax
  let idxMax = 0
  let foundMax = false
  let idx10 = -1
  let idx90 = -1
  let m2 = 0
  let m3 = 0
  let m4 = 0
  let tSpread = 0

  shannonCounts.fill(0)

  for (let i = 0; i < N; i += 1) {
    const val = v[i]
    const d = val - mean
    const d2 = d * d
    m2 += d2
    m3 += d2 * d
    m4 += d2 * d2

    const sq = val * val
    const dt = i / fs - t0
    tSpread += dt * dt * sq

    if (absMax !== 0) {
      // DIVIDIR, no multiplicar por el recíproco: redondean distinto y una
      // muestra justo en el borde de un bin acaba en otro, lo que desvía la
      // entropía ~1e-4 respecto de la implementación de referencia en Python.
      let b = ((val / absMax + 1.0) / 2.0) * SHANNON_BINS | 0
      if (b >= SHANNON_BINS) b = SHANNON_BINS - 1
      else if (b < 0) b = 0
      shannonCounts[b] += 1
    }

    // El risetime mira sólo el flanco que sube hasta el primer pico absoluto.
    if (!foundMax) {
      const a = val < 0 ? -val : val
      if (idx10 === -1 && a >= v10) idx10 = i
      if (idx90 === -1 && a >= v90) idx90 = i
      if (a === absMax) {
        idxMax = i
        foundMax = true
      }
    }
  }

  m2 /= N
  m3 /= N
  m4 /= N

  const kurtosis = m2 === 0 ? 0 : m4 / (m2 * m2) - 3.0
  const skewness = m2 === 0 ? 0 : m3 / Math.pow(m2, 1.5)

  let risetime = 0
  if (absMax !== 0 && idx10 !== -1 && idx90 !== -1 && idx90 <= idxMax) {
    risetime = Math.max(0, ((idx90 - idx10) / fs) * 1e9) // ns
  }

  const teq = sumSq === 0 ? 0 : Math.sqrt(tSpread / sumSq) * 1e6 // µs

  let H = 0
  if (absMax !== 0) {
    for (let b = 0; b < SHANNON_BINS; b += 1) {
      const c = shannonCounts[b]
      if (c > 0) {
        const p = c / N
        H -= p * (Math.log(p) / Math.LN2)
      }
    }
    H /= Math.log2(SHANNON_BINS)
  }

  out[0] = rms
  out[1] = absMax
  out[2] = vMax - vMin
  out[3] = absMax / safeRms
  out[4] = kurtosis
  out[5] = skewness
  out[6] = risetime
  out[7] = teq
  out[8] = N > 1 ? crossings / (N - 1) : 0
  out[9] = H
  out[10] = (1.0 / (fs * R)) * sumSq
  out[11] = computeFeq(v, fs, mean) // reutiliza la media de la pasada A

  return out
}
