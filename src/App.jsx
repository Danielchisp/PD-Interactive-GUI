import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Canvas from './components/Canvas.jsx'
import Menu from './components/Menu.jsx'
import ChartCard from './components/ChartCard.jsx'
import DataSourcePanel, { groupLabelFor } from './components/DataSourcePanel.jsx'
import MetricsProgress from './components/MetricsProgress.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import { hdf5 } from './hdf5/hdf5Client.js'
import {
  fetchSidecar,
  loadSidecar,
  saveSidecar,
  sidecarKey,
} from './hdf5/metricsStore.js'
import { compute } from './compute/computeClient.js'
import { METRICS } from './compute/metrics.js'
import { opsFor } from './compute/operations.js'
import {
  deleteDataset,
  getDataset,
  nextDatasetId,
  putDataset,
} from './state/datasetStore.js'
import { GRID, snap } from './constants.js'

// True when point (cx, cy) falls inside card c's rectangle.
const contains = (c, cx, cy) =>
  cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height

// Signature of a card's series — changes when a series is added/removed.
const seriesSig = (series) =>
  series.map((s) => `${s.datasetId}|${s.xCol}|${s.yCol}`).join(',')

const CARD_DEFAULT = { width: 576, height: 352 } // multiples of the grid step
const PANEL_DEFAULT = { width: 320, height: 448 }

let cardSeq = 0
const nextCardId = () => {
  cardSeq += 1
  return `card_${cardSeq}`
}

// z-index shared between cards and the panel: a simple monotonic counter.
let zTop = 0
const bumpZ = () => (zTop += 1)

