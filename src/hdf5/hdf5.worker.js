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
    return {
      name,
      nChunks: g.keys().length,
      date: attrVal(g, 'date') ?? name,
      chunkDuration: Number(attrVal(g, 'chunk_duration_s') ?? 0),
      description: attrVal(g, 'description') ?? '',
    }
  })
  return { fileName: file.name, tests }
}

function listChunks(testName) {
  const g = h5file.get(testName)
  const chunks = g.keys().map((name) => ({ name }))
  return { chunks }
}

function chunkInfo(testName, chunkName) {
  const ch = h5file.get(`${testName}/${chunkName}`)
  const dset = h5file.get(`${testName}/${chunkName}/signals/data`)
  const [nSignals, nSamples] = dset.shape
  const chunkDuration = Number(attrVal(h5file.get(testName), 'chunk_duration_s') ?? 0)
  return {
    nSignals: Number(attrVal(ch, 'n_signals') ?? nSignals),
    signalOffset: Number(attrVal(ch, 'signal_offset') ?? 0),
    isBaseline: Boolean(attrVal(ch, 'is_baseline')),
    nSamples,
    chunkDuration,
    dt: chunkDuration && nSamples ? chunkDuration / nSamples : 1,
  }
}

function readSignal(testName, chunkName, row) {
  const dset = h5file.get(`${testName}/${chunkName}/signals/data`)
  const [, nSamples] = dset.shape
  const slab = dset.slice([[row, row + 1], [0, nSamples]])
  // Copy into an owned buffer (slab may be a view on the WASM heap) so it can
  // be transferred without detaching WASM memory.
  const y = Float32Array.from(slab)
  const info = chunkInfo(testName, chunkName)
  return {
    y,
    nSamples,
    dt: info.dt,
    globalIndex: info.signalOffset + row,
    transfer: [y.buffer],
  }
}

// --- Message bridge ---------------------------------------------------------
const handlers = {
  open: (p) => openFile(p.file),
  chunks: (p) => listChunks(p.test),
  chunkInfo: (p) => chunkInfo(p.test, p.chunk),
  signal: (p) => readSignal(p.test, p.chunk, p.row),
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
