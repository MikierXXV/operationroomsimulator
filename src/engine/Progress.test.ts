import { describe, expect, it } from 'vitest';
import { Progress } from './Progress';

/** Almacén de mentira, en memoria, con la interfaz de `Storage`. */
function storageFalso(inicial: Record<string, string> = {}): Storage {
  const datos = new Map(Object.entries(inicial));
  return {
    get length() {
      return datos.size;
    },
    clear: () => datos.clear(),
    getItem: (k: string) => datos.get(k) ?? null,
    key: (i: number) => [...datos.keys()][i] ?? null,
    removeItem: (k: string) => void datos.delete(k),
    setItem: (k: string, v: string) => void datos.set(k, v),
  } as Storage;
}

/** Almacén que revienta, como el de un navegador en modo privado o con la cuota llena. */
function storageQueFalla(): Storage {
  return {
    get length(): number {
      throw new Error('bloqueado');
    },
    clear: () => {
      throw new Error('bloqueado');
    },
    getItem: () => {
      throw new Error('bloqueado');
    },
    key: () => {
      throw new Error('bloqueado');
    },
    removeItem: () => {
      throw new Error('bloqueado');
    },
    setItem: () => {
      throw new Error('bloqueado');
    },
  } as unknown as Storage;
}

const CLAVE = 'operationsimulator.progress.v1';

describe('Progress', () => {
  it('guarda y devuelve la mejor marca', () => {
    const s = storageFalso();
    const p = new Progress(s);
    expect(p.get('op')).toBeNull();

    p.record('op', 70, 90_000, false);
    p.record('op', 100, 120_000, true);

    const r = p.get('op')!;
    expect(r.bestScore).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(2);
  });

  /*
   * Si el mejor tiempo contara cualquier intento, el récord lo marcaría quien valida a los diez
   * segundos con la mesa vacía, que es lo contrario de lo que se quiere premiar.
   */
  it('el mejor tiempo solo cuenta intentos superados', () => {
    const p = new Progress(storageFalso());
    p.record('op', 20, 5_000, false); // rapidísimo pero mal
    expect(p.get('op')!.bestTimeMs).toBeNull();

    p.record('op', 100, 200_000, true);
    expect(p.get('op')!.bestTimeMs).toBe(200_000);

    p.record('op', 100, 150_000, true);
    expect(p.get('op')!.bestTimeMs).toBe(150_000);

    p.record('op', 40, 1_000, false); // otro rápido y malo: no debe bajar el récord
    expect(p.get('op')!.bestTimeMs).toBe(150_000);
  });

  it('la mejor nota nunca baja', () => {
    const p = new Progress(storageFalso());
    p.record('op', 90, 10_000, false);
    p.record('op', 30, 10_000, false);
    expect(p.get('op')!.bestScore).toBe(90);
  });

  it('persiste entre instancias', () => {
    const s = storageFalso();
    new Progress(s).record('op', 80, 60_000, true);
    expect(new Progress(s).get('op')!.bestScore).toBe(80);
  });

  it('sin almacén sigue funcionando, solo que sin recordar', () => {
    const p = new Progress(null);
    p.record('op', 80, 1_000, true);
    expect(p.get('op')!.bestScore).toBe(80); // en memoria sí
    expect(p.isEphemeral()).toBe(true);
  });

  /*
   * Un navegador puede lanzar al leer o al escribir. El juego no puede caerse por no poder apuntar
   * una nota: se sigue jugando, solo que sin recordar al recargar.
   */
  it('si el almacén revienta, no propaga la excepción', () => {
    const p = new Progress(storageQueFalla());
    expect(() => p.record('op', 80, 1_000, true)).not.toThrow();
    expect(p.get('op')!.bestScore).toBe(80);
    expect(p.isEphemeral()).toBe(true);
  });

  it('con JSON corrupto empieza limpio en vez de propagar basura', () => {
    const p = new Progress(storageFalso({ [CLAVE]: '{esto no es json' }));
    expect(p.get('op')).toBeNull();
    expect(() => p.record('op', 50, 1_000, false)).not.toThrow();
  });

  /*
   * Se descarta entrada a entrada y no el bloque entero: si una operación quedó a medias, no tiene
   * por qué llevarse por delante el progreso de las demás.
   */
  it('descarta solo los registros con forma inválida', () => {
    const guardado = JSON.stringify({
      buena: { bestScore: 90, bestTimeMs: 1000, passed: true, attempts: 2 },
      rota: { bestScore: 'muchísimo', attempts: null },
      tambienRota: null,
    });
    const p = new Progress(storageFalso({ [CLAVE]: guardado }));
    expect(p.get('buena')!.bestScore).toBe(90);
    expect(p.get('rota')).toBeNull();
    expect(p.get('tambienRota')).toBeNull();
  });

  /*
   * El motivo de que exista el historial: fallar y marcharse al menú sin corregir tiene que dejar
   * rastro. Con solo la mejor marca, ese intento desaparecía.
   */
  it('registra cada intento, también los fallidos, el más reciente primero', () => {
    const p = new Progress(storageFalso());
    p.record('op', 40, 60_000, false, { missing: 3, wrong: 1 }, 1000);
    p.record('op', 82, 50_000, false, { missing: 1, wrong: 0 }, 2000);
    const h = p.get('op')!.history;
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ score: 82, missing: 1, wrong: 0, at: 2000 });
    expect(h[1]).toMatchObject({ score: 40, missing: 3, wrong: 1 });
  });

  it('el historial se recorta y no crece sin fin', () => {
    const p = new Progress(storageFalso());
    for (let i = 0; i < 25; i++) p.record('op', i, 1000, false);
    const h = p.get('op')!.history;
    expect(h).toHaveLength(10);
    expect(h[0].score).toBe(24); // el más reciente
    expect(p.get('op')!.attempts).toBe(25); // pero el recuento no se recorta
  });

  it('un historial corrupto no se lleva por delante la mejor marca', () => {
    const guardado = JSON.stringify({
      op: { bestScore: 90, bestTimeMs: 1000, passed: true, attempts: 2, history: 'no soy un array' },
    });
    const r = new Progress(storageFalso({ [CLAVE]: guardado })).get('op')!;
    expect(r.bestScore).toBe(90);
    expect(r.history).toEqual([]);
  });

  it('acota valores fuera de rango en vez de creérselos', () => {
    const guardado = JSON.stringify({
      op: { bestScore: 9999, bestTimeMs: -5, passed: 'sí', attempts: -3 },
    });
    const r = new Progress(storageFalso({ [CLAVE]: guardado })).get('op')!;
    expect(r.bestScore).toBe(100);
    expect(r.bestTimeMs).toBeNull();
    expect(r.passed).toBe(false); // 'sí' no es true
    expect(r.attempts).toBe(0);
  });
});
