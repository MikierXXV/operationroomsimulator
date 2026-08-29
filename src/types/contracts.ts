/**
 * CONTRATO CENTRAL — interfaces compartidas por todos los módulos.
 *
 * Todos los workstreams (escena, input, motor, UI, interacción) programan
 * CONTRA estos tipos, no contra las implementaciones concretas de los demás.
 * Esto es lo que permite desarrollar los módulos de forma independiente.
 */

// ---------------------------------------------------------------------------
// ENTRADA UNIFICADA (Workstream C -> D)
// ---------------------------------------------------------------------------

export type PointerSource = 'hand' | 'mouse';

/**
 * Postura de la mano, para los gestos que no son la pinza.
 *
 * - `open`: los cuatro dedos largos estirados. Es la postura de REPOSO, así que nada debe dispararse
 *   por estar en ella: solo por LLEGAR a ella desde otra.
 * - `fist`: los cuatro recogidos.
 * - `two-fingers`: índice y corazón, para desplazar listas.
 * - `other`: cualquier postura intermedia, incluida la de pellizcar.
 */
export type HandShape = 'open' | 'fist' | 'two-fingers' | 'other';

/** Un punto de la mano (coords normalizadas [0..1], ya espejadas en X). */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/**
 * Puntero unificado. Lo emiten TANTO el hand-tracker (una por mano)
 * COMO el ratón/táctil. El resto del sistema no distingue el origen.
 */
export interface Pointer {
  /** Identificador estable: 'hand-left' | 'hand-right' | 'mouse'. */
  id: string;
  /** Coordenadas normalizadas [0..1] respecto al viewport (0,0 = arriba-izq). */
  x: number;
  y: number;
  /** Profundidad relativa opcional [0..1] (mano cerca/lejos de la cámara). */
  z?: number;
  /** ¿Está pellizcando (pulgar-índice) o el botón/toque pulsado? */
  isPinching: boolean;
  /** Fuerza del pinch [0..1], útil para umbrales/histeresis. */
  pinchStrength?: number;
  /** Postura de la mano. Solo la emiten las manos; el ratón no tiene forma. */
  handShape?: HandShape;
  source: PointerSource;
  /** 21 landmarks de la mano (solo source==='hand'); para dibujar el guante 3D. */
  landmarks?: Landmark[];
}

/** Estado de la fuente de entrada, para que la UI reaccione. */
export type InputStatus =
  | 'idle'
  | 'requesting-camera'
  | 'camera-active'
  | 'camera-denied'
  | 'camera-unavailable'
  | 'mouse-only';

export interface InputManagerEvents {
  onPointers(pointers: Pointer[]): void;
  onStatusChange(status: InputStatus): void;
}

/** API mínima que el resto del sistema espera del subsistema de entrada. */
export interface IInputManager {
  start(): Promise<void>;
  stop(): void;
  /** Fuerza el modo (p.ej. usuario desactiva la cámara). */
  setMode(mode: 'hands' | 'mouse'): void;
  getStatus(): InputStatus;
}

// ---------------------------------------------------------------------------
// DATOS DEL DOMINIO (Workstream E, consumido por B, F)
// ---------------------------------------------------------------------------

/**
 * Dónde puede acabar un instrumento al soltarlo.
 *
 * Antes esto era un booleano «está en la bandeja o no», que no dejaba sitio para el descarte: lo
 * incorrecto se quedaba tirado junto a la bandeja, indistinguible de lo que aún no se ha colocado.
 */
export type DropZone = 'pool' | 'tray';

