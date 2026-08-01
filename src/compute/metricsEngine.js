// Motor de métricas: recorre los grupos de señal de un HDF5 abierto, calcula
// las 12 métricas escalares por señal y las persiste en un HDF5 aparte
// (sidecar) con la misma jerarquía que el master:
//
//   /<Test - fecha>/<sensor>/<métrica>   float64[n_signals]
//
// El master nunca se modifica: en el navegador se abre en modo lectura sobre
// un File inmutable.
//
// Vive fuera del worker a propósito: recibe h5wasm y FS por parámetro, así que
// el mismo código corre bajo el build de navegador (dentro del worker) y bajo
// el de Node (en las pruebas), sin duplicar la lógica.

import { METRIC_KEYS_12, METRICS, computeAllMetrics } from './metrics.js'

const SENSORS = ['uhf', 'ae']
const SIDECAR_SCHEMA = 'pd-metrics-v1'
const BATCH_SAMPLES = 2e6 // ~8 MB por lote en float32

export function createMetricsEngine({ h5wasm, FS, sidecarPath }) {
  const attrVal = (obj, name) => {
    const a = obj.attrs[name]
    return a ? a.value : undefined
  }

  // `attrs` es un getter de sólo lectura en h5wasm: escribir va por
  // create_attribute, y sólo si el atributo no estaba ya (no se puede
  // sobrescribir sin borrarlo antes, y h5wasm 0.10.3 no sabe borrar).
  //
  // OJO con el dtype: h5wasm lo mapea por LETRA e ignora el número, así que
  // '<f8' se interpreta como 'f' = float32. Por eso los valores numéricos se
  // pasan como typed array y se deja que guess_metadata infiera el tipo.
  const setAttr = (obj, name, value) => {
    if (name in obj.attrs) return
    const data = typeof value === 'number' ? new Float64Array([value]) : value
    obj.create_attribute(name, data, [])
  }

  // Grupos de señal del master, con la frecuencia de muestreo declarada en el
  // grupo de experimento.
  function signalGroups(h5file) {
    const groups = []
    for (const testName of h5file.keys()) {
      const g = h5file.get(testName)
      if (!(g instanceof h5wasm.Group)) continue
      const keys = g.keys()
      for (const sensor of SENSORS) {
        if (!keys.includes(sensor)) continue
        const dset = h5file.get(`${testName}/${sensor}/data`)
        if (!dset || !dset.shape || dset.shape.length !== 2) continue
        const [nSignals, nSamples] = dset.shape
        const fsAttr = attrVal(g, `fs_${sensor}`)
        groups.push({
          test: testName,
          sensor,
          nSignals,
          nSamples,
          fs: fsAttr === undefined ? null : Number(fsAttr),
        })
      }
    }
    return groups
  }

  function mountSidecar(bytes) {
    const dir = sidecarPath.slice(0, sidecarPath.lastIndexOf('/'))
    if (dir) {
      try { FS.mkdir(dir) } catch (e) { /* ya existe */ }
    }
    try { FS.unlink(sidecarPath) } catch (e) { /* no existía */ }
    if (bytes && bytes.byteLength > 0) {
      FS.writeFile(sidecarPath, new Uint8Array(bytes))
      return true
    }
    return false
  }

  // Qué hay ya calculado: { "<test>|<sensor>": n_signals }. Un grupo sólo
  // cuenta como presente si están las 12 métricas.
  function readSidecarIndex(mounted) {
    if (!mounted) return {}
    const f = new h5wasm.File(sidecarPath, 'r')
    const index = {}
    try {
      for (const testName of f.keys()) {
        const g = f.get(testName)
        if (!(g instanceof h5wasm.Group)) continue
        for (const sensor of g.keys()) {
          const sg = f.get(`${testName}/${sensor}`)
          if (!(sg instanceof h5wasm.Group)) continue
          const have = sg.keys()
          if (METRIC_KEYS_12.every((k) => have.includes(k))) {
            const d = f.get(`${testName}/${sensor}/${METRIC_KEYS_12[0]}`)
            index[`${testName}|${sensor}`] = d?.shape?.[0] ?? 0
          }
        }
      }
    } finally {
      try { f.close() } catch (e) { /* noop */ }
    }
    return index
  }

  function plan(h5file, sidecarBytes) {
    const mounted = mountSidecar(sidecarBytes)
    const index = readSidecarIndex(mounted)
    const pending = []
    const skipped = []
    let totalSignals = 0

    for (const g of signalGroups(h5file)) {
      // Sin fs no se calcula: risetime, teq y energia_j dependen de ella y un
      // valor inventado las falsea en silencio.
      if (g.fs === null) {
        skipped.push({ ...g, reason: `sin atributo fs_${g.sensor}` })
        continue
      }
      if (index[`${g.test}|${g.sensor}`] === g.nSignals) continue
      pending.push(g)
      totalSignals += g.nSignals
    }

    return { pending, skipped, totalSignals, index, existing: Object.keys(index).length, mounted }
  }

  // Calcula lo pendiente y devuelve los bytes del sidecar actualizado.
  // `emit` reporta avance para la barra de progreso.
  function run(h5file, sidecarBytes, emit = () => {}) {
    const { pending, skipped, totalSignals, mounted } = plan(h5file, sidecarBytes)

    // plan() dejó el sidecar previo montado en FS; se reabre en 'a' para
    // añadir lo que falta sin recalcular lo que ya estaba.
    const out = new h5wasm.File(sidecarPath, mounted ? 'a' : 'w')

    try {
      setAttr(out, 'schema', SIDECAR_SCHEMA)
      setAttr(out, 'metrics', METRIC_KEYS_12.join(','))

      const values = new Float64Array(12)
      let done = 0
      emit({ phase: 'start', done, total: totalSignals, groups: pending.length })

      for (const g of pending) {
        const dset = h5file.get(`${g.test}/${g.sensor}/data`)
        const cols = METRIC_KEYS_12.map(() => new Float64Array(g.nSignals))
        const batchRows = Math.max(1, Math.floor(BATCH_SAMPLES / g.nSamples))

        for (let start = 0; start < g.nSignals; start += batchRows) {
          const end = Math.min(start + batchRows, g.nSignals)
          const slab = dset.slice([[start, end], [0, g.nSamples]])
          const flat = slab instanceof Float32Array ? slab : Float32Array.from(slab)

          for (let r = start; r < end; r += 1) {
            const off = (r - start) * g.nSamples
            computeAllMetrics(flat.subarray(off, off + g.nSamples), g.fs, values)
            for (let m = 0; m < 12; m += 1) cols[m][r] = values[m]
          }

          done += end - start
          emit({ phase: 'run', done, total: totalSignals, test: g.test, sensor: g.sensor })
        }

        const testGroup = out.keys().includes(g.test)
          ? out.get(g.test)
          : out.create_group(g.test)
        const sensorGroup = testGroup.keys().includes(g.sensor)
          ? testGroup.get(g.sensor)
          : testGroup.create_group(g.sensor)

        setAttr(sensorGroup, 'fs', g.fs)
        setAttr(sensorGroup, 'n_signals', new Int32Array([g.nSignals]))
        setAttr(sensorGroup, 'n_samples', new Int32Array([g.nSamples]))

        // h5wasm 0.10.3 no puede borrar links, así que un dataset ya presente
        // no se reescribe. Sólo pasa con un sidecar incompleto de origen
        // externo: los nuestros se guardan enteros o no se guardan.
        const have = sensorGroup.keys()
        METRIC_KEYS_12.forEach((key, m) => {
          if (have.includes(key)) return
          const ds = sensorGroup.create_dataset({
            name: key,
            data: cols[m], // Float64Array => guess_metadata infiere '<d'
            shape: [g.nSignals],
            chunks: [Math.min(g.nSignals, 8192)],
            compression: 'gzip',
          })
          const unit = METRICS[key]?.unit
          if (unit) ds.create_attribute('unit', unit, [])
        })

        out.flush()
      }

      emit({ phase: 'writing', done, total: totalSignals })
    } finally {
      try { out.close() } catch (e) { /* noop */ }
    }

    const bytes = FS.readFile(sidecarPath)
    const index = readSidecarIndex(true)

    return { bytes, index, computed: pending.length, skipped }
  }

  function readMetric({ test, sensor, key, sidecarBytes }) {
    const mounted = mountSidecar(sidecarBytes)
    if (!mounted) throw new Error('No hay métricas calculadas para este archivo')
    const f = new h5wasm.File(sidecarPath, 'r')
    try {
      const d = f.get(`${test}/${sensor}/${key}`)
      if (!d) throw new Error(`Métrica no encontrada: ${test}/${sensor}/${key}`)
      const values = Float64Array.from(d.value)
      return { values, n: values.length }
    } finally {
      try { f.close() } catch (e) { /* noop */ }
    }
  }

  return { signalGroups, plan, run, readMetric }
}
