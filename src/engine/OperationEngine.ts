import type {
  EngineEvents,
  EngineState,
  Instrument,
  Operation,
  OperationCatalog,
  OperationResult,
} from '../types/contracts';
import catalogJson from './catalog.json';
import type { Progress } from './Progress';

/**
 * Motor de operaciones: lógica pura, sin dependencias de DOM ni three.js.
 * Mantiene el estado (menú -> preparación -> resultado) y valida la mesa.
 */
export class OperationEngine {
  private catalog: OperationCatalog;
  private state: EngineState;
  private events: EngineEvents;
  /** Instante en que arrancó la preparación en curso, para cronometrarla. */
  private startedAt = 0;
  /** Instante en que se paró el reloj, o `0` si está corriendo. Ver `pausarReloj()`. */
  private pausadoEn = 0;
  /** Veces que se ha puntuado la operación en curso. Se reinicia al elegirla o al vaciarla. */
  private attempts = 0;
  /** Reloj inyectable: los tests no pueden depender de lo que tarde la máquina. */
  private now: () => number;
  /** Progreso persistido. Opcional: el motor tiene que poder funcionar sin navegador (tests). */
  private progress: Progress | null;

  constructor(
    events: EngineEvents,
    catalog: OperationCatalog = catalogJson as OperationCatalog,
    now: () => number = () => Date.now(),
    progress: Progress | null = null,
  ) {
    this.catalog = catalog;
    this.events = events;
    this.now = now;
    this.progress = progress;
    this.state = {
      phase: 'menu',
      operation: null,
      tray: [],
      result: null,
    };
  }

  /** Milisegundos transcurridos desde que empezó la preparación (0 fuera de ella). */
  getElapsedMs(): number {
    if (this.state.phase !== 'preparing' || !this.startedAt) return 0;
    // Con el reloj parado cuenta hasta el instante de la pausa, no hasta ahora.
    return (this.pausadoEn || this.now()) - this.startedAt;
  }

  /**
   * Para el cronómetro mientras no se puede jugar.
   *
   * Existe por el aviso de girar el dispositivo: al ponerse en vertical el área jugable no cabe y la
   * partida queda tapada, pero el reloj es de pared —`now() - startedAt`— así que seguiría corriendo
   * y arruinaría un tiempo que se puntúa y se guarda en el historial.
   *
   * OJO, no confundir con `resume()`: aquel vuelve del resultado a corregir la mesa y conserva el
   * reloj A PROPÓSITO, para que validar a lo loco no salga gratis. Este otro es el par de
   * `reanudarReloj()` y no altera la fase.
   */
  pausarReloj(): void {
    if (this.pausadoEn) return; // ya parado: volver a llamar no debe regalar tiempo
    this.pausadoEn = this.now();
  }

  /** Reanuda el cronómetro descontando lo que ha durado la pausa. */
  reanudarReloj(): void {
    if (!this.pausadoEn) return;
    // Se desplaza el origen en lugar de acumular en un contador aparte: así `getElapsedMs()` sigue
    // siendo una resta y no hay dos fuentes de verdad para el mismo tiempo.
    this.startedAt += this.now() - this.pausadoEn;
    this.pausadoEn = 0;
  }

  /** Para los tests y para que el HUD no muestre el cronómetro corriendo si está parado. */
  relojParado(): boolean {
    return this.pausadoEn !== 0;
  }

  /**
   * ¿Está la mesa lista para dar por terminada la operación?
   *
   * Terminar exige las dos cosas: TODAS las obligatorias puestas y NINGÚN distractor. Las opcionales
   * dan igual, que para eso son opcionales. Si solo se mirara lo obligatorio, la partida se cerraría
   * sola con una sierra ósea en la mesa de una apendicectomía y sin dar ocasión de retirarla.
   */
  isTrayComplete(): boolean {
    const op = this.state.operation;
    if (this.state.phase !== 'preparing' || !op) return false;
    const enMesa = new Set(this.state.tray);
    const faltaAlguna = op.required.some((id) => !enMesa.has(id));
    const hayDistractor = (op.distractors ?? []).some((id) => enMesa.has(id));
    return !faltaAlguna && !hayDistractor;
  }

  // --- Consultas ---------------------------------------------------------

  getState(): EngineState {
    return this.state;
  }

  /** Operaciones en orden de nivel. Las que no declaran `level` van al final, en orden de catálogo. */
  getOperations(): Operation[] {
    const sinNivel = Number.MAX_SAFE_INTEGER;
    return [...this.catalog.operations].sort(
      (a, b) => (a.level ?? sinNivel) - (b.level ?? sinNivel),
    );
  }

  /**
   * La operación siguiente a la actual por nivel, o `null` si es la última.
   *
   * Devolver `null` en lugar de dar la vuelta al catálogo es intencionado: el HUD necesita
   * distinguir «hay más» de «te los has pasado todos» para no ofrecer un «siguiente nivel» que
   * llevaría de vuelta al primero como si no hubiera terminado nada.
   */
  getNextOperation(fromId: string | null = this.state.operation?.id ?? null): Operation | null {
    if (!fromId) return null;
    const ordenadas = this.getOperations();
    const i = ordenadas.findIndex((o) => o.id === fromId);
    if (i < 0) return null;
    return ordenadas[i + 1] ?? null;
  }

