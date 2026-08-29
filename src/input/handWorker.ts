/// <reference lib="webworker" />

/**
 * Detección de manos FUERA del hilo que dibuja. Worker CLÁSICO, no de módulo.
 *
 * POR QUÉ EXISTE. `detectForVideo` es síncrona y tarda 13,8 ms de mediana, con picos de 24,1, cuando
 * el presupuesto de un fotograma a 60 fps es de 16,7. **Una sola detección se come el fotograma
 * entero.** Corriendo unas 30 veces por segundo en el hilo principal, la mitad de los fotogramas
 * quedaban destrozados: eso, y solo eso, era el tirón. Está medido que quitar el render completo no
 * mejoraba el p90 y que quitar el seguimiento sí.
 *
 * POR QUÉ CLÁSICO Y NO DE MÓDULO. Se intentó de módulo y no arranca. Cuatro combinaciones, mismo
 * final:
 *
 *   1. módulo + WASM del CDN             → «ModuleFactory not set»
 *   2. módulo + WASM local sin plugin    → Vite añade `?import` y falla el fetch
 *   3. módulo + WASM local con plugin    → «ModuleFactory not set»
 *   4. lo anterior + delegado CPU        → «ModuleFactory not set»
 *
 * La 2 y la 3 descartan que sea dónde se sirve el WASM; la 4, que sea el contexto gráfico.
 * `FilesetResolver` carga siempre `vision_wasm_internal` —la variante clásica— y esa no funciona
 * dentro de un worker de módulo.
 *
 * CÓMO SE CARGA. El paquete no publica un bundle UMD, pero el `.cjs` vale: solo escribe en `exports`
 * y no usa `module.exports`. En un worker clásico basta con declarar ese objeto en el global antes de
 * `importScripts` y recogerlo después. El único `require(` del bundle es una rama muerta en
 * navegador.
 */

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

interface LandmarkerLike {
  detectForVideo(
    imagen: ImageBitmap,
    t: number,
  ): { landmarks: { x: number; y: number; z: number }[][]; handedness?: { categoryName: string }[][] };
}

let landmarker: LandmarkerLike | null = null;
/** Un fotograma en vuelo como mucho; ver el descarte más abajo. */
let ocupado = false;

export interface PeticionInit {
  tipo: 'init';
  /** Base de la aplicación: el worker no puede dar por hecho que se sirve en la raíz. */
  base: string;
}
export interface PeticionFrame {
  tipo: 'frame';
  bitmap: ImageBitmap;
  t: number;
}
export type Peticion = PeticionInit | PeticionFrame;

export interface RespuestaLista {
  tipo: 'listo';
}
export interface RespuestaError {
  tipo: 'error';
  mensaje: string;
}
export interface RespuestaManos {
  tipo: 'manos';
  landmarks: { x: number; y: number; z: number }[][];
  handedness: string[];
  /** Cuánto tardó la inferencia, para vigilarla sin instrumentar el hilo principal. */
  ms: number;
}
export type Respuesta = RespuestaLista | RespuestaError | RespuestaManos;

const global_ = self as unknown as DedicatedWorkerGlobalScope & {
  exports?: Record<string, unknown>;
  importScripts(...urls: string[]): void;
};

async function iniciar(base: string): Promise<void> {
  const raiz = base.replace(/\/$/, '');

  /*
   * El shim que hace cargable el bundle CommonJS.
   *
   * El fichero hace `exports.HandLandmarker = …` sobre un `exports` que espera encontrar en el
   * ámbito. En un worker `self` ES el objeto global, así que definiéndolo aquí, las referencias
   * desnudas a `exports` dentro del bundle se resuelven contra este objeto.
   */
  global_.exports = {};
  global_.importScripts(`${raiz}/mediapipe/vision_bundle.cjs`);

  const api = global_.exports as {
    FilesetResolver?: { forVisionTasks(ruta: string): Promise<unknown> };
    HandLandmarker?: { createFromOptions(fileset: unknown, opciones: unknown): Promise<LandmarkerLike> };
  };
  if (!api.FilesetResolver || !api.HandLandmarker) {
    throw new Error('el bundle de MediaPipe no expuso FilesetResolver/HandLandmarker');
  }

  // WASM servido en local: la carpeta trae las dos variantes y el resolver escoge la que toca.
  const fileset = await api.FilesetResolver.forVisionTasks(`${raiz}/mediapipe/wasm`);
  landmarker = await api.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    /*
     * Un lienzo propio para que el delegado GPU tenga dónde crear su contexto.
     *
     * Sin esto, en un worker no hay lienzo por defecto y MediaPipe se cae a CPU en silencio: medido,
     * la inferencia pasó de 13,8 ms en el hilo principal a **141 ms** aquí dentro. Diez veces más
     * lenta anula por completo la ventaja de no bloquear el dibujado.
     */
    canvas: new OffscreenCanvas(640, 480),
  });
}

global_.onmessage = async (e: MessageEvent<Peticion>): Promise<void> => {
  const msg = e.data;

  if (msg.tipo === 'init') {
    try {
      await iniciar(msg.base);
      global_.postMessage({ tipo: 'listo' } satisfies Respuesta);
    } catch (err) {
      // No se relanza: el hilo principal necesita el aviso para replegarse a inferir él mismo.
      global_.postMessage({ tipo: 'error', mensaje: String(err) } satisfies Respuesta);
    }
    return;
  }

  /*
   * Si ya se está infiriendo, este fotograma SE TIRA.
   *
   * Encolarlos sería peor que perderlos: la cola crecería sin fin y la mano dibujada iría cada vez
   * más por detrás de la real. Vale más saltarse fotogramas y responder al instante.
   */
  if (!landmarker || ocupado) {
    msg.bitmap.close();
    return;
  }

  ocupado = true;
  const t0 = performance.now();
  try {
    const res = landmarker.detectForVideo(msg.bitmap, msg.t);
    global_.postMessage({
      tipo: 'manos',
      landmarks: res.landmarks.map((h) => h.map((p) => ({ x: p.x, y: p.y, z: p.z }))),
      handedness: res.handedness?.map((h) => h[0]?.categoryName ?? '') ?? [],
      ms: performance.now() - t0,
    } satisfies Respuesta);
  } catch {
    // Un fallo puntual de inferencia no debe tumbar el worker: se ignora y entra el siguiente.
  } finally {
    msg.bitmap.close(); // sin esto se acumulan bitmaps en memoria de GPU
    ocupado = false;
  }
};
