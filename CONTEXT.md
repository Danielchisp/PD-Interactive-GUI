# PD-Interactive-GUI - Contexto del Proyecto

## Objetivo del Proyecto
El objetivo principal de **PD-Interactive-GUI** es proporcionar una aplicación web altamente interactiva (SPA) que permita explorar, visualizar y analizar grandes volúmenes de datos experimentales de señales adquiridas mediante sensores (UHF, AE - Acústico, variables ambientales como Temperatura y Humedad). 

Estos datos provienen de experimentos (por ejemplo, mediciones de Descargas Parciales - PD) y están almacenados en archivos HDF5 de gran tamaño. Dado el gran volumen de datos, la lectura y el procesamiento de estos archivos ocurren enteramente del lado del cliente en el navegador, usando WebAssembly (`h5wasm`) mediante Web Workers.

## Stack Tecnológico
- **Frontend Framework**: React 18
- **Build Tool**: Vite
- **Lenguajes**: JavaScript / JSX, algo de Python (para scripts en backend/offline).
- **Procesamiento HDF5 en el cliente**: `h5wasm` ejecutado en Web Workers.
- **Gráficos y Visualización**: Plotly.js (WebGL) para los trazados intensivos (millones de puntos de las señales).
- **Estilos**: Vanilla CSS con variables nativas.
- **Formato de los datos**: HDF5 con esquema específico `pd-metrics-v1`.

## Arquitectura de Datos
1. **Master HDF5**: Contiene la data en bruto:
   - Señales de sensores UHF (`uhf/data`) y Acústicos (`ae/data`).
   - Timestamps de los sensores y variables de humedad y temperatura (`humidity`).
   - El Master no se modifica, se carga en modo lectura.
2. **Metrics Sidecar (.metrics.h5)**: Contiene atributos escalares precalculados de cada señal para agilizar el análisis, evitando procesar el master en tiempo real:
   - El script `compute_metrics.py` se encarga de generarlo de forma offline (rápido vía Python y `h5py` / `numpy`).
   - El motor `metricsEngine.js` también puede generarlo en vivo en el navegador si no existe, y guarda el `.metrics.h5` usando FS temporal.

### Métricas (12+1 calculadas)
- `rms`, `vmax`, `vpp`, `crest`, `kurtosis`, `skewness`, `risetime`, `teq`, `zcr`, `shannon`, `energia_j`, `feq`.
- `t_pct`: Porcentaje de tiempo (de 0% a 100%) correspondiente al timestamp del pulso relativo a la duración de todo el experimento (añadido para permitir comparaciones normalizadas entre distintos tests).

## Funciones Principales y Flujo (GUI)
1. El usuario arrastra un archivo `master.hdf5` y/o `master.metrics.h5` a la pantalla.
2. Un Panel Izquierdo (`DataSourcePanel`) muestra un árbol navegable del archivo con los Tests, Sensores y Señales.
3. El panel derecho (Canvas) es el escritorio de visualización. 
4. El usuario puede arrastrar elementos desde el árbol al Canvas:
   - Grupos de Sensores (ej. UHF Data) o Experiments completos.
5. **Context Menus**: Se implementó la capacidad de hacer clic derecho sobre los nodos del árbol. Por ejemplo, al hacer clic derecho en un grupo "UHF", se despliega un menú (scrolleable) con la selección de las 12 métricas.
6. Al seleccionar una métrica, la app dibuja un gráfico X-Y donde el **Eje Y** es el valor de la métrica en cada pulso, y el **Eje X** es `t_pct` (Tiempo %), permitiendo alinear horizontalmente pruebas de diferente duración cronológica.

## Historial de Modificaciones (Trabajo Realizado)
- **Implementación del Panel Lateral (DataSourcePanel)**: Manejo del drag & drop nativo para señales y grupos.
- **Generación de Sidecars**: Se introdujo el script de Python y JS para calcular las 12 métricas principales de cada ventana de datos y aliviar al UI Thread.
- **Menú Contextual (Click derecho)**: Se integró el menú en los nodos (`ChildGroupNode`) ignorando el nodo de humedad.
- **Gráficos de Métricas en el Canvas**: `App.jsx` incluye `renderMetricChart` y `buildMetricChart` para crear una gráfica de los datos que lee del sidecar, usando el % de tiempo `t_pct` en X.
- **Actualización Visual del Context Menu**: Se hizo scrolleable (`max-height`, `overflow-y`) mediante CSS.
- **Nuevo cálculo `t_pct`**: Integrado en ambas versiones del motor de métricas (`compute_metrics.py` y `metricsEngine.js`) para que cada `.metrics.h5` generado contenga el eje temporal relativo de manera nativa.

## Próximos pasos posibles / TBD
- Implementar validaciones o alertas sobre compatibilidad si se cargan versiones viejas de los archivos sidecar.
- Ajustes finos al trazado de Plotly o exportación de gráficos.
