// Módulo de cálculo de 22 métricas estadísticas, temporales, espectrales y de eventos en JS

import { magSquaredSpectrum } from './fft.js'

// Las CLAVES son el contrato con el sidecar y con METRIC_KEYS_12: nombran las
// columnas de los archivos ya escritos y no se traducen. Sólo `label` es de cara
// al usuario — es lo que rotula ejes y desplegables.
export const METRICS = {
  feq: { key: 'feq', label: 'Equivalent Frequency', unit: 'Hz' },
  vmax: { key: 'vmax', label: 'Vmax', unit: 'V' },
  vpp: { key: 'vpp', label: 'VPP', unit: 'V' },
  rms: { key: 'rms', label: 'RMS Value', unit: 'V' },
  crest: { key: 'crest', label: 'Crest Factor', unit: '' },
  log5_crest: { key: 'log5_crest', label: 'Log5 Crest Factor', unit: '' },
  kurtosis: { key: 'kurtosis', label: 'Kurtosis', unit: '' },
  skewness: { key: 'skewness', label: 'Skewness', unit: '' },
  f_stat: { key: 'f_stat', label: 'F Analysis (Crest × Kurt)', unit: '' },
  risetime: { key: 'risetime', label: 'Rise Time', unit: 'ns' },
  teq: { key: 'teq', label: 'Equivalent Time', unit: 'µs' },
  zcr: { key: 'zcr', label: 'ZCR', unit: '' },
  f_aprox: { key: 'f_aprox', label: 'Approx. Frequency', unit: 'Hz' },
  erel: { key: 'erel', label: 'Relative Energy', unit: '' },
  energia_v2s: { key: 'energia_v2s', label: 'Energy V²s', unit: 'V²s' },
  energia_j: { key: 'energia_j', label: 'Energy Joules (50Ω)', unit: 'J' },
  shannon: { key: 'shannon', label: 'Shannon Entropy', unit: 'bits' },
  dt: { key: 'dt', label: 'Delta T', unit: 's' },
  logdt: { key: 'logdt', label: 'Log Delta T', unit: '' },
  // Escalar por grupo: sale igual para todas las señales del experimento, así
  // que como serie temporal es una recta. La densidad que sí varía en el tiempo
  // es `rate`, más abajo.
  tasa_pulsos: { key: 'tasa_pulsos', label: 'Pulse Rate (whole group)', unit: 'Hz' },
  rate: { key: 'rate', label: 'Pulse Rate', unit: 'Hz' },
  tasa_energia: { key: 'tasa_energia', label: 'Energy Rate', unit: 'rel/s' },
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
      // Risetime por ENERGÍA ACUMULADA: el tiempo entre el 10% y el 90% de la
      // energía total de la señal.
      //
      // Comparar la acumulada contra `fracción × total` es idéntico a
      // normalizarla y compararla contra la fracción, y ahorra una pasada de
      // división. La acumulada es monótona no decreciente, así que i90 >= i10
      // siempre y el resultado nunca sale negativo.
      if (sum_sq === 0) return 0
      const e10 = 0.1 * sum_sq
      const e90 = 0.9 * sum_sq
      let cum = 0
      let idx10 = -1
      let idx90 = -1
      for (let i = 0; i < N; i++) {
        cum += v[i] * v[i]
        if (idx10 === -1 && cum >= e10) idx10 = i
        if (cum >= e90) {
          idx90 = i
          break
        }
      }
      return ((idx90 - idx10) / fs) * 1e9 // ns
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

// --- Densidad de descargas ---------------------------------------------------
//
// Métricas que NO viven en el sidecar porque no son propiedades de una señal.
// La densidad lo es del proceso de llegada: sale entera de los timestamps, que
// la GUI ya lee para el eje X. Calcularla en Python obligaría a una columna por
// señal, a recalcular el master entero y a congelar dentro del archivo una
// ventana que en realidad es una decisión de visualización.
export const RUNTIME_METRICS = new Set(['rate'])
export const isRuntimeMetric = (key) => RUNTIME_METRICS.has(key)

// Las que ofrece el desplegable: las 12 del sidecar más las de runtime.
// METRIC_KEYS_12 se queda intacto — es el contrato con los archivos escritos.
export const METRIC_KEYS_UI = [...METRIC_KEYS_12, ...RUNTIME_METRICS]

// Vecinos a cada lado que definen la ventana local.
const RATE_K = 10

// Cuánto se puede ensanchar la ventana buscando duración no nula, si hay
// timestamps repetidos. Acotado para que el caso patológico —media serie con el
// mismo instante— no degenere en O(n²).
const RATE_MAX_WIDEN = 200

/**
 * Descargas por segundo alrededor de cada señal, a partir de sus timestamps
 * (ascendentes). Devuelve un Float64Array de `n` valores en Hz.
 *
 * Ventana de K VECINOS y no de anchura fija en segundos. En estos datos la tasa
 * de llegada abarca unos cinco órdenes de magnitud —la mediana de Δt en UHF es
 * de 20 ms y el percentil 99 llega a 940 s—, y ninguna anchura fija sirve para
 * los dos extremos: la que resuelve una ráfaga da cero durante todos los
 * silencios, y la que mide un silencio aplana la ráfaga hasta borrarla. Con K
 * vecinos la ventana se estrecha sola donde hay muchos puntos y se ensancha
 * donde hay pocos.
 *
 * El valor es (nº de intervalos)/(duración), es decir el recíproco del intervalo
 * medio local. Cerca de los extremos la ventana se desplaza hacia dentro en vez
 * de encogerse, para que la estimación no se vuelva ruidosa justo en los bordes.
 */
export function localRate(ts, n = ts?.length ?? 0) {
  const out = new Float64Array(n)
  if (n < 2 || !(ts[n - 1] - ts[0] > 0)) return out

  for (let i = 0; i < n; i += 1) {
    let j0 = i - RATE_K
    let j1 = i + RATE_K
    if (j0 < 0) {
      j1 -= j0 // desplaza la ventana hacia dentro, no la encoge
      j0 = 0
    }
    if (j1 > n - 1) {
      j0 -= j1 - (n - 1)
      j1 = n - 1
    }
    if (j0 < 0) j0 = 0

    let span = ts[j1] - ts[j0]
    for (let w = 0; span <= 0 && w < RATE_MAX_WIDEN && (j0 > 0 || j1 < n - 1); w += 1) {
      if (j0 > 0) j0 -= 1
      if (j1 < n - 1) j1 += 1
      span = ts[j1] - ts[j0]
    }
    out[i] = span > 0 ? (j1 - j0) / span : 0
  }
  return out
}

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
  //
  // El risetime va por energía acumulada, y por eso vive en esta pasada: hace
  // falta la energía TOTAL (`sumSq`, de la pasada A) para saber dónde caen el
  // 10% y el 90%. Comparar la acumulada contra `fracción × sumSq` es idéntico a
  // normalizarla y compararla contra la fracción, sin una pasada de división.
  const e10 = 0.1 * sumSq
  const e90 = 0.9 * sumSq
  let cumE = 0
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

    // La acumulada se suma en el mismo orden que `sumSq` en la pasada A, así que
    // al llegar a la última muestra vale exactamente lo mismo: con energía > 0,
    // el umbral del 90% se cruza siempre.
    cumE += sq
    if (idx10 === -1 && cumE >= e10) idx10 = i
    if (idx90 === -1 && cumE >= e90) idx90 = i

    if (absMax !== 0) {
      // DIVIDIR, no multiplicar por el recíproco: redondean distinto y una
      // muestra justo en el borde de un bin acaba en otro, lo que desvía la
      // entropía ~1e-4 respecto de la implementación de referencia en Python.
      let b = ((val / absMax + 1.0) / 2.0) * SHANNON_BINS | 0
      if (b >= SHANNON_BINS) b = SHANNON_BINS - 1
      else if (b < 0) b = 0
      shannonCounts[b] += 1
    }
  }

  m2 /= N
  m3 /= N
  m4 /= N

  const kurtosis = m2 === 0 ? 0 : m4 / (m2 * m2) - 3.0
  const skewness = m2 === 0 ? 0 : m3 / Math.pow(m2, 1.5)

  const risetime = sumSq === 0 ? 0 : ((idx90 - idx10) / fs) * 1e9 // ns

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
