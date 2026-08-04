// De dónde salen las métricas en la GUI.
//
// De un sitio y sólo uno: el sidecar HDF5 que scripts/compute_metrics.py deja
// junto al master y que el dev server sirve desde la raíz del proyecto. Es un
// archivo real en el directorio, así que no depende del navegador, del puerto
// ni de que no se borren los datos del sitio.
//
// Antes existía además un caché en IndexedDB, necesario mientras el navegador
// calculaba las métricas que faltaran. Ya no calcula: todo se precalcula antes
// de arrancar, y un segundo origen de métricas sólo servía para servir valores
// viejos cuando el sidecar cambiaba.

export function sidecarName(masterName) {
  return `${masterName.replace(/\.(hdf5|h5|he5)$/i, '')}.metrics.h5`
}

// Devuelve null si el sidecar no está (404) o si no hay servidor que lo sirva.
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
