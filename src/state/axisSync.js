// Sincronización del eje de tiempo entre las tarjetas de un mismo grupo.
//
// Los gráficos de un experimento forman un bloque: hacer zoom o pan en el eje
// X de cualquiera de ellos tiene que mover a los demás, o dejan de ser
// comparables (que es justo para lo que se apilan alineados).
//
// Va por un bus pub/sub y no por el estado de React a propósito: el rango de
// los ejes cambia en cada frame durante un pan, y meterlo en el estado
// provocaría un re-render por frame de todas las tarjetas.

const groups = new Map() // groupId -> Set<listener>

export function subscribeAxis(groupId, listener) {
  if (!groupId) return () => {}
  let set = groups.get(groupId)
  if (!set) {
    set = new Set()
    groups.set(groupId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) groups.delete(groupId)
  }
}

// `range` es un par [min, max] o la cadena 'auto' para volver al autorango.
export function publishAxis(groupId, fromId, range) {
  const set = groups.get(groupId)
  if (!set) return
  for (const listener of set) listener(fromId, range)
}
