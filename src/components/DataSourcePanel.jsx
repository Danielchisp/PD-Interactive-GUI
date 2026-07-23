import { useCallback, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { hdf5 } from '../hdf5/hdf5Client.js'
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
  const [chunks, setChunks] = useState(null)
  const [loading, setLoading] = useState(false)

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && !chunks && !loading) {
      setLoading(true)
      try {
        const res = await hdf5.chunks(test.name)
        setChunks(res.chunks)
      } finally {
        setLoading(false)
      }
    }
  }, [open, chunks, loading, test.name])

  const shortDate = test.date.replace('Test - ', '').replace(/Z$/, '')

  return (
    <div className="ds-node">
      <button className="ds-row ds-test" onClick={toggle}>
        <Caret open={open} />
        <span className="ds-label" title={test.name}>
          {shortDate}
        </span>
        <span className="ds-count">{test.nChunks} chunks</span>
      </button>
      {open && (
        <div className="ds-children">
          {loading && <div className="ds-hint">loading chunks…</div>}
          {chunks &&
            chunks.map((c) => (
              <ChunkNode key={c.name} testName={test.name} chunk={c} />
            ))}
        </div>
      )}
    </div>
  )
}

function ChunkNode({ testName, chunk }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && !info && !loading) {
      setLoading(true)
      try {
        setInfo(await hdf5.chunkInfo(testName, chunk.name))
      } finally {
        setLoading(false)
      }
    }
  }, [open, info, loading, testName, chunk.name])

  const label = chunk.name.replace('chunk_', '#')

  return (
    <div className="ds-node">
      <button className="ds-row ds-chunk" onClick={toggle}>
        <Caret open={open} />
        <span className="ds-label">{label}</span>
        {info && (
          <span className={`ds-count ${info.isBaseline ? 'is-base' : ''}`}>
            {info.nSignals} sig{info.isBaseline ? ' · base' : ''}
          </span>
        )}
      </button>
      {open && (
        <div className="ds-children">
          {loading && <div className="ds-hint">reading…</div>}
          {info && (
            <SignalList
              testName={testName}
              chunkName={chunk.name}
              count={info.nSignals}
              offset={info.signalOffset}
            />
          )}
        </div>
      )}
    </div>
  )
}

// Virtualized list: only renders visible rows. Handles thousands of signals
// with no DOM cost.
function SignalList({ testName, chunkName, count, offset }) {
  const [scrollTop, setScrollTop] = useState(0)
  const viewH = Math.min(count * ROW_H, 200)
  const total = count * ROW_H
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4)
  const visible = Math.ceil(viewH / ROW_H) + 8
  const last = Math.min(count, first + visible)

  const rows = []
  for (let i = first; i < last; i += 1) {
    const globalIndex = offset + i
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
              chunk: chunkName,
              row: i,
              label: `${chunkName.replace('chunk_', '#')} · sig ${globalIndex}`,
            }),
          )
        }}
      >
        <span className="ds-sig-dot" />
        sig {globalIndex}
        <span className="ds-sig-row">row {i}</span>
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
