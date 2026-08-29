import * as THREE from 'three';

/**
 * Separa un GLB que contiene VARIOS instrumentos en una sola malla.
 *
 * Muchos de los sets de instrumental publicados con licencia libre vienen así: un único fichero con
 * siete u ocho piezas alineadas una junto a otra, todas en la misma malla y compartiendo material.
 * Tal cual no sirven —colocar el set entero en un hueco de la bandeja no significa nada—, pero
 * dentro está justo lo que hace falta: instrumentos modelados de verdad, con sus anillas, su cremallera
 * y sus dentados, que es lo que los modelos procedurales no consiguen transmitir.
 *
 * La separación se hace en dos pasos, y el segundo es el que importa:
 *
 *  1. Componentes conexas por aristas. NO basta: cada instrumento son varias cáscaras sueltas (las dos
 *     ramas de una tijera, cada anilla), así que esto devuelve muchos más trozos que instrumentos.
 *  2. Fusión de los trozos cuyo intervalo se SOLAPA sobre el eje en el que están alineados. Como las
 *     piezas se colocan separadas para que se vean, sus intervalos son disjuntos entre instrumentos y
 *     solapan dentro de cada uno. Esto sí reconstruye las piezas.
 *
 * Cada parte se devuelve COMPACTADA (solo sus vértices). Es imprescindible, no una optimización:
 * `Box3.setFromObject` mide con la caja de la geometría completa, así que una parte que compartiera
 * el buffer del set entero se mediría como el set entero y saldría a una escala absurda.
 */

/**
 * Hueco mínimo entre dos piezas, como FRACCIÓN de lo que mide el set en el eje de alineación.
 *
 * Relativo y no absoluto a propósito: el mismo modelo mide ~9 unidades en el espacio de su malla y
 * 0,42 m una vez aplicada la matriz del nodo, así que un umbral en unidades fijas o parte piezas de
 * más en un caso o las funde todas en el otro. Los sets separan las piezas para que se distingan, y
 * esa separación es un porcentaje del conjunto, no una distancia concreta.
 */
const SEPARACION = 0.01;
/** Trozos con menos vértices que esto son ruido (restos sueltos), no una pieza. */
const MIN_VERTICES = 8;

export interface InstrumentSet {
  /** Geometrías de cada pieza, en el orden en que están alineadas en el fichero. */
  parts: THREE.BufferGeometry[];
  /** Material compartido del set; conviene clonarlo por instancia antes de usarlo. */
  material: THREE.Material;
}

/**
 * Devuelve las piezas de un set, o `null` si el modelo no tiene la forma esperada
 * (sin mallas, o sin índice, que es lo que necesita el recorrido por aristas).
 */
