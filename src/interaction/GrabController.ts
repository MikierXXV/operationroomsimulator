import type { GrabEvents, ISceneApi, Pointer } from '../types/contracts';

interface HeldState {
  instrumentId: string;
}

/**
 * Traduce Pointers (manos o ratón) en acciones sobre la escena: coger al
 * pellizcar sobre un instrumento, arrastrarlo siguiendo el puntero y soltarlo
 * (snap a la bandeja o vuelta al pool). Notifica al motor vía GrabEvents.
 *
 * Es "el pegamento": no conoce three.js (usa ISceneApi) ni MediaPipe (usa
 * Pointer). Por eso se integra al final, cuando B, C y E existen.
 */
export class GrabController {
  private scene: ISceneApi;
  private events: GrabEvents;
  /** Estado por puntero: qué sujeta cada mano/ratón. */
  private held = new Map<string, HeldState>();
  private wasPinching = new Map<string, boolean>();
  /**
   * Pieza resaltada ahora mismo: la que el jugador está VIENDO como elegida.
   *
   * Es lo que se coge al pellizcar. Se conserva del frame anterior a propósito —`tryGrab` corre
   * antes de recalcular el resaltado de este frame—, porque el resaltado del frame anterior es
   * justamente el que el jugador tenía delante cuando decidió cerrar los dedos.
   */
  private hovered: string | null = null;
  private activePointerIds = new Set<string>();
  /** Frames que un puntero lleva desaparecido (para el periodo de gracia). */
  private missingFrames = new Map<string, number>();
  /** Nº de frames que se tolera perder la mano antes de soltar (~0.25 s). */
  private static readonly RELEASE_GRACE = 15;

  /** Estado de dwell (mano abierta quieta) por puntero, para inspeccionar. */
  private dwell = new Map<string, { id: string; startT: number; fired: boolean; x: number; y: number }>();
  /*
   * Los cuatro números del dwell, subidos tras la queja de que «la información salta cada dos por
   * tres». Cada uno arreglaba una parte:
   *
   *  - 900 ms era muy poco para una postura PASIVA. La mano abierta es la posición de descanso, así
   *    que la condición «sin pellizcar» se cumple prácticamente siempre: el temporizador corría solo.
   *  - la tolerancia de movimiento del 4 % de la pantalla la cumple una mano «casi quieta» de sobra,
   *    porque además la señal viene suavizada.
   *  - se apuntaba con el radio de AGARRE, 20 cm, que es medio pool: bastaba pasar la mano cerca.
   *    Ahora hay un radio propio, mucho menor (ver `pickForInspect`).
   *  - y no había enfriamiento: al cerrar la ficha el dwell seguía vivo sobre el mismo instrumento,
   *    así que quedarse quieto la reabría al instante. Esto es lo que producía la sensación de que
   *    saltaba sin parar.
   */
  private static readonly DWELL_MS = 1400;
  /*
   * Tolerancia de movimiento, en fracción de PANTALLA.
   *
   * Era 0.025, elegido cuando la mano se correspondía 1:1 con el encuadre de la cámara. Al meter el
   * estirado de la zona activa —que amplifica el movimiento 1,47×— el mismo temblor de mano pasó a
   * recorrer un 47 % más de pantalla, así que el umbral quedó de hecho un 47 % más exigente sin que
   * nadie lo decidiera: mantener la ficha abierta se volvió difícil. 0.037 devuelve la exigencia
   * original medida EN LA MANO, que es donde importa.
   */
  private static readonly DWELL_MOVE = 0.037;
  /** Tras cerrar una ficha, no se vuelve a disparar hasta pasado esto. */
  private static readonly DWELL_COOLDOWN_MS = 1200;
  private dwellBlockedUntil = 0;
  /** Instrumento del último disparo: hay que SALIR de él antes de poder repetir. */
  private lastInspected: string | null = null;
  private onInspect: (instrumentId: string) => void;

  constructor(scene: ISceneApi, events: GrabEvents, onInspect: (instrumentId: string) => void = () => {}) {
    this.scene = scene;
    this.events = events;
    this.onInspect = onInspect;
  }

  /**
   * ¿Hay algún puntero sujetando un instrumento?
   *
   * Lo consulta el enrutado de `main.ts`: mientras se lleva una pieza en la mano, los punteros no
   * pueden desviarse a la interfaz aunque la mano pase por encima del panel. Sin esto, cruzar el
   * HUD con un instrumento cogido lo soltaría a mitad de camino.
   */
  isHolding(): boolean {
    return this.held.size > 0;
  }

  /** Se llama en cada frame con los punteros vigentes. */
  update(pointers: Pointer[]): void {
    const seen = new Set<string>();
    let hoverCandidate: string | null = null;

    for (const pointer of pointers) {
      seen.add(pointer.id);
      this.missingFrames.delete(pointer.id);
      this.scene.updateCursor(pointer);
      this.processPointer(pointer);
      this.processDwell(pointer);

      // Resaltar el instrumento que se cogería (si este puntero no sujeta nada).
      if (!this.held.has(pointer.id) && hoverCandidate === null) {
        hoverCandidate = this.scene.pickNearestInstrument(pointer.x, pointer.y);
      }
    }

    // Si algún puntero sujeta algo, el resaltado de "held" manda; no marcar hover.
    this.hovered = this.held.size > 0 ? null : hoverCandidate;
    this.scene.setHovered(this.hovered);

    // Punteros desaparecidos: con periodo de gracia si sujetan algo, para no
    // soltar el instrumento por un microcorte de detección de la mano.
    for (const id of this.activePointerIds) {
      if (seen.has(id)) continue;
      if (this.held.has(id)) {
        const missing = (this.missingFrames.get(id) ?? 0) + 1;
        this.missingFrames.set(id, missing);
        if (missing >= GrabController.RELEASE_GRACE) {
          this.releaseHeld(id, 0, 0, true);
          this.scene.removeCursor(id);
          this.missingFrames.delete(id);
        } else {
          seen.add(id); // mantener vivo durante la gracia
        }
      } else {
        this.scene.removeCursor(id);
        this.missingFrames.delete(id);
        this.dwell.delete(id);
      }
    }
    this.activePointerIds = seen;
  }

