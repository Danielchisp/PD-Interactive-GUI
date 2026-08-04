// Línea de tendencia de una métrica contra el tiempo.
//
// Media móvil con núcleo exponencial de dos colas, evaluada sobre una REJILLA
// TEMPORAL uniforme y atenuada por el soporte. Se calcula en runtime, en el hilo
// principal: son dos recorridos O(n) más la rejilla, muy por debajo de un frame,
// y al rehacerse en cada zoom un viaje al worker sólo añadiría latencia.
//
// Tres decisiones y por qué:
//
// 1. REJILLA, no instantes con datos. Evaluar sólo donde hay puntos deja los
//    silencios sin ninguna muestra, y quien dibuja une el último punto de un
//    grupo con el primero del siguiente: una recta inventada que en datos reales
//    de UHF llegaba a ocupar el 88% del ancho del gráfico. Sobre una rejilla, el
//    silencio tiene muestras propias y se ve como lo que es.
//
// 2. NÚCLEO DE DOS COLAS, no un filtro recursivo. Cada punto pesa
//    exp(−|t − t_i|/tau) alrededor de su instante. Al ser simétrico no hay
//    desfase por construcción, sin necesidad de filtrar ida y vuelta.
//
// 3. SOPORTE EXPLÍCITO. Se lleva la cuenta de W = suma de esos pesos, que es
//    "cuántos puntos efectivos respaldan la estimación aquí". Separar W del
//    nivel N/W es lo que permite distinguir las dos cosas que antes se
//    confundían: cuánto puede mover un punto la estimación (robustez) y cuánto
//    hay que olvidar tras un silencio (memoria). Con un único alpha acotado, un
//    hueco largo se cruzaba con poco olvido y los grupos se contagiaban el nivel
//    unos a otros a través del vacío.

// Cuántas desviaciones se admiten antes de recortar una observación.
//
// La escala es una desviación absoluta media, no una típica; para una normal
// vale ~0,8·sigma, así que K=4 recorta más o menos a 3,2·sigma. Se prefiere pasarse
// de generoso: recortar de menos deja pasar algún pico, recortar de más aplana
// una subida real y eso sí sería mentir.
const K = 4

// Soporte a partir del cual la curva muestra el nivel entero.
//
// Por debajo se atenúa proporcionalmente, así que la tendencia se lee como
// ACTIVIDAD: sin descargas no hay actividad y la línea cae a cero. Un punto
// suelto tras un silencio tiene W=1 y sale al 1/15 de su valor — visible como lo
// que es, un dato aislado, en vez de redefinir el nivel él solo.
const FULL_SUPPORT = 15

// Soporte por debajo del cual se corta la línea: menos de medio punto efectivo.
//
// El corte va por soporte y no por la distancia al punto más cercano. Con un
// umbral en taus, tras un grupo denso la línea se cortaba ANTES de empezar a
// bajar —el soporte era tan alto que aún no había caído nada— y se veía plana y
// luego nada. Atado al soporte, la caída siempre se ve entera: primero baja
// hasta rozar el cero y sólo entonces se interrumpe.
const BREAK_SUPPORT = 0.5

// Muestras de rejilla por celda de resolución. Cuatro bastan para que la caída
// tras un grupo se vea como una curva y no como un escalón.
const GRID_PER_CELL = 4

// Cada nivel parte el tramo visible en `cells` celdas: tau = span / cells. Más
// celdas es una tau más corta y una curva que sigue más de cerca.
export const SMOOTHING = {
  soft: { label: 'smooth', cells: 20 },
  medium: { label: 'medium', cells: 60 },
  hard: { label: 'detailed', cells: 150 },
  fine: { label: 'fine', cells: 400 },
}

export const DEFAULT_SMOOTHING = 'medium'

// Parámetros para un tramo visible. Es lo que hace la tendencia adaptativa: al
// acercarse, el span encoge, tau encoge con él y aparece detalle que la vista
// completa no podía mostrar.
export function trendParams(from, to, smoothing = DEFAULT_SMOOTHING) {
  const s = SMOOTHING[smoothing] || SMOOTHING[DEFAULT_SMOOTHING]
  const span = Math.max(0, to - from)
  return { tau: span > 0 ? span / s.cells : 0, from, to, cells: s.cells }
}

// Acumula el núcleo en un sentido. Devuelve, para cada instante de la rejilla,
// la suma de pesos y la suma ponderada de los valores que le llegan por ese
// lado. Recorre eventos y rejilla a la vez, así que es O(n + m).
//
// `forward` decide el sentido y, con él, qué eventos entran: hacia adelante los
// que están en t_i <= t, hacia atrás los de t_i > t. Así cada punto aporta
// exactamente una vez y con el exponente correcto, sin contarse doble.
function accumulate(xs, ys, values, grid, tau, forward) {
  const m = grid.length
  const n = xs.length
  const W = new Float64Array(m)
  const N = new Float64Array(m)

  let w = 0
  let acc = 0
  let tPrev = forward ? grid[0] : grid[m - 1]
  let j = forward ? 0 : n - 1

  for (let step = 0; step < m; step += 1) {
    const g = forward ? step : m - 1 - step
    const t = grid[g]

    while (
      forward
        ? j < n && xs[j] <= t
        : j >= 0 && xs[j] > t
    ) {
      const dt = Math.abs(xs[j] - tPrev)
      const k = Math.exp(-dt / tau)
      w = w * k + 1
      acc = acc * k + values[j]
      tPrev = xs[j]
      j += forward ? 1 : -1
    }

    // Decaimiento hasta el instante de rejilla, sin tocar el estado: la
    // acumulación sigue desde `tPrev` en el siguiente paso.
    const k = Math.exp(-Math.abs(t - tPrev) / tau)
    W[g] = w * k
    N[g] = acc * k
  }

  return { W, N }
}

