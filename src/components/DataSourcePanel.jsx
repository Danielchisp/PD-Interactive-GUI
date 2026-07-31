import { useCallback, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { hdf5 } from '../hdf5/hdf5Client.js'
import { METRICS } from '../compute/metrics.js'
import { snap } from '../constants.js'

// Source object on the canvas: the open HDF5 becomes a browsable panel.
// Lazy tree Test → chunk → signal. Each signal is draggable; dropping it on the
// canvas plots it (handled by Canvas/App via dataTransfer).

const ROW_H = 22

export default function DataSourcePanel({ source, geom, onChange, onClose, onFocus }) {
  return (
    <Rnd
      className="card"
      size={{ width: geom.width, height: geom.height }}
      position={{ x: geom.x, y: geom.y }}
      bounds="parent"
      minWidth={256}
      minHeight={224}
      dragHandleClassName="ds-title"
      style={{ zIndex: geom.z || 1 }}
      onDragStart={onFocus}
      onResizeStart={onFocus}
      // Free while dragging; snap to the nearest grid lines only on release.
      onDragStop={(e, d) => onChange({ x: snap(d.x), y: snap(d.y) })}
      onResizeStop={(e, dir, refEl, delta, pos) =>
        onChange({
          width: snap(parseInt(refEl.style.width, 10)),
          height: snap(parseInt(refEl.style.height, 10)),
          x: snap(pos.x),
          y: snap(pos.y),
        })
      }
    >
      <div className="card-inner ds-panel">
        <div className="card-title ds-title">
          <span className="ds-glyph">⛃</span>
          <span className="card-name" title={source.fileName}>
            {source.fileName}
          </span>
          <span className="card-meta">{source.tests.length} tests</span>
          <button
            className="card-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            aria-label="Close source"
          >
            ✕
          </button>
        </div>
        <div className="ds-tree">
          {source.tests.map((t) => (
            <TestNode key={t.name} test={t} />
          ))}
        </div>
      </div>
    </Rnd>
  )
}

function TestNode({ test }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState(null)
  const [loading, setLoading] = useState(false)

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && !children && !loading) {
      setLoading(true)
      try {
        const res = await hdf5.testChildren(test.name)
        setChildren(res.items)
      } finally {
        setLoading(false)
      }
    }
  }, [open, children, loading, test.name])

  const shortDate = test.date.replace('Test - ', '').replace(/Z$/, '')

  return (
    <div className="ds-node">
      <button className="ds-row ds-test" onClick={toggle}>
        <Caret open={open} />
        <span className="ds-label" title={test.name}>
          {shortDate}
        </span>
        <span className="ds-count">{test.nChildren} elementos</span>
      </button>
      {open && (
        <div className="ds-children">
          {loading && <div className="ds-hint">cargando estructura…</div>}
          {children &&
            children.map((item) => (
              <ChildGroupNode key={item.name} testName={test.name} item={item} />
            ))}
        </div>
      )}
    </div>
  )
}

