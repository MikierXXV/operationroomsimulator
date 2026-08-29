/**
 * Progreso por operación: mejor nota, mejor tiempo e intentos, guardado entre sesiones.
 *
 * Sin esto los niveles no significan nada: pasar al siguiente sería solo cambiar de pantalla, y
 * volver mañana empezaría de cero sin rastro de lo conseguido.
 *
 * Todo el acceso a `localStorage` está blindado a propósito. No es paranoia de manual: el navegador
 * lanza al *leer* la propiedad en modo privado de algunos navegadores, lanza al escribir cuando la
 * cuota está llena, y devuelve texto arbitrario si alguien lo ha tocado a mano. Un simulador no
 * puede quedarse en blanco porque no haya podido apuntar una nota, así que el repliegue es siempre
 * la memoria: se juega igual, solo que sin recordar nada al recargar.
 */

const CLAVE = 'operationsimulator.progress.v1';

/** Cuántos intentos se recuerdan por nivel. Acota lo que ocupa en el navegador. */
const MAX_HISTORIAL = 10;

/** Un intento puntuado, tal como quedó. */
export interface AttemptRecord {
  score: number;
  elapsedMs: number;
  passed: boolean;
  /** Cuántos obligatorios faltaban y cuántos sobraban: el resumen de en qué se falló. */
  missing: number;
  wrong: number;
  /** Momento en que se puntuó (epoch ms). */
  at: number;
}

export interface OperationProgress {
  /** Mejor nota obtenida [0..100]. */
  bestScore: number;
  /** Mejor tiempo, en ms, SOLO de intentos superados. `null` si aún no se ha superado. */
  bestTimeMs: number | null;
  /** ¿Se ha llegado a dejar la mesa perfecta alguna vez? */
  passed: boolean;
  /** Veces que se ha puntuado esta operación. */
  attempts: number;
  /**
   * Últimos intentos, EL MÁS RECIENTE PRIMERO.
   *
   * Existe porque un intento fallido tiene que quedar registrado aunque te vayas al menú sin
   * corregirlo: con solo la mejor marca, fallar y salir no dejaba rastro y parecía que no hubieras
   * jugado.
   */
  history: AttemptRecord[];
}

/** Lo que se guarda: un registro por id de operación. */
type Almacen = Record<string, OperationProgress>;

export class Progress {
  private datos: Almacen;
  /** Si el almacén del navegador falla, se sigue jugando solo con esto. */
  private soloMemoria = false;

  constructor(private storage: Storage | null = leerStorage()) {
    if (!this.storage) this.soloMemoria = true;
    this.datos = this.cargar();
  }

  /** Progreso de una operación, o `null` si nunca se ha jugado. */
  get(operationId: string): OperationProgress | null {
    return this.datos[operationId] ?? null;
  }

  getAll(): Readonly<Almacen> {
    return this.datos;
  }

  /**
   * Registra un intento puntuado y devuelve el progreso resultante.
   *
   * El mejor tiempo solo se toca si la mesa se ha SUPERADO: si contara cualquier intento, el récord
   * lo marcaría quien valida a los diez segundos con la mesa vacía, que es lo contrario de lo que se
   * quiere premiar.
   */
  record(
    operationId: string,
    score: number,
    elapsedMs: number,
    passed: boolean,
    detalle: { missing: number; wrong: number } = { missing: 0, wrong: 0 },
    at: number = Date.now(),
  ): OperationProgress {
    const previo = this.datos[operationId];
    const intento: AttemptRecord = { score, elapsedMs, passed, ...detalle, at };
    const siguiente: OperationProgress = {
      bestScore: Math.max(previo?.bestScore ?? 0, score),
      bestTimeMs: mejorTiempo(previo?.bestTimeMs ?? null, elapsedMs, passed),
      passed: (previo?.passed ?? false) || passed,
      attempts: (previo?.attempts ?? 0) + 1,
      // El más reciente primero, y se recorta: sin tope, jugar mucho acabaría llenando la cuota del
      // navegador y las escrituras empezarían a fallar en silencio.
      history: [intento, ...(previo?.history ?? [])].slice(0, MAX_HISTORIAL),
    };
    this.datos[operationId] = siguiente;
    this.guardar();
    return siguiente;
  }

