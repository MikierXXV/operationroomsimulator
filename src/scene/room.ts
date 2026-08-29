import * as THREE from 'three';

/**
 * Decorado del quirófano: todo lo que rodea a la mesa del instrumentista sin ser jugable.
 *
 * Vive fuera de `SceneManager` porque no interviene en nada: no se puede coger, no se mide, no
 * participa en el encuadre. Sigue el patrón de `handGlove.ts` e `instrumentModels.ts`, que también
 * son geometría que se construye una vez y se olvida.
 *
 * DOS REGLAS, que son las que impiden que esto acabe siendo ruido:
 *
 *  1. **Ni una luz nueva.** Todo lo que brilla lo hace con material emisivo. Cada luz con sombra
 *     cuesta un mapa de sombras por frame y ya hay una —el foco quirúrgico sobre la mesa—; el fondo
 *     no tiene que proyectar nada sobre nadie.
 *  2. **Desaturado y en penumbra.** El foco sigue estando sobre la mesa. Lo de atrás se lee como
 *     contexto, no compite por la atención, y por eso los tonos son apagados y las emisiones débiles.
 *
 * Todo se sitúa en la BANDA SUPERIOR del encuadre, que es la única parte que estaba vacía: la cámara
 * mira hacia abajo a la mesa y lo que se ve por encima de ella era fondo liso.
 */

const VERDE_PANO = '#2c5b50';
const METAL_APAGADO = '#48585f';

/** Materiales compartidos: el decorado son decenas de mallas y no tiene sentido un material por una. */
const matPano = new THREE.MeshStandardMaterial({ color: VERDE_PANO, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 });
const matMetal = new THREE.MeshStandardMaterial({ color: METAL_APAGADO, roughness: 0.55, metalness: 0.7, envMapIntensity: 0.4 });
const matTecho = new THREE.MeshStandardMaterial({ color: '#1b2b33', roughness: 0.95, metalness: 0 });
const matPanelApagado = new THREE.MeshStandardMaterial({ color: '#33474f', roughness: 0.7, emissive: '#4a6570', emissiveIntensity: 0.35 });

export function buildOperatingRoom(): THREE.Group {
  const sala = new THREE.Group();
  sala.name = 'quirofano';
  sala.add(techo(), mesaDeOperaciones(), negatoscopio(), reloj());
  return sala;
}

// ---------------------------------------------------------------------------
// Quirófano real, cargado de un GLB
// ---------------------------------------------------------------------------

/** Ruta del modelo. Si falta, se sigue jugando con el decorado de arriba. */
const MODELO = 'assets/hospital_operating_room.glb';

/**
 * Colocación del modelo, medida sobre él y no a ojo.
 *
 * El GLB viene en metros reales: 7,19 × 3,2 × 4,18, con el suelo en y=-0.5 y la sala centrada en el
 * origen. Dentro, su mesa de operaciones mide 1,91 m y está en (1.26, 0.14).
 *
 * `escala` no es 1 porque **nuestra mesa mide 3,2 m**, más del doble que una mesa de instrumentista
 * real. Es un tamaño de juego, no de quirófano: se decidió así para que quepan dieciséis
 * instrumentos y se puedan coger con la mano. A escala natural, la sala se quedaría pequeña y nuestra
 * mesa se montaría encima de la suya. Con 1.6 su mesa de operaciones pasa a medir 3,05 m, que es
 * comparable a la nuestra, y la sala da de sí para las dos.
 */
const ENCAJE = {
  escala: 1.6,
  /*
   * SIN GIRO, y esto costó un intento.
   *
   * El modelo es una habitación EN CORTE: solo tiene pared al fondo (z=-2.03) y a la derecha; los
   * otros dos lados están abiertos, que es como se modelan los interiores para poder mirarlos desde
   * fuera. Girándolo 180° esas dos paredes quedaban detrás de la cámara y el juego miraba hacia el
   * lado abierto: se veía el vacío, no un quirófano.
   *
   * Con giro 0, la pared del fondo queda detrás de la mesa, que es justo donde la cámara mira.
   */
  rotY: 0,
  /**
   * Centro de la sala en coordenadas de mundo.
   *
   * Elegido para que SU mesa de operaciones caiga detrás de la nuestra: está en (1.26, 0.14) del
   * modelo, o sea (2.02, 0.22) tras escalar, y con este desplazamiento aterriza cerca de (0, -2.5).
   */
  offset: { x: -2.0, z: -2.7 },
} as const;

/**
 * Volumen que el decorado NO puede invadir: la mesa de trabajo y el aire sobre ella.
 *
 * Estas escenas traen su propio mobiliario —mesa de instrumental, carritos, taburetes— y si se
 * añaden tal cual aparecen atravesando la nuestra. Se poda por intersección con esta caja.
 */
