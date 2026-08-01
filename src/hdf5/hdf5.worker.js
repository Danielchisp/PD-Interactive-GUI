// Web Worker: reads the HDF5 in the browser with h5wasm, mounting the File
// through a LAZY emscripten filesystem. HDF5 asks for bytes via the VFS
// read()/seek(); we serve them by reading File slices with FileReaderSync
// (synchronous, worker-only). An aligned block cache avoids re-reading metadata
// pages while walking the B-tree. Nothing is loaded whole into memory: only a
// few MB are read out of 1 GB.

import h5wasm from 'h5wasm'
import { createMetricsEngine } from '../compute/metricsEngine.js'

let FS = null
let h5file = null // open h5wasm.File instance
const MOUNT = '/lazy/data.h5'
const SIDECAR = '/out/metrics.h5'

async function ensureReady() {
  if (FS) return
  const Module = await h5wasm.ready
  FS = Module.FS
}

// --- Lazy filesystem over the File ------------------------------------------
const BLOCK = 1 << 19 // 512 KB per block
const MAX_BLOCKS = 160 // ~80 MB cache cap

function makeLazyNode(file) {
  const size = file.size
  const reader = new FileReaderSync()
  const cache = new Map() // blockIndex -> Uint8Array (insertion order = LRU)

  function getBlock(bi) {
    const hit = cache.get(bi)
    if (hit) {
      cache.delete(bi)
      cache.set(bi, hit) // refresh LRU
      return hit
    }
    const start = bi * BLOCK
    const end = Math.min(start + BLOCK, size)
    const ab = reader.readAsArrayBuffer(file.slice(start, end))
    const block = new Uint8Array(ab)
    cache.set(bi, block)
    if (cache.size > MAX_BLOCKS) {
      cache.delete(cache.keys().next().value) // evict the oldest
    }
    return block
  }

  try {
    FS.mkdir('/lazy')
  } catch (e) {
    /* already exists */
  }
  try {
    FS.unlink(MOUNT)
  } catch (e) {
    /* didn't exist */
  }
  FS.createFile('/lazy', 'data.h5', null, true, false)
  const node = FS.lookupPath(MOUNT).node
  node.usedBytes = size
  node.stream_ops = {
    llseek(stream, offset, whence) {
      let pos = offset
      if (whence === 1) pos += stream.position
      else if (whence === 2) pos = size + offset
      return pos
    },
    read(stream, buffer, offset, length, position) {
      let done = 0
      while (done < length && position + done < size) {
        const p = position + done
        const bi = Math.floor(p / BLOCK)
        const within = p - bi * BLOCK
        const block = getBlock(bi)
        const n = Math.min(block.length - within, length - done)
        buffer.set(block.subarray(within, within + n), offset + done)
        done += n
      }
      return done
    },
  }
}

// --- High-level operations --------------------------------------------------

function attrVal(obj, name) {
  const a = obj.attrs[name]
  return a ? a.value : undefined
}

function openFile(file) {
  if (h5file) {
    try { h5file.close() } catch (e) { /* noop */ }
    h5file = null
  }
  makeLazyNode(file)
  h5file = new h5wasm.File(MOUNT, 'r')

  const tests = h5file.keys().map((name) => {
    const g = h5file.get(name)
    const subKeys = g.keys()
    
    // Inspeccionamos si los subgrupos son directamente tipos de señal (ae, uhf, humidity)
    // o si son chunks (chunk_000000)
    let mode = 'groups' // 'chunks' | 'groups'
    if (subKeys.some((k) => k.startsWith('chunk_'))) {
      mode = 'chunks'
    }

    return {
      name,
      mode,
      nChildren: subKeys.length,
      childrenKeys: subKeys,
      date: attrVal(g, 'date') ?? name,
      chunkDuration: Number(attrVal(g, 'chunk_duration_s') ?? 0),
      description: attrVal(g, 'description') ?? '',
    }
  })
  return { fileName: file.name, tests }
}

// Span temporal de un grupo, en segundos. Sólo se leen el primer y el último
// timestamp (dos slices), nunca el vector completo: en AE son >36k valores.
function groupDuration(path) {
  const t = h5file.get(`${path}/timestamps`)
  if (!t || !t.shape || t.shape.length !== 1 || t.shape[0] < 2) return null
  const n = t.shape[0]
  const first = Number(t.slice([[0, 1]])[0])
  const last = Number(t.slice([[n - 1, n]])[0])
  const span = last - first
  return Number.isFinite(span) && span >= 0 ? span : null
}

