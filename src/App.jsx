import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Canvas from './components/Canvas.jsx'
import Menu from './components/Menu.jsx'
import ChartCard, { PALETTE, spunColor } from './components/ChartCard.jsx'
import DataSourcePanel, { groupLabelFor } from './components/DataSourcePanel.jsx'
import { hdf5 } from './hdf5/hdf5Client.js'
import { fetchSidecar, sidecarName } from './hdf5/metricsStore.js'
import { compute } from './compute/computeClient.js'
import { METRICS, METRIC_KEYS_UI, isRuntimeMetric, localRate } from './compute/metrics.js'
import { DEFAULT_SMOOTHING } from './compute/trend.js'
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

// Especie de un gráfico: qué clase de cosa dibuja. Sólo se superponen dos
// gráficos de la MISMA especie.
//
// El dominio no bastaba. Una forma de onda, una métrica contra el tiempo y la
// temperatura ambiental son las tres `domain: 'time'`, y fusionarlas daba una
// tarjeta con un eje Y que no significaba nada para dos de sus series: microsegundos
// de una señal cruda contra minutos de experimento en el mismo eje X, o voltios
// de pico contra grados. La especie es lo que de verdad comparten dos series que
// tiene sentido mirar juntas.
//
//   signal   forma de onda cruda (muestras)
//   metric   una métrica contra el tiempo del experimento
//   scatter  métrica contra métrica
//   env      temperatura / humedad
//   freq     espectro
//
// Es un campo de la tarjeta, no algo que se deduzca: dos tarjetas pueden tener
// los mismos `domain` y `sensor` y venir de sitios distintos.
const SPECIES_FALLBACK = 'signal'
const speciesOf = (card) => card.species || SPECIES_FALLBACK

// Signature of a card's series — changes when a series is added/removed.
const seriesSig = (series) =>
  series.map((s) => `${s.datasetId}|${s.xCol}|${s.yCol}`).join(',')

// Colores distinguibles tras una fusión.
//
// El color de un gráfico de sensor depende del sensor, no del experimento: dos
// scatter de UHF traen los dos el mismo verde, así que al fusionarlos las dos
// nubes de puntos quedaban una encima de otra sin forma de separarlas.
//
// Sólo se recolorean las series que chocan, y por orden: la primera conserva su
// color. Así la humedad sigue siendo azul y la temperatura roja —ahí el color
// significa algo— y sólo se mueve lo que de verdad era ambiguo.
// Agotada la paleta, `spunColor` sigue generando tonos por ángulo áureo: reparte
// el círculo de color sin repetir por muchas series que se fusionen.
const recolor = (series) => {
  const used = new Set()
  return series.map((s) => {
    let color = s.color && !used.has(s.color) ? s.color : PALETTE.find((p) => !used.has(p))
    for (let n = 0; !color; n += 1) {
      const candidate = spunColor(n)
      if (!used.has(candidate)) color = candidate
    }
    used.add(color)
    return color === s.color ? s : { ...s, color }
  })
}

const CARD_DEFAULT = { width: 576, height: 352 } // multiples of the grid step
const PANEL_DEFAULT = { width: 320, height: 448 }

// Métrica con la que nace un gráfico de sensor. Las 12 están en el sidecar, así
// que cambiarla es leer otra columna, no calcular nada.
const DEFAULT_METRIC = 'vpp'

// Par de arranque del scatter métrica-vs-métrica. Amplitud contra forma del
// pulso separa a ojo los grupos que interesa descartar.
const DEFAULT_SCATTER = { x: 'vpp', y: 'kurtosis' }

// Color de identidad de cada sensor. Sale de PALETTE —los dos primeros tonos,
// que son los que la validación garantiza separables entre sí— y no del orden en
// que se dibuje: un UHF es verde-azul esté solo o fusionado con tres series más.
const SENSOR_COLOR = { uhf: PALETTE[0], ae: PALETTE[1] }

// Ambiental. Aquí el color sí significa algo por convención —frío el agua,
// caliente la temperatura—, así que se fija por magnitud y no por posición.
const ENV_COLOR = { humidity: PALETTE[0], temperature: PALETTE[5] }

