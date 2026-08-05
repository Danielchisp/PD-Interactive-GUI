import { useContext, useEffect, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import Plotly from 'plotly.js-dist-min'
import { METRICS } from '../compute/metrics.js'
import {
  CELLS_MAX,
  CELLS_MIN,
  DEFAULT_SMOOTHING,
  SMOOTHING,
  smoothingCells,
  trendCurve,
  trendParams,
} from '../compute/trend.js'
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

// Tonos de serie, en orden fijo. Se asignan por posición y NUNCA se ciclan: el
// color identifica a la serie, así que el 9.º no se genera girando el círculo.
//
// El orden no es decorativo. Validado sobre la superficie del gráfico (--panel,
// #0a0a0c) con el validador de paleta: los ocho pasan separación para daltonismo
// entre contiguos, y los CUATRO PRIMEROS la pasan además entre todos los pares.
// Eso es lo que importa aquí, porque un gráfico de métrica es una nube de puntos
// donde cualquier par de series puede solaparse, no sólo las vecinas de la
// leyenda. Reordenar esta lista invalida esa garantía.
export const PALETTE = [
  '#3987e5', '#c98500', '#d55181', '#008300',
  '#9085e9', '#d95926', '#199e70', '#e66767',
]

// Superficie y tinta del área de trazado, en sintonía con los tokens del CSS.
// Plotly no lee variables CSS, así que los valores se repiten aquí a mano.
const PLOT_THEME = { paper: '#0a0a0c', font: '#c9c9d2' }

// Trazas que aporta la tendencia por cada serie: sólo la curva.
const TREND_TRACES = 1

// Opacidad de la nube cuando hay tendencia encima. Los puntos siguen ahí —se
// pueden clicar y seleccionar para descartar—, sólo ceden el primer plano.
const DIMMED = 0.25

// OKLCH → hex. Es el espacio en el que están definidos los tonos de PALETTE y
// en el que se mide la separación entre ellos; generar un color de reserva en
// HSL daba luminosidades que variaban con el tono y unos salían apagados sobre
// el negro y otros deslumbraban.
function oklchHex(L, C, hueDeg) {
  const h = (hueDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
  return `#${rgb.map((v) => {
    const c = Math.max(0, Math.min(1, v))
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255).toString(16).padStart(2, '0')
  }).join('')}`
}

// Tono de reserva para la serie n.ª más allá de PALETTE.
//
// Es una red de seguridad, no un noveno color de la paleta: se llega aquí sólo
// fusionando más de ocho series en una tarjeta, y a esa altura la identidad ya la
// lleva la leyenda. El ángulo áureo reparte el círculo sin repetir, y la
// luminosidad y la croma quedan fijas dentro de la banda con la que se validó
// PALETTE, así que un tono generado no desentona ni se pierde sobre el negro.
export const spunColor = (n) => oklchHex(0.62, 0.15, (n * 137.508) % 360)

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

// Gráficos desde los que se puede descartar. El modebar se fija visible en vez
// de dejarlo aparecer al pasar por encima: el rectángulo y el lazo son la única
// forma de seleccionar, y escondidos no se encuentran. Se deja tal cual por lo
// demás —para scatter y scattergl ya trae rectángulo, lazo, zoom y pan—: añadir
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

function baseLayout(xTitle, card) {
  const t = PLOT_THEME
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
      title={`${axis.toUpperCase()} axis metric`}
      aria-label={`${axis.toUpperCase()} axis metric`}
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
  onToggleTrend,
  onSmoothingChange,
  onPointClick,
  onSelectPoints,
  onDropSelection,
  onResetExclusion,
  excludedCount = 0,
}) {
  const scale = useContext(CanvasViewContext)

  // Zoom del lienzo una vez quieto.
  //
  // Las trazas `scattergl` pintan en un canvas WebGL, y ese es un mapa de bits
  // de verdad: por mucho que el navegador vuelva a rasterizar el SVG de
  // alrededor, ampliar el canvas lo emborrona. La única salida es redibujarlo a
  // más densidad, y eso es un replot entero — demasiado caro para hacerlo en
  // cada muesca de la rueda, así que se espera a que el gesto termine.
  const [settledScale, setSettledScale] = useState(scale)
  useEffect(() => {
    const id = setTimeout(() => setSettledScale(scale), 200)
    return () => clearTimeout(id)
  }, [scale])

  // Sólo los que de verdad usan WebGL pagan el replot. `rowCount` es anterior a
  // la máscara y a la decimación, así que puede sobrestimar; da igual, sólo
  // decide si vale la pena redibujar.
  const usesGL = card.series.some(
    (s) => (getDataset(s.datasetId)?.rowCount ?? 0) > GL_THRESHOLD,
  )
  const glRatio = usesGL ? Math.max(1, settledScale) : 1
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
  const maskedRef = useRef([]) // por serie: datos enmascarados sin decimar, para la tendencia
  const dataCountRef = useRef(0) // cuántas trazas son datos; de ahí en adelante, tendencia

  // Índice original de un punto: sin filtrado es él mismo; con filtrado, el que
  // dice `keep`.
  //
  // Devuelve null para las trazas de tendencia, que van detrás de las de datos.
  // Sin ese corte, un clic o un lazo que rozara la curva se leería como si fuera
  // un punto de la serie: abriría una señal que no es y descartaría la
  // equivocada.
  const originalIndex = (curve, i) => {
    if (curve >= dataCountRef.current) return null
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

  // El scatter métrica-vs-métrica elige las dos métricas de sus ejes.
  const isScatter = card.kind === 'metricScatter'

  // Desde dónde se puede descartar. Vale cualquier gráfico indexado por señal,
  // no sólo el scatter: en la métrica contra el tiempo un punto es también una
  // señal, y hay recortes —una racha de ruido en un tramo, la cola del ensayo—
  // que se ven en el tiempo y no en la nube de métrica contra métrica.
  //
  // Lo que cambia entre los dos es el gesto por defecto, no la capacidad: el
  // scatter nace seleccionando, y el de tiempo nace haciendo zoom, que es como
  // se lee (y va sincronizado con el resto del bloque). En ése hay que coger el
  // rectángulo del modebar, que por eso queda siempre visible.
  const canSelect = isMetricChart

  // La tendencia sólo tiene sentido donde el eje X es tiempo: en el scatter
  // métrica-vs-métrica el X es otra métrica y "suavizar en el tiempo" no
  // significa nada.
  const canTrend = card.species === 'metric'
  const trendOn = canTrend && !!card.trend
  const smoothing = card.trend?.smoothing ?? DEFAULT_SMOOTHING
  const cells = smoothingCells(smoothing)

  // El suavizado se lee desde una ref dentro del efecto de dibujo, no desde su
  // clausura. Así moverlo NO está en las dependencias del efecto: cambiarlo
  // recalcula la curva y hace un restyle, en lugar de reconstruir el gráfico
  // entero — que es lo que haría inservible un deslizador en vivo.
  const smoothingRef = useRef(smoothing)
  smoothingRef.current = smoothing
  const retrendRef = useRef(null) // rehace la tendencia sobre el último rango

  // Initial draw / redraw when the set of series changes (e.g. after a merge).
  useEffect(() => {
    const el = plotRef.current
    if (!el || card.loading) return

    const keeps = []
    const fulls = []
    const masked = []
    const colors = []
    const traces = card.series.map((s, i) => {
      const ds = getDataset(s.datasetId)
      const color = s.color || PALETTE[i % PALETTE.length]
      colors[i] = color
      const mode = s.mode || 'lines'
      const { x, y, keep } = applyMask(
        ds ? ds.data[s.xCol] : [],
        ds ? ds.data[s.yCol] : [],
        masksRef.current[i],
      )
      keeps[i] = keep
      // Sin decimar y ya enmascarado: es de aquí de donde come la tendencia, así
      // que respeta lo descartado y no ve una envolvente recortada.
      masked[i] = { x, y }

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
        ...(trendOn ? { opacity: DIMMED } : {}),
        ...(mode.includes('lines') ? { line: { width: 1, color } } : {}),
        ...(mode.includes('markers') ? { marker: { size: 3, color } } : {}),
      }
    })
    keepRef.current = keeps
    fullRef.current = fulls
    maskedRef.current = masked
    dataCountRef.current = traces.length

    // --- Tendencia ------------------------------------------------------------
    // Se añade SIEMPRE una traza por serie cuando la tendencia está encendida,
    // aunque salga vacía: los índices de traza tienen que ser estables para que
    // el restyle del zoom sepa a quién escribe.
    if (trendOn) {
      card.series.forEach((s, i) => {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          yaxis: s.axis === 'y2' ? 'y2' : 'y',
          showlegend: false,
          hoverinfo: 'skip',
          x: [],
          y: [],
          line: { width: 2, color: colors[i] },
        })
      })
    }

    const xTitle = card.series[0]?.xCol ?? ''
    let unsubscribe = () => {}
    let disposed = false

    // Span completo de los datos, para cuando el eje está en automático.
    let fullSpan = [Infinity, -Infinity]
    for (const m of masked) {
      if (m.x.length === 0) continue
      if (m.x[0] < fullSpan[0]) fullSpan[0] = m.x[0]
      if (m.x[m.x.length - 1] > fullSpan[1]) fullSpan[1] = m.x[m.x.length - 1]
    }
    if (!Number.isFinite(fullSpan[0])) fullSpan = [0, 0]

    // Recalcula la tendencia para el tramo visible. Se recalcula al hacer zoom
    // sólo para volver a muestrear la rejilla dentro de lo que se ve; el
    // suavizado se mide siempre contra el span COMPLETO de los datos, así que
    // la curva es la misma esté como esté el eje y acercarse la amplía en lugar
    // de cambiarla. Son tres pasadas O(n) — unos pocos ms en el peor caso
    // real—, así que va en el hilo principal sin worker.
    let lastRange = null
    const applyTrend = (x0, x1) => {
      if (!trendOn || disposed) return
      const from = x0 ?? fullSpan[0]
      const to = x1 ?? fullSpan[1]
      lastRange = [from, to]
      const params = trendParams(from, to, smoothingRef.current, fullSpan[1] - fullSpan[0])
      const ys = []
      const xsOut = []
      const indices = []
      masked.forEach((m, i) => {
        const t = trendCurve(m.x, m.y, params)
        xsOut.push(t ? t.x : [])
        ys.push(t ? t.mid : [])
        indices.push(dataCountRef.current + i * TREND_TRACES)
      })
      if (indices.length > 0) Plotly.restyle(el, { x: xsOut, y: ys }, indices)
    }

    // Modebar fijo donde se puede descartar: es donde hacen falta el rectángulo
    // y el lazo, y donde la barra de título trae el botón para aplicarlo.
    // La densidad del canvas WebGL se multiplica por el zoom del lienzo, para
    // que acercarse no amplíe píxeles sino que redibuje.
    const base = canSelect ? SELECT_CONFIG : CONFIG
    const config = glRatio > 1
      ? { ...base, plotGlPixelRatio: (window.devicePixelRatio || 1) * glRatio }
      : base
    Plotly.react(el, traces, baseLayout(xTitle, card), config).then(() => {
      if (disposed) return
      drawnRef.current = true
      Plotly.Plots.resize(el)

      // Primer trazado de la tendencia: sobre el rango fijado de la tarjeta si
      // lo hay (los del bloque de experimento lo traen), y si no sobre el span
      // completo de los datos.
      applyTrend(card.xRange?.[0], card.xRange?.[1])
      retrendRef.current = () => applyTrend(lastRange?.[0], lastRange?.[1])
      if (trendOn) {
        el.on('plotly_relayout', (ev) => {
          if (!drawnRef.current) return
          if (ev['xaxis.autorange']) applyTrend(fullSpan[0], fullSpan[1])
          else if (ev['xaxis.range[0]'] !== undefined) {
            applyTrend(ev['xaxis.range[0]'], ev['xaxis.range[1]'])
          }
        })
      }

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
        if (canSelect) {
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
      retrendRef.current = null
      Plotly.purge(el) // se lleva también los listeners de plotly
      drawnRef.current = false
    }
    // `smoothing` NO va aquí a propósito: se lee por ref y se aplica con el
    // efecto de abajo, sin reconstruir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, card.loading, card.groupId, isMetricChart, canSelect, maskSig, trendOn, glRatio])

  // Cambiar el suavizado: sólo la curva, sin tocar el resto del gráfico.
  useEffect(() => {
    if (drawnRef.current) retrendRef.current?.()
  }, [smoothing])

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

          {canTrend && !card.loading && (
            <>
              <button
                className={`card-trend${trendOn ? ' on' : ''}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onToggleTrend}
                title={
                  trendOn
                    ? 'Hide the trend line'
                    : 'Time-aware EWMA trend, adapts to the visible range'
                }
                aria-pressed={trendOn}
              >
                ∿ trend
              </button>
              {trendOn && (
                <>
                  <select
                    className="card-metric"
                    value={typeof smoothing === 'number' ? 'custom' : smoothing}
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => onSmoothingChange?.(e.target.value)}
                    title="Trend smoothing"
                    aria-label="Trend smoothing"
                  >
                    {Object.entries(SMOOTHING).map(([key, { label }]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                    {typeof smoothing === 'number' && (
                      <option value="custom" disabled>
                        custom
                      </option>
                    )}
                  </select>
                  {/* Ajuste fino en vivo. En escala logarítmica porque lo que
                      importa es el factor, no la diferencia: de 40 a 60 celdas
                      se ve tanto como de 400 a 600. */}
                  <input
                    className="card-cells"
                    type="range"
                    min={Math.round(Math.log2(CELLS_MIN) * 100)}
                    max={Math.round(Math.log2(CELLS_MAX) * 100)}
                    step={1}
                    value={Math.round(Math.log2(cells) * 100)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      onSmoothingChange?.(Math.round(2 ** (Number(e.target.value) / 100)))
                    }}
                    title="Trend detail: cells across the full run"
                    aria-label="Trend detail in cells"
                  />
                  <span className="card-meta">{cells} cells</span>
                </>
              )}
            </>
          )}

          {canSelect && !card.loading && (
            <>
              <button
                className="card-drop"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onDropSelection}
                title="Drop the selected signals from every metric of this sensor"
              >
                ✂ drop
              </button>
              <button
                className="card-reset"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onResetExclusion}
                disabled={excludedCount === 0}
                title="Restore every dropped signal"
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