export interface Instrument {
  /** id estable, kebab-case: 'scalpel-10'. */
  id: string;
  /** Nombre visible: 'Bisturí nº10'. */
  name: string;
  /** Ruta al modelo GLB relativa a /public. Si falta -> placeholder. */
  glb?: string;
  /**
   * Rotación fija del GLB, en radianes, cuando la heurística automática lo tumba mal.
   *
   * `InstrumentFactory` orienta los modelos suponiendo que su eje más largo es el que va sobre la
   * mesa. Es cierto casi siempre —el instrumental quirúrgico es alargado— pero falla en piezas de
   * caja casi cúbica, donde el eje mayor lo decide un detalle. Esta es la válvula de escape.
   */
  glbRotation?: [number, number, number];
  /**
   * Longitud en metros a la que escalar el GLB, si la del modelo procedural no sirve.
   *
   * Por omisión se hereda la del procedural al que sustituye, que ya está pensada para esa pieza.
   */
  glbLength?: number;
  /**
   * Índice de la pieza a extraer cuando el GLB es un SET con varios instrumentos en una sola malla.
   *
   * Es la forma habitual en que se publica el instrumental libre: siete u ocho piezas alineadas en
   * un mismo fichero. Con este campo, varios instrumentos del catálogo comparten `glb` y se quedan
   * cada uno con su trozo (ver `scene/glbParts.ts`). Las piezas se numeran desde 0 en el orden en
   * que están alineadas en el modelo.
   */
  glbPart?: number;
  /** Categoría: 'corte' | 'pinza' | 'sutura' | 'separador' | ... */
  category: string;
  /** Descripción corta para la UI/tooltip. */
  description?: string;
  /** Color del placeholder si no hay GLB (hex). */
  placeholderColor?: string;
  /** Atribución del GLB (obligatoria para CC-BY); se muestra en créditos. */
  credit?: { author: string; license: string; url: string };
}

export interface Operation {
  id: string;
  /** Nombre de la operación: 'Apendicectomía'. */
  name: string;
  /**
   * Orden de dificultad, empezando en 1. Es lo que convierte el catálogo en niveles.
   *
   * Va en los datos y no deducido del número de instrumentos porque la dificultad real no es solo
   * cuántos hay: también cuánto se parecen entre sí y cuántos distractores acompañan.
   */
  level?: number;
  /** Especialidad/área para agrupar en la UI. */
  specialty?: string;
  /** Instrumentos OBLIGATORIOS en la mesa (ids). */
  required: string[];
  /** Instrumentos opcionales (no penalizan, no obligan). */
  optional?: string[];
  /** Distractores: NO deben estar en la mesa; penalizan la nota. */
  distractors?: string[];
  briefing?: string;
}

/** Catálogo completo cargado desde JSON. */
export interface OperationCatalog {
  instruments: Instrument[];
  operations: Operation[];
}

// ---------------------------------------------------------------------------
// MOTOR DE OPERACIONES (Workstream E)
// ---------------------------------------------------------------------------

export type EnginePhase = 'menu' | 'preparing' | 'result';

export interface EngineState {
  phase: EnginePhase;
  operation: Operation | null;
  /** ids de instrumentos actualmente en la bandeja. */
  tray: string[];
  result: OperationResult | null;
}

export interface OperationResult {
  /** Nota [0..100]. */
  score: number;
  correct: string[];
  missing: string[];
  wrong: string[]; // distractores colocados
  passed: boolean;
  /** Tiempo empleado en preparar la mesa, en milisegundos. Ausente en la evaluación pura. */
  elapsedMs?: number;
  /** Nº de veces que se ha puntuado esta mesa, contando esta. 1 = a la primera. */
  attempts?: number;
}

export interface EngineEvents {
  onStateChange(state: EngineState): void;
}

// ---------------------------------------------------------------------------
// INTERACCIÓN CON LA ESCENA (Workstream B <-> D)
// ---------------------------------------------------------------------------

/** Lo que el GrabController notifica al motor cuando el usuario actúa. */
export interface GrabEvents {
  onGrab(instrumentId: string): void;
  /** onTray = true si se soltó dentro de la bandeja. */
  /** Dónde ha acabado la pieza. Puede no ser donde se soltó: un recipiente lleno la devuelve. */
  onDrop(instrumentId: string, zone: DropZone): void;
}

/**
 * API que la Escena (Workstream B) expone al GrabController (Workstream D).
 * Abstrae three.js para que la lógica de interacción no dependa de él
 * directamente.
 */
