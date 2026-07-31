// Web Worker: reads the HDF5 in the browser with h5wasm, mounting the File
// through a LAZY emscripten filesystem. HDF5 asks for bytes via the VFS
// read()/seek(); we serve them by reading File slices with FileReaderSync
// (synchronous, worker-only). An aligned block cache avoids re-reading metadata
// pages while walking the B-tree. Nothing is loaded whole into memory: only a
// few MB are read out of 1 GB.

import h5wasm from 'h5wasm'

let FS = null
let h5file = null // open h5wasm.File instance
const MOUNT = '/lazy/data.h5'

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

function listTestChildren(testName) {
  const g = h5file.get(testName)
  const keys = g.keys()
  
  const items = keys.map((key) => {
    const item = h5file.get(`${testName}/${key}`)
    const isGroup = item instanceof h5wasm.Group
    let datasets = []
    let nSignals = 0
    let nSamples = 0

    if (isGroup) {
      const subKeys = item.keys()
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

// --- Message bridge ---------------------------------------------------------
const handlers = {
  open: (p) => openFile(p.file),
  testChildren: (p) => listTestChildren(p.test),
  chunks: (p) => listTestChildren(p.test), // retrocompatibilidad
  readSignal: (p) => readSignalData(p.test, p.path, p.row, p.datasetName),
  readHumidity: (p) => readHumidityData(p.test),
  signal: (p) => readSignalData(p.test, `${p.chunk}/signals`, p.row, 'data'), // retrocompatibilidad
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data
  try {
    await ensureReady()
    const result = await handlers[type](payload)
    const transfer = result && result.transfer ? result.transfer : []
    if (result) delete result.transfer
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) })
  }
}
