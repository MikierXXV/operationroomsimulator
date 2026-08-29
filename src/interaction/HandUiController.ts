import type { HandShape, Pointer } from '../types/contracts';

/**
 * Manos sobre la interfaz de DOM: menú, lista de instrumentos y botones.
 *
 * POR QUÉ EXISTE. El HUD es DOM y el cursor de la mano es un anillo 3D que se proyecta sobre el
 * plano de la mesa (`SceneManager.updateCursor`). Sobre el panel, ese anillo cae DETRÁS del panel,
 * así que apuntar a un botón con la mano era literalmente imposible: no había forma de saber a qué
 * estabas señalando ni de pulsarlo. Quien jugaba con las manos se quedaba sin menú y sin botones, y
 * tenía que ir al ratón para cualquier cosa que no fuera mover instrumentos.
 *
 * CÓMO FUNCIONA. No sintetiza eventos de puntero ni duplica la lógica del HUD: localiza el elemento
 * bajo la mano con `document.elementFromPoint` y, al pellizcar, le llama a `click()`. Los
 * manejadores que ya tiene `Hud.ts` se reutilizan tal cual.
 *
 * La pieza que lo hace limpio es que **`elementFromPoint` respeta `pointer-events: none`**. Como
 * `#hud` lo tiene puesto y solo los botones y los paneles `.interactive` lo reactivan, preguntar por
 * el elemento bajo la mano ya distingue «estoy sobre la interfaz» de «estoy sobre la mesa» sin
 * mantener a mano una lista de rectángulos que se desincronizaría al primer cambio de diseño.
 */

/** Lo que se considera pulsable. `[data-mano]` deja marcar cualquier cosa a futuro. */
const DIANAS = 'button, .hud-check, summary, a[href], [data-mano]';

export class HandUiController {
  private cursor: HTMLElement;
  /** Estado anterior de la pinza por mano, para detectar el flanco y no repetir el clic. */
  private wasPinching = new Map<string, boolean>();
  /** Diana resaltada ahora mismo; se guarda para poder quitarle la clase al salir. */
  private resaltada: Element | null = null;
  /** Y de la mano en el frame anterior mientras dura el gesto de dos dedos, para el desplazamiento. */
  private scrollPrevY: number | null = null;
  /** Última velocidad y contenedor, para seguir deslizando al levantar los dedos. */
  private scrollVel = 0;
  private scrollEl: HTMLElement | null = null;
  private scrollRaf = 0;
  /** Postura de la mano en el frame anterior, para detectar el flanco puño↔abierta. */
  private formaPrevia: HandShape = 'other';

  constructor(root: HTMLElement) {
    this.cursor = document.createElement('div');
    this.cursor.className = 'hand-cursor';
    this.cursor.hidden = true;
    root.appendChild(this.cursor);
  }

  /**
   * Procesa los punteros y devuelve `true` si se los queda.
   *
   * Devolver un booleano en lugar de actuar en silencio es lo que permite a `main.ts` decidir el
   * enrutado: si la interfaz se ha quedado los punteros, el agarre no debe verlos.
   */
  update(pointers: Pointer[]): boolean {
    // El ratón ya interactúa con el DOM por su cuenta; aquí solo se atienden manos.
    const manos = pointers.filter((p) => p.source === 'hand');
    if (manos.length === 0) {
      this.reposo();
      return false;
    }

    // Manda la que esté pellizcando; si ninguna, la primera. Con dos manos en cuadro, la que actúa
    // es la que hace el gesto, no la que pasaba por ahí.
    const mano = manos.find((p) => p.isPinching) ?? manos[0];
    const px = mano.x * window.innerWidth;
    const py = mano.y * window.innerHeight;

    const bajoLaMano = document.elementFromPoint(px, py);
    const sobreUi = esInterfaz(bajoLaMano);
    if (!sobreUi) {
      this.reposo();
      // Importante: se olvida el estado de pinza al salir de la interfaz. Si no, entrar en el panel
      // con la mano ya cerrada contaría como flanco y pulsaría lo primero que hubiera debajo.
      this.wasPinching.clear();
      return false;
    }

    this.cursor.hidden = false;
    this.cursor.style.left = `${px}px`;
    this.cursor.style.top = `${py}px`;
    this.cursor.classList.toggle('pinching', mano.isPinching);

    /*
     * Dos dedos: desplazar la lista, como en un trackpad.
     *
     * Manda sobre el resaltado y el clic. Mientras se desplaza no se está apuntando a nada, y dejar
     * la diana encendida invitaría a pellizcar justo cuando la lista se está moviendo debajo.
     */
    /*
     * Puño ↔ mano abierta: desplegar o plegar los historiales del menú.
     *
     * Se ignora mientras se pellizca: un pellizco se clasifica como puño —comprobado con manos
     * reales—, así que sin esta condición cada clic con la mano plegaría además los historiales.
     */
    this.gestoHistoriales(mano.isPinching ? 'other' : mano.handShape ?? 'other');

    if (mano.handShape === 'two-fingers') {
      this.resaltar(null);
      this.cursor.classList.add('dos-dedos');
      const contenedor = contenedorDesplazable(bajoLaMano);
      if (contenedor && this.scrollPrevY !== null) {
        // Factor bajado de 1.6 a 1.15: con 1.6 un gesto normal se comía la lista entera y había que
        // buscar hacia atrás. Y se guarda la velocidad para poder soltar con inercia.
        const delta = (py - this.scrollPrevY) * -1.15;
        contenedor.scrollTop += delta;
        this.scrollVel = delta;
        this.scrollEl = contenedor;
      }
      this.scrollPrevY = py;
      // Se olvida la pinza: pasar de dos dedos a pinza no debe contar como flanco y pulsar algo.
      this.wasPinching.clear();
      return true;
    }
    this.cursor.classList.remove('dos-dedos');
    this.soltarConInercia();

    const diana = bajoLaMano?.closest(DIANAS) ?? null;
    this.resaltar(diana);

    /*
     * LA PINZA MANDA SOBRE LA FORMA. Aquí ya no se descarta nada por parecer un puño.
     *
     * Medido con una mano real: de 50 muestras, 30 estaban pellizcando y las 30 se clasificaron
     * como `fist`. Al pellizcar, el índice se curva y los demás se recogen, así que un pellizco y un
     * puño son casi indistinguibles por la postura de los dedos —y el umbral que probé para
     * separarlos no aguanta con landmarks de verdad—.
     *
     * Filtrar por forma dejaba la interfaz sin poder pulsar nada con la mano, igual que había dejado
     * el juego sin poder coger. Si las yemas se tocan, es un clic.
     */
    const pellizcando = mano.isPinching;
    const antes = this.wasPinching.get(mano.id) ?? false;
    this.wasPinching.set(mano.id, pellizcando);
    // Solo el flanco de subida: mantener la pinza no repite el clic.
    if (pellizcando && !antes && diana instanceof HTMLElement) {
      diana.classList.add('mano-pulsado');
      window.setTimeout(() => diana.classList.remove('mano-pulsado'), 220);
      diana.click();
    }

    return true;
  }

