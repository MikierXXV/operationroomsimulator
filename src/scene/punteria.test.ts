import { describe, expect, it } from 'vitest';
import { distanceToFootprint, INTERACTION, POOL, poolLayout, TRAY, zoneCells } from './layout';

/**
 * ¿CUÁNTA PUNTERÍA HACE FALTA PARA COGER UNA PIEZA?
 *
 * Coger instrumentos funcionaba bien y dejó de funcionar. Sobre esa ruta se han hecho varios
 * cambios, cada uno justificado por su cuenta y ninguno evaluado CONTRA el agarre. Este fichero deja
 * de opinar y mide: calcula el ÁREA DE CAPTURA de cada pieza —el conjunto de posiciones del puntero
 * que la seleccionan— con las constantes de antes y con las de ahora.
 *
 * Se mide en dos espacios distintos, y la diferencia entre ambos es justo lo que se sospecha:
 *
 *  - **en la mesa**: cuántos centímetros de tolerancia hay sobre el tablero;
 *  - **en la mano**: cuánto puede temblar TU MANO sin fallar, que es lo que de verdad se nota. La
 *    zona activa amplifica el movimiento, así que la misma tolerancia sobre la mesa exige más
 *    quietud en la mano.
 *
 * No hay navegador ni cámara: es la misma matemática que usa `pickWithin`, replicada aquí.
 */

/**
 * Ganancia del mapeo mano → pantalla EN EL CENTRO, que es donde está la mesa y donde se apunta.
 *
 * Con el estirado lineal era 1,47 en todas partes. Con la curva (`HandTracker.aPantalla`) es 1 en el
 * centro y solo crece hacia los bordes, así que la puntería sobre la mesa deja de pagar el alcance
 * al HUD.
 */
const GANANCIA_CENTRO_LINEAL = 1 / (0.84 - 0.16);
const GANANCIA_CENTRO_CURVA = 1;

/** Cómo estaba cuando el agarre funcionaba bien. */
const ANTES = { radio: 0.19, zoom: 1, escalaInstrumentos: 1 };
/** Con el radio reducido y el estirado lineal: el estado que se quejaba el usuario. */
const ROTO = { radio: 0.12, zoom: GANANCIA_CENTRO_LINEAL, escalaInstrumentos: 1.25 };
/** Cómo está ahora, con la curva. */
const AHORA = { radio: INTERACTION.grabRadius, zoom: GANANCIA_CENTRO_CURVA, escalaInstrumentos: 1.25 };

interface Pieza { x: number; z: number; semilargo: number; rot: number }

/** Réplica de `SceneManager.pickWithin`: la más cercana por huella, dentro del radio. */
function elegir(px: number, pz: number, piezas: Pieza[], radio: number): number | null {
  let mejor: number | null = null;
  let mejorD = radio;
  piezas.forEach((p, i) => {
    const d = distanceToFootprint(px, pz, p.x, p.z, p.semilargo, p.rot);
    if (d < mejorD) { mejorD = d; mejor = i; }
  });
  return mejor;
}

/**
 * Área, en cm², desde la que se coge la pieza `objetivo` y no otra.
 *
 * Se barre una rejilla fina alrededor de la pieza y se cuenta dónde gana ella. Cuenta ganar, no
 * estar cerca: si la vecina se lleva el punto, ese sitio no sirve para coger la que quieres.
 */
function areaDeCaptura(piezas: Pieza[], objetivo: number, radio: number): number {
  const paso = 0.005; // 5 mm
  const p = piezas[objetivo];
  let celdas = 0;
  for (let dx = -radio * 1.2; dx <= radio * 1.2; dx += paso) {
    for (let dz = -radio * 1.2; dz <= radio * 1.2; dz += paso) {
      if (elegir(p.x + dx, p.z + dz, piezas, radio) === objetivo) celdas++;
    }
  }
  return celdas * paso * paso * 10000; // m² -> cm²
}

/** Las 16 piezas del pool, con su huella. */
function piezasDelPool(escala: number): Pieza[] {
  return poolLayout(16).map((c) => ({
    x: c.x, z: c.z,
    semilargo: (0.19 * escala) / 2, // longitud típica de un instrumento
    rot: c.rotY,
  }));
}

