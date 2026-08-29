import type {
  IInputManager,
  InputManagerEvents,
  InputStatus,
  Pointer,
} from '../types/contracts';
import { HandTracker } from './HandTracker';
import { MouseAdapter } from './MouseAdapter';

/**
 * Orquesta las fuentes de entrada y expone una única corriente de Pointers al
 * resto del sistema. Intenta usar las manos (webcam); si no hay cámara o el
 * usuario la desactiva, cae al ratón. Ambos modos pueden coexistir: el ratón
 * está siempre activo como red de seguridad.
 */
export class InputManager implements IInputManager {
  private events: InputManagerEvents;
  private handTracker: HandTracker;
  private mouseAdapter: MouseAdapter;

  private status: InputStatus = 'idle';
  private mode: 'hands' | 'mouse' = 'hands';
  private handPointers: Pointer[] = [];
  private mousePointer: Pointer | null = null;

  constructor(video: HTMLVideoElement, target: HTMLElement, events: InputManagerEvents) {
    this.events = events;
    this.handTracker = new HandTracker(video, (p) => {
      this.handPointers = p;
      this.publish();
    });
    this.mouseAdapter = new MouseAdapter(target, (p) => {
      this.mousePointer = p;
      this.publish();
    });
  }

  async start(): Promise<void> {
    // El ratón siempre está disponible como fallback.
    this.mouseAdapter.start();

    if (this.mode === 'hands') {
      await this.tryStartCamera();
    } else {
      this.setStatus('mouse-only');
    }
  }

  private async tryStartCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus('camera-unavailable');
      this.mode = 'mouse';
      return;
    }
    try {
      this.setStatus('requesting-camera');
      await this.handTracker.start();
      // El usuario pudo cambiar a ratón mientras la cámara arrancaba: no revivir.
      if (this.mode !== 'hands') {
        this.handTracker.stop();
        this.setStatus('mouse-only');
        return;
      }
      this.setStatus('camera-active');
    } catch (err) {
      console.warn('[InputManager] cámara no disponible:', err);
      this.setStatus('camera-denied');
      this.mode = 'mouse';
    }
  }

  stop(): void {
    this.handTracker.stop();
    this.mouseAdapter.stop();
    this.setStatus('idle');
  }

  setMode(mode: 'hands' | 'mouse'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'mouse') {
      this.handTracker.stop();
      this.handPointers = [];
      this.setStatus('mouse-only');
      this.publish();
    } else {
      void this.tryStartCamera();
    }
  }

  getStatus(): InputStatus {
    return this.status;
  }

  /**
   * Fusiona punteros: si hay manos detectadas, se usan; si no, el ratón. El
   * ratón nunca desaparece como respaldo cuando no hay manos en cuadro.
   */
  private publish(): void {
    const pointers: Pointer[] = [];
    if (this.mode === 'hands' && this.handPointers.length > 0) {
      pointers.push(...this.handPointers);
    } else if (this.mousePointer) {
      pointers.push(this.mousePointer);
    }
    this.events.onPointers(pointers);
  }

  private setStatus(status: InputStatus): void {
    this.status = status;
    this.events.onStatusChange(status);
  }
}
