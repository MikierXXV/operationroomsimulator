import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { Landmark, Pointer } from '../types/contracts';
import { clasificarMano, puntoDePinza } from './handShape';
import type { Peticion, Respuesta, RespuestaManos } from './handWorker';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/*
 * LA INFERENCIA CORRE EN EL HILO PRINCIPAL, y no porque no se haya intentado lo contrario.
 *
 * Está medido que es la única causa de los tirones: el peor 10 % de los fotogramas tarda 43,8 ms con
 * seguimiento y 17,9 ms sin él, mientras que quitar el render entero no cambia nada. `detectForVideo`
 * es síncrona y bloquea el dibujado mientras corre.
 *
 * Se probaron tres arreglos:
 *  1. Detectar a 20 Hz emitiendo interpolado a 60 → PEOR (62 ms): `emit()` no es gratis y repetirlo
 *     hacia un objetivo que no cambia no mueve el puntero.
 *  2. Buscar una mano en vez de dos → sin efecto (46 vs 44 ms): el coste de MediaPipe es casi fijo.
 *  3. Sacar la inferencia a un Web Worker → **no arranca**: `@mediapipe/tasks-vision` falla con
 *     «ModuleFactory not set» dentro de un worker de módulo ES; su WASM espera un contexto clásico.
 *
 * La vía que queda es un worker CLÁSICO cargando el bundle con `importScripts`, que es harina de
 * otro costal. Hasta entonces se prefiere con tirones y funcionando que fluido y sin manos.
 */

// Umbrales de pinza con histéresis: se activa por debajo de CLOSE y se
// desactiva por encima de OPEN, evitando parpadeo. Generosos para que coger
// resulte cómodo y el agarre "enganche" (no se suelta por microaperturas).
const PINCH_CLOSE = 0.06;
const PINCH_OPEN = 0.14;

/*
 * Suavizado ADAPTATIVO A LA VELOCIDAD del puntero.
 *
 * Con un factor fijo hay que elegir entre las dos cosas que se necesitan y son opuestas: poco filtro
 * responde rápido pero tiembla parado —y apuntar a una pieza entre otras se vuelve una lotería—, y
 * mucho filtro no tiembla pero arrastra con retardo pastoso.
 *
 * La salida es que el filtro dependa de lo deprisa que se mueva la mano: casi quieta, que es cuando
 * se apunta, filtra fuerte y el puntero se queda clavado; en movimiento, que es cuando se arrastra,
 * apenas filtra y sigue a la mano. Es la idea del filtro «1 euro», reducida a lo imprescindible.
 */
const SMOOTH_QUIETO = 0.12; // mano parada: mucho filtro, nada de temblor
const SMOOTH_RAPIDO = 0.7; // mano en movimiento: poco filtro, sin retardo
/** Velocidad (fracción de pantalla por frame) a la que ya se aplica el filtro más suelto. */
const VELOCIDAD_REF = 0.035;
const SMOOTH_LM = 0.55;

/**
 * ZONA ACTIVA: qué parte del encuadre de la cámara se estira hasta cubrir toda la pantalla.
 *
 * Antes la correspondencia era 1:1, y eso hacía **materialmente inalcanzables los bordes**: para
 * llegar al panel del HUD, pegado al borde derecho, había que poner la yema del índice en el borde
 * mismo del cuadro de la webcam, que es justo donde MediaPipe deja de ver la mano. El resultado era
 * que con las manos no se podía pulsar ningún botón del panel ni del menú final: no era falta de
 * puntería, era que el punto no existía.
 *
 * Tomando el 68 % central del cuadro, un gesto cómodo delante del pecho recorre la pantalla entera y
 * las esquinas caen bien dentro de la zona donde la detección es fiable. El precio es que el mismo
 * movimiento de mano cubre más pantalla —el puntero va más "rápido"—, compensado por el suavizado.
 */
/** Hasta dónde llega la mano con detección fiable, medido desde el centro del cuadro. */
const ALCANCE_FIABLE = 0.34;

