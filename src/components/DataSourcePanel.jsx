import { useCallback, useContext, useState } from 'react'
import { Rnd } from 'react-rnd'
import { hdf5 } from '../hdf5/hdf5Client.js'
import { CanvasViewContext } from './Canvas.jsx'
import { snap } from '../constants.js'

// Source object on the canvas: the open HDF5 becomes a browsable panel.
// Lazy tree Test → chunk → signal. Each signal is draggable; dropping it on the
// canvas plots it (handled by Canvas/App via dataTransfer).

const ROW_H = 22

// Nombres de cara al usuario. Las claves son los grupos tal como vienen en el
// HDF5; cualquier otra se muestra con su nombre crudo.
const GROUP_LABELS = {
  uhf: 'UHF Data',
  ae: 'AE Data',
  humidity: 'Temp/Hum Data',
}

export const groupLabelFor = (name) => GROUP_LABELS[name] || name

// El HDF5 devuelve las claves en orden alfabético (ae, humidity, uhf); en la
// UI mandan los sensores. Lo que no esté aquí va después, alfabéticamente.
const GROUP_ORDER = ['uhf', 'ae', 'humidity']

const rankOf = (name) => {
  const i = GROUP_ORDER.indexOf(name)
  return i === -1 ? GROUP_ORDER.length : i
}

function sortGroups(items) {
  return [...items].sort((a, b) => {
    const d = rankOf(a.name) - rankOf(b.name)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
}

// Duración legible del span de un grupo: "2h 14m", "37m 12s", "45s".
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export default function DataSourcePanel({
  source,
  geom,
  onChange,
  onClose,
  onFocus,
  plottedTests = new Set(),
  editedGroups = new Map(),
}) {
  const scale = useContext(CanvasViewContext)

  return (
    <Rnd
      className="card"
      size={{ width: geom.width, height: geom.height }}
      position={{ x: geom.x, y: geom.y }}
      scale={scale}
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
          <span className="card-meta">
            {source.tests.length} tests
            {plottedTests.size > 0 && ` · ${plottedTests.size} en el lienzo`}
          </span>
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
            <TestNode
              key={t.name}
              test={t}
              plotted={plottedTests.has(t.name)}
              editedGroups={editedGroups}
            />
          ))}
        </div>
      </div>
    </Rnd>
  )
}

function TestNode({ test, plotted = false, editedGroups = new Map() }) {
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

  // Cuántas señales lleva descartadas este experimento en total. El árbol nace
  // plegado, así que sin esto el aviso del grupo quedaría escondido justo
  // cuando importa: al volver a un experimento que ya se tocó.
  let editedTotal = 0
  for (const [key, n] of editedGroups) {
    if (key.startsWith(`${test.name}|`)) editedTotal += n
  }

  return (
    <div className="ds-node">
      {/* Arrastrar el experimento entero genera los tres gráficos alineados */}
      <button
        className={`ds-row ds-test${plotted ? ' ds-plotted' : ''}`}
        onClick={toggle}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copy'
          e.dataTransfer.setData(
            'application/x-hdf5-signal',
            JSON.stringify({ kind: 'experiment', test: test.name }),
          )
        }}
        title="Drag to the canvas for the full experiment overview"
      >
        <Caret open={open} />
        <span className="ds-label" title={test.name}>
          {shortDate}
        </span>
        {editedTotal > 0 && <EditedMark count={editedTotal} scope="este experimento" />}
        {plotted && (
          <span className="ds-plotted-dot" title="Graficado en el lienzo" aria-label="graficado" />
        )}
      </button>
      {open && (
        <div className="ds-children">
          {loading && <div className="ds-hint">loading structure…</div>}
          {children &&
            sortGroups(children).map((item) => (
              <ChildGroupNode
                key={item.name}
                testName={test.name}
                item={item}
                edited={editedGroups.get(`${test.name}|${item.name}`) ?? 0}
              />
            ))}
        </div>
      )}
    </div>
  )
}

function ChildGroupNode({ testName, item, edited = 0 }) {
  const [open, setOpen] = useState(false)

  const toggle = useCallback(() => {
    setOpen((prev) => !prev)
  }, [])

  // Con nSignals > 0 (p.ej. AE con 12103 o UHF con 89) se lista cada señal.
  const isSignalMatrix = item.nSignals > 0
  const groupLabel = groupLabelFor(item.name)
  const duration = formatDuration(item.durationS)

  const draggableProps = {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'copy'
      // Un grupo suelto da el mismo gráfico que aporta al bloque del
      // experimento; lo construye el mismo código en App.
      e.dataTransfer.setData(
        'application/x-hdf5-signal',
        JSON.stringify({
          kind: 'sensorChart',
          test: testName,
          path: item.name,
          label: `${groupLabel} (${testName})`,
        }),
      )
    },
  }

  return (
    <div className="ds-node">
      {/* La fila es arrastrable y además despliega, así que el botón va dentro.
          Todo el estilo vive en la hoja: en línea se desviaba de .ds-row y los
          grupos acababan con otra tipografía que el resto del árbol. */}
      <div className="ds-row ds-chunk" {...draggableProps}>
        <button
          className="ds-toggle"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          <Caret open={open} />
          <span className="ds-label">{groupLabel}</span>
          {edited > 0 && <EditedMark count={edited} scope="este grupo" />}
          {duration && <span className="ds-count">{duration}</span>}
        </button>
      </div>

      {open && (
        <div className="ds-children">
          {isSignalMatrix ? (
            <SignalList
              testName={testName}
              path={item.name}
              label={groupLabel}
              count={item.nSignals}
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
    ? `${datasetName} (${testName})`
    : `${groupLabelFor(path)} / ${datasetName}`

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
      {isHumidityGroup && <span className="ds-sig-row"> (time series)</span>}
    </div>
  )
}

// Lista virtualizada, para renderizar miles de señales sin coste (p.ej. 12.103 de AE)
function SignalList({ testName, path, label: groupLabel, count }) {
  const [scrollTop, setScrollTop] = useState(0)
  const viewH = Math.min(count * ROW_H, 220)
  const total = count * ROW_H
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4)
  const visible = Math.ceil(viewH / ROW_H) + 8
  const last = Math.min(count, first + visible)

  const rows = []
  for (let i = first; i < last; i += 1) {
    const label = `${groupLabel} · #${i + 1}`
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
        {`#${i + 1}`}
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

// Marca de "editado en esta sesión". El HDF5 se abre en sólo lectura y no se
// toca nunca: esto es un recorte que vive en memoria y se pierde al recargar.
// El texto lo dice, para que nadie crea que el archivo cambió.
function EditedMark({ count, scope }) {
  const label = `${count.toLocaleString()} ${count === 1 ? 'señal descartada' : 'señales descartadas'}`
  return (
    <span
      className="ds-edited"
      title={`${label} en ${scope}, sólo en esta sesión — el archivo no se modifica`}
      aria-label={label}
    >
      ✂
    </span>
  )
}

function Caret({ open }) {
  return <span className={`ds-caret ${open ? 'open' : ''}`}>▸</span>
}
