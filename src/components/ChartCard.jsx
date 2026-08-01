import { useEffect, useRef } from 'react'
import { Rnd } from 'react-rnd'
import Plotly from 'plotly.js-dist-min'
import { getDataset } from '../state/datasetStore.js'
import { publishAxis, subscribeAxis } from '../state/axisSync.js'
import { snap } from '../constants.js'

// Chart card: draggable + resizable (react-rnd), with a title bar. Data is read
// from the external store by datasetId (never from React state). A ResizeObserver
// on the plot container keeps Plotly in sync with the card size while resizing.
//
// A card holds a list of `series`, each { datasetId, xCol, yCol, name }. This is
// what makes cards mergeable: dropping one card on another concatenates series.

const PALETTE = [
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
}) {
  const plotRef = useRef(null)
  const drawnRef = useRef(false)
  const applyingRef = useRef(false) // evita el bucle al propagar el rango
  const sig = seriesSignature(card.series)

  // Initial draw / redraw when the set of series changes (e.g. after a merge).
  useEffect(() => {
    const el = plotRef.current
    if (!el || card.loading) return

    const traces = card.series.map((s, i) => {
      const ds = getDataset(s.datasetId)
      const color = s.color || PALETTE[i % PALETTE.length]
      const mode = s.mode || 'lines'
      return {
        type: 'scattergl', // WebGL: handles hundreds of thousands of points
        mode,
        name: s.name,
        x: ds ? ds.data[s.xCol] : [],
        y: ds ? ds.data[s.yCol] : [],
        yaxis: s.axis === 'y2' ? 'y2' : 'y',
        ...(mode.includes('lines') ? { line: { width: 1, color } } : {}),
        ...(mode.includes('markers') ? { marker: { size: 3, color } } : {}),
      }
    })

    const xTitle = card.series[0]?.xCol ?? ''
    let unsubscribe = () => {}
    let disposed = false

    Plotly.react(el, traces, baseLayout(theme, xTitle, card), CONFIG).then(() => {
      if (disposed) return
      drawnRef.current = true
      Plotly.Plots.resize(el)

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
  }, [sig, card.loading, card.groupId])

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
      bounds="parent"
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
        className={`card-inner${isMergeTarget ? ' merge-target' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onFocus()
          onContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <div className="card-title">
          <span className="card-meta">
            {card.loading
              ? card.title || 'loading…'
              : `${card.series.length} ${card.series.length === 1 ? 'signal' : 'signals'}` +
                (nPoints ? ` · ${nPoints.toLocaleString()} pts` : '')}
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
