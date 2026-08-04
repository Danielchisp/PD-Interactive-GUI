#!/usr/bin/env python3
"""Calcula las 12 métricas por señal de un HDF5 y las guarda en un sidecar.

Se ejecuta **antes** que la GUI (`npm run dev` lo lanza vía `predev`). Escribe
<master>.metrics.h5 junto al master, con el esquema `pd-metrics-v1` que la GUI
ya sabe leer. El frontend nunca calcula métricas: si el sidecar no está, avisa
y sigue sin ellas.

  python3 scripts/compute_metrics.py              # menú interactivo
  python3 scripts/compute_metrics.py --all        # todo lo pendiente, sin menú
  python3 scripts/compute_metrics.py f.hdf5       # un archivo concreto
  python3 scripts/compute_metrics.py --check      # sólo informa, no calcula

Entiende los dos layouts que produce el generador:

  plano-v1    /<test>/<sensor>/data                    (n, muestras)
  chunks-v2   /<test>/chunk_NNNNNN/<origen>/data       un bloque por chunk

En chunks-v2 los bloques se concatenan en el orden de `chunk_index` para dar un
único vector por test y sensor, igual que en plano-v1: el sidecar tiene la misma
forma sea cual sea el layout de origen, y la GUI no nota la diferencia.

La frecuencia de muestreo sale del atributo `fs_<sensor>` del grupo de
experimento. chunks-v2 no lo escribe, así que se puede suministrar con
`--fs-ae` / `--fs-uhf` o dejándolo en metrics.config.json. Un grupo sin fs por
ninguna de las dos vías se omite en vez de asumir una tasa: risetime, teq y
energia_j dependen de ella. Lo que declare el archivo siempre manda sobre lo
que se pase por fuera.

El master nunca se modifica: se abre en sólo lectura.
"""

import argparse
import json
import multiprocessing as mp
import os
import shutil
import sys
import time
from pathlib import Path

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pd_metrics import METRIC_KEYS, UNITS, compute_batch  # noqa: E402

# La barra de progreso y el menú usan ✓/█/⚠. La consola de Windows es cp1252 y
# los rechaza con UnicodeEncodeError, que además mataba el `predev` entero antes
# de que Vite llegara a arrancar.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

SCHEMA = "pd-metrics-v1"
SENSORS = ["uhf", "ae"]
# De qué subgrupo sale cada sensor dentro de un chunk de chunks-v2.
CHUNK_SOURCES = {"uhf": "signals", "ae": "ae_signals"}
BATCH_SAMPLES = 4_000_000  # ~32 MB por lote en float64
ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "metrics.config.json"


# --- Presentación ------------------------------------------------------------

