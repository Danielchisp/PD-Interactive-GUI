import { useRef } from 'react'

// Full-screen canvas. A click on empty space opens the context menu at that
// position. A click on a card never reaches here (the card stops propagation).
export default function Canvas({ children, onOpenMenu, onDismiss, hasMenu, onDropSignal }) {
  const ref = useRef(null)

  const handleClick = (e) => {
    // Only react to clicks on the canvas itself, not on children.
    if (e.target !== ref.current) {
      return
    }
    if (hasMenu) {
      onDismiss()
      return
    }
    const rect = ref.current.getBoundingClientRect()
    onOpenMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handleDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-hdf5-signal')
    if (!raw) return
    e.preventDefault()
    const rect = ref.current.getBoundingClientRect()
    onDropSignal(JSON.parse(raw), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }

  const handleDragOver = (e) => {
    // Allow the drop only when a signal is being dragged.
    if (e.dataTransfer.types.includes('application/x-hdf5-signal')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  return (
    <div
      ref={ref}
      className="canvas"
      onClick={handleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {children}
    </div>
  )
}