export function splitInstrumentSet(root: THREE.Object3D): InstrumentSet | null {
  root.updateMatrixWorld(true);

  // Se trabaja sobre la malla con más triángulos: en estos sets es la que lleva el instrumental,
  // y las demás (si las hay) suelen ser suelo o atrezo.
  let mesh: THREE.Mesh | null = null;
  let mejor = -1;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const n = m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position?.count ?? 0;
    if (n > mejor) {
      mejor = n;
      mesh = m;
    }
  });
  if (!mesh) return null;

  const fuente = mesh as THREE.Mesh;
  // Hornear la matriz de mundo: así las piezas salen ya en el espacio del root y no arrastran
  // la escala ni la rotación del nodo que las contenía.
  const geo = fuente.geometry.clone();
  geo.applyMatrix4(fuente.matrixWorld);

  const index = geo.index;
  const pos = geo.attributes.position;
  if (!index || !pos) {
    geo.dispose();
    return null;
  }
  const idx = index.array;
  const n = pos.count;

  // --- 1. Componentes conexas (union-find sobre los vértices de cada triángulo) ---
  const padre = new Int32Array(n);
  for (let i = 0; i < n; i++) padre[i] = i;
  const raiz = (a: number): number => {
    while (padre[a] !== a) {
      padre[a] = padre[padre[a]]; // compresión de camino
      a = padre[a];
    }
    return a;
  };
  const unir = (a: number, b: number): void => {
    const ra = raiz(a);
    const rb = raiz(b);
    if (ra !== rb) padre[ra] = rb;
  };
  for (let i = 0; i < idx.length; i += 3) {
    unir(idx[i], idx[i + 1]);
    unir(idx[i + 1], idx[i + 2]);
  }

  // --- 2. Eje de alineación: aquel en el que el set es más largo ---
  geo.computeBoundingBox();
  const caja = geo.boundingBox!;
  const extension = [caja.max.x - caja.min.x, caja.max.y - caja.min.y, caja.max.z - caja.min.z];
  const eje = extension.indexOf(Math.max(...extension)) as 0 | 1 | 2;
  const coord = (v: number): number =>
    eje === 0 ? pos.getX(v) : eje === 1 ? pos.getY(v) : pos.getZ(v);

  // Intervalo de cada componente sobre ese eje.
  const trozos = new Map<number, { min: number; max: number; nv: number; raiz: number }>();
  for (let v = 0; v < n; v++) {
    const r = raiz(v);
    const c = coord(v);
    const t = trozos.get(r);
    if (!t) {
      trozos.set(r, { min: c, max: c, nv: 1, raiz: r });
      continue;
    }
    t.nv++;
    if (c < t.min) t.min = c;
    if (c > t.max) t.max = c;
  }

  // --- 3. Fusionar intervalos solapados ---
  const holgura = extension[eje] * SEPARACION;
  const ordenados = [...trozos.values()].filter((t) => t.nv >= MIN_VERTICES).sort((a, b) => a.min - b.min);
  const piezas: { min: number; max: number; raices: number[] }[] = [];
  for (const t of ordenados) {
    const ultima = piezas[piezas.length - 1];
    if (ultima && t.min <= ultima.max + holgura) {
      ultima.max = Math.max(ultima.max, t.max);
      ultima.raices.push(t.raiz);
    } else {
      piezas.push({ min: t.min, max: t.max, raices: [t.raiz] });
    }
  }
  if (piezas.length === 0) {
    geo.dispose();
    return null;
  }

  // --- 4. Repartir triángulos y compactar ---
  const deRaizAPieza = new Map<number, number>();
  piezas.forEach((p, i) => p.raices.forEach((r) => deRaizAPieza.set(r, i)));

  const triangulos: number[][] = piezas.map(() => []);
  for (let i = 0; i < idx.length; i += 3) {
    const p = deRaizAPieza.get(raiz(idx[i]));
    if (p === undefined) continue; // triángulo de un trozo descartado por ruido
    triangulos[p].push(idx[i], idx[i + 1], idx[i + 2]);
  }

  const parts = triangulos
    .filter((t) => t.length > 0)
    .map((t) => compactar(geo, t));

  const material = Array.isArray(fuente.material) ? fuente.material[0] : fuente.material;
  geo.dispose();
  return { parts, material };
}

/**
 * Construye una geometría nueva que contiene SOLO los vértices usados por esos triángulos.
 *
 * Sin esto la parte seguiría llevando el buffer del set completo: se dibujaría bien, pero su caja
 * envolvente —y por tanto su escala y su asentado sobre la mesa— serían las del set entero.
 */
function compactar(geo: THREE.BufferGeometry, triangulos: number[]): THREE.BufferGeometry {
  const viejoANuevo = new Map<number, number>();
  const indice = new Array<number>(triangulos.length);
  for (let i = 0; i < triangulos.length; i++) {
    const v = triangulos[i];
    let nuevo = viejoANuevo.get(v);
    if (nuevo === undefined) {
      nuevo = viejoANuevo.size;
      viejoANuevo.set(v, nuevo);
    }
    indice[i] = nuevo;
  }

  const salida = new THREE.BufferGeometry();
  for (const [nombre, attr] of Object.entries(geo.attributes)) {
    const origen = attr as THREE.BufferAttribute;
    const items = origen.itemSize;
    const datos = new Float32Array(viejoANuevo.size * items);
    for (const [viejo, nuevo] of viejoANuevo) {
      for (let k = 0; k < items; k++) {
        datos[nuevo * items + k] = origen.array[viejo * items + k] as number;
      }
    }
    salida.setAttribute(nombre, new THREE.BufferAttribute(datos, items, origen.normalized));
  }
  salida.setIndex(indice);
  salida.computeBoundingBox();
  salida.computeBoundingSphere();
  return salida;
}