  /** Borra el progreso (útil para pruebas y para un futuro botón de reinicio). */
  clear(): void {
    this.datos = {};
    this.guardar();
  }

  /** ¿Se está jugando sin poder guardar? El HUD puede avisarlo si algún día interesa. */
  isEphemeral(): boolean {
    return this.soloMemoria;
  }

  // --- Persistencia -------------------------------------------------------

  private cargar(): Almacen {
    if (!this.storage) return {};
    let crudo: string | null = null;
    try {
      crudo = this.storage.getItem(CLAVE);
    } catch {
      this.soloMemoria = true;
      return {};
    }
    if (!crudo) return {};
    try {
      return sanear(JSON.parse(crudo));
    } catch {
      // JSON corrupto o de una versión que ya no se entiende: se descarta y se empieza limpio.
      // Propagarlo dejaría el HUD pintando `undefined` en las tarjetas de nivel.
      return {};
    }
  }

  private guardar(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(CLAVE, JSON.stringify(this.datos));
    } catch {
      // Cuota llena o escritura prohibida: se sigue en memoria, sin romper la partida en curso.
      this.soloMemoria = true;
    }
  }
}

/** Acceder a `localStorage` puede lanzar por sí solo; de ahí que ni siquiera esto sea directo. */
function leerStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function mejorTiempo(previo: number | null, elapsedMs: number, passed: boolean): number | null {
  if (!passed) return previo;
  if (previo === null) return elapsedMs;
  return Math.min(previo, elapsedMs);
}

/**
 * Filtra lo leído dejando solo registros con la forma esperada.
 *
 * Se descarta entrada a entrada en vez de todo el bloque: si una operación quedó a medias, no tiene
 * por qué llevarse por delante el progreso de las demás.
 */
function sanear(valor: unknown): Almacen {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return {};
  const salida: Almacen = {};
  for (const [id, v] of Object.entries(valor as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    const bestScore = numeroFinito(p.bestScore);
    const attempts = numeroFinito(p.attempts);
    if (bestScore === null || attempts === null) continue;
    const bestTimeMs = numeroFinito(p.bestTimeMs);
    salida[id] = {
      bestScore: Math.min(100, Math.max(0, bestScore)),
      bestTimeMs: bestTimeMs !== null && bestTimeMs >= 0 ? bestTimeMs : null,
      passed: p.passed === true,
      attempts: Math.max(0, Math.floor(attempts)),
      history: sanearHistorial(p.history),
    };
  }
  return salida;
}

/**
 * Filtra el historial guardado.
 *
 * Un historial ausente o que no sea un array no invalida el registro: se queda vacío y el nivel
 * conserva su mejor marca. Perder el detalle de partidas viejas es molesto; perder el progreso
 * entero por ello sería peor.
 */
function sanearHistorial(v: unknown): AttemptRecord[] {
  if (!Array.isArray(v)) return [];
  const salida: AttemptRecord[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const score = numeroFinito(r.score);
    const elapsedMs = numeroFinito(r.elapsedMs);
    if (score === null || elapsedMs === null) continue;
    salida.push({
      score: Math.min(100, Math.max(0, score)),
      elapsedMs: Math.max(0, elapsedMs),
      passed: r.passed === true,
      missing: Math.max(0, numeroFinito(r.missing) ?? 0),
      wrong: Math.max(0, numeroFinito(r.wrong) ?? 0),
      at: numeroFinito(r.at) ?? 0,
    });
    if (salida.length >= MAX_HISTORIAL) break;
  }
  return salida;
}

function numeroFinito(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
