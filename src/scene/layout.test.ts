import { describe, expect, it } from 'vitest';
import catalog from '../engine/catalog.json';
import {
  assertLayout,
  CAMERA,
  distanceToFootprint,
  contentBounds,
  framingPoints,
  INTERACTION,
  occlusionReachZ,
  POOL,
  poolLayout,
  SURFACE_Y,
  tableBounds,
  TRAY_CAPACITY,
  zoneCapacity,
  zoneCells,
  zoneRect,
  zoneRimTopY,
  type BinZone,
} from './layout';

/**
 * Estos tests son la razón de ser de `layout.ts`.
 *
 * Los tres fallos que motivaron el módulo —una fila tapada por dos milímetros, la caja de la
 * bandeja invadiendo el pool y una bandeja con menos huecos que instrumentos requeridos— eran
 * todos comprobables con aritmética, y ninguno se detectó hasta jugar. Aquí quedan como
 * aserciones: matemática pura, sin navegador ni three.js.
 */

/*
 * Solo queda la bandeja. Hubo una cubeta de descartes, retirada porque para el motor «descartado» y
 * «en el pool» eran el mismo estado —no está en la bandeja—: una zona más sin significado propio.
 * La lista se mantiene, en vez de escribir 'tray' en cada test, para que volver a haber dos zonas
 * sea añadir un elemento aquí.
 */
const ZONAS: BinZone[] = ['tray'];
/** El pool más grande que sirve el catálogo hoy: apendicectomía, 16 instrumentos. */
const POOL_MAXIMO = 16;

describe('layout · invariantes generales', () => {
  it('assertLayout no encuentra ningún fallo', () => {
    expect(assertLayout()).toEqual([]);
  });
});

describe('layout · las zonas caben y no se pisan', () => {
  it('las zonas están dentro de la mesa', () => {
    const mesa = tableBounds();
    for (const z of ZONAS) {
      const r = zoneRect(z);
      expect(r.minX, `${z} por la izquierda`).toBeGreaterThanOrEqual(mesa.minX);
      expect(r.maxX, `${z} por la derecha`).toBeLessThanOrEqual(mesa.maxX);
      expect(r.minZ, `${z} por detrás`).toBeGreaterThanOrEqual(mesa.minZ);
      expect(r.maxZ, `${z} por delante`).toBeLessThanOrEqual(mesa.maxZ);
    }
  });

  /*
   * La bandeja se centró respecto al pool al retirarse el descarte. Que ambos compartan eje no es
   * cosmético: es lo que reparte la holgura por igual a izquierda y derecha ahora que los
   * instrumentos son un 25 % más grandes.
   */
  it('la bandeja está centrada respecto al pool', () => {
    const t = zoneRect('tray');
    expect((t.minX + t.maxX) / 2).toBeCloseTo(POOL.centerX, 5);
  });

  it('ningún instrumento del pool cae dentro de una zona', () => {
    const pool = poolLayout(POOL_MAXIMO);
    for (const z of ZONAS) {
      const r = zoneRect(z);
      for (const c of pool) {
        const dentro = c.x > r.minX && c.x < r.maxX && c.z > r.minZ && c.z < r.maxZ;
        expect(dentro, `hueco del pool (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) dentro de ${z}`).toBe(false);
      }
    }
  });

  it('el contenido entero cabe sobre la mesa', () => {
    const mesa = tableBounds();
    const c = contentBounds();
    expect(c.minX).toBeGreaterThanOrEqual(mesa.minX);
    expect(c.maxX).toBeLessThanOrEqual(mesa.maxX);
    expect(c.minZ).toBeGreaterThanOrEqual(mesa.minZ);
    expect(c.maxZ).toBeLessThanOrEqual(mesa.maxZ);
  });
});

