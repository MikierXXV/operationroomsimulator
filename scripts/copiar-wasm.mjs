import { copyFile, cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copia el WASM de MediaPipe a `vendor/` para poder servirlo desde el mismo origen EN DESARROLLO.
 *
 * POR QUÉ SE SIRVE EN LOCAL. Sirve al worker de inferencia: desde un worker hay que cargar la
 * variante `vision_wasm_module_internal`, y pidiéndoselo al CDN `FilesetResolver` elegía la clásica y
 * moría con «ModuleFactory not set». La carpeta local contiene AMBAS y el resolver escoge la que toca.
 *
 * POR QUÉ EN `vendor/` Y NO EN `public/`. Porque `public/` se copia entero a `dist`, y esto son 32 MB
 * que **el sitio publicado no llega a pedir nunca**: el worker está desactivado (`USAR_WORKER` en
 * `HandTracker.ts`) y el hilo principal carga el WASM del CDN de jsDelivr. Estaban engordando el
 * despliegue de 47 a 79 MB a cambio de nada. Desde `vendor/` los sirve el middleware de
 * `vite.config.ts` en desarrollo, que es donde de verdad hacen falta.
 *
 * Consecuencia a tener presente: si algún día se activa el worker, en producción no encontrará el
 * WASM y se replegará al hilo principal —que es justo lo que hace hoy—. Para que el worker funcione
 * publicado habría que volver a servir esta carpeta.
 *
 * Se ejecuta en `postinstall` y no a mano a propósito: no tiene sentido versionar 32 MB, y dejarlo al
 * criterio de quien clone el repo garantiza que tarde o temprano falte.
 */

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, '..');
const origen = join(raiz, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const destino = join(raiz, 'vendor', 'mediapipe', 'wasm');

if (!existsSync(origen)) {
  // No es un error: en un `npm ci --omit=dev` o antes de instalar, la carpeta puede no estar todavía.
  console.warn(`[copiar-wasm] no encuentro ${origen}; se omite.`);
  process.exit(0);
}

await mkdir(destino, { recursive: true });
await cp(origen, destino, { recursive: true });

/*
 * El bundle CommonJS, para el worker CLÁSICO.
 *
 * MediaPipe no arranca dentro de un worker de MÓDULO —comprobadas cuatro combinaciones, todas
 * terminan en «ModuleFactory not set»—, así que la inferencia se saca a un worker clásico que carga
 * este fichero con `importScripts`. El paquete no publica un bundle UMD, pero el `.cjs` sirve: solo
 * escribe en `exports`, y en un worker basta con declarar ese objeto en el global antes de cargarlo.
 */
const bundle = join(raiz, 'node_modules', '@mediapipe', 'tasks-vision', 'vision_bundle.cjs');
if (existsSync(bundle)) {
  await copyFile(bundle, join(raiz, 'vendor', 'mediapipe', 'vision_bundle.cjs'));
}

const copiados = await readdir(destino);
console.log(`[copiar-wasm] ${copiados.length} ficheros en vendor/mediapipe/wasm + el bundle CJS`);
