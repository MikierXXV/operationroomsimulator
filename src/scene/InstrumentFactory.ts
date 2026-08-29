import * as THREE from 'three';
import { crearCargadorGltf } from './gltf';
import type { Instrument } from '../types/contracts';
import { buildInstrumentModel } from './instrumentModels';
import { splitInstrumentSet, type InstrumentSet } from './glbParts';
import { INSTRUMENT_SCALE } from './layout';

/**
 * Dónde queda el origen del grupo respecto al modelo.
 *
 * `base` es el convenio de la escena: el origen cae en el centro de la huella y a la altura de la
 * BASE de la pieza, de modo que colocar es `position.set(x, alturaDeApoyo, z)` y funciona igual
 * sobre la mesa, sobre la bandeja o en el descarte, que están a alturas distintas.
 *
 * `center` es para el visor de inspección, que gira el modelo sobre sí mismo: anclado en la base,
 * el pivote quedaría en un extremo y la pieza bailaría en lugar de girar.
 */
export type Anchor = 'base' | 'center';

export interface CreateOptions {
  anchor?: Anchor;
}

/**
 * Altura máxima de una pieza tumbada. Por encima, tapa lo que tiene detrás.
 *
 * NO crece con `INSTRUMENT_SCALE`: el límite no es estético sino de visibilidad —lo alto tapa la
 * fila de atrás—, y esa restricción depende de la cámara, no del tamaño que queramos darle a los
 * instrumentos. Agrandar en largo y ancho es gratis; en alto, no.
 */
const MAX_HEIGHT = 0.06;
/** Límites de longitud, para que ningún GLB salga microscópico ni descomunal. */
const MIN_LENGTH = 0.1 * INSTRUMENT_SCALE;
const MAX_LENGTH = 0.24 * INSTRUMENT_SCALE;

/**
 * Crea el objeto 3D de un instrumento. Si el instrumento define `glb`, lo carga; si no (o si falla
 * la carga), genera un modelo procedural según su categoría. Devuelve un Group para que posición y
 * rotación sean uniformes.
 */
export class InstrumentFactory {
  private loader = crearCargadorGltf();
  private base: string;
  /**
   * Sets ya troceados, por URL.
   *
   * Cinco instrumentos del catálogo salen del mismo fichero: sin caché se descargaría y se
   * separaría cinco veces el mismo modelo. Se guarda la promesa, no el resultado, para que las
   * cinco peticiones simultáneas del primer reparto compartan una única descarga.
   */
  private sets = new Map<string, Promise<InstrumentSet | null>>();

  constructor(base: string = import.meta.env.BASE_URL) {
    this.base = base;
  }