// Cuánta masa del núcleo cabe dentro del tramo observado, entre 0,5 y 1.
//
// Corrige el borde. En mitad de la serie el núcleo recibe puntos por los dos
// lados; en el primer instante, sólo por uno, así que el soporte sale a la mitad
// sin que la actividad haya bajado. Sin esto, TODA tendencia empezaba y acababa
// cayendo hacia cero, y una señal constante se desviaba casi un 40% en los
// extremos.
//
// Ojo con la diferencia que justifica que esto no anule el efecto que se busca:
// en un hueco INTERIOR faltan puntos donde sí se estaba observando —eso es
// información, y la línea debe caer—, mientras que fuera del tramo simplemente
// no se miró. Aquí sólo se compensa lo segundo.
function edgeFactor(t, first, last, tau) {
  const left = 1 - Math.exp(-Math.max(0, t - first) / tau)
  const right = 1 - Math.exp(-Math.max(0, last - t) / tau)
  return Math.max(0.5, (left + right) / 2)
}

/**
 * Tendencia de (xs, ys) sobre el tramo [from, to]. `params` viene de
 * `trendParams()`.
 *
 * Devuelve { x, mid } o null. Son arrays normales, no tipados, porque llevan
 * `null` donde la línea se corta — que es como Plotly interrumpe una traza.
 * `mid` es el nivel atenuado por el soporte.
 */
export function trendCurve(xs, ys, params) {
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0)
  const { tau, from, to } = params || {}
  if (n < 2 || !(tau > 0)) return null

  // Rejilla uniforme sobre lo que se ve.
  const m = Math.max(2, Math.round(((to - from) / tau) * GRID_PER_CELL) + 1)
  const grid = new Float64Array(m)
  const step = (to - from) / (m - 1)
  for (let i = 0; i < m; i += 1) grid[i] = from + i * step

  // --- Nivel sin recortar, para tener contra qué medir los atípicos ----------
  const raw = ys
  const f0 = accumulate(xs, ys, raw, grid, tau, true)
  const b0 = accumulate(xs, ys, raw, grid, tau, false)
  const level0 = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    const w = f0.W[i] + b0.W[i]
    level0[i] = w > 0 ? (f0.N[i] + b0.N[i]) / w : 0
  }

  // Dispersión respecto de ese nivel, en la misma escala.
  const devAt = (t) => {
    const i = Math.min(m - 1, Math.max(0, Math.round((t - from) / step)))
    return level0[i]
  }
  const absDev = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    absDev[i] = Number.isFinite(ys[i]) ? Math.abs(ys[i] - devAt(xs[i])) : 0
  }
  const fd = accumulate(xs, ys, absDev, grid, tau, true)
  const bd = accumulate(xs, ys, absDev, grid, tau, false)
  const scale = new Float64Array(m)
  for (let i = 0; i < m; i += 1) {
    const w = fd.W[i] + bd.W[i]
    scale[i] = w > 0 ? (fd.N[i] + bd.N[i]) / w : 0
  }

  // --- Nivel definitivo, recortando cada observación contra el anterior -------
  // El punto sigue dibujado en la nube; sólo se le quita autoridad sobre la
  // línea. Se recorta aquí y no en la primera vuelta porque hasta tenerla no
  // había contra qué comparar.
  const clamped = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    const y = ys[i]
    if (!Number.isFinite(y)) {
      clamped[i] = devAt(xs[i])
      continue
    }
    const s = devAt(xs[i])
    const j = Math.min(m - 1, Math.max(0, Math.round((xs[i] - from) / step)))
    const limit = K * scale[j]
    const diff = y - s
    clamped[i] = limit > 0 && Math.abs(diff) > limit ? s + Math.sign(diff) * limit : y
  }
  const f1 = accumulate(xs, ys, clamped, grid, tau, true)
  const b1 = accumulate(xs, ys, clamped, grid, tau, false)

  // --- Salida: nivel atenuado por el soporte, cortado donde no hay nada -------
  const first = xs[0]
  const last = xs[n - 1]
  const x = new Array(m)
  const mid = new Array(m)

  for (let i = 0; i < m; i += 1) {
    x[i] = grid[i]
    const w = f1.W[i] + b1.W[i]
    if (w < BREAK_SUPPORT) {
      mid[i] = null
      continue
    }
    // `presence` es lo que hace que la curva se lea como actividad: con soporte
    // de sobra vale 1 y la línea marca el nivel real; según se vacía el tramo
    // baja hacia 0 y la línea cae con él. El soporte exigido se corrige en los
    // bordes, donde falta medio núcleo por no haber mirado y no por no haber
    // pasado nada.
    const needed = FULL_SUPPORT * edgeFactor(grid[i], first, last, tau)
    const presence = Math.min(1, w / needed)
    mid[i] = ((f1.N[i] + b1.N[i]) / w) * presence
  }

  return { x, mid }
}
