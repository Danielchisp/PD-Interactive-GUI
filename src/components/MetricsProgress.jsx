// Progreso del cálculo de métricas al abrir un HDF5. Se calculan una sola vez
// por archivo, pero son varios minutos sobre cientos de miles de señales, así
// que el avance tiene que ser visible y estimar cuánto falta.

const fmtInt = new Intl.NumberFormat('es-CL')

function eta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m} min ${String(s).padStart(2, '0')} s`
}

export default function MetricsProgress({ state }) {
  if (!state) return null

  const { done, total, test, sensor, phase, startedAt } = state
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0

  const elapsed = (performance.now() - startedAt) / 1000
  const remaining = done > 0 ? (elapsed / done) * (total - done) : Infinity

  const label =
    phase === 'writing'
      ? 'Escribiendo el sidecar…'
      : test
        ? `${sensor?.toUpperCase()} · ${test.replace('Test - ', '').replace(/Z$/, '')}`
        : 'Preparando…'

  return (
    <div className="metrics-progress" role="status" aria-live="polite">
      <div className="mp-head">
        <span className="mp-glyph">∿</span>
        <span className="mp-title">Calculando métricas</span>
        <span className="mp-pct">{pct.toFixed(1)}%</span>
      </div>

      <div className="mp-bar">
        <div
          className={`mp-fill ${phase === 'writing' ? 'mp-indeterminate' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mp-meta">
        <span className="mp-where" title={test || ''}>{label}</span>
        <span className="mp-count">
          {fmtInt.format(done)} / {fmtInt.format(total)} señales
        </span>
      </div>

      <div className="mp-meta mp-dim">
        <span>12 métricas por señal · se guardan una sola vez</span>
        <span>{phase === 'writing' ? '' : `faltan ~${eta(remaining)}`}</span>
      </div>
    </div>
  )
}
