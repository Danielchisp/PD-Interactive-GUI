// Compute worker: runs signal operations off the main thread. Today: Welch
// spectrum. Inputs come copied via structured clone; outputs go back as
// transferables. Keeping compute here keeps the UI responsive when a card has
// many series (one spectrum per series).

import { welchSpectrum } from './welch.js'

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