export interface ISceneApi {
  /** Instrumentos disponibles para coger (los del pool inicial). */
  layoutInstruments(instruments: Instrument[]): void;
  /**
   * Devuelve el id del instrumento MÁS CERCANO al puntero (proyectado sobre la
   * mesa) dentro de un radio de tolerancia, o null. Mucho más permisivo que un
   * raycast exacto: no hace falta apuntar con precisión al instrumento.
   */
  pickNearestInstrument(x: number, y: number): string | null;
  /** Resalta (o quita el resaltado si es null) el instrumento indicado. */
  setHovered(instrumentId: string | null): void;
  /** Mueve el mesh "en mano" siguiendo el puntero. */
  moveHeld(instrumentId: string, x: number, y: number): void;
  /**
   * Instrumento señalado para MIRAR, con menos tolerancia que para coger: si no, basta acercar la
   * mano a la zona para que salte la ficha de algo que no se estaba señalando.
   */
  pickForInspect(x: number, y: number): string | null;
  /** Zona de la superficie bajo el puntero. `pool` es el resto de la mesa. */
  zoneAt(x: number, y: number): DropZone;
  /**
   * Coloca el instrumento en una zona y devuelve dónde ha acabado DE VERDAD.
   *
   * No es `void` a propósito: si el recipiente está lleno la pieza vuelve al pool, y quien llama
   * tiene que enterarse o su idea de lo que hay en la bandeja dejará de coincidir con la escena.
   */
  placeIn(instrumentId: string, zone: DropZone): DropZone;
  /** Actualiza el cursor visual asociado a un puntero. */
  updateCursor(pointer: Pointer): void;
  removeCursor(pointerId: string): void;
  /** Parpadeo breve de un instrumento para localizarlo (clic en checklist). */
  pulseInstrument(instrumentId: string): void;
  /** Anillo de progreso de dwell [0..1] sobre el cursor de una mano (0 oculta). */
  setDwell(pointerId: string, progress: number): void;
  /** Instrumento más cercano a un punto de pantalla (px CSS), para clic de ratón. */
  pickInstrumentAtScreen(clientX: number, clientY: number): string | null;
}

// ---------------------------------------------------------------------------
// UI / HUD (Workstream F)
// ---------------------------------------------------------------------------

export interface HudCallbacks {
  onSelectOperation(operationId: string): void;
  onValidate(): void;
  onReset(): void;
  /**
   * Volver a la mesa CONSERVANDO lo colocado, para corregirla.
   *
   * Distinto de `onReset`, que la vacía: tras ver la nota lo normal es querer arreglar las dos
   * piezas que fallaron, no montar los once instrumentos otra vez desde cero.
   */
  onResume(): void;
  /** Saltar al siguiente nivel. El HUD solo lo ofrece si `getNextOperation` devuelve algo. */
  onNextLevel(): void;
  onToggleInput(mode: 'hands' | 'mouse'): void;
  /**
   * Abrir el visor de cercanía de un instrumento.
   *
   * Localizarlo en la mesa ya no es un callback aparte: el destello lo dispara `main.ts` al CERRAR
   * la ficha, que es cuando se puede ver (con el visor abierto queda tapado).
   */
  onInspectInstrument(instrumentId: string): void;
  /**
   * Tiempo transcurrido en la preparación en curso, en ms.
   *
   * Es una consulta y no un aviso porque el cronómetro corre solo: el HUD lo pregunta cuando le toca
   * refrescar, en lugar de obligar al motor a emitir un estado nuevo cada segundo y repintar el
   * panel entero —que reiniciaría las animaciones del checklist a cada tic—.
   */
  getElapsedMs(): number;
  /** Mejor marca guardada de una operación, o `null` si nunca se ha jugado. */
  getProgress(operationId: string): OperationProgressSummary | null;
  /** Siguiente nivel, o `null` si el actual es el último: el HUD cambia el botón en consecuencia. */
  getNextOperation(): Operation | null;
}

/** Lo que el HUD necesita saber del progreso guardado, sin acoplarse a cómo se almacena. */
export interface OperationProgressSummary {
  bestScore: number;
  bestTimeMs: number | null;
  passed: boolean;
  attempts: number;
  /** Últimos intentos, el más reciente primero. */
  history: AttemptSummary[];
}

export interface AttemptSummary {
  score: number;
  elapsedMs: number;
  passed: boolean;
  missing: number;
  wrong: number;
  at: number;
}
