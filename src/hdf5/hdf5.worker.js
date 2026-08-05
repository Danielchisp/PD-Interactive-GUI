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
  rowIndexCache.clear() // los offsets son de este archivo, no del siguiente
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

// Tamaño LÓGICO de un grupo: lo que ocupan sus datos descomprimidos, no lo que
// el experimento ocupa en el archivo. El HDF5 va comprimido y por chunks, y
// h5wasm no expone el tamaño almacenado; además lo que interesa al elegir un
// experimento es cuántos datos trae, que es esto.
//
// `metadata.size` son los bytes de un elemento y `total_size` cuántos hay — la
// misma pareja con la que h5wasm reserva los búferes al leer.
function groupBytes(path) {
  let total = 0
  const walk = (p) => {
    const o = h5file.get(p)
    if (!o) return
    if (o instanceof h5wasm.Group) {
      for (const k of o.keys()) walk(`${p}/${k}`)
    } else if (o instanceof h5wasm.Dataset) {
      const m = o.metadata
      if (m) total += (m.size || 0) * (m.total_size || 0)
    }
  }
  walk(path)
  return total
}

// Duración y tamaño de un experimento, para el explorador.
//
// Va en una llamada aparte y no dentro de `listTests` a propósito: el árbol
// tiene que aparecer en cuanto se abre el archivo, y esto recorre datasets sobre
// un VFS perezoso. La duración reutiliza `experimentT0`, que en chunks-v2 sólo
// sondea el primer y el último chunk en vez de recorrerlos todos.
function testStats(testName) {
  let durationS = null
  try {
    durationS = experimentT0(testName).durationS
  } catch (err) {
    durationS = null // sin timestamps: se muestra el tamaño y nada más
  }
  return { test: testName, durationS, bytes: groupBytes(testName) }
}

function readSignalData(testName, path, row = 0, datasetName = 'data') {
  const fullPath = datasetName ? `${testName}/${path}/${datasetName}` : `${testName}/${path}`
  const dset = h5file.get(fullPath)
  if (!dset) {
    throw new Error(`Dataset not found at: ${fullPath}`)
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
    throw new Error(`Unsupported dataset shape: ${dset.shape}`)
  }

  return {
    y,
    nSamples,
    dt: 1,
    row,
    transfer: [y.buffer],
  }
}

// --- Layout chunks-v2 --------------------------------------------------------
// En chunks-v2 un sensor no es un dataset por test sino un bloque por chunk:
//
//   /<test>/chunk_NNNNNN/<origen>/{data,timestamps}
//
// Concatenarlos en el orden de `chunk_index` reconstruye el vector que en
// plano-v1 está escrito de una pieza. Es el mismo orden que usa
// scripts/compute_metrics.py, así que la fila i del sidecar y el instante i de
// aquí son la misma señal.

const CHUNK_SOURCES = { uhf: 'signals', ae: 'ae_signals' }

// Chunks de un test ordenados por chunk_index, no por nombre.
function chunkOrder(testName) {
  const g = h5file.get(testName)
  if (!g) return []
  return g.keys()
    .filter((k) => k.startsWith('chunk_'))
    .map((k) => ({ key: k, i: Number(attrVal(h5file.get(`${testName}/${k}`), 'chunk_index') ?? -1) }))
    .sort((a, b) => (a.i - b.i) || a.key.localeCompare(b.key))
    .map((c) => c.key)
}

