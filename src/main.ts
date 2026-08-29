import './styles.css';
import { SceneManager } from './scene/SceneManager';
import { OperationEngine } from './engine/OperationEngine';
import { InputManager } from './input/InputManager';
import { GrabController } from './interaction/GrabController';
import { HandUiController } from './interaction/HandUiController';
import { Progress } from './engine/Progress';
import { CREDITO_SALA } from './scene/room';
import { Hud } from './ui/Hud';
import { InstrumentInspector } from './ui/InstrumentInspector';
import type { EngineState, InputStatus, Pointer } from './types/contracts';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const appRoot = document.getElementById('app') as HTMLElement;

// --- Núcleo ---------------------------------------------------------------

const scene = new SceneManager(canvas);

// Progreso entre sesiones (mejor nota y mejor tiempo por nivel). Si el navegador no deja guardar,
// `Progress` se repliega a memoria y el juego sigue igual.
const progress = new Progress();

const engine = new OperationEngine(
  { onStateChange: (state) => onEngineState(state) },
  undefined,
  undefined,
  progress,
);

// Las manos, sobre el HUD: menú, lista y botones.
const handUi = new HandUiController(appRoot);

/*
 * Visor de cercanía (modal). Al cerrarse, el bucle reanuda el agarre solo.
 *
 * Además avisa al controlador de agarre para que arranque el enfriamiento del dwell: si no, al
 * cerrar la ficha el temporizador seguía vivo sobre el mismo instrumento —la mano no se ha movido—
 * y volvía a abrirse sola. Era el origen de que la información «saltara cada dos por tres».
 *
 * El callback se resuelve tarde a propósito: `grab` se construye más abajo porque necesita la
 * escena, y aquí solo se guarda la referencia para cuando de verdad se cierre algo.
 */
const inspector = new InstrumentInspector(appRoot, () => {
  grab.notifyInspectorClosed();
  /*
   * Al cerrar la ficha, la pieza destella en la mesa.
   *
   * El destello se dispara AQUÍ y no al pulsar en la lista porque dura 1,2 s y el visor se abre
   * encima al instante: destellar antes es iluminar algo que nadie puede ver. Cerrando es cuando
   * sirve —ya sabes qué instrumento es, ahora te dice dónde está entre los dieciséis de la mesa—.
   * Esto es lo que por fin usa `pulseInstrument`, que llevaba desde el principio sin llamar nadie.
   */
  if (ultimoInspeccionado) scene.pulseInstrument(ultimoInspeccionado);
});

/** Última pieza abierta en la ficha, para poder señalarla en la mesa al cerrarla. */
let ultimoInspeccionado: string | null = null;

function openInspector(id: string): void {
  const inst = engine.getInstrument(id);
  if (!inst) return;
  ultimoInspeccionado = id;
  inspector.open(inst);
}

const hud = new Hud(hudRoot, (id) => engine.getInstrument(id), {
  onSelectOperation: (id) => (id ? engine.selectOperation(id) : engine.backToMenu()),
  onValidate: () => engine.validate(),
  onReset: () => engine.reset(),
  onResume: () => engine.resume(),
  onNextLevel: () => {
    const siguiente = engine.getNextOperation();
    if (siguiente) engine.selectOperation(siguiente.id);
    else engine.backToMenu();
  },
  /*
   * Solo PIDE el cambio. Lo que se hace con el modo vive en `aplicarModo`, al que se llega por el
   * estado de la entrada: aquí no se reparte nada.
   *
   * Antes este callback repartía el modo por su cuenta —al visor, al cursor— y esa duplicidad causó
   * una regresión silenciosa: arrancando con la cámara sola, nadie pulsa este botón, así que el visor
   * nunca se enteraba de que se jugaba con las manos y su cartel de «pellizca fuera para cerrar» no
   * llegaba a aparecer.
   */
  onToggleInput: (mode) => input.setMode(mode),
  onInspectInstrument: (id) => openInspector(id),
  getElapsedMs: () => engine.getElapsedMs(),
  getProgress: (id) => progress.get(id),
  getNextOperation: () => engine.getNextOperation(),
});
hud.setOperations(engine.getOperations());
hud.setCredits(engine.getInstruments());
// El decorado solo se acredita si de verdad se ha cargado: si el `.glb` falta y se juega con la sala
// propia, citar a su autor sería falso.
void scene.whenRoomLoaded().then((info) => {
  if (info) hud.setSceneCredit(CREDITO_SALA.nombre, CREDITO_SALA);
});

// El GrabController traduce gestos en cambios de bandeja del motor; el dwell de
// mano abierta abre el visor de cercanía.
const grab = new GrabController(
  scene,
  {
    onGrab: () => {},
    onDrop: (instrumentId, zone) => {
      // Para el motor solo cuenta la bandeja: descartado y devuelto al pool son ambos «fuera».
      // `removeFromTray` ya es idempotente, así que no hace falta distinguirlos aquí.
      if (zone === 'tray') engine.addToTray(instrumentId);
      else engine.removeFromTray(instrumentId);
      comprobarFinal();
    },
  },
  (id) => openInspector(id),
);