def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def hms(seconds):
    if not np.isfinite(seconds) or seconds < 0:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}" if m < 60 else f"{m // 60}h{m % 60:02d}m"


class ProgressBar:
    """Barra de progreso en una línea, sin dependencias.

    Se dibuja sobre stderr para no ensuciar la salida si se redirige stdout.
    Si no hay terminal (CI, pipe), imprime hitos sueltos en vez de repintar.
    """

    def __init__(self, total, label=""):
        self.total = max(1, total)
        self.label = label
        self.done = 0
        self.t0 = time.monotonic()
        self.last_draw = 0.0
        self.tty = sys.stderr.isatty()
        self.width = shutil.get_terminal_size((100, 20)).columns
        self.last_milestone = -1

    def update(self, n):
        self.done += n
        now = time.monotonic()
        if self.tty:
            if now - self.last_draw < 0.08 and self.done < self.total:
                return
            self.last_draw = now
            self._draw(now)
        else:
            pct = int(self.done * 100 / self.total)
            milestone = pct - pct % 10
            if milestone > self.last_milestone:
                self.last_milestone = milestone
                el = now - self.t0
                print(f"  {pct:3d}%  {self.done:,}/{self.total:,} señales  ({el:.0f}s)",
                      flush=True)

    def _draw(self, now):
        frac = self.done / self.total
        elapsed = now - self.t0
        rate = self.done / elapsed if elapsed > 0 else 0
        eta = (self.total - self.done) / rate if rate > 0 else float("inf")

        tail = (f" {frac * 100:5.1f}%  {self.done:,}/{self.total:,}"
                f"  {rate / 1000:.1f}k sig/s  ETA {hms(eta)}")
        head = f"{self.label} " if self.label else ""
        bar_w = max(10, self.width - len(head) - len(tail) - 4)
        filled = int(bar_w * frac)
        bar = "█" * filled + "░" * (bar_w - filled)
        sys.stderr.write(f"\r{head}[{bar}]{tail}")
        sys.stderr.flush()

    def close(self):
        if self.tty:
            elapsed = time.monotonic() - self.t0
            sys.stderr.write(
                f"\r{' ' * (self.width - 1)}\r"
                f"  ✓ {self.done:,} señales en {hms(elapsed)}"
                f" ({self.done / max(elapsed, 1e-9) / 1000:.1f}k sig/s)\n"
            )
            sys.stderr.flush()


# --- Inspección --------------------------------------------------------------

def sidecar_path(master: Path) -> Path:
    return master.with_suffix("").with_suffix(".metrics.h5") \
        if master.suffixes[-2:] == [".metrics", ".h5"] \
        else master.parent / (master.stem + ".metrics.h5")


def sidecar_index(path: Path):
    """{(test, sensor): n_signals} de los grupos con las 12 métricas completas."""
    if not path.exists():
        return {}
    index = {}
    try:
        with h5py.File(path, "r") as f:
            for test in f:
                if not isinstance(f[test], h5py.Group):
                    continue
                for sensor in f[test]:
                    g = f[test][sensor]
                    if not isinstance(g, h5py.Group):
                        continue
                    if all(k in g for k in METRIC_KEYS):
                        index[(test, sensor)] = g[METRIC_KEYS[0]].shape[0]
    except OSError:
        return {}
    return index


def chunk_names(g):
    """Chunks de un test, en el orden de `chunk_index` (no el alfabético)."""
    names = [k for k in g if k.startswith("chunk_") and isinstance(g[k], h5py.Group)]
    return sorted(names, key=lambda k: (int(g[k].attrs.get("chunk_index", -1)), k))


def group_pieces(g, test, sensor):
    """Trozos contiguos de un grupo de señal: (ruta, n_filas, offset de salida).

    En plano-v1 sale un solo trozo con todas las filas. En chunks-v2, uno por
    chunk no vacío; el offset acumula para que el vector final quede en orden
    cronológico. Devuelve (pieces, n_signals, n_samples) o None si el sensor no
    está en este test.
    """
    if sensor in g and isinstance(g[sensor], h5py.Group) and "data" in g[sensor]:
        shape = g[sensor]["data"].shape
        if len(shape) != 2:
            return None
        n_signals, n_samples = int(shape[0]), int(shape[1])
        if n_signals == 0:
            return None
        return ([(f"{test}/{sensor}/data", n_signals, 0)], n_signals, n_samples)

    source = CHUNK_SOURCES[sensor]
    pieces, offset, n_samples = [], 0, None
    for name in chunk_names(g):
        sub = g[name]
        if source not in sub or "data" not in sub[source]:
            continue
        shape = sub[source]["data"].shape
        if len(shape) != 2 or shape[0] == 0:
            continue
        rows, samples = int(shape[0]), int(shape[1])
        # Un ancho distinto a mitad de test rompería la matriz de salida; el
        # chunk se omite en vez de recortarlo o rellenarlo en silencio.
        if n_samples is None:
            n_samples = samples
        elif samples != n_samples:
            continue
        pieces.append((f"{test}/{name}/{source}/data", rows, offset))
        offset += rows

    if not pieces:
        return None
    return (pieces, offset, n_samples)


def survey(master: Path, fs_default=None):
    """Estado de un master: grupos pendientes, omitidos y totales.

    `fs_default` es {sensor: hz} para los layouts que no declaran `fs_<sensor>`.
    Sólo se usa cuando el archivo no lo trae: lo escrito en el HDF5 manda.
    """
    fs_default = fs_default or {}
    index = sidecar_index(sidecar_path(master))
    pending, skipped, done = [], [], []
    try:
        with h5py.File(master, "r") as f:
            tests = list(f)
            for test in tests:
                g = f[test]
                if not isinstance(g, h5py.Group):
                    continue
                for sensor in SENSORS:
                    found = group_pieces(g, test, sensor)
                    if found is None:
                        continue
                    pieces, n_signals, n_samples = found
                    declared = g.attrs.get(f"fs_{sensor}")
                    fs = float(declared) if declared is not None else fs_default.get(sensor)
                    item = {"test": test, "sensor": sensor, "n_signals": n_signals,
                            "n_samples": n_samples, "pieces": pieces,
                            "chunked": len(pieces) > 1 or not pieces[0][0].endswith(
                                f"/{sensor}/data"),
                            "fs": None if fs is None else float(fs),
                            "fs_source": "archivo" if declared is not None else "externo"}
                    if fs is None:
                        skipped.append(item)
                    elif index.get((test, sensor)) == n_signals:
                        done.append(item)
                    else:
                        pending.append(item)
    except OSError as e:
        return {"error": str(e), "pending": [], "skipped": [], "done": [], "tests": 0,
                "total_pending": 0}

    return {
        "error": None,
        "tests": len(tests),
        "pending": pending,
        "skipped": skipped,
        "done": done,
        "total_pending": sum(p["n_signals"] for p in pending),
    }


def find_masters(paths):
    out = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            out += sorted(q for q in p.glob("*.hdf5") if ".metrics" not in q.suffixes)
            out += sorted(q for q in p.glob("*.h5") if ".metrics" not in q.name)
        elif p.exists():
            out.append(p)
    # sin duplicados, conservando el orden
    seen, uniq = set(), []
    for p in out:
        r = p.resolve()
        if r not in seen:
            seen.add(r)
            uniq.append(p)
    return uniq


# --- Cálculo -----------------------------------------------------------------

_worker_path = None
_worker_file = None


def _init_worker(path):
    global _worker_path
    _worker_path = path


def _run_task(task):
    """Un lote de filas. Cada proceso abre el HDF5 por su cuenta (spawn en macOS).

    `out` es la columna del vector final donde va el lote: en chunks-v2 no
    coincide con `start`, que es relativo al dataset del chunk.
    """
    global _worker_file
    test, sensor, path, start, end, out, fs = task
    if _worker_file is None:
        _worker_file = h5py.File(_worker_path, "r")
    data = _worker_file[path][start:end]
    return test, sensor, out, compute_batch(data, fs)


def compute_file(master: Path, state, jobs):
    pending = state["pending"]
    if not pending:
        return 0

    tasks = []
    for g in pending:
        step = max(1, BATCH_SAMPLES // max(1, g["n_samples"]))
        for path, rows, offset in g["pieces"]:
            for start in range(0, rows, step):
                end = min(start + step, rows)
                tasks.append((g["test"], g["sensor"], path, start, end,
                              offset + start, g["fs"]))

    cols = {
        (g["test"], g["sensor"]): np.zeros((12, g["n_signals"]), dtype=np.float64)
        for g in pending
    }

    bar = ProgressBar(state["total_pending"], label="  ")
    if jobs > 1:
        ctx = mp.get_context("spawn")
        with ctx.Pool(jobs, initializer=_init_worker, initargs=(str(master),)) as pool:
            for test, sensor, out, block in pool.imap_unordered(_run_task, tasks):
                cols[(test, sensor)][:, out:out + block.shape[1]] = block
                bar.update(block.shape[1])
    else:
        _init_worker(str(master))
        for task in tasks:
            test, sensor, out, block = _run_task(task)
            cols[(test, sensor)][:, out:out + block.shape[1]] = block
            bar.update(block.shape[1])
    bar.close()

    out_path = sidecar_path(master)
    with h5py.File(out_path, "a") as out:
        out.attrs["schema"] = SCHEMA
        out.attrs["metrics"] = ",".join(METRIC_KEYS)
        for g in pending:
            key = (g["test"], g["sensor"])
            grp = out.require_group(f"{g['test']}/{g['sensor']}")
            grp.attrs["fs"] = np.float64(g["fs"])
            grp.attrs["n_signals"] = np.int32(g["n_signals"])
            grp.attrs["n_samples"] = np.int32(g["n_samples"])
            # Queda anotado de dónde salió la fs y de qué layout se leyó: un
            # sidecar con fs suministrada por fuera no debe confundirse con uno
            # cuyo master la declaraba.
            grp.attrs["fs_source"] = g["fs_source"]
            grp.attrs["source_layout"] = "chunks-v2" if g["chunked"] else "plano-v1"
            for m, name in enumerate(METRIC_KEYS):
                if name in grp:
                    del grp[name]
                ds = grp.create_dataset(
                    name, data=cols[key][m], dtype="<f8",
                    chunks=(min(g["n_signals"], 8192),), compression="gzip",
                )
                if name in UNITS:
                    ds.attrs["unit"] = UNITS[name]

    print(f"  → {out_path.name}  ({human(out_path.stat().st_size)})")
    return len(pending)


# --- Menú --------------------------------------------------------------------

def describe(master: Path, state):
    if state["error"]:
        return f"ilegible ({state['error'][:40]})"
    if not state["pending"] and not state["skipped"] and not state["done"]:
        return "sin grupos de señal reconocibles"
    bits = []
    if state["pending"]:
        bits.append(f"{len(state['pending'])} grupos pendientes "
                    f"· {state['total_pending']:,} señales")
    if state["done"]:
        bits.append(f"{len(state['done'])} al día")
    if state["skipped"]:
        sensors = sorted({s["sensor"] for s in state["skipped"]})
        bits.append(f"{len(state['skipped'])} sin fs (pasa --fs-{'/--fs-'.join(sensors)})")
    return " · ".join(bits)


def choose(candidates):
    print("\nArchivos HDF5 encontrados:\n")
    for i, (master, state) in enumerate(candidates, 1):
        size = human(master.stat().st_size)
        mark = " " if state["pending"] else "✓"
        print(f"  {mark} {i}) {master.name}")
        print(f"       {size:>9}   {describe(master, state)}")

    actionable = [i for i, (_, s) in enumerate(candidates, 1) if s["pending"]]
    if not actionable:
        print("\nTodo al día. Nada que calcular.")
        return []

    print(f"\n  a) todos los pendientes ({len(actionable)} archivos)")
    print("  q) salir\n")

    while True:
        try:
            raw = input("Elige [a]: ").strip().lower() or "a"
        except EOFError:
            return [candidates[i - 1] for i in actionable]
        if raw == "q":
            return []
        if raw == "a":
            return [candidates[i - 1] for i in actionable]
        try:
            picks = [int(x) for x in raw.replace(",", " ").split()]
        except ValueError:
            print("  No entendí. Usa números, 'a' o 'q'.")
            continue
        if all(1 <= p <= len(candidates) for p in picks):
            return [candidates[p - 1] for p in picks]
        print(f"  Fuera de rango (1-{len(candidates)}).")


# --- Entrada -----------------------------------------------------------------

def load_fs_config():
    """{sensor: hz} de metrics.config.json, para no repetir --fs en cada corrida.

    Es lo que hace que `npm run dev` precalcule solo, sin flags. Un archivo
    ausente o ilegible no es un error: simplemente no hay fs por defecto y los
    grupos que no la declaren se omiten.
    """
    if not CONFIG.exists():
        return {}
    try:
        raw = json.loads(CONFIG.read_text(encoding="utf-8")).get("fs", {})
    except (json.JSONDecodeError, OSError, AttributeError) as e:
        print(f"  ⚠ {CONFIG.name} ilegible ({e}); se ignora.")
        return {}
    out = {}
    for sensor in SENSORS:
        if raw.get(sensor) is None:
            continue
        try:
            out[sensor] = float(raw[sensor])
        except (TypeError, ValueError):
            print(f"  ⚠ {CONFIG.name}: fs.{sensor} no es un número; se ignora.")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", default=None,
                    help="archivos o directorios (por defecto: raíz del proyecto)")
    ap.add_argument("--all", action="store_true", help="sin menú: todo lo pendiente")
    ap.add_argument("--check", action="store_true", help="sólo informar, no calcular")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    for sensor in SENSORS:
        ap.add_argument(f"--fs-{sensor}", type=float, default=None, metavar="HZ",
                        help=f"fs de {sensor.upper()} para los grupos que no la "
                             f"declaren (por defecto: fs.{sensor} de "
                             f"metrics.config.json)")
    args = ap.parse_args()

    # Prioridad: lo que declare el HDF5 > --fs-<sensor> > metrics.config.json.
    # Las dos últimas se resuelven aquí; la primera, en survey().
    fs_default = load_fs_config()
    for sensor in SENSORS:
        flag = getattr(args, f"fs_{sensor}")
        if flag is not None:
            fs_default[sensor] = flag
    for sensor, hz in sorted(fs_default.items()):
        print(f"  fs_{sensor} = {hz:g} Hz donde el archivo no la declare")

    masters = find_masters(args.paths or [ROOT])
    if not masters:
        print("No se encontró ningún .hdf5.")
        return 0

    candidates = [(m, survey(m, fs_default)) for m in masters]

    if args.check:
        for master, state in candidates:
            print(f"{master.name}: {describe(master, state)}")
        return 0

    interactive = sys.stdin.isatty() and not args.all and len(args.paths or []) != 1
    if interactive:
        selected = choose(candidates)
    else:
        selected = [(m, s) for m, s in candidates if s["pending"]]
        if not selected:
            print("Métricas al día, nada que calcular.")
            return 0

    for master, state in selected:
        print(f"\n{master.name}  ·  {len(state['pending'])} grupos"
              f"  ·  {state['total_pending']:,} señales  ·  {args.jobs} procesos")
        for s in state["skipped"]:
            print(f"  ⚠ {s['test']}/{s['sensor']}: sin fs, omitido "
                  f"(--fs-{s['sensor']} HZ o fs.{s['sensor']} en {CONFIG.name})")
        compute_file(master, state, args.jobs)

    return 0


if __name__ == "__main__":
    sys.exit(main())
