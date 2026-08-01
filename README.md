# PD Interactive GUI

Instrumento web tipo lienzo para análisis de descargas parciales (PD). Es un
instrumento, no un tablero: no emite diagnósticos, su trabajo es hacer barato
*preguntarle cosas a los datos*.

```bash
npm install
npm run dev          # calcula las métricas que falten y levanta la GUI
```

→ http://localhost:5173

---

## Estado actual

| Área | Estado |
|---|---|
| Lectura de HDF5 en el navegador | funcionando (h5wasm + VFS perezoso) |
| 12 métricas por señal | calculadas y validadas contra NumPy |
| CLI de métricas en Python | 55 s para 766.697 señales |
| Explorador de archivos | árbol Test → sensor → señal, con duraciones |
| Vista de experimento | 3 gráficos apilados y sincronizados |
| Operaciones sobre señales | FFT (Welch) |

Rama actual: `file-explorer`.

---

## Cómo se ejecuta

| Script | Qué hace |
|---|---|
| `npm run dev` | Calcula las métricas pendientes (`predev`) y arranca Vite |
| `npm run dev:fast` | Igual, saltándose el cálculo |
| `npm run metrics` | Solo el CLI, con menú interactivo de archivos |
| `npm run metrics:check` | Informa qué falta, sin calcular |
| `npm run conformance` | Verifica que las métricas de JS y Python coinciden |
| `npm run build` | Build de producción |

Requisitos del CLI: `python3` con `numpy` y `h5py`.

---

## Los datos

**Master** (`master_2_filtrado.hdf5`, ~2,8 GB, layout `plano-v1`):

```
/Test - <fecha>/               attrs: fs_uhf=3e9, fs_ae=100e3, date, description
    uhf/  data (n, 3000)  float32   timestamps  triggers  is_baseline
    ae/   data (n, 10000) float32   timestamps  triggers  is_baseline
    humidity/  humidity  temperature  timestamps
```

La frecuencia de muestreo vive en el **grupo de experimento**, un atributo por
sensor. Un grupo sin `fs_<sensor>` se omite en vez de asumir una tasa:
`risetime`, `teq` y `energia_j` dependen de ella y un valor inventado las
falsearía en silencio.

**Sidecar de métricas** (`master_2_filtrado.metrics.h5`, ~49 MB, esquema
`pd-metrics-v1`), generado por el CLI junto al master:

```
/Test - <fecha>/<sensor>/<métrica>    float64[n_signals], gzip
                          attrs del grupo: fs, n_signals, n_samples
```

El master **nunca** se modifica: en el navegador se abre en solo lectura sobre
un `File` inmutable.

---

## Las 12 métricas

`rms`, `vmax`, `vpp`, `crest`, `kurtosis`, `skewness`, `risetime`, `teq`,
`zcr`, `shannon`, `energia_j`, `feq`

Es el subconjunto no redundante de las 22 originales. El orden de
`METRIC_KEYS_12` define las columnas del sidecar y **no debe reordenarse** una
vez que hay archivos escritos.

Unidades: `risetime` en ns, `teq` en µs, el resto en SI. Esas dos escalas se
eligieron pensando en UHF a 3 GHz; en AE a 100 kHz salen números enormes y
conviene revisarlas.

### Dos implementaciones, un contrato

- `scripts/pd_metrics.py` — NumPy vectorizado, es la de referencia
- `src/compute/metrics.js` — respaldo de cero instalación, dentro del worker

`npm run conformance` comprueba que coinciden contra un archivo dorado (10
casos, incluidos bordes: todo cero, constante, pico único, señal rectificada).
Ya cazó un bug real: multiplicar por el recíproco en el histograma de
`shannon` redondea distinto que dividir, y desviaba la entropía 1,6e-4.

`kurtosis` diverge ~5e-8 entre ambas por cancelación en `m4/m2²−3` más suma
secuencial en JS contra pairwise en NumPy. Es inherente, no un bug.

---

## Arquitectura

```
scripts/          CLI de Python: métricas y conformidad
src/
  hdf5/           worker de lectura (h5wasm), cliente y caché del sidecar
  compute/        métricas, FFT, Welch y motor de métricas
  components/     Canvas, ChartCard, DataSourcePanel, Menu, progreso
  state/          datasetStore (datos crudos), axisSync (ejes compartidos)
```

**Los datos crudos viven fuera del estado de React**, en `datasetStore` (un
`Map`). En el estado solo van referencias, metadatos y geometría.

**Lectura perezosa**: `hdf5.worker.js` monta el `File` como nodo de emscripten
con `stream_ops` propios que leen slices con `FileReaderSync` y una caché de
bloques de 512 KB. De 2,8 GB se leen unos pocos MB.

**De dónde salen las métricas en la GUI**: primero `fetch` del sidecar que
sirve el dev server desde la raíz del proyecto; si no está, caché de
IndexedDB; y como último recurso, cálculo en el navegador con barra de
progreso. El frontend nunca calcula una métrica si el sidecar existe.

**FFT de longitud exacta** (`src/compute/fft.js`): mixed-radix Cooley-Tukey con
respaldo Bluestein. Hace falta para `feq` — rellenar N=3000 hasta 4096 desvía
el resultado un 12%.

---

## La interfaz

Clic derecho en el lienzo → **Open HDF5…**

**Explorador**: `Test → UHF Data / AE Data / Temp/Hum Data → señales`. Cada
grupo muestra su duración. Todo arrastrable al lienzo.

**Arrastrar un experimento** genera tres gráficos apilados como un bloque:

1. Temp/Hum — humedad en azul (eje izquierdo), temperatura en rojo (derecho)
2. UHF Data · Vpp — un punto por señal, leído del sidecar
3. AE Data · Vpp — ídem

El bloque se mueve, se redimensiona y hace zoom del eje de tiempo **como una
unidad**. Arrastrar un grupo suelto da exactamente ese mismo gráfico, solo.

**Alineación**: los tres comparten el t=0 del experimento (el mínimo de los
tres grupos) y el mismo rango X. Además reservan el margen del eje secundario
aunque no lo usen: si uno tuviera eje derecho y otro no, sus áreas de trazado
tendrían anchos distintos y el mismo instante caería en píxeles distintos.

**Otras interacciones**: arrastrar una tarjeta sobre otra fusiona sus series
(mismo dominio); `⑃` las separa; clic derecho abre las operaciones del dominio
(hoy, FFT).

---

## Pendiente

- Unidades de `risetime` y `teq` por sensor (ver arriba)
- Zoom vertical no sincronizado entre gráficos del bloque: las escalas son
  incompatibles (% vs 0,15 V vs 3,4 V)
- `kind: 'groupSeries'` (envolvente min/max) sigue en `App.jsx` pero ya no lo
  emite ninguna parte de la UI
- Lienzo infinito con pan y zoom
- Decimación para señales largas; techo de ~8-16 contextos WebGL
- Más operaciones: registrar en `operations.js` y añadir handler en el worker
- Que el proyecto generador emita `fs_<sensor>` y las métricas de origen
