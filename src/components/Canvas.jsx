import { createContext, useCallback, useEffect, useRef, useState } from 'react'

// Lienzo con desplazamiento y zoom, sin límites laterales.
//
// Dos capas: el *viewport* (fijo, del tamaño de la ventana, recorta y captura
// los eventos) y el *mundo* (transformado), donde viven las tarjetas. Las
// tarjetas guardan coordenadas de mundo y no saben nada del zoom; sólo hay que
// convertir en los dos puntos donde entra una posición de pantalla: el menú y
// el soltar del explorador.
//
// El mundo no tiene extensión declarada: una tarjeta puede irse a coordenadas
// negativas o muy lejanas y sigue siendo alcanzable desplazando el lienzo. No
// está pensado para llenarlo de gráficos, así que no hay reciclado ni índice
// espacial: cada tarjeta es un nodo del DOM, como antes.

const MIN_K = 0.2
const MAX_K = 3
const CLICK_SLOP = 4 // px de tolerancia entre "clic" y "arrastre"

// Cuánto puede cambiar el zoom en UN evento de rueda, como factor.
//
// No se puede escalar `deltaY` y ya: su magnitud depende del ratón, del
// navegador y de `deltaMode` (píxeles, líneas o páginas). Una rueda que manda
// ~1250 px por muesca saltaba del 30 % al 200 % de un solo golpe. Así que el
// delta sólo decide el signo y un peso acotado, y el paso nunca pasa de ±18 %:
// llegar de un extremo al otro son varias muescas, en cualquier dispositivo.
const ZOOM_STEP = 0.18

function wheelFactor(e) {
  const perLine = 16 // px equivalentes de una línea
  const perPage = 400
  const unit = e.deltaMode === 1 ? perLine : e.deltaMode === 2 ? perPage : 1
  const dy = e.deltaY * unit
  if (dy === 0) return 1
  // Peso en [-1, 1]: una muesca normal (~100 px) ya es casi el paso completo.
  const weight = Math.max(-1, Math.min(1, dy / 120))
  return Math.exp(-weight * ZOOM_STEP)
}

// El zoom vive aquí, pero react-rnd lo necesita para convertir los deltas del
// ratón: sin `scale`, arrastrar con zoom 0,5 mueve la tarjeta el doble.
export const CanvasViewContext = createContext(1)

export default function Canvas({ children, onOpenMenu, onDismiss, hasMenu, onDropSignal }) {
  const ref = useRef(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [panning, setPanning] = useState(false)
  const panRef = useRef(null) // { startX, startY, originX, originY, moved }
  const viewRef = useRef(view)
  viewRef.current = view

  // Pantalla → mundo. `rect` es el viewport, que no se mueve.
  const toWorld = useCallback((clientX, clientY) => {
    const rect = ref.current.getBoundingClientRect()
    const { x, y, k } = viewRef.current
    return {
      x: (clientX - rect.left - x) / k,
      y: (clientY - rect.top - y) / k,
    }
  }, [])

  // Zoom centrado en el cursor: el punto del mundo bajo el ratón se queda
  // donde está. Se registra a mano y no pasivo, porque hay que frenar el
  // scroll de la página.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onWheel = (e) => {
      // Dentro de un gráfico manda Plotly (scrollZoom sobre sus ejes).
      if (e.target.closest?.('.card')) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const factor = wheelFactor(e)
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
        if (k === v.k) return v
        const ratio = k / v.k
        return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Arrastrar el fondo desplaza. Un clic sin movimiento sigue abriendo el menú,
  // así que el gesto no se decide al pulsar sino al soltar.
  const onPointerDown = (e) => {
    if (e.target !== ref.current && e.button !== 1) return
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    }
    setPanning(true)
  }

  // Un ratón de 1000 Hz dispara varios `pointermove` por frame; sin coalescer,
  // cada uno provocaba un render que la pantalla nunca llegaba a mostrar.
  const frameRef = useRef(0)
  const onPointerMove = (e) => {
    const p = panRef.current
    if (!p) return
    const dx = e.clientX - p.startX
    const dy = e.clientY - p.startY
    if (!p.moved && Math.hypot(dx, dy) < CLICK_SLOP) return
    p.moved = true
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      setView((v) => ({ ...v, x: p.originX + dx, y: p.originY + dy }))
    })
  }

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  const onPointerUp = (e) => {
    const p = panRef.current
    panRef.current = null
    setPanning(false)
    if (!p || p.moved || e.button !== 0) return
    if (e.target !== ref.current) return

    if (hasMenu) {
      onDismiss()
      return
    }
    const rect = ref.current.getBoundingClientRect()
    const world = toWorld(e.clientX, e.clientY)
    onOpenMenu({
      x: e.clientX - rect.left, // el menú se posiciona en pantalla…
      y: e.clientY - rect.top,
      worldX: world.x, // …pero lo que abra nace en el mundo
      worldY: world.y,
    })
  }

  const handleDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-hdf5-signal')
    if (!raw) return
    e.preventDefault()
    onDropSignal(JSON.parse(raw), toWorld(e.clientX, e.clientY))
  }

  const handleDragOver = (e) => {
    // Allow the drop only when a signal is being dragged.
    if (e.dataTransfer.types.includes('application/x-hdf5-signal')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const resetView = useCallback(() => setView({ x: 0, y: 0, k: 1 }), [])
  const atOrigin = view.x === 0 && view.y === 0 && view.k === 1

  // La rejilla se repite cada casilla, así que desplazarla el resto de la
  // división es indistinguible de desplazarla entera. Eso permite moverla con
  // `transform` (que compone en GPU) en vez de con `background-position`, que
  // repinta el fondo del viewport en cada frame del arrastre.
  const tile = 32 * view.k
  const gridX = ((view.x % tile) + tile) % tile
  const gridY = ((view.y % tile) + tile) % tile

  return (
    <div
      ref={ref}
      className={`canvas${panning ? ' panning' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div
        className="canvas-grid"
        aria-hidden="true"
        style={{
          backgroundSize: `${tile}px ${tile}px`,
          transform: `translate3d(${gridX}px, ${gridY}px, 0)`,
        }}
      />
      <div
        className="canvas-world"
        style={{
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`,
        }}
      >
        <CanvasViewContext.Provider value={view.k}>
          {children}
        </CanvasViewContext.Provider>
      </div>

      {!atOrigin && (
        <button className="canvas-reset" onClick={resetView} title="Volver al origen (100%)">
          {Math.round(view.k * 100)}% · centrar
        </button>
      )}
    </div>
  )
}
