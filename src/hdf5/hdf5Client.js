// Main-thread client: creates the worker and exposes a promise-based API.
// One worker/file per session (the open HDF5 lives inside the worker).

let worker = null
let seq = 0
const pending = new Map()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./hdf5.worker.js', import.meta.url), {
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
    // Global worker failure: reject everything pending.
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'))
    pending.clear()
  }
  return worker
}

function call(type, payload, transfer = []) {
  const w = ensureWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, type, payload }, transfer)
  })
}

export const hdf5 = {
  open: (file) => call('open', { file }),
  testChildren: (test) => call('testChildren', { test }),
  chunks: (test) => call('chunks', { test }),
  readSignal: (test, path, row, datasetName) => call('readSignal', { test, path, row, datasetName }),
  readHumidity: (test) => call('readHumidity', { test }),
  readGroupMatrix: (test, path) => call('readGroupMatrix', { test, path }),
  signal: (test, chunk, row) => call('signal', { test, chunk, row }),
}