/**
 * Curvatura del mapeo mano → pantalla. Resuelve el conflicto entre PUNTERÍA y ALCANCE.
 *
 * El estirado lineal de la zona activa amplificaba TODO el movimiento ×1,47, y eso se pagaba en
 * puntería: medido, el margen que se le exige a la mano para acertar una pieza cayó de 20,1 cm a
 * 9,96 cm, la mitad. Coger costaba el doble.
 *
 * Pero volver a 1:1 no vale: se metió el estirado porque sin él los bordes eran materialmente
 * inalcanzables —había que poner el dedo en el borde del cuadro, donde MediaPipe pierde la mano— y
 * el panel del HUD está pegado a la derecha.
 *
 * La salida no es un número intermedio, es una CURVA: ganancia 1 en el centro, donde está la mesa y
 * donde hace falta afinar, y creciente hacia los bordes, donde solo hay que llegar a un botón. Es la
 * misma idea que la aceleración del puntero de cualquier sistema operativo.
 *
 * `s = u + K·u³`, con `u` en [-1,1] desde el centro del cuadro. K se elige para que el límite de
 * detección fiable (±0,34 del centro, o sea la zona activa) llegue justo al borde de la pantalla.
 */
/*
 * OJO CON LAS UNIDADES: `u` va en escala DOBLADA respecto al cuadro.
 *
 * `u = (v - 0.5) * 2`, así que un desplazamiento de 0,34 en coordenadas del encuadre es u = 0,68.
 * La primera versión calculó K metiendo 0,34 directamente, como si ya fuera un valor de `u`, y salió
 * **16,79 en vez de 1,02**: dieciséis veces y media pasado.
 *
 * El efecto era que la mano solo servía en el 34 % central del cuadro y el cursor se clavaba en los
 * bordes en cuanto salías de ahí, con ganancias de 5,5× cerca del límite. La mano dejó de responder.
 */
const ALCANCE_U = ALCANCE_FIABLE * 2;
const CURVA_K = (1 - ALCANCE_U) / ALCANCE_U ** 3;

/**
 * Lleva una coordenada del cuadro de la cámara a coordenada de pantalla [0..1].
 *
 * En el centro la ganancia es 1: mover la mano un centímetro mueve el cursor lo mismo que antes de
 * que existiera el estirado. Cerca del borde la ganancia sube y se alcanza el HUD sin salir de la
 * zona donde la cámara ve bien la mano.
 */
export function aPantalla(v: number): number {
  const u = (v - 0.5) * 2; // [-1..1] desde el centro del cuadro
  const s = u + CURVA_K * u ** 3;
  return Math.max(0, Math.min(1, (s + 1) / 2));
}

/*
 * La clasificación de posturas vive en `handShape.ts`: es matemática pura sobre landmarks y así se
 * puede probar con manos sintéticas, sin cámara ni WebGL.
 */

/**
 * Envuelve MediaPipe HandLandmarker: abre la webcam, detecta hasta 2 manos y
 * emite un Pointer por mano (posición del índice + estado de pinza).
 */
export class HandTracker {
  /**
   * Inferencia en un Web Worker: FUNCIONA, PERO SALE PEOR. Apagado por defecto.
   *
   * La idea era sólida: una detección bloquea 13,8 ms y el presupuesto de fotograma son 16,7, así que
   * sacarla del hilo que dibuja debería quitar los tirones. El recorrido, medido paso a paso:
   *
   *  1. worker de MÓDULO + WASM del CDN              → «ModuleFactory not set»
   *  2. worker de módulo + WASM local sin plugin     → Vite añade `?import` y falla el fetch
   *  3. worker de módulo + WASM local con plugin     → «ModuleFactory not set»
   *  4. lo anterior + delegado CPU                   → «ModuleFactory not set»
   *  5. worker CLÁSICO + bundle `.cjs` importScripts → **arranca**
   *
   * Los pasos 2 y 3 descartan que fuera cosa de dónde se sirve el WASM; el 4, que fuera el contexto
   * gráfico. `FilesetResolver` carga siempre la variante clásica del WASM, que no vale en un worker
   * de módulo. El paso 5 resuelve el arranque y destapa el problema de fondo:
   *
   *   Hilo principal ........... inferencia  13,8 ms · 19 % de fotogramas lentos
   *   Worker clásico ........... inferencia   141 ms · 25 %
   *   Worker + OffscreenCanvas . inferencia   154 ms · 27 %
   *
   * **Dentro del worker la inferencia es diez veces más lenta**: pierde el delegado GPU y cae a CPU.
   * Darle un `OffscreenCanvas` propio no lo arregla. Diez veces más lenta anula con creces la ventaja
   * de no bloquear el dibujado, y el resultado global empeora.
   *
   * SE DEJA MONTADO Y APAGADO. Estas cifras salen del Chrome de Playwright, que suele correr con GL
   * por software; en un Chrome normal el worker podría conservar la GPU, y entonces sí compensaría.
   * Poner esto a `true` es todo lo que hace falta para comprobarlo en otra máquina.
   */
  private static readonly USAR_WORKER = false;

  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  private pinchState = new Map<string, boolean>();
  private smoothed = new Map<string, { x: number; y: number; lm: Landmark[] }>();
  private onPointers: (pointers: Pointer[]) => void;
  /** Solo se usa en el repliegue: si el worker arranca, la inferencia no pasa por aquí. */
  private landmarker: HandLandmarker | null = null;
  private worker: Worker | null = null;
  private workerListo = false;
  /** Última duración de inferencia informada por el worker, para poder vigilarla. */
  ultimaInferenciaMs = 0;

