import type {
  AttemptSummary,
  EngineState,
  HudCallbacks,
  InputStatus,
  Instrument,
  Operation,
} from '../types/contracts';
import { desplazamientoARestaurar, type DesplazamientoGuardado } from './hudScroll';

const STATUS_LABEL: Record<InputStatus, string> = {
  idle: 'Iniciando…',
  'requesting-camera': 'Pidiendo cámara…',
  'camera-active': '🖐️ Manos activas',
  'camera-denied': '⚠️ Cámara denegada · usa el ratón',
  'camera-unavailable': '⚠️ Sin cámara · usa el ratón',
  'mouse-only': '🖱️ Modo ratón',
};

/**
 * HUD declarativo: recibe el estado del motor y lo pinta. Toda interacción sale
 * por HudCallbacks (no toca el motor directamente). Resuelve nombres de
 * instrumentos mediante `getInstrument`.
 */
export class Hud {
  private root: HTMLElement;
  private cb: HudCallbacks;
  private getInstrument: (id: string) => Instrument | undefined;
  private status: InputStatus = 'idle';
  private mode: 'hands' | 'mouse' = 'hands';
  private lastState: EngineState | null = null;
  private operations: Operation[] = [];
  private credited: Instrument[] = [];
  /** Atribución del decorado (el quirófano), separada de la del instrumental. */
  private sceneCredit: { nombre: string; author: string; license: string; url: string } | null = null;
  /** Nodo del cronómetro vivo; se refresca solo su texto, no el panel. */
  private timerEl: HTMLElement | null = null;
  private timerId = 0;
  /**
   * Acción «armada» a la espera del segundo gesto, y su temporizador de desarme.
   *
   * Existe porque con las manos un pellizco se escapa con facilidad —basta rozar el gesto al mover
   * la mano por delante del panel— y las acciones que cierran la partida no pueden dispararse por
   * accidente. Con ratón no se arma nada: un clic ya es deliberado.
   */
  private armado: string | null = null;
  private armadoTimer = 0;

  constructor(
    root: HTMLElement,
    getInstrument: (id: string) => Instrument | undefined,
    cb: HudCallbacks,
  ) {
    this.root = root;
    this.getInstrument = getInstrument;
    this.cb = cb;
  }

  setOperations(operations: Operation[]): void {
    this.operations = operations;
  }

  /** Registra los instrumentos con atribución (GLB CC-BY) para el panel de créditos. */
  setCredits(instruments: Instrument[]): void {
    this.credited = instruments.filter((i) => i.credit);
  }

  /**
   * Atribución del decorado, aparte de la del instrumental.
   *
   * El quirófano es un modelo de terceros con licencia CC BY, y esa licencia **obliga** a citarlo.
   * Va por su lado porque no es un instrumento: no está en el catálogo ni tiene nada que ver con el
   * juego, pero tiene que salir en el mismo panel.
   */
  setSceneCredit(nombre: string, credito: { author: string; license: string; url: string } | null): void {
    this.sceneCredit = credito ? { nombre, ...credito } : null;
    this.render(this.lastState);
  }

  setStatus(status: InputStatus): void {
    this.status = status;
    if (status === 'mouse-only' || status === 'camera-denied' || status === 'camera-unavailable') {
      this.mode = 'mouse';
    } else if (status === 'camera-active') {
      this.mode = 'hands';
    }
    this.render(this.lastState);
  }

  /**
   * Refresco del cronómetro, independiente del repintado.
   *
   * Va a un intervalo propio y toca solo el texto del nodo. Emitir un estado nuevo cada segundo para
   * que se repintara el panel entero relanzaría la animación `pop` de todo el checklist a cada tic.
   */
  private arrancarCronometro(): void {
    if (this.timerId) return;
    this.timerId = window.setInterval(() => {
      if (this.lastState?.phase !== 'preparing' || !this.timerEl) return;
      this.timerEl.textContent = formatTime(this.cb.getElapsedMs());
    }, 500);
  }

  /**
   * Botón de doble confirmación con la mano.
   *
   * Primer pellizco: se arma y cambia el texto. Segundo: actúa. Se desarma solo a los 4 s, para que
   * un botón no se quede indefinidamente «a un gesto» de terminar la partida.
   */
  private botonConfirmable(
    clase: string,
    texto: string,
    textoArmado: string,
    accion: () => void,
  ): HTMLButtonElement {
    const estaArmado = this.armado === texto;
    const btn = el(
      'button',
      `${clase}${estaArmado ? ' armado' : ''}`,
      estaArmado ? textoArmado : texto,
    ) as HTMLButtonElement;
    btn.onclick = () => {
      if (this.mode !== 'hands' || estaArmado) {
        this.desarmar();
        accion();
        return;
      }
      this.armar(texto);
    };
    return btn;
  }

