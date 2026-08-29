import { describe, it, expect, vi } from 'vitest';
import { OperationEngine } from './OperationEngine';
import type { Operation, OperationCatalog } from '../types/contracts';

const op: Operation = {
  id: 'test-op',
  name: 'Operación de prueba',
  required: ['a', 'b', 'c'],
  optional: ['d'],
  distractors: ['x', 'y'],
};

const catalog: OperationCatalog = {
  instruments: [
    { id: 'a', name: 'A', category: 'c' },
    { id: 'b', name: 'B', category: 'c' },
    { id: 'c', name: 'C', category: 'c' },
    { id: 'd', name: 'D', category: 'c' },
    { id: 'x', name: 'X', category: 'c' },
    { id: 'y', name: 'Y', category: 'c' },
  ],
  operations: [op],
};

describe('OperationEngine.evaluate', () => {
  it('nota perfecta con todos los required y ningún distractor', () => {
    const r = OperationEngine.evaluate(op, ['a', 'b', 'c']);
    expect(r.score).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.wrong).toEqual([]);
  });

  it('los opcionales no afectan a la nota ni al passed', () => {
    const r = OperationEngine.evaluate(op, ['a', 'b', 'c', 'd']);
    expect(r.score).toBe(100);
    expect(r.passed).toBe(true);
  });

  it('penaliza required faltantes', () => {
    const r = OperationEngine.evaluate(op, ['a', 'b']);
    expect(r.score).toBe(67); // 2/3
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(['c']);
  });

  it('penaliza distractores y no pasa aunque estén todos los required', () => {
    const r = OperationEngine.evaluate(op, ['a', 'b', 'c', 'x']);
    expect(r.passed).toBe(false);
    expect(r.wrong).toEqual(['x']);
    expect(r.score).toBe(67); // 1 - 1/3
  });

  it('la nota nunca baja de 0', () => {
    const r = OperationEngine.evaluate(op, ['x', 'y']);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });
});

describe('OperationEngine flujo de estado', () => {
  it('emite transiciones menu -> preparing -> result', () => {
    const onStateChange = vi.fn();
    const engine = new OperationEngine({ onStateChange }, catalog);

    expect(engine.getState().phase).toBe('menu');

    engine.selectOperation('test-op');
    expect(engine.getState().phase).toBe('preparing');

    engine.addToTray('a');
    engine.addToTray('a'); // duplicado ignorado
    engine.addToTray('b');
    engine.addToTray('c');
    expect(engine.getState().tray).toEqual(['a', 'b', 'c']);

    const result = engine.validate();
    expect(result?.passed).toBe(true);
    expect(engine.getState().phase).toBe('result');
    expect(onStateChange).toHaveBeenCalled();
  });

  it('removeFromTray quita el instrumento', () => {
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog);
    engine.selectOperation('test-op');
    engine.addToTray('a');
    engine.addToTray('b');
    engine.removeFromTray('a');
    expect(engine.getState().tray).toEqual(['b']);
  });

  it('getPoolInstruments incluye required, optional y distractors', () => {
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog);
    const pool = engine.getPoolInstruments(op).map((i) => i.id);
    expect(pool.sort()).toEqual(['a', 'b', 'c', 'd', 'x', 'y']);
  });
});

describe('OperationEngine · fin automático', () => {
  const motor = () => new OperationEngine({ onStateChange: () => {} }, catalog);

  it('no está completa mientras falte una obligatoria', () => {
    const engine = motor();
    engine.selectOperation('test-op');
    engine.addToTray('a');
    engine.addToTray('b');
    expect(engine.isTrayComplete()).toBe(false);
  });

  it('está completa con todas las obligatorias', () => {
    const engine = motor();
    engine.selectOperation('test-op');
    ['a', 'b', 'c'].forEach((id) => engine.addToTray(id));
    expect(engine.isTrayComplete()).toBe(true);
  });

  it('las opcionales no estorban', () => {
    const engine = motor();
    engine.selectOperation('test-op');
    ['a', 'b', 'c', 'd'].forEach((id) => engine.addToTray(id));
    expect(engine.isTrayComplete()).toBe(true);
  });

  /*
   * El caso que justifica exigir «y ningún distractor»: sin esta condición la partida se cerraría
   * sola con un instrumento equivocado sobre la mesa, sin dar ocasión de retirarlo.
   */
  it('un distractor impide terminar aunque estén todas las obligatorias', () => {
    const engine = motor();
    engine.selectOperation('test-op');
    ['a', 'b', 'c', 'x'].forEach((id) => engine.addToTray(id));
    expect(engine.isTrayComplete()).toBe(false);
    engine.removeFromTray('x');
    expect(engine.isTrayComplete()).toBe(true);
  });

  it('fuera de la preparación nunca está completa', () => {
    const engine = motor();
    expect(engine.isTrayComplete()).toBe(false); // en el menú
    engine.selectOperation('test-op');
    ['a', 'b', 'c'].forEach((id) => engine.addToTray(id));
    engine.validate();
    expect(engine.isTrayComplete()).toBe(false); // ya en resultado
  });
});