const VOLUMEN_DE_JUEGO = { minX: -2.0, maxX: 2.0, minZ: -1.7, maxZ: 1.9, maxY: 2.2 };

/**
 * Atribución del quirófano. Obligatoria: el modelo es CC BY.
 *
 * Vive junto a la ruta del modelo para que cambiar de sala obligue a ver también de quién es. Si
 * algún día se sustituye el `.glb`, este bloque salta a la vista en el mismo sitio.
 */
export const CREDITO_SALA = {
  nombre: 'Quirófano',
  author: 'Chenchanchong',
  license: 'CC BY 4.0',
  url: 'https://sketchfab.com/3d-models/hospital-operating-room-a27400a73f4a43fbb1dda30031cb91c2',
} as const;

export interface RoomLoadResult {
  group: THREE.Group;
  triangulos: number;
  mallas: number;
  podadas: number;
}

/**
 * Carga el quirófano real, lo encaja y poda lo que estorba.
 *
 * Devuelve `null` si el modelo no está o no carga, y entonces se sigue con el decorado procedural:
 * el juego tiene que arrancar en un clon recién bajado sin necesidad de descargar el modelo.
 */
export async function loadOperatingRoom(baseUrl: string): Promise<RoomLoadResult | null> {
  const { crearCargadorGltf } = await import('./gltf');
  const url = baseUrl.replace(/\/$/, '') + '/' + MODELO;
  let gltf;
  try {
    gltf = await crearCargadorGltf().loadAsync(url);
  } catch {
    console.warn(`[room] no se pudo cargar el quirófano: ${url}. Se usa el decorado propio.`);
    return null;
  }

  const group = new THREE.Group();
  group.name = 'quirofano-glb';
  group.add(gltf.scene);

  // 1. Encaje: escalar, girar y apoyar el suelo en y=0.
  group.scale.setScalar(ENCAJE.escala);
  group.rotation.y = ENCAJE.rotY;
  group.updateMatrixWorld(true);
  const caja = new THREE.Box3().setFromObject(group);
  /*
   * En Y NO se apoya el punto más bajo de la sala, se respeta su propio cero.
   *
   * El modelo trae una losa de suelo de medio metro de grosor que va de y=-0.5 a y=0: su cero YA es
   * la cara pisable. Apoyando el mínimo en 0 —que es el reflejo automático al encajar cualquier
   * modelo— toda la sala subía 0,8 m y su suelo quedaba a la altura de nuestra mesa: una plataforma
   * blanca delante de la cámara tapando el quirófano entero. Se veía un degradado pálido y parecía
   * que el modelo no hubiera cargado.
   *
   * Dejando `y = 0`, la losa cuelga bajo el suelo real, donde no molesta a nadie.
   */
  group.position.set(
    ENCAJE.offset.x - (caja.min.x + caja.max.x) / 2,
    0,
    ENCAJE.offset.z - (caja.min.z + caja.max.z) / 2,
  );
  group.updateMatrixWorld(true);

  // 2. Poda de lo que cae dentro del volumen de juego.
  const podadas = podarInvasores(group);

  // 3. Ajustes de render: nada del decorado proyecta sombras (la única luz con sombra es el foco
  //    sobre la mesa, y hacerle calcular 400 mallas más por frame no aporta nada visible).
  let triangulos = 0;
  let mallas = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    mallas++;
    const geo = m.geometry;
    triangulos += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    m.castShadow = false;
    m.receiveShadow = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      // Bajar el reflejo del env map: la sala tiene que quedarse en penumbra para que el foco de la
      // mesa siga siendo lo más luminoso del cuadro.
      if (std && 'envMapIntensity' in std) std.envMapIntensity = 0.25;
    }
  });

  return { group, triangulos: Math.round(triangulos), mallas, podadas };
}

/**
 * Quita las mallas que invaden el volumen de juego.
 *
 * Se mide malla a malla y no por grupos: los muebles del modelo vienen agrupados de forma arbitraria
 * y un grupo puede tener una pata dentro y el resto fuera. La caja se calcula en MUNDO, ya con el
 * encaje aplicado, que es donde importa el solape.
 */
function podarInvasores(group: THREE.Group): number {
  const fuera: THREE.Object3D[] = [];
  const caja = new THREE.Box3();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    caja.setFromObject(m);
    const invade =
      caja.max.x > VOLUMEN_DE_JUEGO.minX &&
      caja.min.x < VOLUMEN_DE_JUEGO.maxX &&
      caja.max.z > VOLUMEN_DE_JUEGO.minZ &&
      caja.min.z < VOLUMEN_DE_JUEGO.maxZ &&
      caja.min.y < VOLUMEN_DE_JUEGO.maxY;
    // El SUELO se salva siempre: es enorme, invade por definición y sin él la sala flota.
    const esSuelo = caja.max.y - caja.min.y < 0.9 && caja.min.y < 0.2;
    if (invade && !esSuelo) fuera.push(m);
  });
  for (const o of fuera) o.removeFromParent();
  return fuera.length;
}