  getInstrument(id: string): Instrument | undefined {
    return this.catalog.instruments.find((i) => i.id === id);
  }

  getInstruments(): Instrument[] {
    return this.catalog.instruments;
  }

  /**
   * Instrumentos que se muestran en el "pool" para una operación: la unión de
   * required + optional + distractors, en orden estable y mezclado por id.
   * Así el usuario debe discriminar cuáles necesita.
   */
  getPoolInstruments(operation: Operation): Instrument[] {
    const ids = new Set<string>([
      ...operation.required,
      ...(operation.optional ?? []),
      ...(operation.distractors ?? []),
    ]);
    return [...ids]
      .map((id) => this.getInstrument(id))
      .filter((i): i is Instrument => Boolean(i))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // --- Transiciones ------------------------------------------------------

  selectOperation(operationId: string): void {
    const operation = this.catalog.operations.find((o) => o.id === operationId);
    if (!operation) return;
    this.state = { phase: 'preparing', operation, tray: [], result: null };
    this.startedAt = this.now();
    // Una pausa pendiente no puede sobrevivir a empezar de nuevo: dejaría el reloj congelado en 0.
    this.pausadoEn = 0;
    this.attempts = 0;
    this.emit();
  }

  addToTray(instrumentId: string): void {
    if (this.state.phase !== 'preparing') return;
    if (this.state.tray.includes(instrumentId)) return;
    if (!this.getInstrument(instrumentId)) return;
    this.state = { ...this.state, tray: [...this.state.tray, instrumentId] };
    this.emit();
  }

  removeFromTray(instrumentId: string): void {
    if (this.state.phase !== 'preparing') return;
    this.state = {
      ...this.state,
      tray: this.state.tray.filter((id) => id !== instrumentId),
    };
    this.emit();
  }

  validate(): OperationResult | null {
    if (this.state.phase !== 'preparing' || !this.state.operation) return null;
    const elapsedMs = this.getElapsedMs();
    this.attempts++;
    const result = {
      ...OperationEngine.evaluate(this.state.operation, this.state.tray),
      elapsedMs,
      attempts: this.attempts,
    };
    // El detalle va al historial para que un intento fallido deje constancia de EN QUÉ falló, aunque
    // se salga al menú sin corregirlo.
    this.progress?.record(this.state.operation.id, result.score, elapsedMs, result.passed, {
      missing: result.missing.length,
      wrong: result.wrong.length,
    });
    this.state = { ...this.state, phase: 'result', result };
    this.emit();
    return result;
  }

  /**
   * Volver a la mesa desde el resultado SIN vaciarla, para corregirla.
   *
   * El cronómetro sigue corriendo desde el principio: mide el tiempo total hasta dejar la mesa bien.
   * Reiniciarlo aquí premiaría validar a lo loco para parar el reloj y volver a entrar con marcador
   * a cero, que es justo la estrategia que no interesa fomentar.
   */
  resume(): void {
    if (this.state.phase !== 'result' || !this.state.operation) return;
    this.state = { ...this.state, phase: 'preparing', result: null };
    this.emit();
  }

  reset(): void {
    if (this.state.operation) {
      this.state = {
        phase: 'preparing',
        operation: this.state.operation,
        tray: [],
        result: null,
      };
      // Reintentar es empezar de cero también en el cronómetro: si no, el segundo intento arrastraría
      // el tiempo del primero y sería imposible mejorar la marca. Ojo a la diferencia con `resume()`,
      // que conserva mesa y reloj porque allí NO se empieza de nuevo, se corrige.
      this.startedAt = this.now();
      this.pausadoEn = 0;
      this.attempts = 0;
    } else {
      this.state = { phase: 'menu', operation: null, tray: [], result: null };
    }
    this.emit();
  }

  backToMenu(): void {
    this.state = { phase: 'menu', operation: null, tray: [], result: null };
    this.emit();
  }

  // --- Evaluación (pura, estática para testear sin instanciar) ------------

  static evaluate(operation: Operation, tray: string[]): OperationResult {
    const traySet = new Set(tray);
    const required = operation.required;
    const distractors = operation.distractors ?? [];

    const correct = required.filter((id) => traySet.has(id));
    const missing = required.filter((id) => !traySet.has(id));
    const wrong = distractors.filter((id) => traySet.has(id));

    // Nota: proporción de required presentes, penalizando cada distractor.
    const base = required.length > 0 ? correct.length / required.length : 1;
    const penalty = distractors.length > 0 ? wrong.length / required.length : 0;
    const raw = Math.max(0, base - penalty);
    const score = Math.round(raw * 100);

    const passed = missing.length === 0 && wrong.length === 0;

    return { score, correct, missing, wrong, passed };
  }

  private emit(): void {
    this.events.onStateChange(this.state);
  }
}