describe('layout · nada queda oculto tras un borde', () => {
  /*
   * El fallo original: el borde trasero de la bandeja tenía su cima en y=1.005 y la fila del pool
   * en z=-0.31 estaba a y=0.965. La visual cruzaba el borde dos milímetros por debajo de su cima,
   * así que cinco instrumentos quedaban tapados. Margen exigido: 8 cm, que a esta distancia son
   * varios centímetros de pantalla.
   */
  const MARGEN_MINIMO = 0.08;

  it.each(ZONAS)('el borde de "%s" no alcanza la fila más cercana del pool', (zona) => {
    const r = zoneRect(zona);
    const alcance = occlusionReachZ(r.minZ, zoneRimTopY(zona));
    const masCercano = Math.max(...poolLayout(POOL_MAXIMO).map((c) => c.z));
    expect(
      alcance - masCercano,
      `la sombra de ${zona} llega a z=${alcance.toFixed(3)} y el pool empieza en z=${masCercano.toFixed(3)}`,
    ).toBeGreaterThan(MARGEN_MINIMO);
  });

  it('un instrumento no tapa al de la fila de detrás', () => {
    // Altura generosa para un instrumento tumbado.
    const alto = SURFACE_Y + 0.06;
    const alcance = occlusionReachZ(POOL.frontZ, alto);
    expect(alcance - (POOL.frontZ - POOL.pitchZ)).toBeGreaterThan(0.05);
  });

  it('la fórmula detecta el caso que se escapó (bandeja vieja contra pool viejo)', () => {
    /*
     * Regresión al revés: con los números antiguos la comprobación DEBE dar «tapado».
     *
     * La banda oculta va del borde HACIA ATRÁS, así que estar visible significa tener z más
     * negativo que el alcance de la sombra, no menos. El borde viejo estaba en z=-0.27 con su cima
     * en 1.005 y su sombra llegaba a z=-0.328; la fila del pool, en z=-0.31, caía dentro.
     */
    const alcanceViejo = occlusionReachZ(-0.27, 1.005);
    expect(alcanceViejo).toBeLessThan(-0.31); // la sombra pasa por detrás de la fila
    expect(-0.31).toBeLessThan(-0.27); // y la fila está detrás del borde: tapada
  });
});

describe('layout · distancia a la huella', () => {
  // Una pieza de 30 cm tumbada a lo largo del eje X, centrada en el origen.
  const media = 0.15;

  it('el centro está a distancia cero', () => {
    expect(distanceToFootprint(0, 0, 0, 0, media, 0)).toBeCloseTo(0, 6);
  });

  /*
   * El caso que motiva todo esto. Con la distancia al CENTRO, apuntar a la punta de una tijera de
   * 30 cm daba 0.15, más que los 0.108 que separan dos filas de la bandeja: el juego elegía la
   * pieza de al lado. Contra la huella, la punta está a cero de la suya.
   */
  it('la punta de la pieza está a cero de SU pieza, no a medio largo', () => {
    expect(distanceToFootprint(0.15, 0, 0, 0, media, 0)).toBeCloseTo(0, 6);
    expect(distanceToFootprint(-0.15, 0, 0, 0, media, 0)).toBeCloseTo(0, 6);
  });

  it('más allá del extremo, la distancia se mide desde el extremo', () => {
    expect(distanceToFootprint(0.2, 0, 0, 0, media, 0)).toBeCloseTo(0.05, 6);
  });

  it('de costado mide la separación perpendicular, no la diagonal', () => {
    // Un punto a 4 cm de lado sobre la mitad de la pieza: 4 cm, no la distancia al centro.
    expect(distanceToFootprint(0.1, 0.04, 0, 0, media, 0)).toBeCloseTo(0.04, 6);
  });

  it('respeta el giro de la pieza', () => {
    // Girada 90°, su eje largo pasa a ser Z: lo que antes era «de costado» ahora es «a lo largo».
    const g = Math.PI / 2;
    expect(distanceToFootprint(0, 0.15, 0, 0, media, g)).toBeCloseTo(0, 6);
    expect(distanceToFootprint(0.04, 0, 0, 0, media, g)).toBeCloseTo(0.04, 6);
  });

  /*
   * El escenario que de verdad fallaba: dos piezas ALINEADAS DE LADO, como en el pool (paso 0.28),
   * y el dedo sobre la punta lejana de la larga. Su punta está a 15 cm de su propio centro, mientras
   * que el centro de la vecina queda a 13 cm: con la métrica al centro ganaba la vecina.
   *
   * Ojo: no vale cualquier disposición. Con las dos piezas en el mismo eje —una detrás de otra— la
   * métrica vieja también acertaba; el fallo aparece cuando la vecina está a lo largo del eje en el
   * que la pieza señalada es larga.
   */
  it('apuntando a la punta, elige esa pieza y no la vecina de al lado', () => {
    const paso = 0.28; // paso del pool
    const punta = 0.15; // punta derecha de la pieza larga, centrada en 0
    const mediaCorta = 0.08;

    const aLaSenalada = distanceToFootprint(punta, 0, 0, 0, media, 0);
    const aLaVecina = distanceToFootprint(punta, 0, paso, 0, mediaCorta, 0);
    expect(aLaSenalada).toBeLessThan(aLaVecina);

    // Y con la métrica vieja (al centro) ganaba la vecina: de ahí venía «coge la que no quiero».
    expect(Math.abs(punta - 0)).toBeGreaterThan(Math.abs(punta - paso));
  });

  /*
   * La histéresis, comprobada como número y no como impresión: con la diana vigente favorecida por
   * `targetStickiness`, una rival tiene que estar bastante más cerca para robarla.
   */
  it('la histéresis impide que el temblor cambie de diana', () => {
    const sep = 0.108;
    const s = INTERACTION.targetStickiness;
    // El dedo justo en el medio, oscilando 1 cm hacia la vecina.
    for (const temblor of [0, 0.005, 0.01]) {
      const z = sep / 2 + temblor;
      const actual = distanceToFootprint(0, z, 0, 0, media, 0) * s;
      const rival = distanceToFootprint(0, z, 0, sep, media, 0);
      expect(actual).toBeLessThan(rival);
    }
  });
});