/**
 * Techo con luminarias empotradas, apagadas.
 *
 * Es lo que más «cierra» la sala: sin techo, por encima de la pared solo había vacío negro y la
 * escena se leía como una mesa flotando. Las luminarias son emisivas y suaves; encenderlas de verdad
 * competiría con el foco.
 */
function techo(): THREE.Group {
  const g = new THREE.Group();
  const plancha = new THREE.Mesh(new THREE.BoxGeometry(16, 0.12, 14), matTecho);
  plancha.position.set(0, 3.9, -2);
  g.add(plancha);

  for (const [x, z] of [
    [-3.2, -4.2], [0, -4.2], [3.2, -4.2],
    [-3.2, -1.2], [3.2, -1.2],
  ] as const) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.7), matPanelApagado);
    panel.position.set(x, 3.82, z);
    g.add(panel);
  }
  return g;
}

/**
 * Mesa de operaciones al fondo, cubierta de paños. SIN figura humana.
 *
 * Es la pieza que de verdad dice «esto es un quirófano» en vez de «esto es una sala con aparatos»:
 * lo que se está preparando en primer plano es el instrumental PARA esa mesa. Se deja el campo
 * montado y vacío, que además es lo correcto en el momento que simula el juego —antes de empezar—.
 */
function mesaDeOperaciones(): THREE.Group {
  const g = new THREE.Group();

  const tablero = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 2.1), matPano);
  tablero.position.y = 0.86;
  g.add(tablero);

  // Paños cayendo por los lados, que es lo que le da volumen de tela.
  for (const lado of [-1, 1]) {
    const caida = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 2.1), matPano);
    caida.position.set(lado * 0.36, 0.62, 0);
    g.add(caida);
  }

  // Pedestal y base.
  const columna = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.78, 12), matMetal);
  columna.position.y = 0.42;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.07, 1.0), matMetal);
  base.position.y = 0.05;
  g.add(columna, base);

  /*
   * En la ESQUINA y recortada por el borde del encuadre, no centrada al fondo.
   *
   * Medido: la franja de fondo visible son 152 px de 810 —la cámara mira muy abajo—, y una mesa de
   * 0,96 m no cabe ahí a NINGUNA distancia. Cerca invade la mesa de trabajo; lejos, como la cámara
   * mira hacia abajo, el suelo distante proyecta por encima del borde superior y desaparece entera.
   *
   * Así que se coloca a un lado, aceptando que el marco la corte. Eso no es un apaño: es como se ve
   * de verdad una sala desde donde está el instrumentista, con la mesa quedando fuera de su campo
   * de atención. Lo que hay que evitar no es el recorte, sino que llame la atención: por eso va
   * oscura y a un lado, no centrada y clara como estaba.
   */
  g.position.set(-2.5, 0, -3.2);
  g.rotation.y = 0.55;
  return g;
}

/** Negatoscopio: el panel retroiluminado de las radiografías. Emisivo frío, tenue. */
function negatoscopio(): THREE.Group {
  const g = new THREE.Group();
  const marco = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 0.06), matMetal);
  const luz = new THREE.Mesh(
    new THREE.PlaneGeometry(0.98, 0.68),
    new THREE.MeshStandardMaterial({ color: '#dfeef5', emissive: '#9fc6d6', emissiveIntensity: 0.8 }),
  );
  luz.position.z = 0.035;
  g.add(marco, luz);
  g.position.set(-3.6, 2.2, -5.9);
  return g;
}

/** Reloj de pared: detalle pequeño que sitúa la sala sin llamar la atención. */
function reloj(): THREE.Group {
  const g = new THREE.Group();
  const esfera = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: '#c8d6da', roughness: 0.5, metalness: 0.2 }),
  );
  esfera.rotation.x = Math.PI / 2;
  const aguja = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.17, 0.01),
    new THREE.MeshStandardMaterial({ color: '#1b2b33' }),
  );
  aguja.position.set(0, 0.07, 0.035);
  const minutero = new THREE.Mesh(
    new THREE.BoxGeometry(0.015, 0.22, 0.01),
    new THREE.MeshStandardMaterial({ color: '#1b2b33' }),
  );
  minutero.position.set(0.05, -0.06, 0.035);
  minutero.rotation.z = 1.9;
  g.add(esfera, aguja, minutero);
  g.position.set(2.4, 2.5, -5.9);
  return g;
}