function listTestChildren(testName) {
  const g = h5file.get(testName)
  const keys = g.keys()

  const items = keys.map((key) => {
    const item = h5file.get(`${testName}/${key}`)
    const isGroup = item instanceof h5wasm.Group
    let datasets = []
    let nSignals = 0
    let nSamples = 0
    let durationS = null

    if (isGroup) {
      const subKeys = item.keys()
      if (subKeys.includes('timestamps')) {
        durationS = groupDuration(`${testName}/${key}`)
      }
      // Si contiene 'data', es un dataset de señales (ej. ae/data, uhf/data o chunk_XX/signals/data)
      if (subKeys.includes('data')) {
        const dset = h5file.get(`${testName}/${key}/data`)
        if (dset && dset.shape) {
          if (dset.shape.length === 2) {
            [nSignals, nSamples] = dset.shape
          } else if (dset.shape.length === 1) {
            nSignals = 1
            nSamples = dset.shape[0]
          }
        }
      } else if (subKeys.includes('signals')) {
        const dset = h5file.get(`${testName}/${key}/signals/data`)
        if (dset && dset.shape) {
          [nSignals, nSamples] = dset.shape
        }
      } else {
        // Ejemplo: humidity (contiene humidity, temperature, timestamps)
        datasets = subKeys
      }
    }

    return {
      name: key,
      isGroup,
      datasets,
      nSignals,
      nSamples,
      durationS,
      attrs: item.attrs ? Object.fromEntries(Object.entries(item.attrs).map(([k, v]) => [k, v.value])) : {},
    }
  })

  return { items }
}

function readSignalData(testName, path, row = 0, datasetName = 'data') {
  const fullPath = datasetName ? `${testName}/${path}/${datasetName}` : `${testName}/${path}`
  const dset = h5file.get(fullPath)
  if (!dset) {
    throw new Error(`Dataset no encontrado en: ${fullPath}`)
  }

  let y
  let nSamples = 0

  if (dset.shape.length === 2) {
    nSamples = dset.shape[1]
    const slab = dset.slice([[row, row + 1], [0, nSamples]])
    y = Float32Array.from(slab)
  } else if (dset.shape.length === 1) {
    nSamples = dset.shape[0]
    const slab = dset.value
    y = Float32Array.from(slab)
  } else {
    throw new Error(`Forma de dataset no soportada: ${dset.shape}`)
  }

  return {
    y,
    nSamples,
    dt: 1,
    row,
    transfer: [y.buffer],
  }
}

// Timestamps de un grupo en float64. NO se puede usar readSignalData para
// esto: devuelve Float32Array, y un epoch como 1784038547 en float32 pierde
// unos 100 s de precisión, suficiente para descuadrar el eje de tiempo.
function readTimestamps(testName, path) {
  const dset = h5file.get(`${testName}/${path}/timestamps`)
  if (!dset || !dset.shape || dset.shape.length !== 1) {
    throw new Error(`Sin timestamps en ${testName}/${path}`)
  }
  const values = Float64Array.from(dset.value)
  return { values, n: values.length, transfer: [values.buffer] }
}

// Instante inicial común del experimento: el mínimo de los primeros
// timestamps de todos sus grupos. Es el origen que hace que los gráficos
// alineados representen de verdad los mismos instantes.
function experimentT0(testName) {
  const g = h5file.get(testName)
  if (!g) throw new Error(`Test no encontrado: ${testName}`)
  let t0 = Infinity
  const spans = {}
  for (const key of g.keys()) {
    const child = h5file.get(`${testName}/${key}`)
    if (!(child instanceof h5wasm.Group) || !child.keys().includes('timestamps')) continue
    const t = h5file.get(`${testName}/${key}/timestamps`)
    if (!t || !t.shape || t.shape.length !== 1 || t.shape[0] < 1) continue
    const n = t.shape[0]
    const first = Number(t.slice([[0, 1]])[0])
    const last = Number(t.slice([[n - 1, n]])[0])
    spans[key] = { first, last, n }
    if (first < t0) t0 = first
  }
  if (!Number.isFinite(t0)) throw new Error(`Sin timestamps en ${testName}`)
  const tEnd = Math.max(...Object.values(spans).map((s) => s.last))
  return { t0, tEnd, durationS: tEnd - t0, spans }
}