describe('OperationEngine · corregir y niveles', () => {
  /** Reloj de mentira: el tiempo solo avanza cuando lo decide el test. */
  const relojFalso = () => {
    let t = 1000;
    return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
  };

  /*
   * El caso que motiva todo `resume()`: antes, tras ver la nota, la única salida era «Reintentar»,
   * que llamaba a `reset()` y borraba los once instrumentos por dos fallos. Corregir tiene que
   * conservar la mesa.
   */
  it('resume() conserva la bandeja y vuelve a preparación', () => {
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog);
    engine.selectOperation('test-op');
    engine.addToTray('a');
    engine.addToTray('b');
    engine.validate();
    expect(engine.getState().phase).toBe('result');

    engine.resume();
    expect(engine.getState().phase).toBe('preparing');
    expect(engine.getState().tray).toEqual(['a', 'b']);
    expect(engine.getState().result).toBeNull();
  });

  it('resume() NO reinicia el cronómetro: mide el total hasta dejarla bien', () => {
    const reloj = relojFalso();
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog, reloj.ahora);
    engine.selectOperation('test-op');
    reloj.avanzar(40_000);
    engine.addToTray('a');
    engine.validate();

    engine.resume();
    reloj.avanzar(20_000);
    ['b', 'c'].forEach((id) => engine.addToTray(id));
    // 60 s, no 20: reiniciarlo premiaría validar a lo loco para parar el reloj.
    expect(engine.validate()?.elapsedMs).toBe(60_000);
  });

  it('cuenta los intentos y los reinicia al cambiar o vaciar', () => {
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog);
    engine.selectOperation('test-op');
    expect(engine.validate()?.attempts).toBe(1);
    engine.resume();
    expect(engine.validate()?.attempts).toBe(2);
    engine.reset();
    expect(engine.validate()?.attempts).toBe(1);
  });

  it('resume() no hace nada fuera del resultado', () => {
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog);
    engine.selectOperation('test-op');
    engine.addToTray('a');
    engine.resume();
    expect(engine.getState().phase).toBe('preparing');
    expect(engine.getState().tray).toEqual(['a']);
  });

  it('ordena por nivel y encadena hasta el último', () => {
    const porNiveles: OperationCatalog = {
      instruments: catalog.instruments,
      operations: [
        { id: 'c', name: 'C', level: 3, required: ['a'] },
        { id: 'a', name: 'A', level: 1, required: ['a'] },
        { id: 'b', name: 'B', level: 2, required: ['a'] },
      ],
    };
    const engine = new OperationEngine({ onStateChange: () => {} }, porNiveles);
    expect(engine.getOperations().map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(engine.getNextOperation('a')?.id).toBe('b');
    expect(engine.getNextOperation('b')?.id).toBe('c');
    // El último no da la vuelta: el HUD necesita distinguir «hay más» de «te los has pasado todos».
    expect(engine.getNextOperation('c')).toBeNull();
  });
});

describe('OperationEngine · cronómetro', () => {
  /** Reloj de mentira: el tiempo solo avanza cuando lo decide el test. */
  const relojFalso = () => {
    let t = 1000;
    return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
  };

  it('mide el tiempo desde que se elige la operación hasta que se valida', () => {
    const reloj = relojFalso();
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog, reloj.ahora);
    engine.selectOperation('test-op');
    reloj.avanzar(75_000);
    ['a', 'b', 'c'].forEach((id) => engine.addToTray(id));
    const r = engine.validate();
    expect(r?.elapsedMs).toBe(75_000);
  });

  it('reintentar reinicia el cronómetro', () => {
    const reloj = relojFalso();
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog, reloj.ahora);
    engine.selectOperation('test-op');
    reloj.avanzar(60_000);
    ['a', 'b', 'c'].forEach((id) => engine.addToTray(id));
    engine.validate();

    engine.reset();
    reloj.avanzar(10_000);
    ['a', 'b', 'c'].forEach((id) => engine.addToTray(id));
    // 10 s, no 70: el segundo intento no arrastra el tiempo del primero.
    expect(engine.validate()?.elapsedMs).toBe(10_000);
  });

  it('no corre fuera de la preparación', () => {
    const reloj = relojFalso();
    const engine = new OperationEngine({ onStateChange: () => {} }, catalog, reloj.ahora);
    expect(engine.getElapsedMs()).toBe(0);
    engine.selectOperation('test-op');
    reloj.avanzar(5000);
    expect(engine.getElapsedMs()).toBe(5000);
    engine.backToMenu();
    expect(engine.getElapsedMs()).toBe(0);
  });
});
