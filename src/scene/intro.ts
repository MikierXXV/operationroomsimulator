/**
 * Reloj y curva del plano de apertura, aparte de la escena para poder probarlos.
 *
 * Vive fuera de `SceneManager` porque lo delicado aquí no es mover una cámara sino decidir CUÁNTO ha
 * avanzado la animación, y eso se puede comprobar con un reloj de mentira y sin navegador.
 */

/** Recorte del salto de un fotograma. Por encima se considera parón, no avance. */
export const MAX_SALTO_MS = 100;

/** Cuánto puede alargarse el plano en tiempo real antes de dejar de recortar. */
export const ESTIRAMIENTO_MAX = 1.5;

/** Parte del plano que se pasa quieto en la vista general, antes de empezar a bajar. */
export const PAUSA = 0.22;

export interface EstadoIntro {
  /** Tiempo de animación consumido, en ms. No es tiempo de reloj. */
  transcurrido: number;
  /** Tiempo real desde el primer fotograma dibujado, en ms. */
  real: number;
}

/**
 * Avance de un fotograma.
 *
 * `salto` es el tiempo de reloj desde el fotograma anterior. Se recorta a `MAX_SALTO_MS` para que un
 * parón —el de la carga del nivel, sobre todo— cueste tiempo real pero no se lleve por delante la
 * animación. El recorte se levanta cuando el plano ya lleva `ESTIRAMIENTO_MAX` veces su duración en
 * tiempo real, para que un equipo muy lento no lo alargue indefinidamente.
 */
export function avanzarIntro(estado: EstadoIntro, salto: number, duracion: number): EstadoIntro {
  const estirado = estado.real >= duracion * ESTIRAMIENTO_MAX;
  return {
    real: estado.real + salto,
    transcurrido: estado.transcurrido + (estirado ? salto : Math.min(salto, MAX_SALTO_MS)),
  };
}

/**
 * Posición en el recorrido, de 0 (vista general) a 1 (mesa), para un avance `t` de 0 a 1.
 *
 * Primero se queda quieta en la vista general —sin esa pausa la sala se abandona en el primer
 * instante y no da tiempo a verla, que es justo lo que se pedía— y luego baja con una curva simétrica
 * que arranca y frena despacio. La velocidad en el punto donde termina la pausa es cero, así que
 * arrancar no se nota como un tirón.
 */
export function curvaIntro(t: number): number {
  const avance = Math.max(0, Math.min(1, (t - PAUSA) / (1 - PAUSA)));
  return avance < 0.5 ? 4 * avance ** 3 : 1 - Math.pow(-2 * avance + 2, 3) / 2;
}
