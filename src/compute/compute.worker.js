// Compute worker: runs signal operations off the main thread. Today: Welch
// spectrum. Inputs come copied via structured clone; outputs go back as
// transferables. Keeping compute here keeps the UI responsive when a card has
// many series (one spectrum per series).

import { welchSpectrum } from './welch.js'
import { computeMetricForSignal } from './metrics.js'

const handlers = {
  // inputs: [{ name, y, dt }] -> [{ name, freq, mag }]
  fft: ({ inputs, opts }) => {
    const results = []
    const transfer = []
    for (const { name, y, dt } of inputs) {
      const fs = dt > 0 ? 1 / dt : 1
      const { freq, mag } = welchSpectrum(y, fs, opts)
      results.push({ name, freq, mag })
      transfer.push(freq.buffer, mag.buffer)
    }
    return { result: { results }, transfer }
  },

  // Subrepresenta cada señal del grupo con 4 puntos: [sig[0], min, max, sig[N-1]]
  groupSeries: ({ yMatrix, nSignals, nSamples, timestamps }) => {
    const totalPts = nSignals * 4
    const xData = new Float64Array(totalPts)
    const yData = new Float64Array(totalPts)

    const hasTimestamps = timestamps && timestamps.length === nSignals
    const t0 = hasTimestamps ? timestamps[0] : 0

    for (let i = 0; i < nSignals; i++) {
      const offset = i * nSamples
      const sig = yMatrix.subarray(offset, offset + nSamples)

      let minVal = Infinity
      let maxVal = -Infinity
      let minIdx = 0
      let maxIdx = 0

      for (let j = 0; j < nSamples; j++) {
        const val = sig[j]
        if (val < minVal) {
          minVal = val
          minIdx = j
        }
        if (val > maxVal) {
          maxVal = val
          maxIdx = j
        }
      }

      // Base timestamp para la señal i
      const tBase = hasTimestamps ? (timestamps[i] - t0) : i

      // 4 puntos ordenados temporalmente
      // Punto 0: inicio de la señal
      // Punto 1: valor mínimo (o según su posición relativa)
      // Punto 2: valor máximo
      // Punto 3: final de la señal
      const p0 = sig[0]
      const p3 = sig[nSamples - 1]

      const baseIdx = i * 4

      xData[baseIdx] = tBase
      yData[baseIdx] = p0

      xData[baseIdx + 1] = tBase + (minIdx / nSamples) * 0.001
      yData[baseIdx + 1] = minVal

      xData[baseIdx + 2] = tBase + (maxIdx / nSamples) * 0.001
      yData[baseIdx + 2] = maxVal

      xData[baseIdx + 3] = tBase + 0.001
      yData[baseIdx + 3] = p3
    }

    return {
      result: { xData, yData, totalPts, nSignals },
      transfer: [xData.buffer, yData.buffer],
    }
  },

  // Compute metric across full group matrix
  metricGroup: ({ metricKey, yMatrix, nSignals, nSamples, timestamps, fs }) => {
    const values = new Float64Array(nSignals)
    const times = new Float64Array(nSignals)

    const t0 = (timestamps && timestamps.length > 0) ? timestamps[0] : 0

    for (let i = 0; i < nSignals; i++) {
      const offset = i * nSamples
      const sig = yMatrix.subarray(offset, offset + nSamples)
      values[i] = computeMetricForSignal(metricKey, sig, timestamps, i, nSignals, fs)

      if (timestamps && i < timestamps.length) {
        times[i] = timestamps[i] - t0
      } else {
        times[i] = i
      }
    }

    return {
      result: { values, times, nSignals },
      transfer: [values.buffer, times.buffer],
    }
  },
}

self.onmessage = (e) => {
  const { id, type, payload } = e.data
  try {
    const { result, transfer } = handlers[type](payload)
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) })
  }
}