describe('layout · capacidad y huecos', () => {
  /*
   * Este test nace de un fallo real: la bandeja tenía 12 huecos y la apendicectomía admite 14 piezas
   * (11 obligatorias + 3 opcionales). Colocando un par de opcionales, la última obligatoria ya no
   * cabía y volvía al pool sin decir nada: parecía que el juego «no dejaba» poner la gasa.
   *
   * Se comprueba contra el CATÁLOGO y no contra un número escrito a mano, que es la única forma de
   * que añadir mañana una operación con más instrumental haga saltar esto aquí en vez de romperlo
   * en manos de quien juega.
   */
  it('la bandeja da abasto para la operación más exigente del catálogo', () => {
    const necesario = Math.max(
      ...catalog.operations.map((op) => op.required.length + (op.optional?.length ?? 0)),
    );
    expect(TRAY_CAPACITY).toBeGreaterThanOrEqual(necesario);
  });


  it.each(ZONAS)('los huecos de "%s" caen dentro de su interior útil', (zona) => {
    const r = zoneRect(zona);
    const celdas = zoneCells(zona);
    expect(celdas).toHaveLength(zoneCapacity(zona));
    for (const c of celdas) {
      expect(c.x).toBeGreaterThan(r.minX);
      expect(c.x).toBeLessThan(r.maxX);
      expect(c.z).toBeGreaterThan(r.minZ);
      expect(c.z).toBeLessThan(r.maxZ);
      expect(c.y).toBeGreaterThan(SURFACE_Y);
    }
  });

  /*
   * La bandeja es una mesa preparada: cada instrumento tiene que quedar identificable por separado,
   * no amontonado con el vecino. Con las piezas un 25 % más grandes esto importa más que antes, y es
   * la razón de haber aprovechado en ancho el espacio que dejó libre el descarte.
   */
  const SEPARACION_MINIMA: Record<BinZone, number> = { tray: 0.1 };

  it.each(ZONAS)('los huecos de "%s" guardan su separación mínima', (zona) => {
    const celdas = zoneCells(zona);
    for (let i = 0; i < celdas.length; i++) {
      for (let j = i + 1; j < celdas.length; j++) {
        const d = Math.hypot(celdas[i].x - celdas[j].x, celdas[i].z - celdas[j].z);
        expect(d, `huecos ${i} y ${j} de ${zona}`).toBeGreaterThan(SEPARACION_MINIMA[zona]);
      }
    }
  });
});