function readGroupSummary(testName, path) {
  const fullPath = `${testName}/${path}/data`
  const timePath = `${testName}/${path}/timestamps`
  const dset = h5file.get(fullPath)
  const tDset = h5file.get(timePath)

  if (!dset) {
    throw new Error(`Dataset 'data' no encontrado en ${testName}/${path}`)
  }

  const [nSignals, nSamples] = dset.shape

  let timestamps = null
  if (tDset) {
    timestamps = Float64Array.from(tDset.value)
  }
  const hasTimestamps = timestamps && timestamps.length === nSignals
  const t0 = hasTimestamps ? timestamps[0] : 0

  const totalPts = nSignals * 4
  const xData = new Float64Array(totalPts)
  const yData = new Float64Array(totalPts)

  // Procesar fila a fila directamente de la memoria HDF5 (Lazy VFS) para no reservar 2 GB de RAM
  for (let i = 0; i < nSignals; i++) {
    const slab = dset.slice([[i, i + 1], [0, nSamples]])
    const row = Float32Array.from(slab)

    let minVal = Infinity
    let maxVal = -Infinity
    let minIdx = 0
    let maxIdx = 0

    for (let j = 0; j < nSamples; j++) {
      const val = row[j]
      if (val < minVal) {
        minVal = val
        minIdx = j
      }
      if (val > maxVal) {
        maxVal = val
        maxIdx = j
      }
    }

    const tBase = hasTimestamps ? (timestamps[i] - t0) : i
    const baseIdx = i * 4

    xData[baseIdx] = tBase
    yData[baseIdx] = row[0]

    xData[baseIdx + 1] = tBase + (minIdx / nSamples) * 0.001
    yData[baseIdx + 1] = minVal

    xData[baseIdx + 2] = tBase + (maxIdx / nSamples) * 0.001
    yData[baseIdx + 2] = maxVal

    xData[baseIdx + 3] = tBase + 0.001
    yData[baseIdx + 3] = row[nSamples - 1]
  }

  return {
    testName,
    path,
    nSignals,
    totalPts,
    xData,
    yData,
    transfer: [xData.buffer, yData.buffer],
  }
}

function readHumidityData(testName) {
  const g = h5file.get(`${testName}/humidity`)
  if (!g) {
    throw new Error(`Grupo humidity no encontrado en: ${testName}/humidity`)
  }
  const humDset = h5file.get(`${testName}/humidity/humidity`)
  const tempDset = h5file.get(`${testName}/humidity/temperature`)
  const timeDset = h5file.get(`${testName}/humidity/timestamps`)

  if (!humDset || !timeDset) {
    throw new Error(`Datasets de humedad o timestamps no encontrados en: ${testName}/humidity`)
  }

  const humidity = Float64Array.from(humDset.value)
  const timestamps = Float64Array.from(timeDset.value)
  const temperature = tempDset ? Float64Array.from(tempDset.value) : null

  const nSamples = humidity.length

  const transfer = [humidity.buffer, timestamps.buffer]
  if (temperature) transfer.push(temperature.buffer)

  return {
    humidity,
    temperature,
    timestamps,
    nSamples,
    transfer,
  }
}

// --- Métricas ---------------------------------------------------------------
// La lógica vive en compute/metricsEngine.js para poder ejercitarla fuera del
// worker; aquí sólo se le inyectan h5wasm y el FS de esta instancia.

let engine = null
function metricsEngine() {
  if (!engine) engine = createMetricsEngine({ h5wasm, FS, sidecarPath: SIDECAR })
  return engine
}

// --- Message bridge ---------------------------------------------------------
const handlers = {
  open: (p) => openFile(p.file),
  testChildren: (p) => listTestChildren(p.test),
  chunks: (p) => listTestChildren(p.test), // retrocompatibilidad
  readSignal: (p) => readSignalData(p.test, p.path, p.row, p.datasetName),
  readHumidity: (p) => readHumidityData(p.test),
  readGroupSummary: (p) => readGroupSummary(p.test, p.path),
  readGroupMatrix: (p) => readGroupSummary(p.test, p.path),
  signal: (p) => readSignalData(p.test, `${p.chunk}/signals`, p.row, 'data'), // retrocompatibilidad
  metricsPlan: (p) => metricsEngine().plan(h5file, p.sidecarBytes),
  metricsRun: (p, emit) => {
    const r = metricsEngine().run(h5file, p.sidecarBytes, emit)
    return { ...r, transfer: [r.bytes.buffer] }
  },
  readTimestamps: (p) => readTimestamps(p.test, p.path),
  experimentT0: (p) => experimentT0(p.test),
  readMetric: (p) => {
    const r = metricsEngine().readMetric(p)
    return { ...r, transfer: [r.values.buffer] }
  },
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data
  try {
    await ensureReady()
    // Los handlers largos reportan avance con este emisor; el cliente lo
    // distingue de la respuesta final por el campo `progress`.
    const emit = (progress) => self.postMessage({ id, progress })
    const result = await handlers[type](payload, emit)
    const transfer = result && result.transfer ? result.transfer : []
    if (result) delete result.transfer
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) })
  }
}
