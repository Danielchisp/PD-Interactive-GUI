// Main-thread client for the compute worker (promise-based, mirrors hdf5Client).

let worker = null
let seq = 0
const pending = new Map()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./compute.worker.js', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    ok ? p.resolve(result) : p.reject(new Error(error))
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'compute error'))
    pending.clear()
  }
  return worker
}

function call(type, payload) {
  const w = ensureWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, type, payload })
  })
}

export const compute = {
  // inputs: [{ name, y, dt }] -> { results: [{ name, freq, mag }] }
  fft: (inputs, opts = {}) => call('fft', { inputs, opts }),
}