// Concatena un dataset 1-D repartido entre los chunks. Devuelve null si no hay
// ninguno (test en plano-v1, o sensor ausente de este test).
function concatChunked(testName, subPath, dsetName) {
  const parts = []
  let total = 0
  for (const chunk of chunkOrder(testName)) {
    const d = h5file.get(`${testName}/${chunk}/${subPath}/${dsetName}`)
    if (!d || !d.shape || d.shape.length !== 1 || d.shape[0] === 0) continue
    const v = Float64Array.from(d.value)
    parts.push(v)
    total += v.length
  }
  if (parts.length === 0) return null
  const out = new Float64Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// Timestamps de un grupo en float64. NO se puede usar readSignalData para
// esto: devuelve Float32Array, y un epoch como 1784038547 en float32 pierde
// unos 100 s de precisión, suficiente para descuadrar el eje de tiempo.
function readTimestamps(testName, path) {
  const dset = h5file.get(`${testName}/${path}/timestamps`)
  if (dset && dset.shape && dset.shape.length === 1) {
    const values = Float64Array.from(dset.value)
    return { values, n: values.length, transfer: [values.buffer] }
  }
  // chunks-v2: `path` es el sensor ('uhf' | 'ae') o un grupo por chunk.
  const source = CHUNK_SOURCES[path] || path
  const values = concatChunked(testName, source, 'timestamps')
  if (!values) throw new Error(`No timestamps in ${testName}/${path}`)
  return { values, n: values.length, transfer: [values.buffer] }
}

// Índice de tramos de un sensor: [{ path, start, rows }] con `start` el offset
// global de cada tramo. Es lo que traduce "señal nº i del experimento" —el
// índice de un punto del scatter, que va contra el vector entero del sidecar—
// a un dataset y una fila concretos.
//
// En chunks-v2 esto obliga a mirar los ~1800 chunks de un test, así que el
// resultado se memoiza: hacer clic en varios puntos del mismo scatter no
// vuelve a recorrerlos.
const rowIndexCache = new Map()

function rowIndex(testName, sensor) {
  const cacheKey = `${testName}|${sensor}`
  const hit = rowIndexCache.get(cacheKey)
  if (hit) return hit

  const flat = h5file.get(`${testName}/${sensor}/data`)
  let spans
  if (flat && flat.shape && flat.shape.length === 2) {
    spans = [{ path: `${testName}/${sensor}/data`, start: 0, rows: flat.shape[0] }]
  } else {
    const source = CHUNK_SOURCES[sensor] || sensor
    spans = []
    let start = 0
    for (const chunk of chunkOrder(testName)) {
      const d = h5file.get(`${testName}/${chunk}/${source}/data`)
      if (!d || !d.shape || d.shape.length !== 2 || d.shape[0] === 0) continue
      spans.push({ path: `${testName}/${chunk}/${source}/data`, start, rows: d.shape[0] })
      start += d.shape[0]
    }
  }

  const total = spans.reduce((n, s) => n + s.rows, 0)
  const index = { spans, total }
  rowIndexCache.set(cacheKey, index)
  return index
}

// Señal nº `index` de un sensor, contando el experimento entero.
function readSignalAt(testName, sensor, index) {
  const { spans, total } = rowIndex(testName, sensor)
  if (total === 0) throw new Error(`No signals in ${testName}/${sensor}`)
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`Signal ${index} out of range (0-${total - 1})`)
  }
  const span = spans[
    // Búsqueda binaria: con 1800 tramos el escaneo lineal se nota al hacer clic.
    (() => {
      let lo = 0
      let hi = spans.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (spans[mid].start <= index) lo = mid
        else hi = mid - 1
      }
      return lo
    })()
  ]

  const dset = h5file.get(span.path)
  const nSamples = dset.shape[1]
  const row = index - span.start
  const y = Float32Array.from(dset.slice([[row, row + 1], [0, nSamples]]))
  return { y, nSamples, dt: 1, index, total, transfer: [y.buffer] }
}

