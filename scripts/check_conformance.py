#!/usr/bin/env python3
"""Comprueba que pd_metrics.py (Python) coincide con metrics.js (JS).

Hay dos implementaciones de las mismas 12 métricas —una corre en el navegador
y otra en el CLI— y tienen que dar lo mismo, o un modelo entrenado con features
del CLI se comportará distinto con las del navegador.

El archivo dorado lo genera el lado JS:  node scripts/make_golden.mjs
Aquí sólo se verifica:                   python3 scripts/check_conformance.py
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pd_metrics import compute_batch  # noqa: E402

# Margen por encima del ruido observado. Kurtosis y skewness restan momentos de
# orden alto y sufren cancelación, así que se les da más holgura.
TOL = 1e-9
TOL_BY_KEY = {"kurtosis": 1e-7, "skewness": 1e-9}


def main():
    path = Path(__file__).resolve().parent / "golden_metrics.json"
    if not path.exists():
        print(f"Falta {path.name}. Genéralo con: node scripts/make_golden.mjs")
        return 1

    golden = json.loads(path.read_text())
    keys = golden["keys"]
    failures = []
    worst = {k: 0.0 for k in keys}

    for case in golden["cases"]:
        y = np.asarray(case["y"], dtype=np.float32)[None, :]
        got = compute_batch(y, case["fs"])[:, 0]
        exp = np.asarray(case["expected"], dtype=np.float64)

        for i, key in enumerate(keys):
            a, b = float(got[i]), float(exp[i])
            dev = abs(a - b) / abs(b) if abs(b) > 1e-12 else abs(a - b)
            worst[key] = max(worst[key], dev)
            if dev > TOL_BY_KEY.get(key, TOL) or (np.isnan(a) != np.isnan(b)):
                failures.append((case["name"], key, a, b, dev))

    width = max(len(k) for k in keys)
    for key in keys:
        limit = TOL_BY_KEY.get(key, TOL)
        mark = "OK" if worst[key] <= limit else "ERR"
        print(f"  {mark} {key:<{width}}  desviación máx {worst[key]:.2e}  (límite {limit:.0e})")

    if failures:
        print(f"\n{len(failures)} discrepancia(s):")
        for name, key, a, b, dev in failures[:20]:
            print(f"  [{name}] {key}: python={a!r} js={b!r} dev={dev:.3e}")
        return 1

    print(f"\nConforme: {len(golden['cases'])} casos × {len(keys)} métricas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