  private armar(texto: string): void {
    window.clearTimeout(this.armadoTimer);
    this.armado = texto;
    this.armadoTimer = window.setTimeout(() => {
      this.armado = null;
      this.render(this.lastState);
    }, 4000);
    this.render(this.lastState);
  }

  private desarmar(): void {
    window.clearTimeout(this.armadoTimer);
    this.armado = null;
  }

  render(state: EngineState | null): void {
    /*
     * Se anota dónde estaba la lista ANTES de tirar el HUD.
     *
     * Rehacer el panel con `innerHTML = ''` devuelve el desplazamiento a cero, y con la bandeja llena
     * eso obliga a bajar 686 px otra vez solo para confirmar «He terminado». Se toma aquí, antes de
     * pisar `lastState`, porque hace falta la fase VIEJA para saber si la nueva es la misma pantalla.
     */
    const panelPrevio = this.root.querySelector('.hud-panel');
    const guardado: DesplazamientoGuardado | null = panelPrevio
      ? { fase: this.lastState?.phase ?? 'menu', scrollTop: panelPrevio.scrollTop }
      : null;

    this.lastState = state;
    this.timerEl = null;
    this.arrancarCronometro();
    // Con las manos, las dianas tienen que ser mucho más grandes: el puntero va suavizado y tiembla.
    this.root.classList.toggle('modo-manos', this.mode === 'hands');
    this.root.innerHTML = '';
    this.root.appendChild(this.topBar());

    if (!state || state.phase === 'menu') {
      this.root.appendChild(this.menu(state));
    } else if (state.phase === 'preparing') {
      this.root.appendChild(this.preparing(state));
    } else if (state.phase === 'result') {
      this.root.appendChild(this.result(state));
    }

    if (this.mode === 'hands') this.root.appendChild(this.avisoGestos(state));
    if (this.credited.length || this.sceneCredit) this.root.appendChild(this.credits());

    // Y se devuelve al sitio, ya con el panel nuevo medido. Ver `hudScroll.ts`.
    const panelNuevo = this.root.querySelector('.hud-panel');
    if (panelNuevo) {
      panelNuevo.scrollTop = desplazamientoARestaurar(
        guardado,
        state?.phase ?? 'menu',
        panelNuevo.scrollHeight - panelNuevo.clientHeight,
      );
    }
  }

  /**
   * Cartel de gestos, al estilo del «pellizca aquí fuera para cerrar» de la ficha.
   *
   * Los gestos no se descubren solos: la pinza para pulsar y los dos dedos para desplazar no están
   * escritos en ninguna parte, y sin decirlo el jugador se queda mirando el panel sin saber qué
   * hacer. El texto cambia según la fase porque lo que hace falta saber en el menú no es lo mismo
   * que en plena mesa ni ante el resultado.
   */
  private avisoGestos(state: EngineState | null): HTMLElement {
    const fase = state?.phase ?? 'menu';
    const armado = this.armado !== null;

    let texto: string;
    let clase = 'gestos-aviso';
    if (armado) {
      texto = '🤏 Pellizca otra vez para confirmar';
      clase += ' urgente';
    } else if (fase === 'result') {
      texto = '🤏 Pellizca una opción para elegirla';
    } else if (fase === 'preparing') {
      texto = '🤏 Pellizca «He terminado» dos veces para acabar · ✌ Dos dedos para desplazar la lista';
    } else {
      texto = '🤏 Pellizca un nivel · ✌ Dos dedos para desplazar · ✋ Abre y cierra la mano para el historial';
    }

    const aviso = el('div', clase);
    aviso.innerHTML = texto;
    return aviso;
  }

