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
    const { id, ok, result, error, progress } = e.data
    const p = pending.get(id)
    if (!p) return
    if (progress !== undefined) {
      // Avance de una tarea larga: la promesa sigue viva.
      p.onProgress?.(progress)
      return
    }
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

function call(type, payload, transfer = [], onProgress = null) {
  const w = ensureWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    w.postMessage({ id, type, payload }, transfer)
  })
}

export const hdf5 = {
  open: (file) => call('open', { file }),
  testChildren: (test) => call('testChildren', { test }),
  chunks: (test) => call('chunks', { test }),
  readSignal: (test, path, row, datasetName) => call('readSignal', { test, path, row, datasetName }),
  readHumidity: (test) => call('readHumidity', { test }),
  readGroupSummary: (test, path) => call('readGroupSummary', { test, path }),
  readGroupMatrix: (test, path) => call('readGroupSummary', { test, path }),
  signal: (test, chunk, row) => call('signal', { test, chunk, row }),

  readTimestamps: (test, path) => call('readTimestamps', { test, path }),
  experimentT0: (test) => call('experimentT0', { test }),

  // --- Métricas -------------------------------------------------------------
  metricsPlan: (sidecarBytes) => call('metricsPlan', { sidecarBytes }),
  metricsRun: (sidecarBytes, onProgress) =>
    call('metricsRun', { sidecarBytes }, [], onProgress),
  readMetric: (test, sensor, key, sidecarBytes) =>
    call('readMetric', { test, sensor, key, sidecarBytes }),
}
