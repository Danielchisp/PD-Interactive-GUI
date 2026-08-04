import { useContext, useEffect, useRef } from 'react'
import { Rnd } from 'react-rnd'
import Plotly from 'plotly.js-dist-min'
import { METRICS } from '../compute/metrics.js'
import { getDataset } from '../state/datasetStore.js'
import { publishAxis, subscribeAxis } from '../state/axisSync.js'
import { CanvasViewContext } from './Canvas.jsx'
import { snap } from '../constants.js'

// Chart card: draggable + resizable (react-rnd), with a title bar. Data is read
// from the external store by datasetId (never from React state). A ResizeObserver
// on the plot container keeps Plotly in sync with the card size while resizing.
//
// A card holds a list of `series`, each { datasetId, xCol, yCol, name }. This is
// what makes cards mergeable: dropping one card on another concatenates series.

export const PALETTE = [
  '#4f9cff', '#ff7ac6', '#5fd68a', '#ffcf5f',
  '#b98cff', '#ff8f5f', '#4fd6d6', '#ff5f7a',
]

const THEME = {
  dark: {
    paper: '#12151c', font: '#c7ccd6', grid: '#232833', zero: '#2c3240',
  },
  light: {
    paper: '#ffffff', font: '#3a4250', grid: '#e6e9ef', zero: '#cdd3dc',
  },
}

const CONFIG = { displaylogo: false, responsive: false, scrollZoom: true }

// A partir de cuántos puntos compensa WebGL.
//
// `scattergl` consume un contexto WebGL por gráfico y el navegador sólo mantiene
// unos 8-16 vivos: al abrir el 17.º, tira el más antiguo y ese gráfico se queda
// en blanco. Abrir señales a golpe de clic llegaba a ese techo enseguida y los
// primeros gráficos del experimento se apagaban.
//
// Una señal son 3.000 (UHF) o 10.000 (AE) muestras dibujadas como UNA línea:
// en SVG eso es un solo `path` y va sobrado. Los que de verdad necesitan WebGL
// son los de métrica, que son cientos de miles de marcadores sueltos, y de esos
// hay un número acotado (cuatro por experimento arrastrado).
const GL_THRESHOLD = 20000

// El scatter nace en modo selección, que es su gesto principal. El modebar se
// deja tal cual —para scattergl ya trae rectángulo, lazo, zoom y pan—: añadir
// botones a mano corre el riesgo de duplicar los que ya venían.
const SELECT_CONFIG = { ...CONFIG, displayModeBar: true }

// Columnas objetivo al decimar. El área de trazado de una tarjeta ronda los
// 500 px, y cada columna aporta hasta dos puntos: son ~5 por píxel, margen de
// sobra para que no se note ni al redimensionar la tarjeta.
const DECIM_TARGET = 1200

// Decimación min/max de un tramo [i0, i1).
//
// Por cada cubo se conservan el mínimo y el máximo, emitidos en el orden en que
// aparecen para que la línea no retroceda. Eso preserva la envolvente exacta —
// ningún pico desaparece, que es lo que sí pasaría muestreando uno de cada N— y
// a una muestra por píxel el resultado es indistinguible del original.
//
// Sólo se aplica a trazas de línea. Una de marcadores (los gráficos de métrica)
// no se decima nunca: ahí cada punto es una señal con la que se puede
// interactuar, y quitar puntos rompería tanto el clic como la selección.
function decimateMinMax(xs, ys, i0, i1, target = DECIM_TARGET) {
  const n = i1 - i0
  if (n <= target * 2) return { x: xs.subarray(i0, i1), y: ys.subarray(i0, i1) }

  // +2: los extremos exactos del tramo. Un cubo aporta su mínimo y su máximo,
  // que casi nunca son la primera ni la última muestra, así que sin esto la
  // línea empezaba y acababa hasta un cubo por dentro del tramo. Son fracciones
  // de píxel, pero una señal temporal tiene que verse entera.
  const x = new Float64Array(target * 2 + 2)
  const y = new Float64Array(target * 2 + 2)
  let at = 0
  x[at] = xs[i0]
  y[at] = ys[i0]
  at += 1

  for (let b = 0; b < target; b += 1) {
    const s = i0 + Math.floor((b * n) / target)
    const e = i0 + Math.floor(((b + 1) * n) / target)
    if (e <= s) continue
    let lo = s
    let hi = s
    for (let i = s + 1; i < e; i += 1) {
      if (ys[i] < ys[lo]) lo = i
      else if (ys[i] > ys[hi]) hi = i
    }
    const first = Math.min(lo, hi)
    const second = Math.max(lo, hi)
    x[at] = xs[first]
    y[at] = ys[first]
    at += 1
    if (second !== first) {
      x[at] = xs[second]
      y[at] = ys[second]
      at += 1
    }
  }

  x[at] = xs[i1 - 1]
  y[at] = ys[i1 - 1]
  at += 1
  return { x: x.subarray(0, at), y: y.subarray(0, at) }
}

