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