function ChildGroupNode({ testName, item }) {
  const [open, setOpen] = useState(false)
  const [selectedMetric, setSelectedMetric] = useState('vmax')

  const toggle = useCallback(() => {
    setOpen((prev) => !prev)
  }, [])

  // Si tiene nSignals > 0 (ej. ae con 12103 o uhf con 89 señales), mostramos lista de señales
  const isSignalMatrix = item.nSignals > 0
  const isHumidityGroup = item.name === 'humidity'

  const draggableProps = isHumidityGroup
    ? {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = 'copy'
          e.dataTransfer.setData(
            'application/x-hdf5-signal',
            JSON.stringify({
              kind: 'humidity',
              test: testName,
              path: item.name,
              datasetName: 'humidity',
              row: 0,
              label: `Humedad (${testName})`,
            }),
          )
        },
      }
    : {}

  return (
    <div className="ds-node">
      <div
        className="ds-row ds-chunk"
        style={{ cursor: isHumidityGroup ? 'grab' : 'pointer', display: 'flex', alignItems: 'center' }}
        {...draggableProps}
      >
        <button
          onClick={toggle}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            padding: 0,
            flex: 1,
            textAlign: 'left',
          }}
        >
          <Caret open={open} />
          <span className="ds-label" style={{ fontWeight: 'bold' }}>
            {item.name}
          </span>
          {isSignalMatrix ? (
            <span className="ds-count">
              {item.nSignals} señales ({item.nSamples} pts)
            </span>
          ) : item.datasets.length > 0 ? (
            <span className="ds-count">{item.datasets.length} vars</span>
          ) : null}
        </button>
      </div>

      {isSignalMatrix && (
        <div
          style={{
            paddingLeft: '22px',
            paddingRight: '10px',
            marginTop: '4px',
            marginBottom: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <select
            value={selectedMetric}
            onChange={(e) => setSelectedMetric(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--panel-2)',
              color: 'var(--text)',
              border: '1px solid var(--line)',
              borderRadius: '4px',
              fontSize: '11px',
              padding: '2px 4px',
              cursor: 'pointer',
            }}
          >
            {Object.entries(METRICS).map(([k, m]) => (
              <option key={k} value={k}>
                {m.label} {m.unit ? `(${m.unit})` : ''}
              </option>
            ))}
          </select>
          <div
            className="ds-signal"
            style={{
              position: 'relative',
              height: 'auto',
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'var(--accent)',
              color: '#06121f',
              fontWeight: 600,
              fontSize: '10px',
              cursor: 'grab',
            }}
            draggable
            onDragStart={(e) => {
              const m = METRICS[selectedMetric]
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData(
                'application/x-hdf5-signal',
                JSON.stringify({
                  kind: 'groupMetric',
                  test: testName,
                  path: item.name,
                  metricKey: selectedMetric,
                  label: `${m.label} · ${item.name.toUpperCase()} (${testName})`,
                }),
              )
            }}
          >
            + Graficar Métrica
          </div>
        </div>
      )}

      {open && (
        <div className="ds-children">
          {isSignalMatrix ? (
            <SignalList
              testName={testName}
              path={item.name}
              count={item.nSignals}
              nSamples={item.nSamples}
            />
          ) : (
            item.datasets.map((dsName) => (
              <DatasetItemNode
                key={dsName}
                testName={testName}
                path={item.name}
                datasetName={dsName}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function DatasetItemNode({ testName, path, datasetName }) {
  const isHumidityGroup = path === 'humidity'
  const label = isHumidityGroup
    ? `Humedad (${testName})`
    : `${path} / ${datasetName}`

  return (
    <div
      className="ds-signal"
      style={{ paddingLeft: '24px' }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData(
          'application/x-hdf5-signal',
          JSON.stringify({
            kind: isHumidityGroup ? 'humidity' : 'signal',
            test: testName,
            path,
            datasetName,
            row: 0,
            label,
          }),
        )
      }}
    >
      <span className="ds-sig-dot" />
      {datasetName}
      {isHumidityGroup && <span className="ds-sig-row"> (serie temporal)</span>}
    </div>
  )
}

// Lista virtualizada para renderizar eficientemente miles de señales (ej. 12,103 señales AE)
function SignalList({ testName, path, count, nSamples }) {
  const [scrollTop, setScrollTop] = useState(0)
  const viewH = Math.min(count * ROW_H, 220)
  const total = count * ROW_H
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4)
  const visible = Math.ceil(viewH / ROW_H) + 8
  const last = Math.min(count, first + visible)

  const rows = []
  for (let i = first; i < last; i += 1) {
    const label = `${path.toUpperCase()} · Medida #${i + 1} (${nSamples} pts)`
    rows.push(
      <div
        key={i}
        className="ds-signal"
        style={{ top: i * ROW_H }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copy'
          e.dataTransfer.setData(
            'application/x-hdf5-signal',
            JSON.stringify({
              test: testName,
              path,
              datasetName: 'data',
              row: i,
              label,
            }),
          )
        }}
      >
        <span className="ds-sig-dot" />
        {path} #${i + 1}
        <span className="ds-sig-row">índice {i}</span>
      </div>,
    )
  }

  return (
    <div
      className="ds-signals"
      style={{ height: viewH }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: total, position: 'relative' }}>{rows}</div>
    </div>
  )
}

function Caret({ open }) {
  return <span className={`ds-caret ${open ? 'open' : ''}`}>▸</span>
}
