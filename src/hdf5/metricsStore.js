// Persistencia del sidecar de métricas entre sesiones.
//
// El sidecar es un HDF5 real y exportable (ver `downloadSidecar`), pero el
// navegador no puede ir a buscarlo solo al disco junto al master. Para que
// "calcular sólo lo que falte" funcione sin obligar al usuario a elegir un
// archivo cada vez, los mismos bytes se cachean en IndexedDB indexados por
// identidad del master (nombre + tamaño + fecha de modificación).

const DB_NAME = 'pd-metrics'
const STORE = 'sidecars'
const VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

// Identidad del master. lastModified + size distinguen dos archivos con el
// mismo nombre, y detectan que el master fue regenerado (las métricas viejas
// dejarían de corresponder).
export function sidecarKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`
}

export function sidecarName(masterName) {
  return `${masterName.replace(/\.(hdf5|h5|he5)$/i, '')}.metrics.h5`
}

// Sidecar generado por scripts/compute_metrics.py y servido por el dev server
// desde la raíz del proyecto. Es la vía preferente: es un archivo real en el
// directorio, así que no depende del navegador, del puerto ni de que no se
// borren los datos del sitio, y funciona igual en cualquier navegador.
// Devuelve null si no está (404) o si no hay servidor que lo sirva.
export async function fetchSidecar(masterName) {
  try {
    const res = await fetch(`/${encodeURIComponent(sidecarName(masterName))}`, {
      cache: 'no-cache',
    })
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    // El dev server responde el index.html a rutas desconocidas; un HDF5
    // empieza siempre por la firma \x89HDF\r\n\x1a\n.
    const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]
    if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) return null
    return buf
  } catch (e) {
    return null
  }
}

async function tx(mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadSidecar(key) {
  try {
    const v = await tx('readonly', (s) => s.get(key))
    return v || null
  } catch (e) {
    return null // sin IndexedDB (modo privado, cuota): se recalcula y ya
  }
}

export async function saveSidecar(key, bytes) {
  try {
    await tx('readwrite', (s) => s.put(bytes, key))
    return true
  } catch (e) {
    return false
  }
}

export async function clearSidecar(key) {
  try {
    await tx('readwrite', (s) => s.delete(key))
    return true
  } catch (e) {
    return false
  }
}

// Exporta el sidecar como archivo .h5 junto al master (descarga del navegador).
export function downloadSidecar(bytes, masterName) {
  const base = masterName.replace(/\.(hdf5|h5)$/i, '')
  const blob = new Blob([bytes], { type: 'application/x-hdf5' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.metrics.h5`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
