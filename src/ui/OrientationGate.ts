/**
 * Capa que pide girar el dispositivo cuando el área jugable no cabe en la ventana.
 *
 * POR QUÉ EXISTE. La mesa mide 3,2 m de ancho y está pensada para una pantalla apaisada. En vertical
 * no hay ángulo de cámara que la meta en cuadro: medido en un móvil de 390×844, el borde izquierdo de
 * la bandeja cae en x=-0,67 —a dos tercios de pantalla FUERA— y el pool se sale por el mismo lado.
 * No es que se vea pequeño: es que media zona de juego no está.
 *
 * POR QUÉ NO PREGUNTA SI ES UN MÓVIL. Lo que rompe la partida es la PROPORCIÓN de la ventana, no el
 * aparato. Una tablet en vertical (1024×1366) se rompe igual —bandeja en x=-0,224— y una ventana de
 * escritorio estrecha y alta también. Por eso la condición la da `SceneManager.encuadreCompleto()`,
 * que es cierto exactamente cuando el encuadre ha tenido que recortar contra su tope; así el aviso
 * sigue siendo correcto aunque algún día cambien las medidas de la mesa.
 */

export interface OrientationGateEvents {
  /** Se llama al tapar y al destapar. Sirve para parar y reanudar el cronómetro. */
  onCambio(tapado: boolean): void;
}

export class OrientationGate {
  private el: HTMLElement;
  private events: OrientationGateEvents;
  private tapado = false;
  private cabe: () => boolean;

  constructor(raiz: HTMLElement, cabe: () => boolean, events: OrientationGateEvents) {
    this.cabe = cabe;
    this.events = events;
    this.el = document.createElement('div');
    this.el.className = 'girar-aviso';
    this.el.setAttribute('role', 'alertdialog');
    this.el.innerHTML = `
      <div class="girar-caja">
        <div class="girar-icono" aria-hidden="true">📱</div>
        <h2>Gira el dispositivo</h2>
        <p>La mesa del instrumentista es ancha y necesita la pantalla en horizontal.</p>
        <p class="girar-alternativa">Si estás en un ordenador, ensancha la ventana.</p>
      </div>`;
    raiz.appendChild(this.el);
    this.actualizar();

    window.addEventListener('resize', this.actualizar);
    // `resize` no siempre llega al girar en iOS; `orientationchange` sí.
    window.addEventListener('orientationchange', this.actualizar);
  }

  /**
   * Recalcula si hay que tapar.
   *
   * Se aplaza un fotograma porque al girar, `SceneManager` recalcula su encuadre en su propio
   * manejador de `resize`, y preguntarle antes daría la respuesta de la orientación anterior.
   */
  private actualizar = (): void => {
    requestAnimationFrame(() => {
      const debeTapar = !this.cabe();
      if (debeTapar === this.tapado) return;
      this.tapado = debeTapar;
      this.el.classList.toggle('visible', debeTapar);
      this.events.onCambio(debeTapar);
    });
  };

  /** ¿Está tapada la partida ahora mismo? */
  estaTapado(): boolean {
    return this.tapado;
  }
}