// Ventana de índices que cubre [x0, x1] en un eje ascendente, con un punto de
// margen a cada lado para que la línea siga entrando y saliendo del borde.
function rangeToIndices(xs, x0, x1) {
  const search = (target) => {
    let lo = 0
    let hi = xs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[mid] < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const i0 = Math.max(0, search(x0) - 1)
  const i1 = Math.min(xs.length, search(x1) + 1)
  return [i0, i1]
}

// Aplica la máscara de señales descartadas a una serie.
//
// Devuelve además `keep`: el índice ORIGINAL de cada punto dibujado. Es
// imprescindible — en cuanto se descarta algo, el `pointIndex` que reporta
// Plotly es una posición dentro del array filtrado, no el número de señal. Sin
// esta traducción, hacer clic tras un filtrado abriría otra señal, y descartar
// una selección descartaría las equivocadas.
function applyMask(xs, ys, mask) {
  if (!mask || mask.size === 0) return { x: xs, y: ys, keep: null }
  const n = Math.min(xs.length, ys.length)
  const x = new Float64Array(n - mask.size > 0 ? n - mask.size : 0)
  const y = new Float64Array(x.length)
  const keep = new Int32Array(x.length)
  let at = 0
  for (let i = 0; i < n; i += 1) {
    if (mask.has(i)) continue
    if (at >= x.length) break
    x[at] = xs[i]
    y[at] = ys[i]
    keep[at] = i
    at += 1
  }
  return { x: x.subarray(0, at), y: y.subarray(0, at), keep: keep.subarray(0, at) }
}

function seriesSignature(series) {
  return series
    .map((s) => `${s.datasetId}|${s.xCol}|${s.yCol}|${s.axis || 'y'}|${s.color || ''}`)
    .join(',')
}

// Margen reservado al eje secundario. Es un valor fijo (sin `automargin`), así
// que el área de trazado es predecible y se puede igualar entre gráficos.
const Y2_MARGIN = 56

function baseLayout(theme, xTitle, card) {
  const t = THEME[theme] || THEME.dark
  const hasY2 = card.series.some((s) => s.axis === 'y2')

  // Alineación entre gráficos: el margen determina dónde empieza y acaba el
  // área de trazado, no el ancho de la tarjeta. Si uno tiene eje derecho y
  // otro no, sus áreas tienen anchos distintos y el mismo instante cae en
  // píxeles distintos. Las tarjetas de un experimento reservan el hueco del
  // eje secundario aunque no lo usen, así coinciden al píxel — también las
  // sueltas, para que apilar dos a mano dé el mismo resultado.
  const marginR = card.alignedMargin || card.groupId || hasY2 ? Y2_MARGIN : 14

  // No gridlines and no zero lines (per design): just the axis ticks/labels.
  const layout = {
    autosize: true,
    paper_bgcolor: t.paper,
    plot_bgcolor: t.paper,
    font: { color: t.font, family: 'ui-monospace, monospace', size: 11 },
    margin: { l: 56, r: marginR, t: 8, b: 34 },
    showlegend: true,
    legend: { orientation: 'h', y: -0.18, font: { size: 10 } },
    xaxis: {
      showgrid: false,
      zeroline: false,
      title: { text: xTitle, font: { size: 10 } },
    },
    yaxis: { showgrid: false, zeroline: false },
  }

  // Rango fijo: es lo que mantiene alineados varios gráficos del mismo
  // experimento aunque sus series cubran spans distintos.
  if (card.xRange) {
    layout.xaxis.range = [...card.xRange]
  }

  // El scatter se usa sobre todo para seleccionar y descartar, así que ése es
  // su gesto por defecto; zoom y lazo siguen en el modebar.
  if (card.kind === 'metricScatter') {
    layout.dragmode = 'select'
    // Con una sola serie la leyenda sólo roba alto; fusionadas es lo único que
    // dice de qué experimento es cada nube, ahora que se recolorean.
    layout.showlegend = card.series.length > 1
  }

  const yPrimary = card.series.find((s) => s.axis !== 'y2')
  if (yPrimary) {
    layout.yaxis.title = { text: yPrimary.name, font: { size: 10 } }
    if (yPrimary.color) layout.yaxis.color = yPrimary.color
  }

  if (hasY2) {
    const y2 = card.series.find((s) => s.axis === 'y2')
    layout.yaxis2 = {
      overlaying: 'y',
      side: 'right',
      showgrid: false,
      zeroline: false,
      title: { text: y2.name, font: { size: 10 } },
      ...(y2.color ? { color: y2.color } : {}),
    }
  }

  return layout
}

function MetricSelect({ axis, value, keys, onChange }) {
  return (
    <select
      className="card-metric"
      value={value || ''}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange?.(axis, e.target.value)}
      title={`Métrica del eje ${axis.toUpperCase()}`}
      aria-label={`Métrica del eje ${axis.toUpperCase()}`}
    >
      {keys.map((key) => (
        <option key={key} value={key}>
          {axis === 'x' ? 'X: ' : 'Y: '}
          {METRICS[key]?.label || key}
        </option>
      ))}
    </select>
  )
}

