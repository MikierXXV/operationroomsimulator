import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Instrument, Pointer } from '../types/contracts';
import { InstrumentFactory } from '../scene/InstrumentFactory';

/**
 * Visor modal de cercanía: muestra un instrumento en grande con su propio
 * mini-renderer three.js. Gira solo y se puede arrastrar para rotarlo. Reutiliza
 * `InstrumentFactory` (procedural o GLB). Se abre con clic (ratón) o dwell (mano).
 */
export class InstrumentInspector {
  private overlay: HTMLElement;
  private panel: HTMLElement;
  /** Botón de cerrar: también es diana de la pinza, no solo del ratón. */
  private closeBtn!: HTMLElement;
  private canvas: HTMLCanvasElement;
  private nameEl: HTMLElement;
  private descEl: HTMLElement;
  private hintEl: HTMLElement;
  /** Punto que sigue a la mano dentro del visor: sin él, «pellizca fuera» sería a ciegas. */
  private handCursor: HTMLElement;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private pivot = new THREE.Group();
  private factory = new InstrumentFactory();

  private open_ = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private velY = 0.01; // auto-rotación
  private rafId = 0;
  private onClose: () => void;
  /** Última posición de cada mano que está girando, en coordenadas normalizadas. */
  private handDrag = new Map<string, { x: number; y: number }>();
  /** Estado anterior de la pinza por mano, para detectar el flanco de cierre. */
  private wasPinching = new Map<string, boolean>();

