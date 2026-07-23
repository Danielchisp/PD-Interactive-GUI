import { useEffect, useRef } from 'react'
import { Rnd } from 'react-rnd'
import Plotly from 'plotly.js-dist-min'
import { getDataset } from '../state/datasetStore.js'
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
  return series.map((s) => `${s.datasetId}|${s.xCol}|${s.yCol}`).join(',')
}

function baseLayout(theme, xTitle) {
  const t = THEME[theme] || THEME.dark
  // No gridlines and no zero lines (per design): just the axis ticks/labels.
  return {
    autosize: true,
    paper_bgcolor: t.paper,
    plot_bgcolor: t.paper,
    font: { color: t.font, family: 'ui-monospace, monospace', size: 11 },
    margin: { l: 48, r: 14, t: 8, b: 34 },
    showlegend: true,
    legend: { orientation: 'h', y: -0.18, font: { size: 10 } },
    xaxis: {
      showgrid: false,
      zeroline: false,
      title: { text: xTitle, font: { size: 10 } },
    },
    yaxis: { showgrid: false, zeroline: false },
  }
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
  const sig = seriesSignature(card.series)

  // Initial draw / redraw when the set of series changes (e.g. after a merge).
  useEffect(() => {
    const el = plotRef.current
    if (!el) return

    const traces = card.series.map((s, i) => {
      const ds = getDataset(s.datasetId)
      return {
        type: 'scattergl', // WebGL: handles hundreds of thousands of points
        mode: 'lines',
        name: s.name,
        x: ds ? ds.data[s.xCol] : [],
        y: ds ? ds.data[s.yCol] : [],
        line: { width: 1, color: PALETTE[i % PALETTE.length] },
      }
    })

    const xTitle = card.series[0]?.xCol ?? ''
    Plotly.react(el, traces, baseLayout(theme, xTitle), CONFIG).then(() => {
      drawnRef.current = true
      Plotly.Plots.resize(el)
    })

    return () => {
      Plotly.purge(el)
      drawnRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

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
            {card.series.length} {card.series.length === 1 ? 'signal' : 'signals'}
            {nPoints ? ` · ${nPoints.toLocaleString()} pts` : ''}
          </span>
          {card.series.length > 1 && (
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
        {isMergeTarget && <div className="merge-badge">Merge</div>}
      </div>
    </Rnd>
  )
}
