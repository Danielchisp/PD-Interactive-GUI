import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Algunas deps (react-draggable) leen `process.env.*` en runtime. En el
  // navegador `process` no existe; en dev eso lanza "process is not defined"
  // y rompe el arrastre. Lo definimos como objeto vacío para dev y build.
  define: {
    'process.env': {},
  },
  // Pre-empaquetar h5wasm al arrancar evita un reload de Vite la primera vez
  // que se abre el HDF5 (la dep vive dentro del worker y se descubre tarde).
  optimizeDeps: {
    include: ['h5wasm'],
  },
})
