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
| 12 métricas por señal | precalculadas por el CLI; el navegador sólo las lee |
| CLI de métricas en Python | 55 s para 766.697 señales · entiende ambos layouts |
| Explorador de archivos | árbol Test → sensor → señal, con duraciones |
| Vista de experimento | 3 gráficos apilados y sincronizados |
| Operaciones sobre señales | FFT (Welch) |

Rama actual: `file-explorer`.

---

## Cómo se ejecuta

| Script | Qué hace |
|---|---|
| `npm run dev` | Calcula las métricas pendientes (`predev --all`) y arranca Vite |
| `npm run dev:fast` | Igual, saltándose el cálculo |
| `npm run metrics` | Solo el CLI, con menú interactivo de archivos |
| `npm run metrics:check` | Informa qué falta, sin calcular |
| `npm run conformance` | Verifica que las métricas de JS y Python coinciden |
| `npm run build` | Build de producción |

Requisitos del CLI: `python3` con `numpy` y `h5py`.

El cálculo ocurre **siempre antes** de que la GUI exista: `predev` corre con
`--all` (sin menú, porque nadie está mirando) y sólo calcula lo que falte, así
que en un arranque con todo al día cuesta un par de segundos. La fs de los
archivos que no la declaran sale de `metrics.config.json`, para que `npm run
dev` no necesite flags.

---

## Los datos

El generador produce dos layouts y el proyecto entiende los dos.

**`plano-v1`** — un dataset por sensor y test:

```
/Test - <fecha>/               attrs: fs_uhf=3e9, fs_ae=100e3, date, description
    uhf/  data (n, 3000)  float32   timestamps  triggers  is_baseline
    ae/   data (n, 10000) float32   timestamps  triggers  is_baseline
    humidity/  humidity  temperature  timestamps
```

**`chunks-v2`** — un bloque por ventana de adquisición:

```
/Test - <fecha>/               attrs: date, chunk_duration_s, version=2
    chunk_000000/              attrs: chunk_index, signal_offset, ae_signal_offset, …
        signals/     data (n, 3000)   timestamps  triggers     ← uhf
        ae_signals/  data (n, 10000)  timestamps  triggers     ← ae
        humidity/    humidity  temperature  timestamps
    chunk_000001/  …
```

Los chunks se concatenan en el orden de `chunk_index` —no el alfabético— para
dar un vector por test y sensor. El sidecar sale idéntico venga del layout que
venga, así que la GUI no nota la diferencia. Los offsets acumulados coinciden
con los `signal_offset` / `ae_signal_offset` que declara cada chunk; hay una
comprobación de eso en el historial de esta rama.

**Frecuencia de muestreo**: vive en el grupo de experimento, un atributo por
sensor. `chunks-v2` no la escribe, así que se puede suministrar por fuera con
`--fs-uhf` / `--fs-ae` o dejándola en `metrics.config.json`. Lo que declare el
archivo siempre manda sobre lo que se pase por fuera, y el sidecar anota en
`fs_source` de qué vía salió. Un grupo sin fs por ninguna de las dos se omite en
vez de asumir una tasa: `risetime`, `teq` y `energia_j` dependen de ella y un
valor inventado las falsearía en silencio.

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

- `scripts/pd_metrics.py` — NumPy vectorizado, es la que produce los sidecars
- `src/compute/metrics.js` — segunda opinión independiente; ya no corre en la
  GUI (que sólo lee el sidecar), pero sigue viva para la conformidad

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
  hdf5/           worker de lectura (h5wasm), cliente y fetch del sidecar
  compute/        métricas, FFT, Welch y lectura del sidecar
  components/     Canvas, ChartCard, DataSourcePanel, Menu
  state/          datasetStore (datos crudos), axisSync (ejes compartidos)
