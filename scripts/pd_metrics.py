"""Las 12 métricas escalares por señal, vectorizadas con NumPy.

Implementación de referencia, equivalente a src/compute/metrics.js
(`computeAllMetrics`). El orden de METRIC_KEYS define las columnas del sidecar
y NO debe cambiarse una vez que hay archivos escritos.

Las dos implementaciones tienen que coincidir: scripts/check_conformance.py
las compara contra un archivo dorado.
"""

import numpy as np

METRIC_KEYS = [
    "rms",
    "vmax",
    "vpp",
    "crest",
    "kurtosis",
    "skewness",
    "risetime",
    "teq",
    "zcr",
    "shannon",
    "energia_j",
    "feq",
]

# Mismas unidades que el registro METRICS de metrics.js. Las adimensionales
# quedan sin atributo `unit`, igual que en el lado JS.
UNITS = {
    "rms": "V",
    "vmax": "V",
    "vpp": "V",
    "risetime": "ns",
    "teq": "µs",
    "shannon": "bits",
    "energia_j": "J",
    "feq": "Hz",
}

SHANNON_BINS = 64
R_OHM = 50.0


def compute_batch(x, fs, r_ohm=R_OHM):
    """Calcula las 12 métricas de un lote de señales.

    x  : (R, N) float, una señal por fila
    fs : frecuencia de muestreo en Hz
    ->  (12, R) float64, filas en el orden de METRIC_KEYS
    """
    x = np.asarray(x, dtype=np.float64)
    rows, n = x.shape
    out = np.zeros((12, rows), dtype=np.float64)
    if n == 0:
        return out

    a = np.abs(x)
    absmax = a.max(axis=1)
    sumsq = np.einsum("ij,ij->i", x, x)
    rms = np.sqrt(sumsq / n)
    safe_rms = np.where(rms == 0, 1e-15, rms)

    mean = x.mean(axis=1)
    d = x - mean[:, None]
    d2 = d * d
    m2 = d2.mean(axis=1)
    m3 = (d2 * d).mean(axis=1)
    m4 = (d2 * d2).mean(axis=1)
    nz = m2 != 0

    # --- ZCR: cambios de signo, con sign(0) tratado como +1 (igual que el JS)
    sg = np.sign(x)
    sg[sg == 0] = 1
    crossings = (sg[:, 1:] != sg[:, :-1]).sum(axis=1)

    # --- teq: dispersión temporal en torno al centroide de energía
    t = np.arange(n, dtype=np.float64) / fs
    ss = np.where(sumsq == 0, 1.0, sumsq)  # evita 0/0; se anula más abajo
    x2 = x * x
    t0 = (x2 @ t) / ss
    dt = t[None, :] - t0[:, None]
    spread = np.einsum("ij,ij->i", dt * dt, x2) / ss
    teq = np.where(sumsq == 0, 0.0, np.sqrt(spread) * 1e6)

    # --- risetime: 10%→90% del flanco que sube hasta el primer pico absoluto.
    # El primer índice global que supera el 90% ya es <= argmax por definición,
    # así que no hace falta recortar la búsqueda como en el bucle de JS.
    with np.errstate(invalid="ignore"):
        i10 = np.argmax(a >= 0.1 * absmax[:, None], axis=1)
        i90 = np.argmax(a >= 0.9 * absmax[:, None], axis=1)
    risetime = np.where(absmax == 0, 0.0, np.maximum(0.0, (i90 - i10) / fs * 1e9))

    # --- Entropía de Shannon sobre un histograma de 64 bins de x/absmax
    shannon = np.zeros(rows)
    ok = absmax != 0
    if ok.any():
        scaled = np.zeros((rows, n))
        scaled[ok] = x[ok] / absmax[ok, None]
        b = ((scaled + 1.0) / 2.0 * SHANNON_BINS).astype(np.int64)
        np.clip(b, 0, SHANNON_BINS - 1, out=b)
        offsets = (np.arange(rows) * SHANNON_BINS)[:, None]
        counts = np.bincount(
            (b + offsets).ravel(), minlength=rows * SHANNON_BINS
        ).reshape(rows, SHANNON_BINS)
        p = counts / n
        with np.errstate(divide="ignore", invalid="ignore"):
            terms = np.where(p > 0, p * np.log2(p), 0.0)
        shannon = np.where(ok, -terms.sum(axis=1) / np.log2(SHANNON_BINS), 0.0)

    # --- feq: DFT de longitud exacta, sin el bin DC (la media ya se quitó)
    spec = np.fft.rfft(d, axis=1)
    power = (spec.real**2 + spec.imag**2)[:, 1:]
    freq = np.fft.rfftfreq(n, 1.0 / fs)[1:]
    den = power.sum(axis=1)
    num = power @ (freq * freq)
    feq = np.where(den == 0, 0.0, np.sqrt(num / np.where(den == 0, 1.0, den)))

    out[0] = rms
    out[1] = absmax
    out[2] = x.max(axis=1) - x.min(axis=1)
    out[3] = absmax / safe_rms
    out[4] = np.where(nz, m4 / np.where(nz, m2 * m2, 1.0) - 3.0, 0.0)
    out[5] = np.where(nz, m3 / np.where(nz, m2, 1.0) ** 1.5, 0.0)
    out[6] = risetime
    out[7] = teq
    out[8] = crossings / (n - 1) if n > 1 else 0.0
    out[9] = shannon
    out[10] = sumsq / (fs * r_ohm)
    out[11] = feq
    return out
