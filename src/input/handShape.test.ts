import { describe, expect, it } from 'vitest';
import { clasificarMano, dedosEstirados, puntoDePinza } from './handShape';
import type { Landmark } from '../types/contracts';

/**
 * Construye una mano sintética con los dedos que se pidan estirados.
 *
 * La muñeca va en el origen y los dedos crecen hacia arriba (−y). Un dedo estirado pone la yema más
 * lejos de la muñeca que su nudillo; uno recogido, más cerca, que es exactamente lo que distingue
 * `dedoEstirado`. El pulgar se deja fijo: no participa en la clasificación.
 */
function mano(estirados: { indice?: boolean; corazon?: boolean; anular?: boolean; menique?: boolean }): Landmark[] {
  const p = (x: number, y: number): Landmark => ({ x, y, z: 0 });
  const lm: Landmark[] = new Array(21).fill(null).map(() => p(0, 0));
  lm[0] = p(0, 0); // muñeca
  // pulgar (1-4), irrelevante para la clasificación pero tiene que existir
  lm[1] = p(-0.02, -0.02);
  lm[2] = p(-0.04, -0.04);
  lm[3] = p(-0.05, -0.06);
  lm[4] = p(-0.06, -0.08);

  const dedos: [keyof typeof estirados, number, number, number][] = [
    ['indice', 5, 6, 8],
    ['corazon', 9, 10, 12],
    ['anular', 13, 14, 16],
    ['menique', 17, 18, 20],
  ];
  dedos.forEach(([nombre, base, nudillo, yema], i) => {
    const x = -0.03 + i * 0.02;
    lm[base] = p(x, -0.04);
    lm[nudillo] = p(x, -0.08); // nudillo a 0.08 de la muñeca
    // Estirado: yema a 0.14 (más lejos que 0.08·1.15). Recogido: yema a 0.05 (más cerca).
    lm[yema] = estirados[nombre] ? p(x, -0.14) : p(x, -0.05);
    lm[yema - 1] = p(x, estirados[nombre] ? -0.11 : -0.06);
  });
  return lm;
}

describe('clasificarMano', () => {
  it('cuatro dedos estirados es mano abierta', () => {
    const h = mano({ indice: true, corazon: true, anular: true, menique: true });
    expect(dedosEstirados(h)).toBe(4);
    expect(clasificarMano(h)).toBe('open');
  });

  it('los cuatro recogidos es puño', () => {
    const h = mano({});
    expect(dedosEstirados(h)).toBe(0);
    expect(clasificarMano(h)).toBe('fist');
  });

  it('índice y corazón solos son el gesto de desplazar', () => {
    expect(clasificarMano(mano({ indice: true, corazon: true }))).toBe('two-fingers');
  });

  /*
   * Índice y corazón estirados PERO con el anular fuera también: no es el gesto de desplazar. Se
   * exige que los otros dos estén recogidos para poder distinguirlo de la mano abierta, que es la
   * postura de reposo.
   */
  it('índice y corazón con el anular suelto no cuentan como desplazar', () => {
    expect(clasificarMano(mano({ indice: true, corazon: true, anular: true }))).toBe('other');
  });

  /*
   * EL TEST QUE FALTABA, y que habría evitado el fallo.
   *
   * Al pellizcar, el índice se curva hacia el pulgar y los otros tres se recogen: por número de
   * dedos estirados, un pellizco y un puño son idénticos —ambos cero—. Como el puño anula la pinza
   * para que cerrar la mano no pulse botones, clasificar el pellizco como puño dejaba el juego sin
   * poder coger nada.
   *
   * Lo que los distingue es dónde acaba la yema del índice: metida hacia la palma en el puño,
   * proyectada hacia delante a tocar el pulgar en el pellizco.
   */
  it('un PELLIZCO no es un puño, aunque no tenga ningún dedo estirado', () => {
    const p = (x: number, y: number): Landmark => ({ x, y, z: 0 });
    const lm: Landmark[] = new Array(21).fill(null).map(() => p(0, 0));
    lm[0] = p(0, 0);
    // pulgar hacia delante, a encontrarse con el índice
    lm[1] = p(-0.02, -0.02); lm[2] = p(-0.04, -0.05); lm[3] = p(-0.05, -0.08); lm[4] = p(-0.045, -0.105);
    // índice curvado: la yema SALE hacia el pulgar, lejos de la muñeca
    lm[5] = p(-0.02, -0.06); lm[6] = p(-0.02, -0.10); lm[7] = p(-0.035, -0.11); lm[8] = p(-0.048, -0.107);
    // los otros tres, recogidos: lo natural al pellizcar
    for (const [base, x] of [[9, 0], [13, 0.02], [17, 0.04]] as const) {
      lm[base] = p(x, -0.06); lm[base + 1] = p(x, -0.09);
      lm[base + 2] = p(x, -0.07); lm[base + 3] = p(x, -0.055);
    }

    expect(dedosEstirados(lm)).toBe(0);          // igual que un puño…
    expect(clasificarMano(lm)).not.toBe('fist'); // …pero NO es un puño
  });

  it('un solo dedo estirado es una postura cualquiera', () => {
    expect(clasificarMano(mano({ indice: true }))).toBe('other');
  });

  /*
   * El cursor NO puede moverse por el simple hecho de pellizcar.
   *
   * Con la yema del índice como ancla, agarrar desplazaba el cursor hacia atrás: pellizcar es curvar
   * el índice, así que el punto que seguía el cursor se iba con el dedo. Se apuntaba a un
   * instrumento, se cerraba la mano y la pinza se registraba ya en otro sitio.
   *
   * Este test compara las dos anclas entre mano abierta y mano pellizcando, SIN mover la mano de
   * sitio: el punto medio tiene que aguantar mucho mejor que la yema.
   */
  it('el punto de pinza apenas se mueve al cerrar la mano, la yema sí', () => {
    const p = (x: number, y: number): Landmark => ({ x, y, z: 0 });
    const base = (): Landmark[] => new Array(21).fill(null).map(() => p(0, 0));

    // Mano abierta: pulgar a un lado, índice estirado hacia delante.
    const abierta = base();
    abierta[4] = p(-0.08, -0.06);  // yema del pulgar, separada
    abierta[8] = p(0.0, -0.14);    // yema del índice, estirada

    // La MISMA mano pellizcando: las dos yemas se juntan a medio camino. La mano no se ha movido.
    const cerrada = base();
    cerrada[4] = p(-0.041, -0.101);
    cerrada[8] = p(-0.039, -0.099);

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y);

    const saltoYema = dist(abierta[8], cerrada[8]);
    const saltoPinza = dist(puntoDePinza(abierta), puntoDePinza(cerrada));

    expect(saltoPinza).toBeLessThan(saltoYema / 3);
  });

  it('sin landmarks suficientes no inventa una postura', () => {
    expect(clasificarMano(undefined)).toBe('other');
    expect(clasificarMano([{ x: 0, y: 0, z: 0 }])).toBe('other');
  });
});