  /**
   * Panel plegable de créditos/atribución de los modelos GLB (CC-BY).
   *
   * Se agrupa por modelo de origen, no por instrumento: un mismo fichero puede dar varias piezas
   * (los sets de instrumental vienen así), y listarlo una vez por pieza repetiría cinco veces el
   * mismo autor y haría creer que hay cinco modelos donde hay uno.
   */
  private credits(): HTMLElement {
    const porModelo = new Map<string, { autor: string; licencia: string; piezas: string[] }>();
    for (const inst of this.credited) {
      const c = inst.credit!;
      let entrada = porModelo.get(c.url);
      if (!entrada) {
        entrada = { autor: c.author, licencia: c.license, piezas: [] };
        porModelo.set(c.url, entrada);
      }
      entrada.piezas.push(inst.name);
    }
    // El decorado entra en el mismo agrupado: la CC BY obliga a citarlo igual que al instrumental.
    if (this.sceneCredit) {
      const s = this.sceneCredit;
      porModelo.set(s.url, { autor: s.author, licencia: s.license, piezas: [s.nombre] });
    }

    const details = el('details', 'hud-credits interactive') as HTMLDetailsElement;
    details.appendChild(el('summary', '', `Créditos de modelos (${porModelo.size})`));
    for (const [url, m] of porModelo) {
      const row = el('div', 'hud-credit-row');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `${m.autor} (${m.licencia})`;
      row.append(a, document.createTextNode(` — ${m.piezas.join(', ')}`));
      details.appendChild(row);
    }
    return details;
  }

  // --- Secciones ---------------------------------------------------------

  private topBar(): HTMLElement {
    const bar = el('div', 'hud-topbar');
    const title = el('div', 'hud-title', '🏥 Simulador de Instrumentista');

    const right = el('div', 'hud-topbar-right interactive');
    const statusEl = el('span', 'hud-status', STATUS_LABEL[this.status]);

    const toggle = el('button', 'hud-toggle') as HTMLButtonElement;
    toggle.textContent = this.mode === 'hands' ? 'Usar ratón' : 'Usar manos';
    toggle.onclick = () => {
      const next = this.mode === 'hands' ? 'mouse' : 'hands';
      this.cb.onToggleInput(next);
    };

    right.append(statusEl, toggle);
    bar.append(title, right);
    return bar;
  }

  /**
   * Menú de niveles.
   *
   * Cada tarjeta lleva su mejor marca: sin eso, «pasar a otro nivel» sería solo cambiar de pantalla
   * y no habría ninguna razón para volver a intentar uno ya jugado.
   */
  private menu(state: EngineState | null): HTMLElement {
    const panel = el('div', 'hud-panel hud-menu interactive');
    panel.appendChild(el('h2', '', 'Elige un nivel'));
    panel.appendChild(el('p', 'hud-dim', 'Prepara la mesa con los instrumentos correctos.'));

    const list = el('div', 'hud-oplist');
    this.operations.forEach((op, i) => {
      const piezas = new Set([
        ...op.required,
        ...(op.optional ?? []),
        ...(op.distractors ?? []),
      ]).size;
      const p = this.cb.getProgress(op.id);

      const card = el('button', `hud-opcard ${p?.passed ? 'superado' : ''}`) as HTMLButtonElement;
      const cabecera = el('div', 'hud-opcard-cab');
      cabecera.append(
        el('span', 'hud-nivel', `Nivel ${op.level ?? i + 1}`),
        el('strong', '', op.name),
      );
      card.appendChild(cabecera);
      card.appendChild(
        el('span', '', `${op.specialty ?? ''} · ${op.required.length} obligatorios de ${piezas}`),
      );

      const marca = el('span', 'hud-marca');
      if (!p) {
        marca.textContent = 'Sin intentar';
      } else {
        const t = p.bestTimeMs !== null ? ` · ⏱ ${formatTime(p.bestTimeMs)}` : '';
        marca.innerHTML = `${p.passed ? '✔ ' : ''}Mejor: <b>${p.bestScore}/100</b>${t}`;
      }
      card.appendChild(marca);

      card.onclick = () => this.cb.onSelectOperation(op.id);

      // La tarjeta es un <button>; el historial NO puede ir dentro (anidar controles en un botón es
      // HTML inválido y rompe el clic). Van hermanados dentro de un contenedor.
      const bloque = el('div', 'hud-nivel-bloque');
      bloque.appendChild(card);
      if (p?.history.length) bloque.appendChild(this.historial(p.history));
      list.appendChild(bloque);
    });
    panel.appendChild(list);
    void state;
    return panel;
  }

