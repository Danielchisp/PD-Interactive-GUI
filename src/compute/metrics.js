// Módulo de cálculo de 22 métricas estadísticas, temporales, espectrales y de eventos en JS

export const METRICS = {
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

    default:
      return rms
  }
}