  create(instrument: Instrument, options: CreateOptions = {}): THREE.Group {
    const anchor = options.anchor ?? 'base';
    const group = new THREE.Group();
    group.name = `instrument:${instrument.id}`;
    group.userData.instrumentId = instrument.id;

    // Modelo procedural inmediato; si hay GLB, se sustituye al cargar.
    const placeholder = this.placeholder(instrument);
    /*
     * Un único punto de escalado para TODO el instrumental.
     *
     * Se aplica al procedural y, como la referencia de tamaño del GLB se mide sobre él (ver abajo),
     * los modelos cargados heredan la misma subida sin tocar nada más. Así agrandar las piezas es un
     * número en `layout.ts` y no una revisión de dieciocho modelos.
     */
    placeholder.scale.setScalar(INSTRUMENT_SCALE);
    anchorObject(placeholder, anchor);
    group.add(placeholder);

    /*
     * La longitud del procedural es la referencia de escala del GLB.
     *
     * Antes todos los GLB se escalaban a 0.42 fuese cual fuese la pieza: la hoja de bisturí salía
     * del tamaño de una sierra, y todos ellos dos o tres veces más grandes que los procedurales con
     * los que comparten mesa. Midiendo el modelo al que sustituye, cada instrumento hereda la escala
     * que ya se había decidido para él y no hace falta una tabla nueva que mantener.
     */
    const referencia = footprintLength(placeholder);

    if (instrument.glb) {
      const url = this.base.replace(/\/$/, '') + '/' + instrument.glb.replace(/^\//, '');
      const objetivo = clamp(instrument.glbLength ?? referencia, MIN_LENGTH, MAX_LENGTH);
      // El procedural se retira DESPUÉS de encajar el GLB: si la carga tarda, la mesa nunca queda
      // con un hueco vacío donde debería haber un instrumento.
      const sustituir = (model: THREE.Object3D): void => {
        fitToTable(model, objetivo, anchor, instrument.glbRotation);
        dressModel(model, instrument.id);
        group.remove(placeholder);
        disposeObject(placeholder);
        group.add(model);
      };

      if (instrument.glbPart !== undefined) {
        const parte = instrument.glbPart;
        this.loadSet(url)
          .then((set) => {
            const geo = set?.parts[parte];
            if (!geo) {
              // Repliegue al procedural, que ya está puesto: un índice fuera de rango no debe
              // dejar la mesa coja.
              console.warn(`[InstrumentFactory] El set ${url} no tiene la pieza ${parte}`);
              return;
            }
            // Se clona geometría y material por instancia: `clearInstruments` los libera al vaciar
            // la escena, y con buffers compartidos liberar un instrumento borraría a sus hermanos.
            sustituir(new THREE.Mesh(geo.clone(), set!.material.clone()));
          })
          .catch(() => console.warn(`[InstrumentFactory] No se pudo cargar el set: ${url}`));
      } else {
        this.loader.load(url, (gltf) => sustituir(gltf.scene), undefined, () => {
          // Error de carga: nos quedamos con el procedural, que ya está puesto.
          console.warn(`[InstrumentFactory] No se pudo cargar GLB: ${url}`);
        });
      }
    }

    return group;
  }

  /** Descarga y trocea un set de instrumentos, una sola vez por fichero. */
  private loadSet(url: string): Promise<InstrumentSet | null> {
    let pendiente = this.sets.get(url);
    if (!pendiente) {
      pendiente = this.loader.loadAsync(url).then((gltf) => splitInstrumentSet(gltf.scene));
      this.sets.set(url, pendiente);
    }
    return pendiente;
  }

  /** Modelo procedural detallado según el tipo de instrumento. */
  private placeholder(instrument: Instrument): THREE.Object3D {
    return buildInstrumentModel(instrument);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Marca el modelo con su id, le activa las sombras y refuerza los reflejos del env map. */
function dressModel(model: THREE.Object3D, instrumentId: string): void {
  model.traverse((o) => {
    o.userData.instrumentId = instrumentId;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const apply = (m: THREE.Material): void => {
      const std = m as THREE.MeshStandardMaterial;
      if (std && 'envMapIntensity' in std) std.envMapIntensity = 1.2;
    };
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach(apply);
    else if (mat) apply(mat);
  });
}

function measure(obj: THREE.Object3D): { box: THREE.Box3; size: THREE.Vector3 } {
  // Hay que refrescar las matrices entre paso y paso: `Box3.setFromObject` mide en coordenadas de
  // mundo, y con una matriz sin actualizar devuelve la caja de ANTES de la última transformación.
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size };
}

/** Longitud de la huella sobre la mesa: lo que ocupa tumbado, sin contar el alto. */
function footprintLength(obj: THREE.Object3D): number {
  const { size } = measure(obj);
  return Math.max(size.x, size.z) || MIN_LENGTH;
}

/**
 * Deja el origen del objeto donde dice `anchor`, sin tocar escala ni rotación.
 *
 * Se aplica también a los modelos procedurales: están centrados en el origen, así que colocados a
 * la altura de la mesa quedaban medio hundidos. Antes se compensaba sumando 1,5 cm a mano en el
 * momento de colocar, un apaño que solo valía para la mesa y fallaba en la bandeja, que está más
 * alta.
 */
function anchorObject(obj: THREE.Object3D, anchor: Anchor): void {
  const { box } = measure(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= anchor === 'base' ? box.min.y : center.y;
}

/**
 * Tumba, escala, limita la altura y ancla un modelo cargado de un GLB.
 *
 * Los GLB vienen con la orientación y el tamaño que quiso su autor: unos miden centímetros y otros
 * metros, y unos están tumbados y otros de pie. Sin esto, un mismo catálogo mezcla piezas a escalas
 * incompatibles y algunas atraviesan la mesa.
 */
function fitToTable(
  model: THREE.Object3D,
  targetLength: number,
  anchor: Anchor,
  rotationOverride?: readonly [number, number, number],
): void {
  // 1. Tumbar. La heurística es «el eje más largo va sobre la mesa»; para los modelos de caja casi
  //    cúbica, donde esa suposición falla, la ficha puede imponer la rotación.
  if (rotationOverride) {
    model.rotation.set(rotationOverride[0], rotationOverride[1], rotationOverride[2]);
  } else {
    const { size } = measure(model);
    if (size.y > size.x && size.y > size.z) model.rotation.z = -Math.PI / 2;
    else if (size.z > size.x) model.rotation.y = Math.PI / 2;
  }

  // 2. Escalar por la huella, no por la dimensión máxima: si se usa el alto, una pieza esbelta y
  //    vertical sale diminuta al tumbarla.
  const tras = measure(model);
  const largo = Math.max(tras.size.x, tras.size.z) || 1;
  let escala = targetLength / largo;

  // 3. Limitar el alto. Un instrumento demasiado alto tapa la fila de detrás, que es justo el
  //    problema que toda esta geometría existe para evitar.
  const altoFinal = tras.size.y * escala;
  if (altoFinal > MAX_HEIGHT) escala *= MAX_HEIGHT / altoFinal;
  model.scale.setScalar(escala);

  // 4. Anclar, ya con la escala aplicada.
  anchorObject(model, anchor);
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}