// Instante inicial común del experimento: el mínimo de los primeros
// timestamps de todos sus grupos. Es el origen que hace que los gráficos
// alineados representen de verdad los mismos instantes.
function experimentT0(testName) {
  const g = h5file.get(testName)
  if (!g) throw new Error(`Test not found: ${testName}`)
  const spans = {}

  // Extremos de un vector de timestamps sin leerlo entero: dos slices bastan.
  const edges = (path) => {
    const t = h5file.get(`${path}/timestamps`)
    if (!t || !t.shape || t.shape.length !== 1 || t.shape[0] < 1) return null
    const n = t.shape[0]
    return {
      first: Number(t.slice([[0, 1]])[0]),
      last: Number(t.slice([[n - 1, n]])[0]),
      n,
    }
  }

  const chunks = chunkOrder(testName)
  if (chunks.length > 0) {
    // chunks-v2: el span de un sensor va del primer chunk con datos al último.
    // Se buscan por los extremos y se para al encontrarlos: recorrer los 1800
    // chunks de un test para sumar una `n` que nadie usa costaría miles de
    // lecturas sobre el VFS perezoso.
    for (const [name, source] of [...Object.entries(CHUNK_SOURCES), ['humidity', 'humidity']]) {
      let first = null
      for (const chunk of chunks) {
        first = edges(`${testName}/${chunk}/${source}`)
        if (first) break
      }
      if (!first) continue
      let last = null
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        last = edges(`${testName}/${chunks[i]}/${source}`)
        if (last) break
      }
      spans[name] = { first: first.first, last: (last || first).last }
    }
  } else {
    for (const key of g.keys()) {
      const child = h5file.get(`${testName}/${key}`)
      if (!(child instanceof h5wasm.Group) || !child.keys().includes('timestamps')) continue
      const e = edges(`${testName}/${key}`)
      if (e) spans[key] = e
    }
  }

  const firsts = Object.values(spans).map((s) => s.first)
  if (firsts.length === 0) throw new Error(`No timestamps in ${testName}`)
  const t0 = Math.min(...firsts)
  const tEnd = Math.max(...Object.values(spans).map((s) => s.last))
  return { t0, tEnd, durationS: tEnd - t0, spans }
}

