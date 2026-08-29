import { describe, expect, it } from 'vitest';
import { avanzarIntro, curvaIntro, ESTIRAMIENTO_MAX, MAX_SALTO_MS, PAUSA, type EstadoIntro } from './intro';

const DURACION = 4200;

/** Corre el plano entero con un reloj de mentira y devuelve la posición del recorrido por fotograma. */
function reproducir(saltos: number[]): { k: number[]; realMs: number; acabo: boolean } {
  let estado: EstadoIntro = { transcurrido: 0, real: 0 };
  const k: number[] = [];
  for (const salto of saltos) {
    estado = avanzarIntro(estado, salto, DURACION);
    k.push(curvaIntro(Math.min(1, estado.transcurrido / DURACION)));
    if (estado.transcurrido >= DURACION) break;
  }
  return { k, realMs: estado.real, acabo: estado.transcurrido >= DURACION };
}

describe('plano de apertura · el reloj', () => {
  /*
   * La regresión que motivó todo esto. Al elegir nivel el hilo se bloquea montando la bandeja —medido
   * en Playwright: el primer fotograma tardó 7012 ms, con el ritmo en 15,5 ms justo antes— y con el
   * reloj de pared la animación se gastaba entera durante ese parón. El primer fotograma dibujado ya
   * llegaba fuera de tiempo, la cámara aparecía en la mesa y parecía un fallo.
   */
  it('un parón de carga de 7 s no se lleva por delante la animación', () => {
    const { k } = reproducir([7012, ...Array(60).fill(16.7)]);
    expect(k[0]).toBe(0); // sigue en la vista general, no en la mesa
  });

  it('con fotogramas normales dura lo previsto', () => {
    const { realMs, acabo } = reproducir(Array(300).fill(16.7));
    expect(acabo).toBe(true);
    // Sin parones no hay nada que recortar, así que el tiempo real es el de la animación.
    expect(realMs).toBeGreaterThanOrEqual(DURACION);
    expect(realMs).toBeLessThan(DURACION + 50);
  });

  /*
   * El recorte no puede salir gratis: a 10 fps cada fotograma aportaría los 100 ms del tope y el plano
   * duraría 42 s. Por eso el estiramiento está acotado.
   */
  it('en un equipo muy lento se acaba, no se eterniza', () => {
    const FOTOGRAMA = 1000; // 1 fps
    const { realMs, acabo } = reproducir(Array(200).fill(FOTOGRAMA));
    expect(acabo).toBe(true);
    // Se recorta hasta agotar el margen y a partir de ahí manda el reloj, así que el peor caso es el
    // margen más lo que quede de animación. Sin ese tope serían 42 s.
    expect(realMs).toBeLessThanOrEqual(DURACION * ESTIRAMIENTO_MAX + DURACION + FOTOGRAMA);
    expect(realMs).toBeLessThan(20_000);
  });

  it('un tirón suelto a mitad aporta el tope, no su duración entera', () => {
    let estado: EstadoIntro = { transcurrido: 0, real: 0 };
    for (let i = 0; i < 60; i++) estado = avanzarIntro(estado, 16.7, DURACION);
    const antes = estado.transcurrido;
    estado = avanzarIntro(estado, 900, DURACION);
    expect(estado.transcurrido - antes).toBe(MAX_SALTO_MS);
    // El tiempo real sí lo cuenta entero: el tirón ocurrió, solo que no se cobra en animación.
    expect(estado.real).toBeCloseTo(60 * 16.7 + 900, 5);
  });
});

describe('plano de apertura · la curva', () => {
  it('empieza en la vista general y acaba exactamente en la mesa', () => {
    expect(curvaIntro(0)).toBe(0);
    expect(curvaIntro(1)).toBeCloseTo(1, 6);
  });

  it('no retrocede nunca', () => {
    let previo = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const k = curvaIntro(t);
      expect(k).toBeGreaterThanOrEqual(previo);
      previo = k;
    }
  });

  /*
   * Lo que pidió el usuario: que dé tiempo a ver el quirófano. Un intento anterior con `easeOutQuint`
   * dejaba la vista general en el primer segundo —medido: z de 5,17 a 1,65 en 2 s de 4,2— que es
   * justo lo contrario.
   */
  it('se queda quieto arriba el tiempo de la pausa', () => {
    expect(curvaIntro(PAUSA * 0.5)).toBe(0);
    expect(curvaIntro(PAUSA * 0.99)).toBe(0);
    expect(curvaIntro(PAUSA + 0.01)).toBeGreaterThan(0);
  });

  it('a mitad del plano aún no se ha llegado a la mesa', () => {
    expect(curvaIntro(0.5)).toBeLessThan(0.35);
  });

  it('arranca y frena despacio, sin tirón en los extremos', () => {
    const velocidad = (t: number) => curvaIntro(t + 0.005) - curvaIntro(t - 0.005);
    const media = curvaIntro(0.62) - curvaIntro(0.61);
    expect(velocidad(PAUSA + 0.02)).toBeLessThan(media);
    expect(velocidad(0.99)).toBeLessThan(media);
  });
});
