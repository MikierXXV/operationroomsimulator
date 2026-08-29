import { describe, expect, it } from 'vitest';
import { aPantalla } from './HandTracker';

/**
 * EL MAPEO MANO → PANTALLA.
 *
 * Este fichero existe porque un error puramente aritmético dejó la mano inservible y **ningún test
 * lo habría cazado**: no había ni uno sobre el mapeo. La constante de la curva se calculó en unas
 * unidades y se usó en otras —salió 16,79 en vez de 1,02— y el resultado fue un cursor
 * hipersensible, clavado en los bordes, y un guante deformado como una araña.
 *
 * Todo lo que sigue es comprobable sin cámara y sin navegador. Si vuelve a descuadrarse, salta aquí.
 */

/** Hasta dónde llega la mano con detección fiable, medido desde el centro del cuadro. */
const ALCANCE = 0.34;

describe('mapeo mano → pantalla', () => {
  it('el centro del encuadre es el centro de la pantalla', () => {
    expect(aPantalla(0.5)).toBeCloseTo(0.5, 5);
  });

  /*
   * La razón de ser de la curva: en el centro NO amplifica. Ahí está la mesa, y ahí es donde se
   * apunta a piezas que están a diez centímetros unas de otras. El estirado lineal que había antes
   * amplificaba ×1,47 también aquí, y costaba la mitad del margen de puntería.
   */
  it('la ganancia en el centro es 1: no amplifica donde se apunta', () => {
    const e = 0.01;
    const ganancia = (aPantalla(0.5 + e) - aPantalla(0.5 - e)) / (2 * e);
    expect(ganancia).toBeCloseTo(1, 1);
  });

  /*
   * La otra razón de ser: llegar al panel del HUD sin sacar la mano de donde la cámara la ve. El
   * límite de detección fiable tiene que caer JUSTO en el borde de la pantalla.
   */
  it('el alcance fiable llega exactamente al borde', () => {
    expect(aPantalla(0.5 + ALCANCE)).toBeCloseTo(1, 2);
    expect(aPantalla(0.5 - ALCANCE)).toBeCloseTo(0, 2);
  });

  /*
   * El síntoma del fallo: saturaba a la mitad de camino, así que el cursor se quedaba pegado al
   * borde mientras la mano seguía dentro de la zona útil.
   */
  it('no satura antes de llegar al alcance fiable', () => {
    expect(aPantalla(0.5 + ALCANCE * 0.85)).toBeLessThan(0.98);
    expect(aPantalla(0.5 + ALCANCE * 0.5)).toBeLessThan(0.8);
  });

  it('es monótona y simétrica', () => {
    let previo = -1;
    for (let v = 0; v <= 1; v += 0.02) {
      const s = aPantalla(v);
      expect(s).toBeGreaterThanOrEqual(previo);
      expect(s).toBeCloseTo(1 - aPantalla(1 - v), 6);
      previo = s;
    }
  });

  it('nunca se sale de [0,1]', () => {
    for (const v of [-0.5, 0, 0.2, 0.8, 1, 1.5]) {
      const s = aPantalla(v);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  /*
   * LA ASERCIÓN QUE HABRÍA CAZADO LA ARAÑA.
   *
   * Una curva deforma: dos puntos separados una distancia fija acaban a distancias distintas según
   * dónde estén. Aplicándola a los 21 landmarks, los dedos se abrían en abanico.
   *
   * Por eso el mapeo va SOLO al puntero. Este test documenta que la curva sí deforma —no es un
   * defecto, es su naturaleza— y con ello justifica que no deba tocar la forma de la mano.
   */
  it('la curva DEFORMA, y por eso no puede aplicarse a la mano entera', () => {
    const separacion = 0.06; // dos landmarks vecinos
    const enElCentro = aPantalla(0.5 + separacion) - aPantalla(0.5);
    const enElBorde = aPantalla(0.5 + ALCANCE) - aPantalla(0.5 + ALCANCE - separacion);
    // Si se aplicara a los 21 puntos, esa misma separación se dibujaría con tamaños distintos.
    expect(enElBorde / enElCentro).toBeGreaterThan(1.5);
  });
});