/*
 * Cierre automático al completar la mesa.
 *
 * Antes había que acordarse de pulsar «Validar mesa» incluso con todo bien puesto, lo cual sobra:
 * si están las obligatorias y ningún distractor, la tarea ESTÁ hecha y el juego debe reconocerlo.
 *
 * El pequeño retardo no es decorativo: sin él, el panel de resultado aparecería en el mismo frame en
 * que se suelta la última pieza y no daría tiempo a verla caer en su hueco. Se guarda el temporizador
 * para poder anularlo si en ese intervalo se retira algo y la mesa deja de estar completa.
 */
const RETARDO_FINAL_MS = 900;
let temporizadorFinal: number | null = null;

function comprobarFinal(): void {
  if (temporizadorFinal !== null) {
    clearTimeout(temporizadorFinal);
    temporizadorFinal = null;
  }
  if (!engine.isTrayComplete()) return;
  temporizadorFinal = window.setTimeout(() => {
    temporizadorFinal = null;
    // Se vuelve a comprobar: entre el disparo y ahora la mesa ha podido dejar de estar completa.
    if (engine.isTrayComplete()) engine.validate();
  }, RETARDO_FINAL_MS);
}

/*
 * Saltar la apertura con cualquier gesto, PERO no con el que acaba de elegir el nivel.
 *
 * Un plano que no se puede cortar se vuelve insufrible al tercer nivel, y quien ya conoce la sala
 * solo quiere jugar. Ahora bien, el clic o el pellizco con el que se entra sigue en curso cuando la
 * animación arranca, así que sin margen la cortaba de inmediato y la transición no se veía nunca.
 * `puedeSaltarIntro()` da medio segundo de gracia; ver `SceneManager.INTRO_GRACIA_MS`.
 */
for (const evento of ['pointerdown', 'keydown', 'wheel'] as const) {
  window.addEventListener(evento, () => { if (scene.puedeSaltarIntro()) scene.endIntro(); }, { capture: true });
}

// Ratón: clic (sin arrastre) sobre un instrumento abre el visor.
let downX = 0;
let downY = 0;
canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // fue arrastre
  if (inspector.isOpen()) return;
  const id = scene.pickInstrumentAtScreen(e.clientX, e.clientY);
  if (id) openInspector(id);
});

const input = new InputManager(video, canvas, {
  onPointers: (pointers: Pointer[]) => {
    latestPointers = pointers;
  },
  onStatusChange: (status) => {
    hud.setStatus(status);
    aplicarModo(modoDe(status));
  },
});

/**
 * Modo de juego que corresponde a un estado de la entrada.
 *
 * `camera-active` es el ÚNICO estado en que de verdad se juega con las manos; todos los demás
 * —denegada, sin cámara, modo ratón, o arrancando— dejan al ratón al mando.
 */
function modoDe(status: InputStatus): 'hands' | 'mouse' {
  return status === 'camera-active' ? 'hands' : 'mouse';
}

/**
 * Reparte el modo a TODO lo que depende de él, desde un único sitio.
 *
 * Que esto exista es la lección de la regresión del cartel: el modo se decidía en dos rutas —el botón
 * de la barra y el estado de la cámara— y cada una actualizaba a unos cuantos interesados, así que
 * bastaba entrar por la ruta equivocada para que alguno se quedara desinformado.
 */
function aplicarModo(mode: 'hands' | 'mouse'): void {
  // La pista y el cartel del visor dependen del modo: los gestos de mano no son los del ratón.
  inspector.setInputMode(mode);
  // Con el ratón, el cursor de mano tiene que desaparecer; si no, se queda clavado en pantalla.
  if (mode === 'mouse') handUi.reposo();
}

// --- Reacción al estado del motor ----------------------------------------

let currentOperationId: string | null = null;

function onEngineState(state: EngineState): void {
  hud.render(state);

  // Al entrar en preparación de una operación nueva, montar el pool 3D.
  if (state.phase === 'preparing' && state.operation) {
    const esNivelNuevo = state.operation.id !== currentOperationId;
    if (esNivelNuevo || state.tray.length === 0) {
      currentOperationId = state.operation.id;
      scene.layoutInstruments(engine.getPoolInstruments(state.operation));
    }
    /*
     * El plano de apertura, solo al ENTRAR en un nivel.
     *
     * No al corregir la mesa ni al reintentar: ahí ya sabes dónde estás y volver a pasear la cámara
     * cada vez sería una tortura. Se dispara únicamente cuando cambia la operación.
     */
    if (esNivelNuevo) {
      scene.playIntro();
      // Arranca «sin soltar»: el pellizco con el que se ha elegido el nivel no cuenta como salto.
      manoSoltadaTrasIntro = false;
    }
  }
  /*
   * Volver al menú DESMONTA la partida, no solo la oculta.
   *
   * Antes esto se limitaba a olvidar el id, y detrás del menú se quedaba todo vivo: los dieciséis
   * instrumentos sobre la mesa, la ficha abierta si lo estaba y —lo peor— el temporizador del cierre
   * automático armado, que podía dispararse ya fuera de la partida y puntuar una mesa que el jugador
   * había abandonado.
   */
  if (state.phase === 'menu') {
    currentOperationId = null;
    if (temporizadorFinal !== null) {
      clearTimeout(temporizadorFinal);
      temporizadorFinal = null;
    }
    inspector.close();
    scene.clearInstruments();
    handUi.reposo();
  }
}

