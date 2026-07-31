import { useEffect } from 'react'

// Generic context menu at a point. Items: [{ glyph, label, onClick }].
// Used for both the canvas menu and the per-chart operations menu.
export default function Menu({ x, y, items, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} role="menu">
      {items.map((it) => (
        <button
          key={it.label}
          className="context-item"
          role="menuitem"
          onClick={() => {
            it.onClick()
            onClose()
          }}
        >
          <span className="context-glyph">{it.glyph}</span>
          {it.label}
        </button>
      ))}
    </div>
  )
}
