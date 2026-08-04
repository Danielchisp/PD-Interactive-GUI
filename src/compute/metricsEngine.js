// Lectura del sidecar de métricas desde el navegador.
//
//   /<Test - fecha>/<sensor>/<métrica>   float64[n_signals]
//
// El sidecar lo genera scripts/compute_metrics.py **antes** de levantar la GUI.
// Aquí no se calcula ninguna métrica: sobre cientos de miles de señales el
// cálculo en el navegador eran minutos de pestaña bloqueada, y el resultado
// vivía en un caché que cualquier limpieza del sitio se llevaba por delante.
// Este módulo sólo sabe dos cosas: qué falta (`plan`) y cómo leer (`readMetric`).
//
// El master nunca se modifica: en el navegador se abre en modo lectura sobre un
// File inmutable.
//
// Vive fuera del worker a propósito: recibe h5wasm y FS por parámetro, así que
// el mismo código corre bajo el build de navegador (dentro del worker) y bajo
// el de Node (en las pruebas), sin duplicar la lógica.

import { METRIC_KEYS_12 } from './metrics.js'

const SENSORS = ['uhf', 'ae']
// De qué subgrupo sale cada sensor dentro de un chunk del layout chunks-v2.
const CHUNK_SOURCES = { uhf: 'signals', ae: 'ae_signals' }

export function createMetricsEngine({ h5wasm, FS, sidecarPath }) {
  // Grupos de señal del master. Reconoce los dos layouts del generador:
  //
  //   plano-v1    /<test>/<sensor>/data
  //   chunks-v2   /<test>/chunk_NNNNNN/<origen>/data
  //
  // En chunks-v2 no se cuentan las señales: habría que abrir los miles de
  // chunks de cada test sólo para avisar de un número que el CLI ya conoce.
  // Basta con mirar el primer chunk para saber qué sensores hay; `nSignals`
  // queda en null y `plan` se conforma con que el sensor esté en el sidecar.
  function signalGroups(h5file) {
    const groups = []
    for (const testName of h5file.keys()) {
      const g = h5file.get(testName)
      if (!(g instanceof h5wasm.Group)) continue
      const keys = g.keys()
      const firstChunk = keys.find((k) => k.startsWith('chunk_'))

      for (const sensor of SENSORS) {
        if (firstChunk) {
          const probe = h5file.get(`${testName}/${firstChunk}/${CHUNK_SOURCES[sensor]}/data`)
          if (!probe || probe.shape?.length !== 2) continue
          groups.push({ test: testName, sensor, nSignals: null, chunked: true })
          continue
        }
        if (!keys.includes(sensor)) continue
        const dset = h5file.get(`${testName}/${sensor}/data`)
        if (!dset || !dset.shape || dset.shape.length !== 2) continue
        groups.push({
          test: testName,
          sensor,
          nSignals: dset.shape[0],
          chunked: false,
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

  // Contrasta el sidecar con los grupos del master. `pending` es lo que el CLI
  // todavía no calculó — un aviso para el usuario, no una tarea que la GUI vaya
  // a ejecutar. `skipped` se mantiene por compatibilidad con quien lea el plan.
  function plan(h5file, sidecarBytes) {
    const mounted = mountSidecar(sidecarBytes)
    const index = readSidecarIndex(mounted)
    const pending = []
    const skipped = []

    for (const g of signalGroups(h5file)) {
      const have = index[`${g.test}|${g.sensor}`]
      if (have === undefined) {
        pending.push(g)
      } else if (!g.chunked && have !== g.nSignals) {
        // Sidecar desfasado: el master creció o se regeneró desde que se
        // calcularon las métricas.
        pending.push({ ...g, reason: `sidecar con ${have} de ${g.nSignals} señales` })
      }
    }

    return { pending, skipped, index, existing: Object.keys(index).length, mounted }
  }

  function readMetric({ test, sensor, key, sidecarBytes }) {
    const mounted = mountSidecar(sidecarBytes)
    if (!mounted) throw new Error('No metrics computed for this file')
    const f = new h5wasm.File(sidecarPath, 'r')
    try {
      const d = f.get(`${test}/${sensor}/${key}`)
      if (!d) throw new Error(`Metric not found: ${test}/${sensor}/${key}`)
      const values = Float64Array.from(d.value)
      return { values, n: values.length }
    } finally {
      try { f.close() } catch (e) { /* noop */ }
    }
  }

  return { signalGroups, plan, readMetric }
}