// --- Bucle de render + interacción ---------------------------------------

let latestPointers: Pointer[] = [];
/** ¿Se ha soltado la pinza desde que empezó la apertura? Ver el corte del plano en `frame()`. */
let manoSoltadaTrasIntro = true;

function frame(): void {
  // Con el visor abierto se pausa la interacción de agarre.
  /*
   * Con el visor abierto los punteros NO se paran: se desvían a él.
   *
   * Antes esta línea era `if (!inspector.isOpen()) grab.update(...)`, es decir, se congelaba el
   * procesado de punteros por completo. Esa era la razón de fondo de que no se pudiera cerrar la
   * ficha con las manos: no faltaba un gesto, faltaban los datos. Ahora el visor recibe las manos
   * para girar el modelo y para cerrarse, y el agarre sigue en pausa, que es lo que sí interesa
   * pausar mientras hay un modal delante.
   */
  /*
   * Tres consumidores, una sola corriente de punteros. El orden es el que decide todo:
   *
   *  1. La ficha, si está abierta: es modal, se lo queda todo.
   *  2. La interfaz, si la mano está sobre ella Y no se lleva nada en la mano. El segundo guarda no
   *     es un detalle: sin él, cruzar el panel cargando un instrumento lo soltaría a mitad de
   *     camino, porque el agarre dejaría de recibir punteros justo mientras arrastra.
   *  3. La mesa.
   *
   * Al pasar a la interfaz hay que retirar el cursor 3D, o se queda un anillo huérfano señalando un
   * instrumento que ya nadie apunta.
   */
  /*
   * Durante la apertura no se interactúa con la mesa.
   *
   * No es cosmético: coger un instrumento con la cámara en movimiento lo dejaría en un sitio
   * imprevisible, porque el agarre proyecta el puntero sobre el plano de la mesa y esa proyección
   * cambia en cada frame mientras la cámara viaja.
   */
  if (scene.isIntroPlaying()) {
    handUi.reposo();
    /*
     * Con las manos, un pellizco NUEVO corta la apertura. El matiz de «nuevo» es lo que hace que la
     * transición llegue a verse: el nivel se elige pellizcando, y ese pellizco sigue cerrado cuando
     * arranca el plano, así que antes se cancelaba solo en el primer fotograma.
     *
     * Se exige además haber soltado la pinza desde que empezó: con el margen de gracia bastaría casi
     * siempre, pero quien sostenga el pellizco medio segundo se quedaría igualmente sin ver nada.
     */
    const pellizcando = latestPointers.some((p) => p.source === 'hand' && p.isPinching);
    if (!pellizcando) manoSoltadaTrasIntro = true;
    if (pellizcando && manoSoltadaTrasIntro && scene.puedeSaltarIntro()) scene.endIntro();
  } else if (inspector.isOpen()) {
    handUi.reposo();
    inspector.handlePointers(latestPointers);
  } else if (!grab.isHolding() && handUi.update(latestPointers)) {
    scene.clearCursors();
  } else {
    handUi.reposo();
    grab.update(latestPointers);
  }
  scene.render();
  requestAnimationFrame(frame);
}

// --- Arranque -------------------------------------------------------------

hud.render(engine.getState());
input.start().catch((err) => console.error('Input start error:', err));
requestAnimationFrame(frame);

// Hook de depuración solo en desarrollo (para pruebas de interacción).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sim = {
    scene,
    engine,
    grab,
    input,
    // El visor, para poder probar sus gestos inyectando punteros sin necesidad de webcam.
    inspector,
    handUi,
    hud,
    progress,
    getPointers: () => latestPointers,
    /*
     * Inyecta punteros como si vinieran de la webcam.
     *
     * Sirve para probar el ENRUTADO de verdad —el de `frame()`, con sus dos guardas— y no una
     * imitación: llamar a mano a `handUi.update()` desde la consola se saltaría justo la lógica
     * que puede fallar. Solo en desarrollo.
     */
    inject: (pointers: Pointer[]) => {
      latestPointers = pointers;
    },
  };
}