```

**Los datos crudos viven fuera del estado de React**, en `datasetStore` (un
`Map`). En el estado solo van referencias, metadatos y geometría.

**Lectura perezosa**: `hdf5.worker.js` monta el `File` como nodo de emscripten
con `stream_ops` propios que leen slices con `FileReaderSync` y una caché de
bloques de 512 KB. De 2,8 GB se leen unos pocos MB.

**De dónde salen las métricas en la GUI**: de un sitio y sólo uno, el `fetch`
del sidecar que sirve el dev server desde la raíz del proyecto. **El navegador
no calcula métricas.** Se precalculan todas antes de arrancar (`predev`), y si
al abrir un archivo falta el sidecar la GUI avisa y sigue: explorar y graficar
señales sueltas no depende de las métricas, sólo los gráficos de Vpp se quedan
sin datos.

Antes había una cadena de respaldo —caché de IndexedDB y, si no, cálculo en el
navegador con barra de progreso—. Sobre cientos de miles de señales eran
minutos de pestaña bloqueada y el resultado vivía en un caché que cualquier
limpieza del sitio se llevaba por delante. Un segundo origen de métricas sólo
servía para servir valores viejos cuando el sidecar cambiaba.

**FFT de longitud exacta** (`src/compute/fft.js`): mixed-radix Cooley-Tukey con
respaldo Bluestein. Hace falta para `feq` — rellenar N=3000 hasta 4096 desvía
el resultado un 12%.

**Decimación min/max al dibujar**: una traza de línea de más de 2.400 puntos se
reduce a ~1.200 columnas, conservando el mínimo y el máximo de cada una, más los
dos extremos exactos del tramo. Ningún pico desaparece —eso sí pasaría
muestreando uno de cada N—, la señal empieza y acaba donde de verdad empieza y
acaba, y a una muestra por píxel es indistinguible del original. Al hacer zoom
se vuelve a decimar sólo el tramo visible, así que el detalle aparece al
acercarse en vez de perderse para siempre; por debajo de 2.400 muestras en
pantalla se dibujan las crudas.

**Las trazas de marcadores nunca se deciman.** En un gráfico de métrica cada
punto es una señal con la que se puede interactuar: quitar puntos rompería el
clic y la selección. Sólo se decima lo que es una línea.

---

## La interfaz

Clic derecho en el lienzo → **Open HDF5…**

**Explorador**: `Test → UHF Data / AE Data / Temp/Hum Data → señales`. Cada
grupo muestra su duración. Todo arrastrable al lienzo. Los experimentos que ya
tienen alguna tarjeta viva se resaltan con la barra de acento y un punto, así
que se ve de un vistazo qué está en el lienzo y qué no.

**El lienzo no tiene bordes**: se desplaza arrastrando el fondo y hace zoom con
la rueda (20 %–300 %, centrado en el cursor). Las tarjetas guardan coordenadas
de mundo y pueden vivir en negativo; abajo a la derecha aparece el zoom actual y
un botón para volver al origen. La rueda sobre un gráfico sigue siendo de
Plotly, no del lienzo. No está pensado para llenarlo de gráficos, así que cada
tarjeta es un nodo del DOM y no hay reciclado ni índice espacial.

**Arrastrar un experimento** genera tres gráficos apilados como un bloque, más
dos de dispersión al lado:

1. Temp/Hum — humedad en azul (eje izquierdo), temperatura en rojo (derecho)
2. UHF Data — una métrica por señal contra el tiempo, leída del sidecar
3. AE Data — ídem
4. UHF · dispersión — métrica contra métrica, con las dos elegibles
5. AE · dispersión — ídem

El bloque de los tres se mueve, se redimensiona y hace zoom del eje de tiempo
**como una unidad**. Los de dispersión van aparte porque su eje X es una
métrica, no el tiempo: alinearlos con los demás no significaría nada. Arrastrar
un grupo suelto da exactamente el mismo gráfico de sensor, solo.

**Mover y cerrar** siguen la misma regla (`blockOf`), sobre dos agrupaciones.
`groupId` es el bloque geométrico —los tres apilados, que además comparten
tamaño y zoom del eje X—; `experimentId` es más ancho: esos tres más sus dos
scatter. El bloque es la ventana principal del experimento, así que mover o
cerrar cualquiera de sus tres mueve o cierra las cinco, conservando las
posiciones relativas.

Al revés no, y es deliberado: un scatter se mueve y se cierra solo. Si
arrastrarlo moviera el experimento entero no habría forma de soltarlo sobre otro
para fusionarlos, que es justo lo que hace útil compararlos.

Las señales abiertas a clic no entran en ninguna de las dos cosas — son
exploraciones sueltas que a menudo se quieren conservar. Arrastrar dos veces el
mismo experimento da dos `experimentId`, y cada copia va por su cuenta.

**Descartar señales**: en un scatter se seleccionan puntos con rectángulo o lazo
y `✂ quitar` los descarta; `↺` los devuelve todos. El descarte es por
experimento y sensor, así que quitar en el scatter de UHF quita esas señales de
**todas** las métricas de UHF de ese experimento, incluidas las de otras
tarjetas. Se guardan índices de señal, no posiciones dibujadas, así que el
descarte sobrevive a cambiar de métrica o de par de ejes.

El explorador marca con `✂` los grupos que tienen señales descartadas, y el
experimento acumula el total de los suyos —el árbol nace plegado, así que sin esa
marca en el nodo del test el aviso quedaría escondido justo cuando importa: al
volver a un experimento que ya se tocó—. Va en ámbar y no en rojo a propósito:
**el archivo no cambia**. El master se abre en sólo lectura, el recorte vive en
memoria y se pierde al recargar; el tooltip lo dice explícitamente.

Ese es también el motivo de que cada traza lleve un mapa `keep` con el índice
original de cada punto dibujado: en cuanto hay algo descartado, el `pointIndex`
que reporta Plotly es una posición dentro del array filtrado. Sin traducirlo,
un clic tras filtrar abriría otra señal y una selección descartaría las
equivocadas — las dos formas de fallar en silencio que tiene esto.

**Métricas de los ejes**: los gráficos de sensor llevan un desplegable con las
12 para el eje Y; los de dispersión, uno por eje. Cambiarlas es leer otra
columna del sidecar —no se calcula nada—. Arrancan en `vpp` contra el tiempo y
en `vpp` contra `kurtosis`.

**Una tarjeta fusionada conserva sus desplegables.** Fusionar dos scatter da un
scatter: misma naturaleza. Los ejes son de la tarjeta y las series son lo que se
compara en ellos, así que cambiar una métrica reconstruye **todas** las series,
cada una contra su propio experimento y sensor, conservando color y eje. Lo que
no está indexado por señal no se toca: en una tarjeta que mezcle ambiental con
métricas, la humedad se queda como está.

Por eso el dataset de una métrica guarda su `t0`. Al fusionar dos experimentos
cada serie conserva el suyo; sin él, reconstruir una serie ajena la referiría al
origen de tiempo del otro experimento y quedaría desplazada.

**Clic en un punto** del scatter abre la señal temporal que hay detrás, en una
tarjeta suelta al lado, en cascada para que clics sucesivos no se tapen. El índice del punto es el de la señal en el experimento
entero —el mismo orden con el que se escribió el sidecar—, no dentro de un
chunk; el worker lo traduce a dataset y fila con un índice de tramos memoizado.
En una tarjeta fusionada el origen se resuelve por la traza clicada, no por la
tarjeta, que puede mezclar sensores.

**Alineación**: los tres comparten el t=0 del experimento (el mínimo de los
tres grupos) y el mismo rango X. Además reservan el margen del eje secundario
aunque no lo usen: si uno tuviera eje derecho y otro no, sus áreas de trazado
tendrían anchos distintos y el mismo instante caería en píxeles distintos.

**Otras interacciones**: arrastrar una tarjeta sobre otra fusiona sus series
(mismo dominio); `⑃` las separa; clic derecho abre las operaciones del dominio
(hoy, FFT).

**Al fusionar se recolorean las series que chocan.** El color de un gráfico de
sensor depende del sensor, no del experimento, así que dos scatter de UHF traen
los dos el mismo verde y al fusionarlos las nubes quedaban una sobre otra sin
poder separarlas. Sólo cambia el color de lo que colisiona, y por orden: la
primera serie conserva el suyo, así que la humedad sigue azul y la temperatura
roja —ahí el color significa algo—. Agotada la paleta de 8, se generan tonos por
ángulo áureo, sin repetir.

Los scatter fusionados muestran leyenda (sueltos no, sólo robaría alto), y en
ella va el nombre largo con la fecha del experimento: es lo único que distingue
dos nubes de la misma métrica de experimentos distintos. El título del eje sigue
usando el nombre corto, que si no acabaría arrastrando la fecha.

---

## Pendiente

- Unidades de `risetime` y `teq` por sensor (ver arriba)
- Zoom vertical no sincronizado entre gráficos del bloque: las escalas son
  incompatibles (% vs 0,15 V vs 3,4 V)
- `kind: 'groupSeries'` (envolvente min/max) sigue en `App.jsx` pero ya no lo
  emite ninguna parte de la UI
- Lienzo infinito con pan y zoom
- El techo de ~8-16 contextos WebGL sigue ahí, sólo que más lejos: WebGL se usa
  únicamente por encima de 20.000 puntos dibujados (`GL_THRESHOLD`), así que son
  4 contextos por experimento arrastrado y 0 por señal abierta. Con 3-4
  experimentos a la vez se vuelve a rozar; la salida sería recuperarse de
  `webglcontextlost` redibujando
- Más operaciones: registrar en `operations.js` y añadir handler en el worker
- Que el proyecto generador emita `fs_<sensor>` y las métricas de origen. Con
  `chunks-v2` la fs viene de `metrics.config.json`, que es un dato del proyecto
  y no del archivo: dos masters con tasas distintas no se pueden precalcular en
  la misma corrida sin pasar `--fs-*` a mano
- Servir el sidecar en el build de producción: hoy `fetchSidecar` depende de que
  algo sirva el archivo desde la raíz, y eso sólo lo hace el dev server