describe('layout · rejilla del pool', () => {
  it.each([10, 15, 16])('coloca exactamente %i instrumentos', (n) => {
    expect(poolLayout(n)).toHaveLength(n);
  });

  it('reparte las filas de forma equilibrada y carga la delantera', () => {
    const filas = new Map<number, number>();
    for (const c of poolLayout(16)) filas.set(c.z, (filas.get(c.z) ?? 0) + 1);
    const cuentas = [...filas.entries()].sort((a, b) => b[0] - a[0]).map(([, n]) => n);
    expect(cuentas).toEqual([6, 5, 5]);
  });

  it('los instrumentos no se pisan entre sí', () => {
    const celdas = poolLayout(16);
    for (let i = 0; i < celdas.length; i++) {
      for (let j = i + 1; j < celdas.length; j++) {
        const d = Math.hypot(celdas[i].x - celdas[j].x, celdas[i].z - celdas[j].z);
        expect(d).toBeGreaterThanOrEqual(Math.min(POOL.pitchX, POOL.pitchZ) - 1e-9);
      }
    }
  });

  it('la separación con la bandeja no depende del número de instrumentos', () => {
    // Es la razón de anclar el pool por delante: la garantía anti-ocultación vale para las tres
    // operaciones del catálogo, tengan 10, 15 o 16 piezas.
    const frentes = [10, 15, 16].map((n) => Math.max(...poolLayout(n).map((c) => c.z)));
    expect(new Set(frentes).size).toBe(1);
  });

  it('coger no es ambiguo: el radio de agarre es menor que el paso de la rejilla', () => {
    expect(INTERACTION.grabRadius).toBeLessThan(POOL.pitchX);
    expect(INTERACTION.grabRadius).toBeLessThan(POOL.pitchZ);
  });

  it('mirar exige más puntería que coger', () => {
    expect(INTERACTION.inspectRadius).toBeLessThan(INTERACTION.grabRadius);
  });
});

describe('layout · encuadre de la cámara', () => {
  /**
   * Proyecta un punto de la superficie a coordenadas normalizadas de pantalla [-1, 1].
   * Réplica mínima de la matriz de la cámara: evita arrastrar three.js a un test de aritmética.
   */
  function proyectar(x: number, z: number, fovDeg: number, aspect: number) {
    const cam = { x: CAMERA.position[0], y: CAMERA.position[1], z: CAMERA.position[2] };
    const tgt = { x: CAMERA.target[0], y: CAMERA.target[1], z: CAMERA.target[2] };
    const norm = (v: { x: number; y: number; z: number }) => {
      const l = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    const fwd = norm({ x: tgt.x - cam.x, y: tgt.y - cam.y, z: tgt.z - cam.z });
    // right = normalize(fwd × mundoArriba); up = right × fwd. Con los signos al revés, la X sale
    // espejada y la comprobación del panel del HUD acaba midiendo el lado contrario de la pantalla.
    const right = norm({ x: -fwd.z, y: 0, z: fwd.x });
    const up = {
      x: right.y * fwd.z - right.z * fwd.y,
      y: right.z * fwd.x - right.x * fwd.z,
      z: right.x * fwd.y - right.y * fwd.x,
    };
    const v = { x: x - cam.x, y: SURFACE_Y - cam.y, z: z - cam.z };
    const d = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
    const w = v.x * right.x + v.y * right.y + v.z * right.z;
    const h = v.x * up.x + v.y * up.y + v.z * up.z;
    const tv = Math.tan((fovDeg * Math.PI) / 360);
    return { ndcX: w / d / (tv * aspect), ndcY: h / d / tv };
  }

  // Puntos REALES a encuadrar, no las esquinas del rectángulo envolvente: la esquina
  // delantera-izquierda de ese rectángulo cae donde no hay nada y exigirla abre el campo de visión
  // sin motivo. Ver `framingPoints()`.
  const esquinas = () => framingPoints().map((p) => [p.x, p.z] as const);

  it('a 16:9 todo entra sin tocar el fov base', () => {
    for (const [x, z] of esquinas()) {
      const p = proyectar(x, z, CAMERA.baseFovDeg, 16 / 9);
      expect(Math.abs(p.ndcX), `x en (${x}, ${z})`).toBeLessThanOrEqual(1);
      expect(Math.abs(p.ndcY), `y en (${x}, ${z})`).toBeLessThanOrEqual(1);
    }
  });

  it('nada queda bajo el panel del HUD a 16:9', () => {
    // El panel ocupa la franja derecha; el contenido no puede invadirla.
    const limite = 1 - 2 * (CAMERA.hudReserveX + CAMERA.margin);
    for (const [x, z] of esquinas()) {
      expect(proyectar(x, z, CAMERA.baseFovDeg, 16 / 9).ndcX).toBeLessThanOrEqual(limite);
    }
  });

  it.each([16 / 9, 16 / 10, 4 / 3])('con el fov máximo todo entra a aspect %f', (aspect) => {
    for (const [x, z] of esquinas()) {
      const p = proyectar(x, z, CAMERA.maxFovDeg, aspect);
      expect(Math.abs(p.ndcX)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.ndcY)).toBeLessThanOrEqual(1);
    }
  });
});
