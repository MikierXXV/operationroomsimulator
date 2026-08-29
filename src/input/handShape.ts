import type { HandShape, Landmark } from '../types/contracts';

/**
 * Clasifica la POSTURA de la mano a partir de los 21 landmarks de MediaPipe.
 *
 * Vive en su propio módulo, separado de `HandTracker`, porque es matemática pura: entra un array de
 * puntos y sale una etiqueta. Así se puede probar con manos sintéticas sin cámara ni WebGL, que es
 * lo único que permite afirmar que un puño es un puño y no una pinza.
 *
 * Índices de MediaPipe: 0 muñeca; 1-4 pulgar; 5-8 índice; 9-12 corazón; 13-16 anular; 17-20 meñique.
 * En cada dedo, el último es la yema y el penúltimo-1 el nudillo medio.
 */

/** Yema y nudillo medio de los cuatro dedos largos (el pulgar va aparte: se dobla de otra forma). */
const DEDOS_LARGOS: [yema: number, nudillo: number][] = [
  [8, 6], // índice
  [12, 10], // corazón
  [16, 14], // anular
  [20, 18], // meñique
];

/**
 * ¿Está el dedo estirado? Se compara la distancia de la YEMA a la muñeca contra la del NUDILLO medio
 * a la muñeca: con el dedo doblado la yema se acerca a la muñeca y la comparación se invierte.
 *
 * Es más robusto que mirar alturas en Y, que falla en cuanto se gira la mano.
 */
export function dedoEstirado(hand: Landmark[], yema: number, nudillo: number): boolean {
  const w = hand[0];
  const d = (i: number): number => Math.hypot(hand[i].x - w.x, hand[i].y - w.y);
  return d(yema) > d(nudillo) * 1.15;
}

/**
 * Punto que sigue el cursor: el medio entre las yemas del pulgar y del índice.
 *
 * Se eligió así porque es INVARIANTE ante el propio gesto de pellizcar. Usando la yema del índice
 * —que era lo anterior— el cursor retrocedía justo al agarrar, porque pellizcar es precisamente
 * curvar el índice hacia el pulgar. Con el punto medio, al cerrar la mano las dos yemas convergen
 * hacia él y el cursor se queda quieto.
 *
 * Vive aquí, como función pura, para poder demostrarlo con un test en vez de argumentarlo.
 */
export function puntoDePinza(hand: Landmark[]): { x: number; y: number } {
  return { x: (hand[8].x + hand[4].x) / 2, y: (hand[8].y + hand[4].y) / 2 };
}

/** Cuántos de los cuatro dedos largos están estirados. */
export function dedosEstirados(hand: Landmark[]): number {
  return DEDOS_LARGOS.filter(([yema, nudillo]) => dedoEstirado(hand, yema, nudillo)).length;
}

/**
 * ¿Está la yema del índice PROYECTADA hacia fuera, lejos de la palma?
 *
 * Es lo que separa un pellizco de un puño, y no es un matiz: al pellizcar, el índice se curva y los
 * otros tres se recogen, así que **por número de dedos estirados un pellizco es indistinguible de un
 * puño**. Los dos dan cero.
 *
 * La diferencia está en DÓNDE acaba la yema del índice. En un puño se mete hacia la palma, quedando
 * a la altura de su propio nudillo o más cerca. En un pellizco sale hacia delante a tocar el pulgar,
 * bastante más lejos de la muñeca que el nudillo.
 */
function indiceProyectado(hand: Landmark[]): boolean {
  const w = hand[0];
  const d = (i: number): number => Math.hypot(hand[i].x - w.x, hand[i].y - w.y);
  const nudillo = d(5) || 1e-6;
  return d(8) / nudillo > 1.5;
}

/**
 * Postura de la mano.
 *
 * Las cuatro son excluyentes, y por eso es una etiqueta y no un booleano por gesto: con un booleano
 * cada vez que se añadiera un gesto habría que acordarse de apagar los demás en todos los sitios.
 */
export function clasificarMano(hand: Landmark[] | undefined): HandShape {
  if (!hand || hand.length < 21) return 'other';

  const indice = dedoEstirado(hand, 8, 6);
  const corazon = dedoEstirado(hand, 12, 10);
  const anular = dedoEstirado(hand, 16, 14);
  const menique = dedoEstirado(hand, 20, 18);
  const total = [indice, corazon, anular, menique].filter(Boolean).length;

  /*
   * El puño exige, además de los cuatro dedos recogidos, que el índice NO esté proyectado.
   *
   * Sin esa segunda condición, un pellizco se clasificaba como puño —los dos dan cero dedos
   * estirados— y como el puño anula la pinza para que cerrar la mano no pulse botones, el resultado
   * era que **no se podía coger nada**: la pinza se anulaba justo al pellizcar.
   */
  if (total === 0) return indiceProyectado(hand) ? 'other' : 'fist';
  if (total === 4) return 'open';
  // Índice y corazón SOLOS: los otros dos recogidos es lo que lo distingue de la mano abierta, que
  // es la postura de reposo y dispararía el desplazamiento sin querer.
  if (indice && corazon && !anular && !menique) return 'two-fingers';
  return 'other';
}