export default function App() {
  // React state: ONLY references, metadata and indices. No raw data.
  const [cards, setCards] = useState([]) // { id, title, domain, x, y, width, height, z, series:[...] }
  const [menu, setMenu] = useState(null) // { kind:'canvas'|'card', x, y, cardId? }
  const [source, setSource] = useState(null) // { fileName, tests, geom }
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(null)
  const [theme, setTheme] = useState('dark')
  const [mergeTargetId, setMergeTargetId] = useState(null) // highlighted while dragging
  const [metricsProgress, setMetricsProgress] = useState(null) // { done, total, ... }
  const [metrics, setMetrics] = useState(null) // { key, bytes, index, fileName }

  const hdfInputRef = useRef(null)
  const spawnAtRef = useRef(null) // remembered click point for the panel
  const cardsRef = useRef(cards) // latest geometry for use inside drag handlers
  cardsRef.current = cards

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  )

  const openMenu = useCallback((pos) => setMenu({ kind: 'canvas', ...pos }), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  // Right-click on a chart => operations menu (only if the domain has any).
  const openCardMenu = useCallback((cardId, pos) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card || opsFor(card.domain).length === 0) return
    setMenu({ kind: 'card', cardId, ...pos })
  }, [])

  // --- Card creation --------------------------------------------------------
  const addCard = useCallback(({ title, series, at, domain = 'time', source = null }) => {
    setCards((prev) => [
      ...prev,
      {
        id: nextCardId(),
        title,
        domain,
        series,
        source, // { cardId, op, sig } for derived cards (e.g. an FFT)
        x: snap(at.x),
        y: snap(at.y),
        width: CARD_DEFAULT.width,
        height: CARD_DEFAULT.height,
        z: bumpZ(),
      },
    ])
  }, [])

  // Redimensionar una tarjeta agrupada redimensiona todo el bloque y lo vuelve
  // a apilar sin huecos: el grupo es una unidad, no tres tarjetas sueltas.
  const updateCard = useCallback((id, patch) => {
    setCards((prev) => {
      const card = prev.find((c) => c.id === id)
      if (!card?.groupId) {
        return prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
      }

      const width = patch.width ?? card.width
      const height = patch.height ?? card.height
      const members = prev
        .filter((c) => c.groupId === card.groupId)
        .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))

      // El origen del bloque lo fija la tarjeta que se está redimensionando,
      // descontando las que tiene por encima.
      const myPos = members.findIndex((c) => c.id === id)
      const originX = patch.x ?? card.x
      const originY = (patch.y ?? card.y) - myPos * height

      const geom = new Map(
        members.map((c, i) => [c.id, { x: originX, y: originY + i * height, width, height }]),
      )
      return prev.map((c) => (geom.has(c.id) ? { ...c, ...geom.get(c.id) } : c))
    })
  }, [])

  const removeCard = useCallback((id) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const focusCard = useCallback((id) => {
    setCards((prev) => {
      const target = prev.find((c) => c.id === id)
      if (!target || target.z === zTop) return prev // already on top
      return prev.map((c) => (c.id === id ? { ...c, z: bumpZ() } : c))
    })
  }, [])

  // While dragging: find the card the dragged one is hovering over (its center
  // inside another card) and highlight it as the merge target.
  const findMergeTarget = useCallback((id, pos) => {
    const list = cardsRef.current
    const dragged = list.find((c) => c.id === id)
    if (!dragged) return null
    const cx = pos.x + dragged.width / 2
    const cy = pos.y + dragged.height / 2
    // Only merge cards of the SAME domain (a spectrum and a time signal have
    // different axes and must not fuse).
    const targets = list.filter(
      (c) => c.id !== id && c.domain === dragged.domain && contains(c, cx, cy),
    )
    if (targets.length === 0) return null
    return targets.reduce((a, b) => ((b.z || 0) > (a.z || 0) ? b : a)).id
  }, [])

  const cardDragMove = useCallback(
    (id, pos) => {
      // Un grupo se arrastra entero y no participa en la fusión: mezclarlo con
      // otra tarjeta rompería el bloque apilado.
      if (cards.find((c) => c.id === id)?.groupId) return
      const tid = findMergeTarget(id, pos)
      setMergeTargetId((prev) => (prev === tid ? prev : tid))
    },
    [cards, findMergeTarget],
  )

  // Drop a card onto another => merge their series into the target card.
  const cardDragStop = useCallback(
    (id, pos) => {
      const targetId = findMergeTarget(id, pos)
      setMergeTargetId(null)
      setCards((prev) => {
        const dragged = prev.find((c) => c.id === id)
        if (!dragged) return prev

        // Grupo: se traslada el bloque entero por el mismo delta, conservando
        // el apilado contiguo. Sin fusión.
        if (dragged.groupId) {
          const dx = pos.x - dragged.x
          const dy = pos.y - dragged.y
          if (dx === 0 && dy === 0) return prev
          return prev.map((c) =>
            c.groupId === dragged.groupId ? { ...c, x: c.x + dx, y: c.y + dy } : c,
          )
        }

        const moved = { ...dragged, x: pos.x, y: pos.y }
        const target = prev.find((c) => c.id === targetId)
        if (!target) return prev.map((c) => (c.id === id ? moved : c))

        const mergedSeries = [...target.series, ...moved.series]
        const mergedTitle = mergedSeries.map((s) => s.name).join(' + ')
        return prev
          .filter((c) => c.id !== id)
          .map((c) => {
            if (c.id === target.id) {
              return { ...c, series: mergedSeries, title: mergedTitle, z: bumpZ() }
            }
            // Re-point derived cards whose source was consumed by the merge,
            // so their link survives (and they recompute against the target).
            if (c.source?.cardId === id) {
              return { ...c, source: { ...c.source, cardId: target.id } }
            }
            return c
          })
      })
    },
    [findMergeTarget],
  )

  // Split a merged card back into one card per series (cascaded on the grid).
  const splitCard = useCallback((id) => {
    setCards((prev) => {
      const card = prev.find((c) => c.id === id)
      if (!card || card.series.length < 2) return prev
      const fanned = card.series.map((s, i) => ({
        id: nextCardId(),
        title: s.name,
        series: [s],
        x: card.x + i * GRID,
        y: card.y + i * GRID,
        width: card.width,
        height: card.height,
        z: bumpZ(),
      }))
      return [...prev.filter((c) => c.id !== id), ...fanned]
    })
  }, [])

  // --- Operations -----------------------------------------------------------
  // Compute the Welch spectrum of every series of a time card => freq series
  // (one new dataset per series in the store).
  const fftSeriesFrom = useCallback(async (srcCard) => {
    const inputs = srcCard.series.map((s) => {
      const ds = getDataset(s.datasetId)
      const x = ds.data[s.xCol]
      return { name: s.name, y: ds.data[s.yCol], dt: x.length > 1 ? x[1] - x[0] : 1 }
    })
    const { results } = await compute.fft(inputs)
    return results.map((r) => {
      const id = nextDatasetId()
      putDataset({
        id,
        name: r.name,
        columns: ['f (Hz)', r.name],
        rowCount: r.freq.length,
        data: { 'f (Hz)': r.freq, [r.name]: r.mag },
        meta: {},
      })
      return { datasetId: id, xCol: 'f (Hz)', yCol: r.name, name: r.name }
    })
  }, [])

  // Right-click "Compute FFT": a NEW freq card, linked to its source time card.
  const computeFft = useCallback(
    async (cardId) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card) return
      try {
        const series = await fftSeriesFrom(card)
        addCard({
          title: `FFT · ${card.title}`,
          series,
          domain: 'freq',
          at: { x: card.x + 2 * GRID, y: card.y + 2 * GRID },
          source: { cardId: card.id, op: 'fft', sig: seriesSig(card.series) },
        })
      } catch (err) {
        setError(err?.message || 'Could not compute the FFT.')
      }
    },
    [addCard, fftSeriesFrom],
  )

  const runOperation = useCallback(
    (opId, cardId) => {
      if (opId === 'fft') computeFft(cardId)
    },
    [computeFft],
  )

  // Reactive recompute: when a linked source card's series change (e.g. after a
  // merge adds a signal), the derived FFT card recomputes. The stored `sig`
  // makes this idempotent — position/size changes don't retrigger it.
  const recomputingRef = useRef(new Set())
  useEffect(() => {
    for (const card of cards) {
      if (card.domain !== 'freq' || !card.source) continue
      const src = cards.find((c) => c.id === card.source.cardId)
      if (!src) continue // source gone (e.g. split): leave the last result as-is
      const curSig = seriesSig(src.series)
      if (curSig === card.source.sig) continue // already up to date
      if (recomputingRef.current.has(card.id)) continue // recompute in flight

      recomputingRef.current.add(card.id)
      const freqId = card.id
      const oldSeries = card.series
      ;(async () => {
        try {
          const series = await fftSeriesFrom(src)
          setCards((prev) =>
            prev.map((c) =>
              c.id === freqId
                ? {
                    ...c,
                    series,
                    title: `FFT · ${src.title}`,
                    source: { ...c.source, sig: curSig },
                  }
                : c,
            ),
          )
          oldSeries.forEach((s) => deleteDataset(s.datasetId)) // free the old spectra
        } catch (err) {
          setError(err?.message || 'Could not recompute the FFT.')
        } finally {
          recomputingRef.current.delete(freqId)
        }
      })()
    }
  }, [cards, fftSeriesFrom])

  // --- HDF5 source ----------------------------------------------------------
  const openHdf5 = useCallback(() => {
    spawnAtRef.current = menu
    setMenu(null)
    hdfInputRef.current?.click()
  }, [menu])

  const onHdfFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow reopening the same file
    if (!file) return
    setError(null)
    setOpening(true)
    try {
      const res = await hdf5.open(file)
      const at = spawnAtRef.current || { x: 60, y: 60 }
      setSource({
        fileName: res.fileName,
        tests: res.tests,
        geom: { x: snap(at.x), y: snap(at.y), ...PANEL_DEFAULT, z: bumpZ() },
      })
      setOpening(false)
      await ensureMetricsRef.current(file)
    } catch (err) {
      setError(err?.message || 'Could not open the HDF5 file.')
    } finally {
      setOpening(false)
    }
  }, [])

  // Al abrir un archivo, las 12 métricas escalares por señal deben existir.
  // Se recuperan del sidecar cacheado y sólo se calcula lo que falte; sobre
  // cientos de miles de señales el cálculo son minutos, de ahí la barra.
  const ensureMetrics = useCallback(async (file) => {
    const key = sidecarKey(file)
    // Preferencia: el sidecar que dejó scripts/compute_metrics.py junto al
    // master (lo sirve el dev server). Si no está, el caché del navegador.
    let bytes = await fetchSidecar(file.name)
    const fromDisk = bytes !== null
    if (!bytes) bytes = await loadSidecar(key)

    try {
      const plan = await hdf5.metricsPlan(bytes)

      if (plan.skipped.length > 0) {
        setError(
          `Sin métricas en ${plan.skipped.length} grupo(s): falta el atributo fs_<sensor> ` +
          `en el experimento (${plan.skipped.map((s) => `${s.test}/${s.sensor}`).join(', ')}).`,
        )
      }

      // Ya estaba todo calculado (por el CLI o en una sesión anterior).
      if (plan.pending.length === 0) {
        if (bytes) {
          setMetrics({ key, bytes, index: plan.index, fileName: file.name, fromDisk })
          // Si vino del disco no se duplica en IndexedDB: el archivo manda.
          if (!fromDisk) await saveSidecar(key, bytes)
        }
        return
      }

      setMetricsProgress({
        done: 0,
        total: plan.totalSignals,
        phase: 'start',
        startedAt: performance.now(),
      })

      const run = await hdf5.metricsRun(bytes, (p) =>
        setMetricsProgress((prev) => (prev ? { ...prev, ...p } : prev)),
      )

      bytes = run.bytes
      await saveSidecar(key, bytes)
      setMetrics({ key, bytes, index: run.index, fileName: file.name })
    } catch (err) {
      setError(`Métricas: ${err?.message || err}`)
    } finally {
      setMetricsProgress(null)
    }
  }, [])

  // onHdfFile se declara antes que ensureMetrics, así que lo alcanza por ref
  // en vez de por dependencia (evita el TDZ al evaluar el array en el render).
  const ensureMetricsRef = useRef(ensureMetrics)
  ensureMetricsRef.current = ensureMetrics

  const updateSourceGeom = useCallback((patch) => {
    setSource((s) => (s ? { ...s, geom: { ...s.geom, ...patch } } : s))
  }, [])

  const focusSource = useCallback(() => {
    setSource((s) =>
      s && s.geom.z !== zTop ? { ...s, geom: { ...s.geom, z: bumpZ() } } : s,
    )
  }, [])

  const closeSource = useCallback(() => setSource(null), [])

  // --- Gráficos de un experimento ---------------------------------------------
  // Un constructor por tipo de gráfico, compartido entre arrastrar el
  // experimento entero (los tres apilados) y arrastrar un grupo suelto (ese
  // mismo gráfico, solo). Así no hay dos formas de fabricar la misma tarjeta.

  const XCOL = 'Time (s)'

  // Ambiente: humedad en azul (eje izquierdo) y temperatura en rojo (derecho).
  const buildEnvChart = useCallback(async (test, t0) => {
    const res = await hdf5.readHumidity(test)
    const xs = new Float64Array(res.nSamples)
    for (let i = 0; i < res.nSamples; i += 1) xs[i] = res.timestamps[i] - t0

    const hum = 'Humidity (%)'
    const tmp = 'Temperature (°C)'
    const id = nextDatasetId()
    putDataset({
      id,
      name: `Temp/Hum - ${test}`,
      columns: [XCOL, hum, tmp],
      rowCount: res.nSamples,
      data: {
        [XCOL]: xs,
        [hum]: res.humidity,
        [tmp]: res.temperature || new Float64Array(res.nSamples),
      },
      meta: { test, t0 },
    })

    return [
      { datasetId: id, xCol: XCOL, yCol: hum, name: hum, color: '#4f9cff' },
      { datasetId: id, xCol: XCOL, yCol: tmp, name: tmp, color: '#ff5f7a', axis: 'y2' },
    ]
  }, [])

  // Vpp por sensor. El valor sale del sidecar ya calculado — el frontend no
  // computa métricas — y el eje X de los timestamps del master, que el
  // sidecar no guarda.
  const buildVppChart = useCallback(async (test, sensor, t0, color) => {
    if (!metrics?.bytes) throw new Error('sin métricas: ejecuta npm run metrics')

    const [m, ts] = await Promise.all([
      hdf5.readMetric(test, sensor, 'vpp', metrics.bytes),
      hdf5.readTimestamps(test, sensor),
    ])
    const n = Math.min(m.n, ts.n)
    const xs = new Float64Array(n)
    for (let i = 0; i < n; i += 1) xs[i] = ts.values[i] - t0

    const ycol = `Vpp (V) · ${sensor.toUpperCase()}`
    const id = nextDatasetId()
    putDataset({
      id,
      name: `${sensor.toUpperCase()} Vpp - ${test}`,
      columns: [XCOL, ycol],
      rowCount: n,
      data: { [XCOL]: xs, [ycol]: m.values.subarray(0, n) },
      meta: { test, sensor, metricKey: 'vpp', fromSidecar: true },
    })

    return [{ datasetId: id, xCol: XCOL, yCol: ycol, name: ycol, color, mode: 'markers' }]
  }, [metrics])

  // Los tres gráficos del experimento, en orden de apilado. La clave es el
  // nombre del grupo en el HDF5, para poder resolver un arrastre suelto.
  const chartSpecs = useMemo(() => [
    { key: 'humidity', label: 'Temp/Hum Data', build: (t, t0) => buildEnvChart(t, t0) },
    { key: 'uhf', label: 'UHF Data · Vpp', build: (t, t0) => buildVppChart(t, 'uhf', t0, '#5fd68a') },
    { key: 'ae', label: 'AE Data · Vpp', build: (t, t0) => buildVppChart(t, 'ae', t0, '#ffcf5f') },
  ], [buildEnvChart, buildVppChart])

  const patchCard = useCallback((id, p) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)))
  }, [])

  // Arrastrar el experimento: los tres gráficos como bloque contiguo y
  // sincronizado. Las tarjetas aparecen ya, en carga, y se rellenan al llegar
  // sus datos; un fallo en una no arrastra a las demás.
  const dropExperiment = useCallback(async (test, at) => {
    const shortDate = test.replace('Test - ', '').replace(/Z$/, '')
    const x = snap(at.x)
    const y0 = snap(at.y)
    const width = CARD_DEFAULT.width
    const height = 224 // múltiplo de GRID: el apilado sigue cuadrando al soltar
    const ids = chartSpecs.map(() => nextCardId())
    const groupId = `grp_${ids[0]}`

    setCards((prev) => [
      ...prev,
      ...chartSpecs.map((spec, i) => ({
        id: ids[i],
        title: `${spec.label} · ${shortDate}`,
        domain: 'time',
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${spec.label}…`,
        alignedMargin: true,
        groupId,
        groupIndex: i,
        x,
        y: y0 + i * height,
        width,
        height,
        z: bumpZ(),
      })),
    ])

    const fail = (id, msg) => patchCard(id, { loading: false, error: msg })

    let info
    try {
      info = await hdf5.experimentT0(test)
    } catch (err) {
      ids.forEach((id) => fail(id, err?.message || 'no timestamps'))
      return
    }
    const xRange = [0, info.durationS]

    await Promise.all(
      chartSpecs.map((spec, i) =>
        spec
          .build(test, info.t0)
          .then((series) => patchCard(ids[i], { loading: false, xRange, series }))
          .catch((e) => fail(ids[i], e?.message || 'failed')),
      ),
    )
  }, [chartSpecs, patchCard])

  // Arrastrar un grupo suelto: exactamente el mismo gráfico que aporta al
  // bloque, con el mismo origen de tiempo y el mismo rango, pero solo.
  const dropSensorChart = useCallback(async (test, groupName, at) => {
    const spec = chartSpecs.find((c) => c.key === groupName)
    if (!spec) throw new Error(`Sin gráfico definido para "${groupName}"`)

    const shortDate = test.replace('Test - ', '').replace(/Z$/, '')
    const id = nextCardId()

    setCards((prev) => [
      ...prev,
      {
        id,
        title: `${spec.label} · ${shortDate}`,
        domain: 'time',
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${spec.label}…`,
        alignedMargin: true,
        x: snap(at.x),
        y: snap(at.y),
        width: CARD_DEFAULT.width,
        height: 224,
        z: bumpZ(),
      },
    ])

    try {
      const info = await hdf5.experimentT0(test)
      const series = await spec.build(test, info.t0)
      patchCard(id, { loading: false, xRange: [0, info.durationS], series })
    } catch (err) {
      patchCard(id, { loading: false, error: err?.message || 'failed' })
    }
  }, [chartSpecs, patchCard])

  // onDropSignal se declara antes, así que los alcanza por ref.
  const dropExperimentRef = useRef(dropExperiment)
  dropExperimentRef.current = dropExperiment
  const dropSensorChartRef = useRef(dropSensorChart)
  dropSensorChartRef.current = dropSensorChart

  // Drop a signal, humidity dataset or full group series on the canvas => read data and plot it.
  const onDropSignal = useCallback(
    async (payload, pos) => {
      try {
        const { kind, test, path, row = 0, datasetName = 'data', metricKey, label } = payload

        if (kind === 'experiment') {
          await dropExperimentRef.current(test, pos)
          return
        }

        if (kind === 'sensorChart') {
          await dropSensorChartRef.current(test, path, pos)
          return
        }

        if (kind === 'groupSeries') {
          // Read group and downsample each signal to 4 points (min, max, etc.) directly in hdf5 worker
          const summaryRes = await hdf5.readGroupSummary(test, path)

          const xcol = 'Time (s)'
          const ycol = `Amplitude (${groupLabelFor(path)})`

          const id = nextDatasetId()
          putDataset({
            id,
            name: `${groupLabelFor(path)} continuous - ${test}`,
            columns: [xcol, ycol],
            rowCount: summaryRes.totalPts,
            data: { [xcol]: summaryRes.xData, [ycol]: summaryRes.yData },
            meta: { test, path, nSignals: summaryRes.nSignals },
          })

          addCard({
            title: `${groupLabelFor(path)} series (${summaryRes.nSignals} signals) · ${test}`,
            series: [{ datasetId: id, xCol: xcol, yCol: ycol, name: ycol }],
            at: pos,
          })
          return
        }

        if (kind === 'groupMetric') {
          // Read full group matrix and compute chosen metric across all signals in background worker
          const groupRes = await hdf5.readGroupMatrix(test, path)
          const transferables = [groupRes.yMatrix.buffer]
          if (groupRes.timestamps) transferables.push(groupRes.timestamps.buffer)

          const compRes = await compute.metricGroup(
            {
              metricKey,
              yMatrix: groupRes.yMatrix,
              nSignals: groupRes.nSignals,
              nSamples: groupRes.nSamples,
              timestamps: groupRes.timestamps,
              fs: 3e9,
            },
            transferables,
          )

          const m = METRICS[metricKey] || { label: metricKey, unit: '' }
          const xcol = 'Time (s)'
          const ycol = `${m.label}${m.unit ? ` (${m.unit})` : ''}`

          const id = nextDatasetId()
          putDataset({
            id,
            name: `${m.label} - ${groupLabelFor(path)} (${test})`,
            columns: [xcol, ycol],
            rowCount: compRes.nSignals,
            data: { [xcol]: compRes.times, [ycol]: compRes.values },
            meta: { test, metricKey, path },
          })

          addCard({
            title: `${m.label} vs Time · ${groupLabelFor(path)} (${test})`,
            series: [{ datasetId: id, xCol: xcol, yCol: ycol, name: ycol }],
            at: pos,
          })
          return
        }

        if (kind === 'humidity' || path === 'humidity') {
          const res = await hdf5.readHumidity(test)
          const xcol = 'Time (s)'
          
          // Calculate relative seconds from start timestamp
          const t0 = res.timestamps[0]
          const x = new Float64Array(res.nSamples)
          for (let i = 0; i < res.nSamples; i += 1) {
            x[i] = res.timestamps[i] - t0
          }

          let yData = res.humidity
          let ycol = `Humidity (%)`
          let cardTitle = `Humidity vs Time (${test})`

          if (datasetName === 'temperature') {
            yData = res.temperature || res.humidity
            ycol = `Temperature (°C)`
            cardTitle = `Temperature vs Time (${test})`
          } else if (datasetName === 'timestamps') {
            yData = res.timestamps
            ycol = `Timestamp (s)`
            cardTitle = `Timestamps vs Time (${test})`
          }

          const id = nextDatasetId()
          putDataset({
            id,
            name: `${ycol} - ${test}`,
            columns: [xcol, ycol],
            rowCount: res.nSamples,
            data: { [xcol]: x, [ycol]: yData },
            meta: { test, t0 },
          })
          addCard({
            title: cardTitle,
            series: [{ datasetId: id, xCol: xcol, yCol: ycol, name: ycol }],
            at: pos,
          })
          return
        }

        const res = await hdf5.readSignal(test, path, row, datasetName)
        const xcol = 't (muestras)'
        const ycol = label || `${path} · sig ${row}`
        const x = new Float64Array(res.nSamples)
        for (let i = 0; i < res.nSamples; i += 1) x[i] = i * res.dt
        const id = nextDatasetId()
        putDataset({
          id,
          name: ycol,
          columns: [xcol, ycol],
          rowCount: res.nSamples,
          data: { [xcol]: x, [ycol]: res.y },
          meta: {},
        })
        addCard({
          title: ycol,
          series: [{ datasetId: id, xCol: xcol, yCol: ycol, name: ycol }],
          at: pos,
        })
      } catch (err) {
        setError(err?.message || 'Could not read the signal.')
      }
    },
    [addCard],
  )

  const empty = cards.length === 0 && !source

  // Build the menu items for the currently open menu.
  const menuItems = (m) => {
    if (m.kind === 'canvas') {
      return [{ glyph: '⛃', label: 'Open HDF5…', onClick: openHdf5 }]
    }
    const card = cards.find((c) => c.id === m.cardId)
    return opsFor(card?.domain).map((op) => ({
      glyph: op.glyph,
      label: op.label,
      onClick: () => runOperation(op.id, m.cardId),
    }))
  }

  return (
    <div className="app">
      <input
        ref={hdfInputRef}
        type="file"
        accept=".hdf5,.h5,.he5"
        style={{ display: 'none' }}
        onChange={onHdfFile}
      />

      <Canvas
        onOpenMenu={openMenu}
        onDismiss={closeMenu}
        hasMenu={!!menu}
        onDropSignal={onDropSignal}
      >
        {cards.map((card) => (
          <ChartCard
            key={card.id}
            card={card}
            theme={theme}
            isMergeTarget={card.id === mergeTargetId}
            onChange={(patch) => updateCard(card.id, patch)}
            onDragMove={(pos) => cardDragMove(card.id, pos)}
            onDragStop={(pos) => cardDragStop(card.id, pos)}
            onSplit={() => splitCard(card.id)}
            onClose={() => removeCard(card.id)}
            onFocus={() => focusCard(card.id)}
            onContextMenu={(pos) => openCardMenu(card.id, pos)}
          />
        ))}
        {source && (
          <DataSourcePanel
            source={source}
            geom={source.geom}
            onChange={updateSourceGeom}
            onClose={closeSource}
            onFocus={focusSource}
          />
        )}
      </Canvas>

      <ThemeToggle theme={theme} onToggle={toggleTheme} />

      {empty && !menu && !opening && (
        <div className="hint" aria-hidden="true">
          Click the canvas to begin
        </div>
      )}

      {opening && <div className="hint">opening HDF5…</div>}

      <MetricsProgress state={metricsProgress} />

      {error && (
        <div className="toast-error" onClick={() => setError(null)}>
          ⚠ {error}
        </div>
      )}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
