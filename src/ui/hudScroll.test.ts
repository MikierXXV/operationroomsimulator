import { describe, expect, it } from 'vitest';
import { desplazamientoARestaurar } from './hudScroll';

/*
 * El HUD se rehace entero en cada cambio de estado, así que sin esto la lista de la bandeja vuelve al
 * principio constantemente. Medido a 667×375 con 14 instrumentos: 1036 px de contenido sobre 351
 * visibles, con los botones a 923 px del inicio. Pulsar «He terminado» devolvía la vista arriba y
 * obligaba a bajar 686 px otra vez solo para confirmar.
 */
describe('HUD · conservar el desplazamiento entre redibujados', () => {
  it('lo conserva dentro de la misma fase', () => {
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: 686 }, 'preparing', 686)).toBe(686);
  });

  /*
   * Cambiar de fase es cambiar de pantalla. Heredar el desplazamiento dejaría al usuario mirando el
   * medio de algo que acaba de aparecer, que es peor que el problema que esto arregla.
   */
  it('empieza arriba al cambiar de fase', () => {
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: 686 }, 'result', 686)).toBe(0);
    expect(desplazamientoARestaurar({ fase: 'menu', scrollTop: 200 }, 'preparing', 800)).toBe(0);
  });

  it('sin nada guardado, arriba', () => {
    expect(desplazamientoARestaurar(null, 'preparing', 686)).toBe(0);
  });

  /*
   * Si se quita un instrumento, el contenido encoge. Pedir más desplazamiento del que admite no
   * falla —el navegador lo ignora— pero dejaría el panel en un sitio distinto del calculado, así que
   * se recorta explícitamente.
   */
  it('se recorta si el contenido nuevo es más corto', () => {
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: 686 }, 'preparing', 400)).toBe(400);
  });

  it('si el contenido ya no desborda, arriba', () => {
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: 686 }, 'preparing', 0)).toBe(0);
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: 686 }, 'preparing', -12)).toBe(0);
  });

  it('nunca devuelve un valor negativo', () => {
    expect(desplazamientoARestaurar({ fase: 'preparing', scrollTop: -50 }, 'preparing', 400)).toBe(0);
  });
});