  /**
   * Historial de intentos de un nivel, plegado.
   *
   * Plegado y no siempre visible porque son hasta diez filas por nivel y el menú se volvería
   * ilegible; pero presente, porque es lo que hace que fallar y salirse al menú deje constancia en
   * vez de desaparecer.
   */
  private historial(history: AttemptSummary[]): HTMLElement {
    const det = el('details', 'hud-historial') as HTMLDetailsElement;
    det.appendChild(el('summary', '', `Historial (${history.length})`));
    const tabla = el('div', 'hud-historial-tabla');
    history.forEach((h, i) => {
      const fila = el('div', `hud-historial-fila ${h.passed ? 'ok' : ''}`);
      const fallos = h.passed
        ? 'Mesa correcta'
        : [h.missing ? `faltaban ${h.missing}` : '', h.wrong ? `sobraba${h.wrong > 1 ? 'n' : ''} ${h.wrong}` : '']
            .filter(Boolean)
            .join(', ') || 'sin fallos contados';
      fila.append(
        el('span', 'hud-historial-n', `#${history.length - i}`),
        el('span', 'hud-historial-nota', `${h.score}/100`),
        el('span', 'hud-historial-t', formatTime(h.elapsedMs)),
        el('span', 'hud-historial-det', fallos),
      );
      tabla.appendChild(fila);
    });
    det.appendChild(tabla);
    return det;
  }

  /**
   * Panel de juego, DELIBERADAMENTE MUDO sobre si aciertas.
   *
   * Antes esto era media respuesta al examen: listaba por su nombre los instrumentos obligatorios,
   * los marcaba con ✔ según iban cayendo en la bandeja, llevaba una barra con el porcentaje de
   * aciertos y avisaba con «⚠ Sobra en la mesa» de cada pieza equivocada. Se podía resolver un
   * nivel sin saber nada de instrumental: bastaba poner cosas hasta que todo se pusiera verde.
   *
   * Ahora solo se muestra LO QUE HAS PUESTO TÚ, sin juicio: sirve para repasar tu propia mesa sin
   * mirar la escena, pero no dice si está bien. La corrección llega al terminar, que es cuando
   * enseña algo.
   */
  private preparing(state: EngineState): HTMLElement {
    const panel = el('div', 'hud-panel hud-prep interactive');
    const op = state.operation!;
    panel.appendChild(el('h2', '', op.name));
    if (op.briefing) panel.appendChild(el('p', 'hud-dim', op.briefing));

    const cabecera = el('div', 'hud-sub hud-sub-fila');
    cabecera.appendChild(el('span', '', `En la bandeja (${state.tray.length})`));
    // El cronómetro se guarda aparte para poder refrescar SOLO su texto cada segundo, sin repintar
    // el panel entero (ver `arrancarCronometro`).
    this.timerEl = el('span', 'hud-timer', formatTime(this.cb.getElapsedMs()));
    cabecera.appendChild(this.timerEl);
    panel.appendChild(cabecera);

    if (state.tray.length === 0) {
      panel.appendChild(
        el('p', 'hud-dim', 'Arrastra a la bandeja los instrumentos que creas necesarios.'),
      );
    } else {
      const lista = el('div', 'hud-checklist');
      for (const id of state.tray) {
        // Sin marca, sin color y sin orden que insinúe nada: mismo aspecto para todos, acierten o no.
        const item = el('div', 'hud-check hud-check-neutro') as HTMLElement;
        item.innerHTML = `<span class="mark">•</span> <span class="name">${this.getInstrument(id)?.name ?? id}</span>`;
        // Solo abrir la ficha: el destello en la mesa lo dispara `main.ts` al CERRARLA, que es
        // cuando se puede ver. Iluminarla ahora sería iluminar algo tapado por el propio visor.
        item.title = 'Clic para verlo de cerca y localizarlo en la mesa';
        item.onclick = () => this.cb.onInspectInstrument(id);
        lista.appendChild(item);
      }
      panel.appendChild(lista);
    }

    const actions = el('div', 'hud-actions');
    /*
     * «He terminado» es una declaración del usuario —creo que ya está— y se puntúa lo que haya,
     * acierte o no. Ya no se resalta al completar la mesa: ese resaltado era otra pista, decía
     * «ahora sí» sin que nadie lo preguntara.
     *
     * Las dos acciones cierran la partida, así que con la mano piden un segundo gesto.
     */
    const validate = this.botonConfirmable(
      'hud-btn primary',
      'He terminado',
      '¿Seguro? Pellizca otra vez',
      () => this.cb.onValidate(),
    );
    // Antes esto llamaba a onReset(), que no cambiaba de operación: vaciaba la mesa y dejaba la
    // misma. El botón hacía algo destructivo y distinto de lo que decía.
    const back = this.botonConfirmable(
      'hud-btn',
      'Cambiar nivel',
      '¿Seguro? Se pierde la mesa',
      () => this.cb.onSelectOperation(''),
    );
    actions.append(validate, back);
    panel.appendChild(actions);

    return panel;
  }