function readGroupSummary(testName, path) {
  const fullPath = `${testName}/${path}/data`
  const timePath = `${testName}/${path}/timestamps`
  const dset = h5file.get(fullPath)
  const tDset = h5file.get(timePath)

  if (!dset) {
    throw new Error(`Dataset 'data' not found in ${testName}/${path}`)
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

// Salto que ninguna de las dos magnitudes puede dar entre dos muestras seguidas:
// 10 °C o 10 puntos de humedad relativa. Ambas son continuas y el aire de un
// ensayo tiene inercia, así que un escalón así no es física, es la adquisición.
//
// El umbral está holgadamente por encima del ruido real: en el ensayo largo de
// `master.hdf5` la diferencia entre muestras consecutivas tiene mediana 0,02 y
// percentil 99,9 de 0,65. Entre ese 0,65 y los saltos de verdad (17 a 84) no hay
// nada, así que dónde caiga el corte exacto dentro de ese hueco da igual.
const ENV_JUMP = 10

// Cuántas muestras seguidas se aceptan como fallo antes de creerse el valor.
//
// Sin este tope, un salto que NO vuelve —un sensor recalibrado a medio ensayo—
// dejaría todo lo que viene después midiéndose contra un valor viejo y se
// reescribiría el resto de la serie. Con ~1 muestra/s, cinco muestras es un
// pinchazo; lo que dura más ya es el nuevo nivel y se respeta, aunque llegara de
// golpe. Los artefactos observados duran una sola muestra.
const ENV_MAX_RUN = 5

// Repara los pinchazos de una serie ambiental, in situ.
//
// Los fallos observados son muestras sueltas que se desploman a un entero
// pequeño (7, 8 o 9 % de humedad; 1 o 2 °C) y vuelven al valor bueno en la
// muestra siguiente. Cada una se sustituye por el promedio de los extremos del
// tramo: el último valor bueno de antes y el primero de después. Con un tramo de
// una muestra eso es exactamente interpolar el punto que faltaba.
//
// En los bordes no hay dos extremos que promediar, así que se copia el único que
// hay — extrapolar plano es lo más flojo que se puede afirmar sobre un dato que
// no se tiene.
//
// El HDF5 no se toca: esto opera sobre las copias que el worker acaba de leer.
function repairEnvSeries(v) {
  if (!v || v.length < 3) return 0

  let repaired = 0
  let lastGood = null
  let i = 0

  // Primer valor finito: sirve de referencia inicial. Si la serie empieza con un
  // pinchazo, se arregla al cerrarse el tramo contra el primer bueno de después.
  while (i < v.length && !Number.isFinite(v[i])) i += 1
  if (i >= v.length) return 0
  lastGood = v[i]

  for (i += 1; i < v.length; i += 1) {
    const value = v[i]
    if (Number.isFinite(value) && Math.abs(value - lastGood) <= ENV_JUMP) {
      lastGood = value
      continue
    }

    // Arranca un tramo sospechoso: se extiende mientras siga lejos del último
    // valor bueno, hasta el tope o hasta el final de la serie.
    let end = i
    while (
      end < v.length &&
      end - i < ENV_MAX_RUN &&
      (!Number.isFinite(v[end]) || Math.abs(v[end] - lastGood) > ENV_JUMP)
    ) {
      end += 1
    }

    const closes = end < v.length && Number.isFinite(v[end])
    if (!closes && end - i >= ENV_MAX_RUN) {
      // No vuelve dentro del tope: es un nivel nuevo, no un pinchazo. Se acepta
      // tal cual y la referencia pasa a ser el primer valor del tramo.
      lastGood = Number.isFinite(v[i]) ? v[i] : lastGood
      continue
    }

    const fill = closes ? (lastGood + v[end]) / 2 : lastGood
    for (let k = i; k < end; k += 1) {
      v[k] = fill
      repaired += 1
    }
    lastGood = closes ? v[end] : fill
    i = end
  }

  return repaired
}

function readHumidityData(testName) {
  const g = h5file.get(`${testName}/humidity`)
  const humDset = g && h5file.get(`${testName}/humidity/humidity`)
  const timeDset = g && h5file.get(`${testName}/humidity/timestamps`)

  let humidity
  let timestamps
  let temperature
  if (humDset && timeDset) {
    const tempDset = h5file.get(`${testName}/humidity/temperature`)
    humidity = Float64Array.from(humDset.value)
    timestamps = Float64Array.from(timeDset.value)
    temperature = tempDset ? Float64Array.from(tempDset.value) : null
  } else {
    // chunks-v2: cada chunk lleva su propio tramo de ambiental.
    humidity = concatChunked(testName, 'humidity', 'humidity')
    timestamps = concatChunked(testName, 'humidity', 'timestamps')
    temperature = concatChunked(testName, 'humidity', 'temperature')
    if (!humidity || !timestamps) {
      throw new Error(`No humidity data in: ${testName}`)
    }
  }

  const nSamples = humidity.length

  // Se corrige aquí, en el único sitio por el que pasan las dos lecturas de
  // ambiental, y no en cada gráfico: así ninguna vista puede quedarse con la
  // serie cruda. Es sobre las copias que se acaban de leer — el archivo sigue
  // abierto en sólo lectura y no se modifica.
  const repaired = {
    humidity: repairEnvSeries(humidity),
    temperature: repairEnvSeries(temperature),
  }
  if (repaired.humidity > 0 || repaired.temperature > 0) {
    console.info(
      `[env] ${testName}: reparadas ${repaired.humidity} muestras de humedad y ` +
        `${repaired.temperature} de temperatura (saltos > ${ENV_JUMP})`,
    )
  }

  const transfer = [humidity.buffer, timestamps.buffer]
  if (temperature) transfer.push(temperature.buffer)

  return {
    humidity,
    temperature,
    timestamps,
    nSamples,
    repaired,
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
  readSignalAt: (p) => readSignalAt(p.test, p.sensor, p.index),
  readHumidity: (p) => readHumidityData(p.test),
  readGroupSummary: (p) => readGroupSummary(p.test, p.path),
  readGroupMatrix: (p) => readGroupSummary(p.test, p.path),
  signal: (p) => readSignalData(p.test, `${p.chunk}/signals`, p.row, 'data'), // retrocompatibilidad
  metricsPlan: (p) => metricsEngine().plan(h5file, p.sidecarBytes),
  readTimestamps: (p) => readTimestamps(p.test, p.path),
  experimentT0: (p) => experimentT0(p.test),
  testStats: (p) => testStats(p.test),
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
