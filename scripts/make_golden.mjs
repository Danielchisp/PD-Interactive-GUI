// Genera el archivo dorado de conformidad a partir de la implementación JS
// (src/compute/metrics.js), que es la que valida el navegador.
//
// Sólo hay que volver a ejecutarlo si cambia la DEFINICIÓN de alguna métrica:
//   node scripts/make_golden.mjs
// Después, scripts/check_conformance.py comprueba que la de Python coincide.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { METRIC_KEYS_12, computeAllMetrics } from '../src/compute/metrics.js'

// PRNG determinista (mulberry32) para que el dorado sea reproducible.
function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Casos que ejercitan tanto el régimen normal como los bordes donde las
// fórmulas se degradan: señal nula, constante, un solo pico, rectificada.
function makeCases() {
  const cases = []
  const N = 512
  const r = rng(12345)

  const push = (name, fs, build) => {
    const y = new Float32Array(N)
    build(y)
    cases.push({ name, fs, y: Array.from(y) })
  }

  push('ruido', 1e6, (y) => { for (let i = 0; i < N; i++) y[i] = r() * 2 - 1 })
  push('tono', 1e6, (y) => { for (let i = 0; i < N; i++) y[i] = Math.sin(i * 0.21) })
  push('tono+ruido', 1e6, (y) => {
    for (let i = 0; i < N; i++) y[i] = Math.sin(i * 0.07) + 0.3 * (r() * 2 - 1)
  })
  push('pulso amortiguado', 3e9, (y) => {
    for (let i = 0; i < N; i++) y[i] = Math.exp(-i / 40) * Math.sin(i * 0.9)
  })
  push('rectificada', 3e9, (y) => {
    for (let i = 0; i < N; i++) y[i] = Math.abs(Math.exp(-i / 60) * Math.sin(i * 0.5))
  })
  push('con offset', 1e5, (y) => { for (let i = 0; i < N; i++) y[i] = 5 + 0.1 * r() })
  push('todo cero', 1e6, () => {})
  push('constante', 1e6, (y) => y.fill(2.5))
  push('pico único', 1e6, (y) => { y[100] = 1 })
  push('rampa', 1e5, (y) => { for (let i = 0; i < N; i++) y[i] = i / N })

  return cases
}

const cases = makeCases()
const out = new Float64Array(12)
const golden = cases.map((c) => {
  computeAllMetrics(Float32Array.from(c.y), c.fs, out)
  return { ...c, expected: Array.from(out) }
})

const here = dirname(fileURLToPath(import.meta.url))
const path = join(here, 'golden_metrics.json')
writeFileSync(path, JSON.stringify({ keys: METRIC_KEYS_12, cases: golden }, null, 1))
console.log(`escrito ${path}  (${golden.length} casos × ${METRIC_KEYS_12.length} métricas)`)