export default function ChartCard({
  card,
  theme,
  isMergeTarget,
  onChange,
  onDragMove,
  onDragStop,
  onSplit,
  onClose,
  onFocus,
  onContextMenu,
  metricKeys = [],
  masks = [],
  maskSig = '',
  onMetricChange,
  onPointClick,
  onSelectPoints,
  onDropSelection,
  onResetExclusion,
  excludedCount = 0,
}) {
  const scale = useContext(CanvasViewContext)
  const plotRef = useRef(null)
  const drawnRef = useRef(false)
  const applyingRef = useRef(false) // evita el bucle al propagar el rango
  const sig = seriesSignature(card.series)

  // Los handlers viven en refs: se registran una vez con el gráfico y no
  // obligan a redibujar cada vez que App recrea la función.
  const pointClickRef = useRef(onPointClick)
  pointClickRef.current = onPointClick
  const selectRef = useRef(onSelectPoints)
  selectRef.current = onSelectPoints

  // Máscaras y traducción de índices, leídas dentro del efecto. El efecto se
  // vuelve a lanzar por `maskSig`, no por la identidad de estos arrays.
  const masksRef = useRef(masks)
  masksRef.current = masks
  const keepRef = useRef([]) // por traza: índices originales de lo dibujado
  const fullRef = useRef([]) // por traza: datos sin decimar, para re-decimar al hacer zoom

  // Índice original de un punto: sin filtrado es él mismo; con filtrado, el que
  // dice `keep`.
  const originalIndex = (curve, i) => {
    const keep = keepRef.current[curve]
    if (!keep) return i
    return i >= 0 && i < keep.length ? keep[i] : null
  }

  // Sólo los gráficos de métrica por señal: un punto es una señal, y hay a qué
  // volver. En un gráfico de ambiental o de una señal suelta no significa nada.
  const isMetricChart = !!card.sensor

  // Los ejes son de la tarjeta y las series son lo que se compara en ellos, así
  // que una fusionada conserva sus desplegables: cambiar una métrica reconstruye
  // todas las series, cada una contra su propio experimento y sensor.
  const canPickMetric = isMetricChart

  // El scatter métrica-vs-métrica elige las dos, y es desde donde se filtra.
  const isScatter = card.kind === 'metricScatter'

  // Initial draw / redraw when the set of series changes (e.g. after a merge).
  useEffect(() => {
    const el = plotRef.current
    if (!el || card.loading) return

    const keeps = []
    const fulls = []
    const traces = card.series.map((s, i) => {
      const ds = getDataset(s.datasetId)
      const color = s.color || PALETTE[i % PALETTE.length]
      const mode = s.mode || 'lines'
      const { x, y, keep } = applyMask(
        ds ? ds.data[s.xCol] : [],
        ds ? ds.data[s.yCol] : [],
        masksRef.current[i],
      )
      keeps[i] = keep

      // Sólo líneas: en marcadores cada punto es una señal clicable.
      const decimable = mode === 'lines' && x.length > DECIM_TARGET * 2
      fulls[i] = decimable ? { x, y } : null
      const drawn = decimable ? decimateMinMax(x, y, 0, x.length) : { x, y }

      return {
        type: drawn.x.length > GL_THRESHOLD ? 'scattergl' : 'scatter',
        mode,
        // En la leyenda va el nombre largo (con el experimento); el título del
        // eje se queda con `name`, que si no acabaría arrastrando la fecha.
        name: s.legendName || s.name,
        x: drawn.x,
        y: drawn.y,
        yaxis: s.axis === 'y2' ? 'y2' : 'y',
        ...(mode.includes('lines') ? { line: { width: 1, color } } : {}),
        ...(mode.includes('markers') ? { marker: { size: 3, color } } : {}),
      }
    })
    keepRef.current = keeps
    fullRef.current = fulls

    const xTitle = card.series[0]?.xCol ?? ''
    let unsubscribe = () => {}
    let disposed = false

    // Rectángulo y lazo sólo en el scatter: es el gráfico desde el que se
    // filtra, y es donde hay un botón para aplicar lo seleccionado.
    const config = isScatter ? SELECT_CONFIG : CONFIG
    Plotly.react(el, traces, baseLayout(theme, xTitle, card), config).then(() => {
      if (disposed) return
      drawnRef.current = true
      Plotly.Plots.resize(el)

      // Clic en un punto => la señal que hay detrás. El índice dibujado se
      // traduce al número de señal en el experimento, que es con el que se
      // escribieron el sidecar y los timestamps.
      if (isMetricChart) {
        el.on('plotly_click', (ev) => {
          const pt = ev?.points?.[0]
          // scattergl reporta `pointNumber`; scatter, ambos. El índice es
          // relativo a su traza, así que va con `curveNumber`: en una tarjeta
          // fusionada, la serie clicada puede ser de otro sensor que el resto.
          const i = pt?.pointIndex ?? pt?.pointNumber
          if (typeof i !== 'number') return
          const curve = pt.curveNumber ?? 0
          const original = originalIndex(curve, i)
          if (original === null) return
          pointClickRef.current?.(original, curve)
        })

        // Rectángulo o lazo. Se acumulan por traza porque una selección puede
        // cruzar series de sensores distintos en una tarjeta fusionada, y cada
        // una se descarta contra su propio sensor.
        if (isScatter) {
          el.on('plotly_selected', (ev) => {
            if (!ev?.points) return
            const byCurve = new Map()
            for (const pt of ev.points) {
              const i = pt.pointIndex ?? pt.pointNumber
              if (typeof i !== 'number') continue
              const curve = pt.curveNumber ?? 0
              const original = originalIndex(curve, i)
              if (original === null) continue
              if (!byCurve.has(curve)) byCurve.set(curve, [])
              byCurve.get(curve).push(original)
            }
            selectRef.current?.(byCurve)
          })

          el.on('plotly_deselect', () => selectRef.current?.(new Map()))
        }
      }

      // Al acercarse, se vuelve a decimar sólo el tramo visible: los cubos se
      // reparten sobre menos muestras, así que aparece el detalle que la vista
      // completa no podía mostrar. Sin esto, decimar sería perder resolución
      // para siempre en vez de sólo mientras no hace falta.
      if (fullRef.current.some(Boolean)) {
        el.on('plotly_relayout', (ev) => {
          if (!drawnRef.current) return
          const auto = ev['xaxis.autorange']
          const x0 = ev['xaxis.range[0]']
          if (!auto && x0 === undefined) return // mover, redimensionar, etc.

          const updates = { x: [], y: [] }
          const indices = []
          fullRef.current.forEach((full, i) => {
            if (!full) return
            const [i0, i1] = auto
              ? [0, full.x.length]
              : rangeToIndices(full.x, x0, ev['xaxis.range[1]'])
            const d = decimateMinMax(full.x, full.y, i0, i1)
            updates.x.push(d.x)
            updates.y.push(d.y)
            indices.push(i)
          })
          if (indices.length > 0) Plotly.restyle(el, updates, indices)
        })
      }

      // Eje de tiempo compartido con el resto del grupo. El flag `applying`
      // corta el bucle: aplicar un rango recibido dispara otro plotly_relayout.
      if (!card.groupId) return

      el.on('plotly_relayout', (ev) => {
        if (applyingRef.current) return
        let range
        if (ev['xaxis.autorange']) range = 'auto'
        else if (ev['xaxis.range[0]'] !== undefined) {
          range = [ev['xaxis.range[0]'], ev['xaxis.range[1]']]
        } else return
        publishAxis(card.groupId, card.id, range)
      })

      unsubscribe = subscribeAxis(card.groupId, (fromId, range) => {
        if (fromId === card.id || !drawnRef.current) return
        applyingRef.current = true
        const patch = range === 'auto'
          ? { 'xaxis.autorange': true }
          : { 'xaxis.range': [...range] }
        Plotly.relayout(el, patch).finally(() => {
          applyingRef.current = false
        })
      })
    })

    return () => {
      disposed = true
      unsubscribe()
      Plotly.purge(el) // se lleva también los listeners de plotly
      drawnRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, card.loading, card.groupId, isMetricChart, isScatter, maskSig])

  // Restyle colors when the theme changes (no full redraw needed).
  useEffect(() => {
    const el = plotRef.current
    if (!el || !drawnRef.current) return
    const t = THEME[theme] || THEME.dark
    Plotly.relayout(el, {
      paper_bgcolor: t.paper,
      plot_bgcolor: t.paper,
      'font.color': t.font,
    })
  }, [theme])

  // Keep Plotly filling the container as the card is resized (live).
  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (drawnRef.current) Plotly.Plots.resize(el)
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])

  const nPoints = getDataset(card.series[0]?.datasetId)?.rowCount ?? 0

  return (
    <Rnd
      className="card"
      size={{ width: card.width, height: card.height }}
      position={{ x: card.x, y: card.y }}
      // Sin `bounds`: el lienzo no tiene bordes y una tarjeta puede vivir en
      // coordenadas negativas. `scale` es lo que hace que arrastrar con zoom
      // mueva la tarjeta lo que se ve, y no el doble.
      scale={scale}
      minWidth={288}
      minHeight={192}
      dragHandleClassName="card-title"
      style={{ zIndex: card.z || 1 }}
      onDragStart={onFocus}
      onResizeStart={onFocus}
      onDrag={(e, d) => onDragMove({ x: d.x, y: d.y })}
      // Free while dragging; snap to the nearest grid lines only on release.
      onDragStop={(e, d) => onDragStop({ x: snap(d.x), y: snap(d.y) })}
      onResizeStop={(e, dir, refEl, delta, pos) =>
        onChange({
          width: snap(parseInt(refEl.style.width, 10)),
          height: snap(parseInt(refEl.style.height, 10)),
          x: snap(pos.x),
          y: snap(pos.y),
        })
      }
    >
      <div
        className={`card-inner${isMergeTarget ? ' merge-target' : ''}${
          isMetricChart ? ' card-metric-chart' : ''
        }`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onFocus()
          onContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <div className="card-title">
          {/* Las 12 métricas ya están en el sidecar, así que cambiar un eje es
              leer otra columna: ni recalcula ni toca el master. */}
          {canPickMetric && isScatter && (
            <MetricSelect
              axis="x"
              value={card.xMetric}
              keys={metricKeys}
              onChange={onMetricChange}
            />
          )}
          {canPickMetric && (
            <MetricSelect
              axis="y"
              value={isScatter ? card.yMetric : card.metricKey}
              keys={metricKeys}
              onChange={onMetricChange}
            />
          )}

          {isScatter && !card.loading && (
            <>
              <button
                className="card-drop"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onDropSelection}
                title="Descartar la selección en todas las métricas de este sensor"
              >
                ✂ quitar
              </button>
              <button
                className="card-reset"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onResetExclusion}
                disabled={excludedCount === 0}
                title="Devolver todas las señales descartadas"
              >
                ↺
              </button>
            </>
          )}

          <span className="card-meta">
            {card.loading
              ? card.title || 'loading…'
              : `${card.series.length} ${card.series.length === 1 ? 'signal' : 'signals'}` +
                (nPoints ? ` · ${nPoints.toLocaleString()} pts` : '') +
                (excludedCount ? ` · −${excludedCount.toLocaleString()}` : '')}
          </span>
          {!card.loading && card.series.length > 1 && (
            <button
              className="card-split"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onSplit}
              title="Split into separate charts"
              aria-label="Split card"
            >
              ⑃
            </button>
          )}
          <button
            className="card-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="Close card"
          >
            ✕
          </button>
        </div>
        <div className="card-plot" ref={plotRef} />
        {card.loading && (
          <div className="card-loading" role="status" aria-live="polite">
            <span className="card-spinner" aria-hidden="true" />
            <span className="card-loading-text">{card.loadingLabel || 'loading…'}</span>
          </div>
        )}
        {card.error && !card.loading && (
          <div className="card-loading card-failed" role="alert">
            <span className="card-loading-text">⚠ {card.error}</span>
          </div>
        )}
        {isMergeTarget && <div className="merge-badge">Merge</div>}
      </div>
    </Rnd>
  )
}
