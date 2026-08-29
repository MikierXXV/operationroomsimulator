import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Sirve el WASM de MediaPipe SIN pasar por la tubería de módulos de Vite.
 *
 * La inferencia de manos puede correr en un Web Worker, y desde un worker MediaPipe necesita la
 * variante `vision_wasm_module_internal`. Pidiéndosela al CDN elige la clásica y muere con
 * «ModuleFactory not set»; sirviendo la carpeta completa en local, acierta. Ambas comprobadas.
 *
 * Pero su cargador usa `import()` dinámico sobre esos `.js`, y en desarrollo Vite los intercepta, les
 * añade `?import` e intenta transformarlos como módulos de la aplicación. La carga falla.
 *
 * Este middleware corta por lo sano: las peticiones a `/mediapipe/…` se responden leyendo el fichero
 * del disco, con su tipo MIME y sin transformar nada.
 *
 * Los ficheros viven en `vendor/`, NO en `public/`, y por eso hace falta este middleware también para
 * las peticiones normales: `public/` se copiaría entero a `dist` y son 32 MB que el sitio publicado
 * no pide nunca, porque el worker está desactivado y el hilo principal usa el CDN. Ver
 * `scripts/copiar-wasm.mjs`.
 */
function servirWasmMediapipe(): Plugin {
  // Toda la carpeta, no solo `wasm/`: ahí vive también el bundle CJS que carga el worker clásico.
  const PREFIJO = '/mediapipe/';
  const CARPETA = 'vendor';
  const TIPOS: Record<string, string> = {
    '.js': 'text/javascript',
    '.cjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.data': 'application/octet-stream',
  };

  return {
    name: 'servir-wasm-mediapipe',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(PREFIJO)) return next();

        // Fuera la query: Vite añade `?import` y rompería la resolución del fichero.
        const limpio = url.split('?')[0];
        const raiz = normalize(join(server.config.root, CARPETA, PREFIJO));
        const ruta = normalize(join(server.config.root, CARPETA, limpio));
        // Sin esta comprobación, un `..` en la ruta permitiría salir de `vendor/`.
        if (!ruta.startsWith(raiz) || !existsSync(ruta)) return next();

        res.setHeader('Content-Type', TIPOS[extname(ruta)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(ruta).pipe(res);
      });
    },
  };
}

// El `base` debe coincidir con el nombre del repositorio en GitHub Pages:
// https://mikierxxv.github.io/operationroomsimulator/
// Si no coincide, el sitio publicado sale en blanco: el HTML pide los assets de una ruta que no
// existe. En desarrollo local Vite ignora esto y sirve en '/'.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/operationroomsimulator/' : '/',
  plugins: [servirWasmMediapipe()],
  server: {
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
