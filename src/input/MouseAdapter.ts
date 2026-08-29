import type { Pointer } from '../types/contracts';

/**
 * Adaptador de ratón/táctil: convierte el movimiento y el botón/toque en un
 * único Pointer con la misma forma que emite el hand-tracker. Es el fallback
 * cuando no hay cámara y también sirve para testear la lógica de grab.
 */
export class MouseAdapter {
  private el: HTMLElement;
  private pointer: Pointer = {
    id: 'mouse',
    x: 0.5,
    y: 0.5,
    isPinching: false,
    source: 'mouse',
  };
  private active = false;
  private onUpdate: (p: Pointer | null) => void;

  constructor(el: HTMLElement, onUpdate: (p: Pointer | null) => void) {
    this.el = el;
    this.onUpdate = onUpdate;
  }

  start(): void {
    this.active = true;
    this.el.addEventListener('pointermove', this.handleMove);
    this.el.addEventListener('pointerdown', this.handleDown);
    window.addEventListener('pointerup', this.handleUp);
  }

  stop(): void {
    this.active = false;
    this.el.removeEventListener('pointermove', this.handleMove);
    this.el.removeEventListener('pointerdown', this.handleDown);
    window.removeEventListener('pointerup', this.handleUp);
    this.onUpdate(null);
  }

  private handleMove = (e: PointerEvent) => {
    if (!this.active) return;
    this.pointer = {
      ...this.pointer,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    };
    this.onUpdate(this.pointer);
  };

  private handleDown = (e: PointerEvent) => {
    if (!this.active) return;
    this.pointer = { ...this.pointer, isPinching: true, pinchStrength: 1 };
    this.pointer.x = e.clientX / window.innerWidth;
    this.pointer.y = e.clientY / window.innerHeight;
    this.onUpdate(this.pointer);
  };

  private handleUp = () => {
    if (!this.active) return;
    this.pointer = { ...this.pointer, isPinching: false, pinchStrength: 0 };
    this.onUpdate(this.pointer);
  };
}