  /**
   * Resultado como modal centrado, no como panel lateral.
   *
   * Terminar es un momento del juego, no un estado más del panel: merece ocupar el centro y detener
   * la vista. El ancho es el de la ficha de instrumento, así que la bandeja recién preparada sigue
   * viéndose alrededor mientras se leen los fallos.
   */
  private result(state: EngineState): HTMLElement {
    const overlay = el('div', 'hud-modal-overlay');
    const panel = el('div', 'hud-modal interactive');
    overlay.appendChild(panel);
    const r = state.result!;
    const op = state.operation!;

    panel.appendChild(el('div', 'hud-modal-titulo', op.name));
    const scoreEl = el('div', `hud-score ${r.passed ? 'ok' : 'bad'}`);
    scoreEl.innerHTML = `${r.score}<span>/100</span>`;
    panel.appendChild(scoreEl);
    panel.appendChild(
      el('p', r.passed ? 'hud-ok' : 'hud-bad', r.passed ? '✅ Mesa correcta' : '❌ Revisa la mesa'),
    );

    // Tiempo e intento, juntos: la nota sola no dice si se tardó dos minutos o veinte, ni si se
    // acertó a la primera o a la cuarta, que es la mitad de lo que se está midiendo.
    const meta = el('div', 'hud-meta');
    if (r.elapsedMs !== undefined) {
      meta.appendChild(chip(`⏱ ${formatTime(r.elapsedMs)}`));
    }
    if (r.attempts !== undefined) {
      meta.appendChild(chip(r.attempts === 1 ? 'A la primera' : `Intento ${r.attempts}`));
    }
    if (meta.childElementCount) panel.appendChild(meta);

    if (r.missing.length) {
      panel.appendChild(el('div', 'hud-sub', 'Faltan:'));
      panel.appendChild(this.idList(r.missing, 'missing'));
    }
    if (r.wrong.length) {
      panel.appendChild(el('div', 'hud-sub', 'Sobran (no deberían estar):'));
      panel.appendChild(this.idList(r.wrong, 'wrong'));
    }

    const siguiente = this.cb.getNextOperation();
    const actions = el('div', 'hud-actions hud-actions-col');

    /*
     * El botón principal depende de cómo haya ido, porque lo que se quiere hacer después no es lo
     * mismo: si la mesa está mal, corregirla; si está bien, seguir avanzando.
     *
     * «Corregir la mesa» conserva lo colocado (`onResume`). Esto era lo que faltaba: el antiguo
     * «Reintentar» llamaba a `onReset` y borraba los once instrumentos por dos fallos.
     */
    if (!r.passed) {
      const corregir = el('button', 'hud-btn primary', '↩ Corregir la mesa') as HTMLButtonElement;
      corregir.onclick = () => this.cb.onResume();
      actions.appendChild(corregir);
    }

    if (siguiente) {
      const clase = r.passed ? 'hud-btn primary' : 'hud-btn';
      const next = el('button', clase, `Nivel ${siguiente.level ?? ''} · ${siguiente.name} →`) as HTMLButtonElement;
      next.onclick = () => this.cb.onNextLevel();
      actions.appendChild(next);
    } else if (r.passed) {
      panel.appendChild(el('p', 'hud-ok', '🏆 Has completado todos los niveles.'));
    }

    if (r.passed) {
      const repetir = el('button', 'hud-btn', 'Repetir nivel') as HTMLButtonElement;
      repetir.onclick = () => this.cb.onReset();
      actions.appendChild(repetir);
    }

    const menu = el('button', 'hud-btn', 'Menú de niveles') as HTMLButtonElement;
    menu.onclick = () => this.cb.onSelectOperation('');
    actions.appendChild(menu);
    panel.appendChild(actions);

    return overlay;
  }

  private idList(ids: string[], kind: string): HTMLElement {
    const list = el('div', `hud-idlist ${kind}`);
    for (const id of ids) {
      list.appendChild(el('span', 'hud-chip', this.getInstrument(id)?.name ?? id));
    }
    return list;
  }
}

/**
 * Milisegundos a `m:ss`, o `h:mm:ss` si la cosa se alarga.
 *
 * Sin relleno a dos dígitos en los minutos: «2:07» se lee de un vistazo mejor que «02:07», y aquí
 * lo normal es tardar minutos, no horas.
 */
function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function chip(text: string): HTMLElement {
  return el('span', 'hud-chip', text);
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