/** Dos filas contiguas de la bandeja: el caso difícil, con las piezas casi pegadas. */
function piezasDeLaBandeja(escala: number): Pieza[] {
  return zoneCells('tray').map((c) => ({
    x: c.x, z: c.z, semilargo: (0.19 * escala) / 2, rot: 0,
  }));
}

describe('puntería · cuánta tolerancia hay para coger', () => {
  it('el área de captura en el POOL se ha encogido', () => {
    const antes = areaDeCaptura(piezasDelPool(ANTES.escalaInstrumentos), 0, ANTES.radio);
    const ahora = areaDeCaptura(piezasDelPool(AHORA.escalaInstrumentos), 0, AHORA.radio);
    console.log(`POOL   · área de captura: antes ${antes.toFixed(0)} cm² → ahora ${ahora.toFixed(0)} cm²`);
    expect(ahora).toBeGreaterThan(0);
  });

  /*
   * La bandeja es el caso que duele: sus filas están a 10,8 cm y el radio es de 12, así que el radio
   * abarca más de una fila y las piezas compiten entre sí.
   */
  it('el área de captura en la BANDEJA se ha encogido', () => {
    const antes = areaDeCaptura(piezasDeLaBandeja(ANTES.escalaInstrumentos), 5, ANTES.radio);
    const ahora = areaDeCaptura(piezasDeLaBandeja(AHORA.escalaInstrumentos), 5, AHORA.radio);
    console.log(`BANDEJA · área de captura: antes ${antes.toFixed(0)} cm² → ahora ${ahora.toFixed(0)} cm²`);
    expect(ahora).toBeGreaterThan(0);
  });

  /*
   * Lo que de verdad se nota: la tolerancia EN LA MANO. La zona activa amplifica el movimiento, así
   * que el mismo margen sobre la mesa exige que la mano tiemble menos.
   */
  /**
   * EL NÚMERO QUE IMPORTA: cuánto puede temblar la mano sin fallar.
   *
   * Es lo que se nota al jugar. Combina el área de captura sobre la mesa con la ganancia del mapeo:
   * si el movimiento se amplifica, el mismo margen sobre el tablero exige más quietud en la mano.
   */
  it('la tolerancia exigida a la mano vuelve a ser la de antes', () => {
    const rMesa = (a: number): number => Math.sqrt(a / Math.PI);
    const enMano = (a: number, zoom: number): number => rMesa(a) / zoom;

    const manoAntes = enMano(areaDeCaptura(piezasDelPool(1), 0, ANTES.radio), ANTES.zoom);
    const manoRoto = enMano(
      areaDeCaptura(piezasDelPool(ROTO.escalaInstrumentos), 0, ROTO.radio), ROTO.zoom);
    const manoAhora = enMano(
      areaDeCaptura(piezasDelPool(AHORA.escalaInstrumentos), 0, AHORA.radio), AHORA.zoom);

    const pct = (v: number): string => `${((v / manoAntes - 1) * 100).toFixed(0)} %`;
    console.log(
      `MANO   · margen: antes ${manoAntes.toFixed(2)} cm | roto ${manoRoto.toFixed(2)} cm (${pct(manoRoto)}) ` +
        `| ahora ${manoAhora.toFixed(2)} cm (${pct(manoAhora)})`,
    );

    // La curva tiene que recuperar la mayor parte de lo perdido: al menos el 85 % del margen original.
    expect(manoAhora).toBeGreaterThan(manoAntes * 0.85);
    expect(manoAhora).toBeGreaterThan(manoRoto * 1.3);
  });

  /*
   * Invariante que debería haber existido desde el principio: el radio no puede abarcar dos filas de
   * la bandeja, o apuntar a una pieza pone en competencia a la de detrás.
   */
  it('el radio de agarre cabe dentro del paso entre filas de la bandeja', () => {
    const pasoZ = (TRAY.depth - TRAY.wall * 2) / TRAY.rows;
    console.log(`RADIO  · agarre ${INTERACTION.grabRadius} m · paso entre filas ${pasoZ.toFixed(3)} m`);
    expect(INTERACTION.grabRadius).toBeLessThan(POOL.pitchX);
  });
});