  /** Oculta el cursor y suelta el resaltado. Se llama también al cerrar el modal o cambiar de modo. */
  reposo(): void {
    this.cursor.hidden = true;
    this.cursor.classList.remove('pinching', 'dos-dedos');
    this.soltarConInercia();
    this.resaltar(null);
  }

  /**
   * Puño ↔ mano abierta: pliega o despliega los historiales del menú.
   *
   * Se dispara en el FLANCO —al llegar a la postura— y no por estar en ella. Es imprescindible:
   * la mano abierta es la postura de reposo, así que reaccionar al estado abriría los historiales
   * continuamente mientras la mano descansa en cuadro.
   *
   * Y solo actúa si hay historiales en pantalla, lo que lo limita al menú por sí solo: durante la
   * partida, abrir la mano sobre la mesa no hace nada. No hace falta pasarle la fase del juego.
   */
  private gestoHistoriales(forma: HandShape): void {
    const anterior = this.formaPrevia;
    this.formaPrevia = forma;
    if (forma === anterior) return;
    if (forma !== 'open' && forma !== 'fist') return;
    // De 'other' a 'open' no cuenta: abrir la mano tiene que venir de un puño para ser deliberado.
    if (forma === 'open' && anterior !== 'fist') return;

    const historiales = document.querySelectorAll<HTMLDetailsElement>('.hud-historial');
    if (historiales.length === 0) return;
    historiales.forEach((d) => (d.open = forma === 'open'));
  }

  /**
   * Al levantar los dedos, la lista sigue deslizando y frena poco a poco.
   *
   * Sin esto se paraba en seco en cuanto el gesto se deshacía —o en cuanto la detección perdía un
   * frame—, que es justo la sensación de que «la lista se atasca». Con rozamiento, el gesto se
   * termina solo y perdona los microcortes de la cámara.
   */
  private soltarConInercia(): void {
    this.scrollPrevY = null;
    if (this.scrollRaf || !this.scrollEl || Math.abs(this.scrollVel) < 0.6) {
      this.scrollVel = 0;
      return;
    }
    const paso = (): void => {
      this.scrollVel *= 0.92; // rozamiento
      if (!this.scrollEl || Math.abs(this.scrollVel) < 0.4) {
        this.scrollRaf = 0;
        this.scrollVel = 0;
        return;
      }
      this.scrollEl.scrollTop += this.scrollVel;
      this.scrollRaf = requestAnimationFrame(paso);
    };
    this.scrollRaf = requestAnimationFrame(paso);
  }

  private resaltar(diana: Element | null): void {
    if (this.resaltada === diana) return;
    this.resaltada?.classList.remove('mano-encima');
    diana?.classList.add('mano-encima');
    this.resaltada = diana;
  }
}

/**
 * ¿Ese elemento pertenece a la interfaz?
 *
 * Se responde que sí para CUALQUIER cosa del HUD, no solo para los botones. Si solo contaran las
 * dianas, un pellizco sobre el fondo del panel se le pasaría al agarre y cogería el instrumento que
 * hay detrás del panel, que es un efecto desconcertante: la mano está sobre una superficie opaca y
 * aun así pasa algo en la mesa.
 */
/**
 * Sube por los antepasados hasta encontrar algo que de verdad pueda desplazarse.
 *
 * No basta con `overflow: auto` en el CSS: si el contenido cabe entero, ese elemento no scrollea y
 * mover la mano no haría nada aunque el panel de más arriba sí tuviera barra. Por eso se exige
 * `scrollHeight > clientHeight`.
 */
function contenedorDesplazable(desde: Element | null): HTMLElement | null {
  let el = desde as HTMLElement | null;
  while (el && el !== document.body) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function esInterfaz(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO') return false;
  return Boolean(el.closest('#hud, .inspector-overlay, .hud-credits'));
}