// Sensores con scatter propio, en orden.
const SCATTER_SENSORS = [
  { sensor: 'uhf', label: 'UHF', color: SENSOR_COLOR.uhf },
  { sensor: 'ae', label: 'AE', color: SENSOR_COLOR.ae },
]

const exKey = (test, sensor) => `${test}|${sensor}`

// "Test - 2026-07-14T14-15-47Z" -> "2026-07-14T14-15-47"
const shortLabel = (test) => test.replace('Test - ', '').replace(/Z$/, '')

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
  const [mergeTargetId, setMergeTargetId] = useState(null) // highlighted while dragging
  const [metrics, setMetrics] = useState(null) // { key, bytes, index, fileName }

  // Señales descartadas, por experimento y sensor: { "<test>|<sensor>": Set }.
  // Vive en App y no en la tarjeta a propósito — descartar en un scatter tiene
  // que notarse en TODAS las métricas de ese sensor, que están en otras
  // tarjetas. Guarda índices de señal, no posiciones dibujadas, así que
  // sobrevive a cambiar de métrica o de par de ejes.
  const [excluded, setExcluded] = useState({})
  const selectionRef = useRef(new Map()) // cardId -> Map(curve -> índices)

  const hdfInputRef = useRef(null)
  const spawnAtRef = useRef(null) // remembered click point for the panel
  const cardsRef = useRef(cards) // latest geometry for use inside drag handlers
  cardsRef.current = cards

  const openMenu = useCallback((pos) => setMenu({ kind: 'canvas', ...pos }), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  // Right-click on a chart => operations menu (only if the domain has any).
  const openCardMenu = useCallback((cardId, pos) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card || opsFor(card.domain).length === 0) return
    setMenu({ kind: 'card', cardId, ...pos })
  }, [])

  // --- Card creation --------------------------------------------------------
  const addCard = useCallback(({
    title,
    series,
    at,
    domain = 'time',
    source = null,
    species = SPECIES_FALLBACK,
  }) => {
    setCards((prev) => [
      ...prev,
      {
        id: nextCardId(),
        title,
        domain,
        species,
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

  // Qué arrastra consigo una tarjeta, tanto al moverla como al cerrarla.
  //
  // El bloque apilado es la ventana principal del experimento: sus tres
  // gráficos son una unidad —se mueven, se redimensionan y hacen zoom juntos—
  // y los dos scatter van anclados a ella. Mover o cerrar cualquiera de los
  // tres mueve o cierra las cinco.
  //
  // Al revés no, y es deliberado: un scatter suelto se mueve y se cierra solo.
  // Si arrastrarlo moviera el experimento entero no habría forma de soltarlo
  // sobre otro para fusionarlos, que es justo lo que hace útil compararlos.
  //
  // Las señales abiertas a clic tampoco entran: son exploraciones sueltas que
  // el usuario abrió a propósito y a menudo quiere conservar para comparar.
  const blockOf = (list, card) => {
    if (!card.groupId) return [card] // scatter suelto, señal, gráfico aislado
    return list.filter(
      (c) =>
        c.groupId === card.groupId ||
        (card.experimentId != null && c.experimentId === card.experimentId),
    )
  }

  const removeCard = useCallback((id) => {
    const list = cardsRef.current
    const card = list.find((c) => c.id === id)
    if (!card) return
    const doomed = blockOf(list, card)
    // Los datos crudos viven fuera de React, así que hay que soltarlos a mano:
    // un experimento son cientos de miles de puntos por gráfico.
    doomed.forEach((c) => c.series.forEach((s) => deleteDataset(s.datasetId)))
    const ids = new Set(doomed.map((c) => c.id))
    setCards((prev) => prev.filter((c) => !ids.has(c.id)))
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
    // Sólo se fusionan gráficos de la misma especie y del mismo dominio: un
    // espectro y una señal temporal no comparten ejes, y una forma de onda y una
    // métrica tampoco aunque las dos vayan contra el tiempo.
    const species = speciesOf(dragged)
    const targets = list.filter(
      (c) =>
        c.id !== id &&
        c.domain === dragged.domain &&
        speciesOf(c) === species &&
        contains(c, cx, cy),
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

        // Ventana principal: se traslada el experimento entero por el mismo
        // delta —los tres apilados y sus scatter—, conservando las posiciones
        // relativas. Sin fusión: mezclar el bloque con otra tarjeta lo rompería.
        if (dragged.groupId) {
          const dx = pos.x - dragged.x
          const dy = pos.y - dragged.y
          if (dx === 0 && dy === 0) return prev
          const moving = new Set(blockOf(prev, dragged).map((c) => c.id))
          return prev.map((c) =>
            moving.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c,
          )
        }

        const moved = { ...dragged, x: pos.x, y: pos.y }
        const target = prev.find((c) => c.id === targetId)
        if (!target) return prev.map((c) => (c.id === id ? moved : c))

        const mergedSeries = recolor([...target.series, ...moved.series])
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
      // Dominio y especie se heredan: separar una fusión da las mismas tarjetas
      // que entraron, y tienen que poder volver a juntarse.
      const fanned = card.series.map((s, i) => ({
        id: nextCardId(),
        title: s.name,
        domain: card.domain,
        species: card.species,
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
          species: 'freq',
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
    // El menú se dibuja en pantalla, pero el panel nace en el mundo: con el
    // lienzo desplazado o con zoom, no son el mismo punto.
    spawnAtRef.current = menu ? { x: menu.worldX, y: menu.worldY } : null
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

  // Las 12 métricas por señal se calculan **antes** de levantar la GUI, con
  // scripts/compute_metrics.py (`npm run dev` lo lanza vía predev). Aquí sólo
  // se carga el sidecar que dejó junto al master y que sirve el dev server.
  //
  // El navegador no calcula métricas: sobre cientos de miles de señales eran
  // minutos de pestaña bloqueada, y el resultado se perdía con el caché. Si
  // falta el sidecar se avisa y se sigue — explorar y graficar señales sueltas
  // no depende de las métricas; sólo los gráficos de Vpp se quedan sin datos.
  const ensureMetrics = useCallback(async (file) => {
    const bytes = await fetchSidecar(file.name)

    if (!bytes) {
      setError(
        `No metrics for ${file.name}: ${sidecarName(file.name)} is missing. ` +
        'Run `npm run metrics` and open the file again.',
      )
      return
    }

    try {
      // plan() aquí no planifica ningún cálculo: sólo contrasta lo que hay en
      // el sidecar con los grupos del master, para saber qué falta.
      const plan = await hdf5.metricsPlan(bytes)
      setMetrics({ bytes, index: plan.index, fileName: file.name })

      const missing = [...plan.pending, ...plan.skipped]
      if (missing.length > 0) {
        const names = missing.slice(0, 3).map((g) => `${g.test}/${g.sensor}`).join(', ')
        setError(
          `Missing metrics in ${missing.length} group(s) (${names}` +
          `${missing.length > 3 ? ', …' : ''}). Run \`npm run metrics\`.`,
        )
      }
    } catch (err) {
      setError(`Metrics: ${err?.message || err}`)
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
      { datasetId: id, xCol: XCOL, yCol: hum, name: hum, color: ENV_COLOR.humidity },
      { datasetId: id, xCol: XCOL, yCol: tmp, name: tmp, color: ENV_COLOR.temperature, axis: 'y2' },
    ]
  }, [])

  // Etiqueta del eje Y de una métrica: "VPP (V) · UHF".
  const metricLabel = (metricKey, sensor) => {
    const m = METRICS[metricKey] || { label: metricKey, unit: '' }
    return `${m.label}${m.unit ? ` (${m.unit})` : ''} · ${sensor.toUpperCase()}`
  }

  // Una métrica por sensor, en scatter. El valor sale del sidecar ya calculado
  // —el frontend no computa métricas— y el eje X de los timestamps del master,
  // que el sidecar no guarda.
  const buildMetricChart = useCallback(async (test, sensor, t0, color, metricKey) => {
    // La densidad se calcula aquí a partir de los timestamps; el sidecar sólo
    // hace falta para las 12 que sí son propiedades de una señal.
    const runtime = isRuntimeMetric(metricKey)
    if (!runtime && !metrics?.bytes) throw new Error('no metrics: run npm run metrics')

    const [m, ts] = await Promise.all([
      runtime ? null : hdf5.readMetric(test, sensor, metricKey, metrics.bytes),
      hdf5.readTimestamps(test, sensor),
    ])
    const n = runtime ? ts.n : Math.min(m.n, ts.n)
    const xs = new Float64Array(n)
    for (let i = 0; i < n; i += 1) xs[i] = ts.values[i] - t0
    const values = runtime ? localRate(ts.values, n) : m.values.subarray(0, n)

    const ycol = metricLabel(metricKey, sensor)
    const id = nextDatasetId()
    putDataset({
      id,
      name: `${sensor.toUpperCase()} ${metricKey} - ${test}`,
      columns: [XCOL, ycol],
      rowCount: n,
      data: { [XCOL]: xs, [ycol]: values },
      // `perSignal`: cada fila es una señal, no una muestra. Es lo que autoriza
      // a enmascarar esta serie con las señales descartadas — y lo que permite
      // volver del punto del scatter a la señal, porque el índice del punto es
      // el de la señal en el experimento entero.
      // `t0` viaja con el dataset porque al fusionar dos experimentos cada
      // serie conserva el suyo: sin él, reconstruir la métrica de una serie
      // ajena la referiría al origen de tiempo del otro experimento.
      meta: { test, sensor, metricKey, t0, perSignal: true, fromSidecar: !runtime },
    })

    return [{
      datasetId: id,
      xCol: XCOL,
      yCol: ycol,
      name: ycol,
      // Sólo para la leyenda. El eje sigue titulándose con `name`, que si no
      // acabaría arrastrando la fecha; en la leyenda, en cambio, es lo único
      // que distingue dos series fusionadas de experimentos distintos.
      legendName: `${ycol} · ${shortLabel(test)}`,
      color,
      mode: 'markers',
    }]
  }, [metrics])

  // Scatter métrica contra métrica, uno por sensor. Es el gráfico desde el que
  // se filtra: un punto sigue siendo una señal, así que seleccionar con
  // rectángulo o lazo selecciona señales, y descartarlas las quita de todas las
  // métricas de ese sensor.
  const buildScatterChart = useCallback(async (test, sensor, xMetric, yMetric, color) => {
    // Cualquiera de los dos ejes puede ser la densidad, que no está en el
    // sidecar: sólo se exige el sidecar si alguno de los dos sí lo necesita.
    const xr = isRuntimeMetric(xMetric)
    const yr = isRuntimeMetric(yMetric)
    if (!(xr && yr) && !metrics?.bytes) throw new Error('no metrics: run npm run metrics')

    const [mx, my, ts] = await Promise.all([
      xr ? null : hdf5.readMetric(test, sensor, xMetric, metrics.bytes),
      yr ? null : hdf5.readMetric(test, sensor, yMetric, metrics.bytes),
      xr || yr ? hdf5.readTimestamps(test, sensor) : null,
    ])
    const lengths = [mx?.n, my?.n, ts?.n].filter((v) => Number.isFinite(v))
    const n = Math.min(...lengths)
    const rate = ts ? localRate(ts.values, n) : null
    const xv = xr ? rate : mx.values.subarray(0, n)
    const yv = yr ? rate : my.values.subarray(0, n)
    const xcol = metricLabel(xMetric, sensor)
    const ycol = metricLabel(yMetric, sensor)
    // Dos métricas distintas del mismo sensor pueden dar la misma etiqueta si
    // se eligen iguales; entonces sobra una columna y el eje Y se queda vacío.
    const yname = xcol === ycol ? `${ycol} ` : ycol

    const id = nextDatasetId()
    putDataset({
      id,
      name: `${sensor.toUpperCase()} ${yMetric} vs ${xMetric} - ${test}`,
      columns: [xcol, yname],
      rowCount: n,
      data: { [xcol]: xv, [yname]: yv },
      meta: {
        test, sensor, metricKey: yMetric, xMetric, perSignal: true,
        fromSidecar: !(xr && yr),
      },
    })

    return [{
      datasetId: id,
      xCol: xcol,
      yCol: yname,
      name: yname,
      legendName: `${yname} vs ${METRICS[xMetric]?.label || xMetric} · ${shortLabel(test)}`,
      color,
      mode: 'markers',
    }]
  }, [metrics])

  // Los tres gráficos del experimento, en orden de apilado. La clave es el
  // nombre del grupo en el HDF5, para poder resolver un arrastre suelto.
  // Los de sensor llevan `sensor`: son los que aceptan cambio de métrica y
  // clic en un punto.
  const chartSpecs = useMemo(() => [
    {
      key: 'humidity',
      label: 'Temp/Hum Data',
      species: 'env',
      build: (t, t0) => buildEnvChart(t, t0),
    },
    {
      key: 'uhf',
      label: 'UHF Data',
      sensor: 'uhf',
      species: 'metric',
      color: SENSOR_COLOR.uhf,
      build: (t, t0, metricKey = DEFAULT_METRIC) =>
        buildMetricChart(t, 'uhf', t0, SENSOR_COLOR.uhf, metricKey),
    },
    {
      key: 'ae',
      label: 'AE Data',
      sensor: 'ae',
      species: 'metric',
      color: SENSOR_COLOR.ae,
      build: (t, t0, metricKey = DEFAULT_METRIC) =>
        buildMetricChart(t, 'ae', t0, SENSOR_COLOR.ae, metricKey),
    },
  ], [buildEnvChart, buildMetricChart])

  const patchCard = useCallback((id, p) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)))
  }, [])

  // Arrastrar el experimento: los tres gráficos como bloque contiguo y
  // sincronizado. Las tarjetas aparecen ya, en carga, y se rellenan al llegar
  // sus datos; un fallo en una no arrastra a las demás.
  const dropExperiment = useCallback(async (test, at) => {
    const shortDate = shortLabel(test)
    const x = snap(at.x)
    const y0 = snap(at.y)
    const width = CARD_DEFAULT.width
    const height = 224 // múltiplo de GRID: el apilado sigue cuadrando al soltar
    const ids = chartSpecs.map(() => nextCardId())
    const scatterIds = SCATTER_SENSORS.map(() => nextCardId())
    // `groupId` es el bloque geométrico (los tres apilados: mismo tamaño, misma
    // posición encadenada, mismo zoom del eje X). `experimentId` es más ancho:
    // esos tres más sus scatter, que ni se apilan ni comparten eje pero se
    // cierran con ellos. Arrastrar dos veces el mismo experimento da dos
    // experimentId distintos, y cada copia se cierra por su cuenta.
    const groupId = `grp_${ids[0]}`
    const experimentId = `exp_${ids[0]}`

    setCards((prev) => [
      ...prev,
      ...chartSpecs.map((spec, i) => ({
        id: ids[i],
        title: `${spec.label} · ${shortDate}`,
        domain: 'time',
        species: spec.species,
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${spec.label}…`,
        alignedMargin: true,
        groupId,
        groupIndex: i,
        experimentId,
        test, // para resaltar el experimento en el explorador
        sensor: spec.sensor ?? null,
        metricKey: spec.sensor ? DEFAULT_METRIC : null,
        x,
        y: y0 + i * height,
        width,
        height,
        z: bumpZ(),
      })),
      // Los scatter métrica-vs-métrica van al lado, no en el bloque: su eje X
      // es una métrica, no el tiempo, así que ni se alinean ni comparten zoom
      // con los tres apilados.
      ...SCATTER_SENSORS.map((s, i) => ({
        id: scatterIds[i],
        title: `${s.label} · scatter · ${shortDate}`,
        domain: 'metric',
        species: 'scatter',
        kind: 'metricScatter',
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${s.label} scatter…`,
        experimentId, // satélite: se cierra con el bloque, pero no al revés
        test,
        sensor: s.sensor,
        xMetric: DEFAULT_SCATTER.x,
        yMetric: DEFAULT_SCATTER.y,
        x: x + width + GRID,
        y: y0 + i * (height + GRID + 96),
        width,
        height: height + 96,
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

    await Promise.all([
      ...chartSpecs.map((spec, i) =>
        spec
          .build(test, info.t0)
          .then((series) => patchCard(ids[i], { loading: false, xRange, series, t0: info.t0 }))
          .catch((e) => fail(ids[i], e?.message || 'failed')),
      ),
      ...SCATTER_SENSORS.map((s, i) =>
        buildScatterChart(test, s.sensor, DEFAULT_SCATTER.x, DEFAULT_SCATTER.y, s.color)
          .then((series) => patchCard(scatterIds[i], { loading: false, series, t0: info.t0 }))
          .catch((e) => fail(scatterIds[i], e?.message || 'failed')),
      ),
    ])
  }, [chartSpecs, buildScatterChart, patchCard])

  // Arrastrar un grupo suelto: exactamente el mismo gráfico que aporta al
  // bloque, con el mismo origen de tiempo y el mismo rango, pero solo.
  const dropSensorChart = useCallback(async (test, groupName, at) => {
    const spec = chartSpecs.find((c) => c.key === groupName)
    if (!spec) throw new Error(`No chart defined for "${groupName}"`)

    const shortDate = shortLabel(test)
    const id = nextCardId()

    setCards((prev) => [
      ...prev,
      {
        id,
        title: `${spec.label} · ${shortDate}`,
        domain: 'time',
        species: spec.species,
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${spec.label}…`,
        alignedMargin: true,
        test,
        sensor: spec.sensor ?? null,
        metricKey: spec.sensor ? DEFAULT_METRIC : null,
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
      patchCard(id, { loading: false, xRange: [0, info.durationS], series, t0: info.t0 })
    } catch (err) {
      patchCard(id, { loading: false, error: err?.message || 'failed' })
    }
  }, [chartSpecs, patchCard])

  // Cambiar la métrica de un eje. Las 12 están en el sidecar, así que esto es
  // leer otra columna: no se recalcula nada ni se toca el master. Descartar y
  // cambiar de métrica son independientes — la exclusión guarda índices de
  // señal, así que sigue valiendo con otros ejes.
  // Cambiar un eje reconstruye TODAS las series de la tarjeta, cada una contra
  // su propio experimento y sensor. Fusionar dos scatter da un scatter —misma
  // naturaleza—, así que conserva sus desplegables: los ejes son de la tarjeta
  // y las series son lo que se compara en ellos.
  const changeMetric = useCallback(async (cardId, axis, metricKey) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card?.sensor) return

    const isScatter = card.kind === 'metricScatter'
    const current = isScatter ? (axis === 'x' ? card.xMetric : card.yMetric) : card.metricKey
    if (current === metricKey) return

    const xMetric = axis === 'x' ? metricKey : card.xMetric
    const yMetric = axis === 'y' ? metricKey : card.yMetric

    const old = card.series
    patchCard(cardId, { loading: true, loadingLabel: `${METRICS[metricKey]?.label || metricKey}…` })
    try {
      const replaced = []
      const series = await Promise.all(old.map(async (s) => {
        const meta = getDataset(s.datasetId)?.meta
        // Lo que no está indexado por señal no es una métrica y no se toca: en
        // una tarjeta que mezcle ambiental con métricas, la humedad sigue ahí.
        if (!meta?.perSignal) return s

        const test = meta.test ?? card.test
        const sensor = meta.sensor ?? card.sensor
        const [built] = isScatter
          ? await buildScatterChart(test, sensor, xMetric, yMetric, s.color)
          : await buildMetricChart(
              test,
              sensor,
              meta.t0 ?? card.t0 ?? (await hdf5.experimentT0(test)).t0,
              s.color,
              metricKey,
            )
        replaced.push(s.datasetId)
        // El color y el eje son de la serie, no de la métrica: sobreviven al
        // cambio, que si no una fusión recolocada perdería sus colores.
        return { ...built, color: s.color, ...(s.axis ? { axis: s.axis } : {}) }
      }))

      patchCard(cardId, {
        loading: false,
        error: null,
        series,
        ...(isScatter ? { xMetric, yMetric } : { metricKey }),
      })
      replaced.forEach((id) => deleteDataset(id))
    } catch (err) {
      patchCard(cardId, { loading: false, error: err?.message || 'failed' })
    }
  }, [buildScatterChart, buildMetricChart, patchCard])

  // --- Tendencia ---------------------------------------------------------------
  // Sólo el interruptor y el nivel de suavizado viven aquí: la curva se calcula
  // en la tarjeta, a partir de los datos ya enmascarados y del tramo visible, y
  // no se guarda en ningún sitio. Es barata de rehacer y depende del zoom, así
  // que almacenarla sólo daría ocasión de que quedara desfasada.
  const toggleTrend = useCallback((cardId) => {
    setCards((prev) => prev.map((c) => (
      c.id === cardId
        ? { ...c, trend: c.trend ? null : { smoothing: DEFAULT_SMOOTHING } }
        : c
    )))
  }, [])

  const setSmoothing = useCallback((cardId, smoothing) => {
    setCards((prev) => prev.map((c) => (
      c.id === cardId && c.trend ? { ...c, trend: { ...c.trend, smoothing } } : c
    )))
  }, [])

  // --- Descarte de señales ----------------------------------------------------
  // La selección es efímera y no pinta nada de React: se guarda en una ref para
  // que arrastrar el lazo no re-renderice el lienzo entero en cada movimiento.
  const selectPoints = useCallback((cardId, byCurve) => {
    if (!byCurve || byCurve.size === 0) selectionRef.current.delete(cardId)
    else selectionRef.current.set(cardId, byCurve)
  }, [])

  // Descartar lo seleccionado. Se resuelve el sensor por la traza, no por la
  // tarjeta, y se acumula sobre lo ya descartado.
  const dropSelection = useCallback((cardId) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    const byCurve = selectionRef.current.get(cardId)
    if (!card || !byCurve || byCurve.size === 0) {
      setError('Select points with the box or lasso tool before dropping them.')
      return
    }

    setExcluded((prev) => {
      const next = { ...prev }
      for (const [curve, indices] of byCurve) {
        const s = card.series[curve]
        const meta = s ? getDataset(s.datasetId)?.meta : null
        const test = meta?.test ?? card.test
        const sensor = meta?.sensor ?? card.sensor
        if (!test || !sensor) continue
        const key = exKey(test, sensor)
        const set = new Set(next[key] || [])
        indices.forEach((i) => set.add(i))
        next[key] = set // Set nuevo: la identidad es lo que dispara el redibujado
      }
      return next
    })
    selectionRef.current.delete(cardId)
  }, [])

  const resetExclusion = useCallback((cardId) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card?.sensor) return
    const key = exKey(card.test, card.sensor)
    setExcluded((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    selectionRef.current.delete(cardId)
  }, [])

  // Máscara de cada serie de una tarjeta: la del sensor al que pertenece su
  // dataset.
  //
  // Sólo se enmascara lo que está indexado POR SEÑAL (`perSignal`), que son los
  // gráficos de métrica. Una tarjeta de señal lleva el mismo test y el mismo
  // sensor en sus metadatos, pero sus filas son muestras: aplicarle la máscara
  // le arrancaba a la forma de onda las muestras cuyo número coincidía con el
  // de una señal descartada, y la señal salía incompleta.
  const masksFor = useCallback((card) => card.series.map((s) => {
    const meta = getDataset(s.datasetId)?.meta
    if (!meta?.perSignal || !meta.test || !meta.sensor) return null
    return excluded[exKey(meta.test, meta.sensor)] || null
  }), [excluded])

  // Clic en un punto del scatter: la señal temporal que hay detrás, en una
  // tarjeta suelta. El índice del punto es el de la señal en el experimento
  // entero —el mismo con el que se escribió el sidecar—, no dentro de un chunk.
  const openSignalAt = useCallback(async (cardId, index, curve = 0) => {
    const card = cardsRef.current.find((c) => c.id === cardId)
    if (!card || !Number.isInteger(index)) return

    // De qué serie salió el punto. Una tarjeta fusionada puede mezclar sensores
    // o experimentos, así que el origen lo dice el dataset de esa traza, no la
    // tarjeta; si no lleva metadatos de sensor, no hay señal que abrir.
    const clicked = card.series[curve]
    const meta = clicked ? getDataset(clicked.datasetId)?.meta : null
    const test = meta?.test ?? card.test
    const sensor = meta?.sensor ?? card.sensor
    if (!test || !sensor) return

    const sensorLabel = sensor.toUpperCase()
    const title = `${sensorLabel} · signal #${index + 1}`
    const id = nextCardId()

    // Cascada desde la tarjeta de origen. Cuenta las que ya salieron de ella:
    // sin esto, clic tras clic las apilaba en el mismo punto y sólo se veía la
    // última. Se reinicia cada 8 para no irse al infinito.
    const born = cardsRef.current.filter((c) => c.fromCardId === card.id).length
    const step = (born % 8) * GRID

    setCards((prev) => [
      ...prev,
      {
        id,
        title,
        domain: 'time',
        species: 'signal',
        series: [],
        source: null,
        loading: true,
        loadingLabel: `${title}…`,
        test,
        fromCardId: card.id,
        x: snap(card.x + card.width + GRID + step),
        y: snap(card.y + step),
        width: CARD_DEFAULT.width,
        height: CARD_DEFAULT.height,
        z: bumpZ(),
      },
    ])

    try {
      const res = await hdf5.readSignalAt(test, sensor, index)
      const xcol = 't (samples)'
      const x = new Float64Array(res.nSamples)
      for (let i = 0; i < res.nSamples; i += 1) x[i] = i * res.dt
      const dsId = nextDatasetId()
      putDataset({
        id: dsId,
        name: title,
        columns: [xcol, title],
        rowCount: res.nSamples,
        data: { [xcol]: x, [title]: res.y },
        meta: { test, sensor, index },
      })
      patchCard(id, {
        loading: false,
        series: [{ datasetId: dsId, xCol: xcol, yCol: title, name: title }],
      })
    } catch (err) {
      patchCard(id, { loading: false, error: err?.message || 'failed' })
    }
  }, [patchCard])

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
            species: 'signal',
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
            species: 'metric',
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
            species: 'env',
            at: pos,
          })
          return
        }

        const res = await hdf5.readSignal(test, path, row, datasetName)
        const xcol = 't (samples)'
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

  // Experimentos con alguna tarjeta viva: el explorador los resalta para que se
  // vea de un vistazo qué está ya en el lienzo.
  const plottedTests = useMemo(
    () => new Set(cards.map((c) => c.test).filter(Boolean)),
    [cards],
  )

  // Grupos con señales descartadas, para marcarlos en el explorador:
  // { "<test>|<sensor>": nº descartadas }. Es estado de la sesión y nada más —
  // el HDF5 se abre en sólo lectura y no se toca nunca.
  const editedGroups = useMemo(() => {
    const m = new Map()
    for (const [key, set] of Object.entries(excluded)) {
      if (set?.size > 0) m.set(key, set.size)
    }
    return m
  }, [excluded])

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
        {cards.map((card) => {
          const masks = masksFor(card)
          return (
          <ChartCard
            key={card.id}
            card={card}
            isMergeTarget={card.id === mergeTargetId}
            masks={masks}
            // Firma estable: el redibujado depende de qué hay descartado, no de
            // la identidad del array que se recrea en cada render.
            maskSig={masks.map((m) => (m ? m.size : 0)).join(',')}
            excludedCount={
              card.sensor ? (excluded[exKey(card.test, card.sensor)]?.size ?? 0) : 0
            }
            onSelectPoints={(byCurve) => selectPoints(card.id, byCurve)}
            onDropSelection={() => dropSelection(card.id)}
            onResetExclusion={() => resetExclusion(card.id)}
            onChange={(patch) => updateCard(card.id, patch)}
            onDragMove={(pos) => cardDragMove(card.id, pos)}
            onDragStop={(pos) => cardDragStop(card.id, pos)}
            onSplit={() => splitCard(card.id)}
            onClose={() => removeCard(card.id)}
            onFocus={() => focusCard(card.id)}
            onContextMenu={(pos) => openCardMenu(card.id, pos)}
            metricKeys={METRIC_KEYS_UI}
            onMetricChange={(axis, key) => changeMetric(card.id, axis, key)}
            onToggleTrend={() => toggleTrend(card.id)}
            onSmoothingChange={(value) => setSmoothing(card.id, value)}
            onPointClick={(index, curve) => openSignalAt(card.id, index, curve)}
          />
          )
        })}
        {source && (
          <DataSourcePanel
            source={source}
            geom={source.geom}
            onChange={updateSourceGeom}
            onClose={closeSource}
            onFocus={focusSource}
            plottedTests={plottedTests}
            editedGroups={editedGroups}
          />
        )}
      </Canvas>

      {empty && !menu && !opening && (
        <div className="hint" aria-hidden="true">
          Click the canvas to begin
        </div>
      )}

      {opening && <div className="hint">opening HDF5…</div>}

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