  constructor(video: HTMLVideoElement, onPointers: (pointers: Pointer[]) => void) {
    this.video = video;
    this.onPointers = onPointers;
  }

  /** Abre la cámara y arranca la detección. Lanza si el usuario deniega permiso. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    /*
     * Se intenta el worker y, si no arranca, se infiere aquí como siempre.
     *
     * El repliegue no es paranoia: la primera versión de esto murió con «ModuleFactory not set» y el
     * juego se quedó sin manos sin avisar. Con tirones pero funcionando es preferible a fluido y
     * muerto, así que un fallo del worker degrada, no rompe.
     */
    if (!this.worker && !this.landmarker) {
      if (HandTracker.USAR_WORKER) {
        try {
          await this.arrancarWorker();
        } catch (err) {
          console.warn('[HandTracker] worker no disponible, se infiere en el hilo principal:', err);
          this.descartarWorker();
          await this.arrancarLocal();
        }
      } else {
        await this.arrancarLocal();
      }
    }

    this.running = true;
    this.video.classList.add('active');
    this.loop();
  }

  /** ¿Está la inferencia fuera del hilo principal? Lo consulta la verificación de rendimiento. */
  usandoWorker(): boolean {
    return this.workerListo;
  }

  /**
   * Levanta el worker y espera a que tenga el modelo cargado.
   *
   * Se espera a propósito: enviando fotogramas antes, se descartarían todos hasta que el modelo
   * estuviera listo y el arranque parecería que no detecta la mano.
   */
  private arrancarWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      /*
       * CLÁSICO, no de módulo: MediaPipe no arranca en un worker de módulo (ver `handWorker.ts`).
       * Sin `type`, Vite lo empaqueta como IIFE y `importScripts` queda disponible dentro.
       */
      const worker = new Worker(new URL('./handWorker.ts', import.meta.url));
      this.worker = worker;
      const fallo = setTimeout(() => reject(new Error('el worker no respondió en 15 s')), 15000);

      worker.onmessage = (e: MessageEvent<Respuesta>): void => {
        const msg = e.data;
        if (msg.tipo === 'listo') {
          clearTimeout(fallo);
          this.workerListo = true;
          resolve();
        } else if (msg.tipo === 'error') {
          clearTimeout(fallo);
          reject(new Error(msg.mensaje));
        } else if (msg.tipo === 'manos') {
          this.ultimaInferenciaMs = msg.ms;
          this.emitDesdeWorker(msg);
        }
      };
      worker.onerror = (err): void => {
        clearTimeout(fallo);
        reject(new Error(`worker de manos: ${err.message}`));
      };
      worker.postMessage({ tipo: 'init', base: import.meta.env.BASE_URL } satisfies Peticion);
    });
  }

  /** Cierra el worker y olvida que existió, para que el bucle pase por el repliegue. */
  private descartarWorker(): void {
    const w: Worker | null = this.worker;
    w?.terminate();
    this.worker = null;
    this.workerListo = false;
  }

  /** Repliegue: el modelo cargado en el hilo principal, como estaba antes del worker. */
  private async arrancarLocal(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  }

  stop(): void {
    this.running = false;
    this.video.classList.remove('active');
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.smoothed.clear();
    this.pinchState.clear();
    this.onPointers([]);
  }

  /**
   * Cadencia de detección, en Hz.
   *
   * Medido: una inferencia tarda 13,8 ms de mediana y hasta 24,1, cuando el presupuesto de un
   * fotograma a 60 fps es de 16,7. Es decir, **una sola detección se come el fotograma entero**. Al
   * lanzarla en cada fotograma de vídeo nuevo —unas 30 veces por segundo— la mitad de los fotogramas
   * de pantalla cargaban con ella, y eso es exactamente el tirón que se nota.
   *
   * A 15 Hz solo una cuarta parte de los fotogramas la sufre. El puntero se actualiza cada 66 ms en
   * lugar de cada 33; el suavizado adaptativo disimula la diferencia porque al apuntar despacio ya
   * filtraba fuerte de todos modos.
   *
   * OJO: esto es throttling PURO. Un intento anterior detectaba a 20 Hz pero emitía a 60
   * interpolando, y salió peor (62 ms): `emit()` no es gratis y repetirlo hacia un objetivo que no ha
   * cambiado no mueve el puntero. Aquí se emite solo cuando hay detección nueva.
   */
  private static readonly DETECCION_HZ = 15;
  /** Con la inferencia fuera del hilo, ya no hay que racionarla: se detecta a ritmo de cámara. */
  private static readonly DETECCION_HZ_WORKER = 30;
  private ultimaDeteccion = 0;
  /** Timestamps monótonos propios: MediaPipe rechaza los que no crecen. */
  private sello = 0;

  private loop = (): void => {
    if (!this.running) return;

    const ahora = performance.now();
    const hz = this.workerListo ? HandTracker.DETECCION_HZ_WORKER : HandTracker.DETECCION_HZ;
    const toca = ahora - this.ultimaDeteccion >= 1000 / hz;

    if (toca && this.video.currentTime !== this.lastVideoTime && this.video.readyState >= 2) {
      this.lastVideoTime = this.video.currentTime;
      this.ultimaDeteccion = ahora;
      this.sello += 40;

      if (this.workerListo && this.worker) {
        /*
         * Al worker se le manda el fotograma como `ImageBitmap` TRANSFERIDO: no se copia, se cede.
         * Lo único que hace este hilo es capturarlo y soltarlo; la inferencia ocurre en otro sitio.
         */
        const sello = this.sello;
        void createImageBitmap(this.video)
          .then((bitmap) => {
            if (!this.running || !this.worker) {
              bitmap.close(); // se paró mientras se creaba: no dejarlo colgando
              return;
            }
            this.worker.postMessage({ tipo: 'frame', bitmap, t: sello } satisfies Peticion, [bitmap]);
          })
          .catch(() => {}); // fotograma no disponible aún; se reintenta en el siguiente
      } else if (this.landmarker) {
        this.emit(this.landmarker.detectForVideo(this.video, ahora));
      }
    }
    requestAnimationFrame(this.loop);
  };

  /**
   * Adapta la respuesta del worker al formato de MediaPipe y reutiliza `emit`.
   *
   * Se traduce en vez de duplicar `emit` porque ahí vive todo lo delicado —el espejado, la curva de
   * aceleración, el suavizado adaptativo, la histéresis de la pinza— y tener dos copias garantizaría
   * que una de las dos se quedara atrás.
   */
  private emitDesdeWorker(msg: RespuestaManos): void {
    this.emit({
      landmarks: msg.landmarks,
      handedness: msg.handedness.map((n) => [{ categoryName: n, score: 1, index: 0, displayName: n }]),
      worldLandmarks: [],
handednesses: [],
    } as unknown as HandLandmarkerResult);
  }

  private emit(result: HandLandmarkerResult): void {
    const pointers: Pointer[] = [];

    result.landmarks.forEach((hand, i) => {
      // Handedness la da MediaPipe respecto a la imagen sin espejar; el vídeo
      // se muestra espejado, así que invertimos la etiqueta para el usuario.
      const label = result.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'right' : 'left';
      const id = `hand-${label}`;

      const indexTip = hand[8];
      const thumbTip = hand[4];

      const dist = Math.hypot(
        indexTip.x - thumbTip.x,
        indexTip.y - thumbTip.y,
        (indexTip.z - thumbTip.z) * 0.5,
      );

      const forma = clasificarMano(hand);

      /*
       * La pinza se reporta TAL CUAL SE VE. Aquí no se anula por nada.
       *
       * Antes se anulaba al clasificar la mano como puño, para que cerrarla —el gesto del historial—
       * no pulsara botones. Pero al pellizcar, el índice se curva y los otros dedos se recogen, así
       * que un pellizco se clasificaba como puño y **la pinza se anulaba justo al pellizcar**: no se
       * podía coger nada.
       *
       * La lección es de diseño, no de umbrales: quien detecta no debe decidir. `HandTracker` informa
       * de lo que ve —las yemas se tocan— y cada consumidor decide qué hacer con ello. El único al
       * que le estorba un puño-pinza es la interfaz, y ese ya lo filtra por su cuenta
       * (`HandUiController`), donde equivocarse solo cuesta un clic y no dejar el juego inservible.
       */
      const wasPinching = this.pinchState.get(id) ?? false;
      const isPinching = wasPinching ? dist < PINCH_OPEN : dist < PINCH_CLOSE;
      this.pinchState.set(id, isPinching);

      const pinchStrength = Math.max(0, Math.min(1, 1 - dist / PINCH_OPEN));

      /*
       * Landmarks espejados en X y suavizados, PERO SIN LA CURVA DE ACELERACIÓN.
       *
       * Aquí estaba el fallo que dejó la mano inservible. La curva se aplicaba a los 21 puntos por
       * separado, y una curva cúbica **separa cada punto una cantidad distinta según dónde esté**:
       * los dedos se abrían en abanico y la palma se estiraba. El guante salía como una araña de
       * medio metro.
       *
       * Con el estirado LINEAL de antes esto no se notaba, porque una recta conserva la forma: solo
       * escala. Al cambiarlo por una curva dejó de conservarla, y el error pasó desapercibido.
       *
       * La lección es de diseño: **la aceleración es del puntero, no de la mano.** En cualquier
       * sistema operativo se acelera el cursor, no el ratón. Así que los landmarks se quedan
       * lineales —conservan la forma, y siguen valiendo para `clasificarMano` y para el guante— y la
       * curva se aplica solo al punto que hace de cursor, unas líneas más abajo.
       */
      const rawLm: Landmark[] = hand.map((lm) => ({
        x: 1 - lm.x,
        y: lm.y,
        z: lm.z,
      }));
      const prev = this.smoothed.get(id);
      const landmarks: Landmark[] = rawLm.map((lm, k) => {
        if (!prev) return lm;
        const p = prev.lm[k];
        return {
          x: p.x + (lm.x - p.x) * SMOOTH_LM,
          y: p.y + (lm.y - p.y) * SMOOTH_LM,
          z: p.z + (lm.z - p.z) * SMOOTH_LM,
        };
      });

      /*
       * PUNTERO = PUNTO MEDIO entre las yemas del pulgar y del índice, no la yema del índice sola.
       *
       * Antes era el landmark 8, la yema del índice, y eso hacía que **el cursor retrocediera justo
       * al agarrar**: pellizcar ES curvar el índice hacia el pulgar, así que en el instante del
       * gesto la yema se desplaza varios centímetros y el puntero se iba con ella. Se apuntaba a un
       * instrumento, se pellizcaba, y para cuando la pinza se registraba el cursor ya estaba en otro
       * sitio: había que compensar a mano y algunas piezas resultaban casi imposibles de coger.
       *
       * El punto medio es INVARIANTE ante el gesto por construcción: al pellizcar, las dos yemas
       * convergen precisamente hacia él. La mano se cierra, el cursor se queda donde estaba, y solo
       * se mueve cuando de verdad mueves la mano.
       */
      /*
       * Y AQUÍ, solo aquí, se aplica la curva de aceleración: sobre el punto que hace de cursor.
       *
       * Ganancia 1 en el centro del encuadre —donde está la mesa y donde hace falta afinar— y
       * creciente hacia los bordes, donde solo hay que llegar a un botón del HUD.
       */
      const ancla = puntoDePinza(landmarks);
      const rawX = aPantalla(ancla.x);
      const rawY = aPantalla(ancla.y);
      let x = rawX;
      let y = rawY;
      if (prev) {
        const velocidad = Math.hypot(rawX - prev.x, rawY - prev.y);
        const t = Math.min(1, velocidad / VELOCIDAD_REF);
        const alfa = SMOOTH_QUIETO + (SMOOTH_RAPIDO - SMOOTH_QUIETO) * t;
        x = prev.x + (rawX - prev.x) * alfa;
        y = prev.y + (rawY - prev.y) * alfa;
      }
      this.smoothed.set(id, { x, y, lm: landmarks });

      pointers.push({
        id,
        x,
        y,
        z: indexTip.z,
        isPinching,
        pinchStrength,
        // Se clasifica sobre los landmarks CRUDOS: el estirado de la zona activa deforma las
        // distancias en X, y con ellas la comparación yema/nudillo que decide si un dedo está
        // extendido.
        handShape: forma,
        source: 'hand',
        landmarks,
      });
    });

    this.onPointers(pointers);
  }
}