  constructor(root: HTMLElement, onClose: () => void = () => {}) {
    this.onClose = onClose;

    this.overlay = document.createElement('div');
    this.overlay.className = 'inspector-overlay interactive';
    /*
     * La salida se señala en las FRANJAS LATERALES, no con un cartel encima del panel.
     *
     * Antes había un cartel arriba que decía «pellizca aquí fuera para cerrar». En una pantalla ancha
     * sobraba sitio arriba y funcionaba, pero en un móvil tumbado no: medido a 667×375, el panel mide
     * 464 px de alto y no cabe —se corta 45 px por arriba y otros 45 por abajo—, así que el cartel
     * acababa dibujado SOBRE el panel, señalando un punto donde pellizcar en realidad gira el modelo.
     * La indicación decía justo lo contrario de lo que hacía.
     *
     * El hueco libre está a los lados: 94 px a la izquierda y 93 a la derecha. Ahí es donde el
     * pellizco cierra de verdad, así que ahí es donde se dibuja la salida.
     *
     * Las franjas NO llevan lógica: pellizcar fuera del panel ya cerraba y hacer clic en el fondo
     * también. Solo enseñan dónde. Por eso van con `pointer-events: none` en el CSS; sin eso, un clic
     * sobre la franja tendría como diana la franja y no el overlay, y el cierre por clic —que
     * comprueba `e.target === this.overlay`— dejaría de funcionar.
     */
    this.overlay.innerHTML = `
      <div class="inspector-salida izq" aria-hidden="true"><span>🤏<br>Salir</span></div>
      <div class="inspector-panel">
        <button class="inspector-close" aria-label="Cerrar">✕</button>
        <canvas class="inspector-canvas"></canvas>
        <div class="inspector-name"></div>
        <div class="inspector-desc"></div>
        <div class="inspector-hint">Arrastra para girar</div>
      </div>
      <div class="inspector-salida der" aria-hidden="true"><span>🤏<br>Salir</span></div>
      <div class="inspector-hand" hidden></div>`;
    root.appendChild(this.overlay);

    this.panel = this.overlay.querySelector('.inspector-panel') as HTMLElement;
    this.closeBtn = this.overlay.querySelector('.inspector-close') as HTMLElement;
    this.canvas = this.overlay.querySelector('.inspector-canvas') as HTMLCanvasElement;
    this.nameEl = this.overlay.querySelector('.inspector-name') as HTMLElement;
    this.descEl = this.overlay.querySelector('.inspector-desc') as HTMLElement;
    this.hintEl = this.overlay.querySelector('.inspector-hint') as HTMLElement;
    this.handCursor = this.overlay.querySelector('.inspector-hand') as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#333333', 0.6));
    const key = new THREE.DirectionalLight('#ffffff', 1.4);
    key.position.set(2, 3, 2);
    this.scene.add(key);
    this.scene.add(this.pivot);
    this.camera.position.set(0, 0, 0.6);

    // Cierre.
    (this.overlay.querySelector('.inspector-close') as HTMLElement).onclick = () => this.close();
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close(); // clic en el fondo cierra
    });

    // Arrastre para girar.
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.rotateBy(dx, dy);
    });
    const endDrag = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    /*
     * Escape cierra. No existía ningún atajo de teclado en todo el proyecto, así que quien llegaba
     * con el teclado —o quien simplemente lo intenta por costumbre— se quedaba atrapado en el modal.
     */
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open_) {
        e.preventDefault();
        this.close();
      }
    });
  }

  /**
   * Manos dentro del visor: girar el modelo y cerrar.
   *
   * POR QUÉ HACE FALTA. Con el visor abierto, el bucle principal dejaba de procesar punteros por
   * completo, de modo que la mano ni siquiera movía el cursor: no es que faltara un gesto de
   * cierre, es que no llegaba ningún dato. Quien jugaba con las manos se quedaba encerrado en la
   * ficha y tenía que ir al ratón.
   *
   * Los dos gestos salen de la pinza que ya existe, sin inventar detección nueva:
   *  - pellizcar DENTRO del panel y arrastrar → girar, con la misma cuenta que el ratón;
   *  - pellizcar FUERA → cerrar, que es el equivalente del clic en el fondo.
   *
   * Se descartó «mano abierta» como gesto de cierre: la mano abierta es la postura de reposo, así
   * que la ficha se cerraría sola en cuanto alguien dejara de pellizcar.
   */
  handlePointers(pointers: Pointer[]): void {
    if (!this.open_) return;

    const manos = pointers.filter((p) => p.source === 'hand');
    this.handCursor.hidden = manos.length === 0;

    for (const p of manos) {
      const antes = this.wasPinching.get(p.id) ?? false;
      this.wasPinching.set(p.id, p.isPinching);

      // El cursor sigue a la primera mano; con dos, manda la que esté pellizcando.
      if (p === manos[0] || p.isPinching) {
        this.handCursor.style.left = `${p.x * window.innerWidth}px`;
        this.handCursor.style.top = `${p.y * window.innerHeight}px`;
        this.handCursor.classList.toggle('pinching', p.isPinching);
      }

      const sobreCerrar = this.isInside(this.closeBtn, p.x, p.y);
      const dentro = this.isInside(this.panel, p.x, p.y) && !sobreCerrar;

      // La ✕ se ilumina al apuntarla con la mano: sin esto no hay nada que diga que también es una
      // diana para la pinza, y es el sitio al que todo el mundo apunta primero para cerrar.
      if (p === manos[0] || p.isPinching) this.closeBtn.classList.toggle('apuntado', sobreCerrar);

      if (p.isPinching && !antes) {
        // Flanco de cierre de la pinza: aquí se decide si esto es girar o cerrar.
        if (!dentro) {
          // Fuera del panel o sobre la ✕: ambas cosas cierran. Apuntar al aspa es el gesto que sale
          // solo, y antes no hacía nada porque el aspa cae DENTRO del panel y contaba como girar.
          this.close();
          return;
        }
        this.handDrag.set(p.id, { x: p.x, y: p.y });
        this.dragging = true;
      } else if (p.isPinching && dentro) {
        const ultimo = this.handDrag.get(p.id);
        if (ultimo) {
          // A píxeles para reutilizar la misma sensibilidad que el arrastre con ratón.
          this.rotateBy((p.x - ultimo.x) * window.innerWidth, (p.y - ultimo.y) * window.innerHeight);
        }
        this.handDrag.set(p.id, { x: p.x, y: p.y });
      } else if (!p.isPinching && antes) {
        this.handDrag.delete(p.id);
        this.dragging = false;
      }
    }
  }

  /** ¿El punto normalizado cae dentro de ese elemento? */
  private isInside(el: HTMLElement, x: number, y: number): boolean {
    const r = el.getBoundingClientRect();
    const px = x * window.innerWidth;
    const py = y * window.innerHeight;
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }

  /** Giro compartido por el ratón y la mano, para que ambos se sientan igual. */
  private rotateBy(dx: number, dy: number): void {
    this.pivot.rotation.y += dx * 0.01;
    this.pivot.rotation.x = Math.max(-1.2, Math.min(1.2, this.pivot.rotation.x + dy * 0.01));
    this.velY = dx * 0.01;
  }

  isOpen(): boolean {
    return this.open_;
  }

  open(instrument: Instrument): void {
    // Limpia el modelo anterior.
    this.pivot.clear();
    this.pivot.rotation.set(0.2, 0, 0);
    this.velY = 0.01;

    // Anclado por el CENTRO y no por la base: aquí el modelo gira sobre sí mismo, y anclado por la
    // base el pivote caería en un extremo y la pieza bailaría en lugar de girar.
    const model = this.factory.create(instrument, { anchor: 'center' });
    this.pivot.add(model);

    this.nameEl.textContent = instrument.name;
    this.descEl.textContent = instrument.description ?? '';

    this.handDrag.clear();
    this.wasPinching.clear();
    this.overlay.classList.add('open');
    this.open_ = true;
    this.resize();
    if (!this.rafId) this.loop();
  }

  /**
   * Ajusta las pistas al modo de entrada: con manos, los gestos son otros.
   *
   * La clase en el overlay es lo que hace aparecer el cartel de cierre y resaltar la ✕: con ratón
   * sobran, porque para cerrar basta el clic de siempre.
   */
  setInputMode(mode: 'hands' | 'mouse'): void {
    this.overlay.classList.toggle('manos', mode === 'hands');
    this.hintEl.textContent =
      mode === 'hands'
        ? '🤏 Pellizca sobre el instrumento y arrastra para girarlo'
        : 'Arrastra para girar · Esc para cerrar';
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.handDrag.clear();
    this.wasPinching.clear();
    this.handCursor.hidden = true;
    this.closeBtn.classList.remove('apuntado');
    this.overlay.classList.remove('open');
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.pivot.clear();
    this.onClose();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 420;
    const h = this.canvas.clientHeight || 340;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (!this.open_) return;
    this.rafId = requestAnimationFrame(this.loop);

    // Encaje: centra el modelo y ajusta la distancia de cámara al tamaño real.
    const box = new THREE.Box3().setFromObject(this.pivot);
    if (!box.isEmpty()) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      // Recentra restando el centro (en espacio del pivot, aprox).
      const maxDim = Math.max(size.x, size.y, size.z) || 0.2;
      this.camera.position.z = maxDim * 2.2 + 0.05;
      this.camera.lookAt(center);
    }

    if (!this.dragging) {
      this.pivot.rotation.y += this.velY;
      // Fricción suave hacia la velocidad de auto-rotación.
      this.velY += (0.01 - this.velY) * 0.03;
    }
    this.renderer.render(this.scene, this.camera);
  };
}