  /**
   * Dwell para inspeccionar con la mano: mano ABIERTA (sin pinza) y casi quieta
   * sobre el mismo instrumento durante DWELL_MS abre el visor. Publica el
   * progreso [0..1] como anillo. El ratón no usa dwell (usa clic).
   */
  private processDwell(pointer: Pointer): void {
    if (pointer.source !== 'hand' || pointer.isPinching || this.held.has(pointer.id)) {
      this.clearDwell(pointer.id);
      return;
    }
    // Radio propio, mucho más exigente que el de agarre: mirar pide puntería, coger no.
    const near = this.scene.pickForInspect(pointer.x, pointer.y);
    if (!near) {
      this.clearDwell(pointer.id);
      // Salir del instrumento es lo que rearma el disparo: sin esto, quedarse quieto donde estabas
      // reabría la ficha una y otra vez.
      this.lastInspected = null;
      return;
    }
    const now = performance.now();
    if (now < this.dwellBlockedUntil || near === this.lastInspected) {
      this.clearDwell(pointer.id);
      return;
    }
    const d = this.dwell.get(pointer.id);
    if (!d || d.id !== near || Math.hypot(pointer.x - d.x, pointer.y - d.y) > GrabController.DWELL_MOVE) {
      this.dwell.set(pointer.id, { id: near, startT: now, fired: false, x: pointer.x, y: pointer.y });
      this.scene.setDwell(pointer.id, 0);
      return;
    }
    const progress = Math.min(1, (now - d.startT) / GrabController.DWELL_MS);
    this.scene.setDwell(pointer.id, progress);
    if (progress >= 1 && !d.fired) {
      d.fired = true;
      this.lastInspected = d.id;
      this.onInspect(d.id);
    }
  }

  /**
   * Aviso de que se ha cerrado una ficha: arranca el enfriamiento.
   *
   * Lo llama el bucle principal. Sin esto, el dwell no se enteraba de nada y al cerrar volvía a
   * contar desde donde estaba la mano, que es exactamente donde acababa de disparar.
   */
  notifyInspectorClosed(): void {
    this.dwellBlockedUntil = performance.now() + GrabController.DWELL_COOLDOWN_MS;
    for (const id of this.dwell.keys()) this.clearDwell(id);
  }

  private clearDwell(pointerId: string): void {
    if (this.dwell.has(pointerId)) {
      this.dwell.delete(pointerId);
      this.scene.setDwell(pointerId, 0);
    }
  }

  private processPointer(pointer: Pointer): void {
    const was = this.wasPinching.get(pointer.id) ?? false;
    const now = pointer.isPinching;

    if (now && !was) {
      this.tryGrab(pointer);
    } else if (now && was) {
      this.dragHeld(pointer);
    } else if (!now && was) {
      this.releaseHeld(pointer.id, pointer.x, pointer.y);
    }

    this.wasPinching.set(pointer.id, now);
  }

  /**
   * Coge la pieza que está RESALTADA, no una recién elegida.
   *
   * Antes se volvía a preguntar por la más cercana en el instante del pellizco, y ahí está el
   * problema: el resaltado que el jugador ve se calculó con la posición del frame anterior, y al
   * cerrar los dedos la yema del índice se desplaza unos centímetros. Con dos piezas juntas eso
   * bastaba para coger una distinta de la que el juego estaba iluminando. Se coge lo prometido.
   */
  private tryGrab(pointer: Pointer): void {
    if (this.held.has(pointer.id)) return;
    const id = this.hovered ?? this.scene.pickNearestInstrument(pointer.x, pointer.y);
    if (!id) return;
    // Evita que dos punteros cojan el mismo instrumento.
    for (const state of this.held.values()) {
      if (state.instrumentId === id) return;
    }
    this.held.set(pointer.id, { instrumentId: id });
    this.scene.moveHeld(id, pointer.x, pointer.y);
    this.events.onGrab(id);
  }

  private dragHeld(pointer: Pointer): void {
    const state = this.held.get(pointer.id);
    if (!state) return;
    this.scene.moveHeld(state.instrumentId, pointer.x, pointer.y);
  }

  /**
   * Suelta lo que se lleva en la mano.
   *
   * `forcePool` existe por el camino de la mano perdida: allí no hay una posición real donde soltar
   * y antes se usaba el centro de la pantalla, que con la geometría actual cae dentro de la cubeta
   * de descartes. Un microcorte de la cámara habría descartado el instrumento sin que nadie lo
   * pidiera.
   */
  private releaseHeld(pointerId: string, x: number, y: number, forcePool = false): void {
    const state = this.held.get(pointerId);
    if (!state) return;
    this.held.delete(pointerId);

    const pedida = forcePool ? 'pool' : this.scene.zoneAt(x, y);
    // La zona real puede no ser la pedida si el recipiente está lleno.
    const real = this.scene.placeIn(state.instrumentId, pedida);
    this.events.onDrop(state.instrumentId, real);
  }
}
