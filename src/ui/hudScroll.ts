/**
 * Qué posición de desplazamiento conservar cuando el HUD se reconstruye.
 *
 * POR QUÉ EXISTE. `Hud.render()` rehace el panel entero con `innerHTML = ''`, así que el
 * desplazamiento se pierde en CADA cambio de estado. Con la bandeja llena eso duele: medido a
 * 667×375, el contenido mide 1036 px sobre 351 visibles y los botones empiezan a 923 px del
 * principio, o sea 686 px de desplazamiento para llegar a «He terminado». Al pulsarlo, el redibujado
 * devolvía la lista al principio y había que bajar otra vez para confirmar. Y no pasaba solo al
 * terminar: también al soltar cada instrumento.
 *
 * VIVE APARTE PORQUE SE PUEDE PROBAR. El proyecto no tiene jsdom ni un solo test de DOM, así que
 * separando la decisión del enchufe al elemento, lo que decide queda cubierto por `npm test`. Es lo
 * mismo que se hizo con `scene/intro.ts` y el reloj del plano de apertura.
 */

export interface DesplazamientoGuardado {
  /** Fase del motor en la que se tomó la medida: 'menu', 'preparing' o 'result'. */
  fase: string;
  scrollTop: number;
}

/**
 * Posición a aplicar al panel recién construido.
 *
 * Devuelve 0 —arriba del todo— salvo que se cumpla todo esto:
 *
 *  - hay algo guardado;
 *  - **la fase no ha cambiado**. Pasar del menú a la partida, o de la partida al resultado, es una
 *    pantalla distinta; heredar el desplazamiento de la anterior dejaría al usuario mirando el medio
 *    de algo que acaba de aparecer, que es peor que el problema que esto arregla;
 *  - el contenido nuevo da de sí lo suficiente. Si ha encogido —se quitó un instrumento de la
 *    bandeja— se recorta hasta donde llegue, porque pedirle a un elemento más desplazamiento del que
 *    admite no falla, simplemente lo ignora, y quedaría en un sitio que no es el que se calculó.
 */
export function desplazamientoARestaurar(
  guardado: DesplazamientoGuardado | null,
  faseNueva: string,
  maximo: number,
): number {
  if (!guardado || guardado.fase !== faseNueva) return 0;
  if (maximo <= 0) return 0;
  return Math.max(0, Math.min(guardado.scrollTop, maximo));
}
