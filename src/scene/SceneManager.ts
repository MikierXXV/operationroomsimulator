import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { DropZone, Instrument, ISceneApi, Pointer } from '../types/contracts';
import { InstrumentFactory } from './InstrumentFactory';
import { HandGlove } from './handGlove';
import { avanzarIntro, curvaIntro } from './intro';
import { buildOperatingRoom, loadOperatingRoom, type RoomLoadResult } from './room';
import {
  assertLayout,
  CAMERA,
  CONSULTA_PANEL_ABAJO,
  contentBounds,
  framingPoints,
  HAND_LENGTH,
  PALMA_SOBRE_MANO,
  INTERACTION,
  LAMP,
  poolLayout,
  SURFACE_Y,
  TABLE,
  TRAY,
  tableBounds,
  zoneCapacity,
  zoneCells,
  zoneRect,
  distanceToFootprint,
  type BinZone,
} from './layout';

/*
 * Las zonas con huecos, en una constante TIPADA y no en literales sueltos con `as BinZone[]`.
 *
 * Ese casting era una mentira al compilador: al quitar el descarte quedó un `['tray', 'discard']`
 * que `tsc` aceptó tan campante, y habría intentado resaltar en cada arrastre una cubeta que ya no
 * existe. Sin el casting, un nombre de zona inválido no compila.
 */
const ZONAS_CON_HUECOS: BinZone[] = ['tray'];

interface InstrumentSlot {
  group: THREE.Group;
  poolPosition: THREE.Vector3;
  baseRotationY: number;
  /**
   * Medio largo de la pieza tumbada, para medir la distancia a su HUELLA y no a su centro.
   *
   * Se guarda al colocarla en vez de recalcular la caja envolvente en cada frame: `pickNearest` se
   * llama por puntero y por frame, y medir dieciséis grupos con `Box3.setFromObject` cada vez es
   * recorrer toda la jerarquía de mallas sesenta veces por segundo para un dato que no cambia.
   */
  halfLength: number;
  /** Dónde está ahora. Sustituye al antiguo `onTray`, que no sabía del descarte. */
  zone: DropZone;
  /** Índice de hueco dentro de la zona, o null si está en el pool. */
  cell: number | null;
  held: boolean;
}

const HOVER_COLOR = 0x1f8f88;
const HELD_COLOR = 0xf4b942;

/**
 * Gestiona la escena three.js: quirófano, mesa del instrumentista, lámpara,
 * bandeja e instrumentos. Implementa ISceneApi.
 *
 * Agarre por PROXIMIDAD: `pickNearestInstrument` proyecta el puntero sobre la
 * mesa y devuelve el instrumento más cercano dentro de `INTERACTION.grabRadius`. No hace
 * falta apuntar con precisión al modelo.
 */
export class SceneManager implements ISceneApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private factory = new InstrumentFactory();
  private raycaster = new THREE.Raycaster();
  private slots = new Map<string, InstrumentSlot>();
  private cursors = new Map<string, THREE.Mesh>();
  private gloves = new Map<string, HandGlove>();
  private pulses = new Map<string, number>(); // id -> timestamp fin del parpadeo
  private lastCursorPos = new Map<string, THREE.Vector3>(); // ancla del cursor por puntero
  private dwellRings = new Map<string, THREE.Mesh>(); // anillo de progreso de dwell

  /** Recuadro sobre el hueco de destino mientras se arrastra una pieza. */
  private cellMarker: THREE.Mesh | null = null;
  /** Etiqueta con el nombre de la pieza señalada, y el texto que lleva pintado ahora. */
  private label: THREE.Sprite | null = null;
  private labelText = '';
  /** Nombres legibles por id, para la etiqueta: la escena no tiene acceso al catálogo. */
  private instrumentNames = new Map<string, string>();

  private zoneHighlights = new Map<BinZone, THREE.Mesh>();
  /**
   * Ocupación por hueco: `cells.tray[3] = 'kelly-forceps'`.
   *
   * Sustituye al contador incremental de antes, que nunca decrementaba: al retirar un instrumento
   * de la bandeja su hueco se perdía para siempre, así que tras unos cuantos cambios de opinión los
   * instrumentos empezaban a caer fuera.
   */
  private cells: Record<BinZone, (string | null)[]> = { tray: [] };
  private hoveredId: string | null = null;
  /** Decorado hecho a mano; se retira cuando entra el quirófano del GLB. */
  private decoradoPropio: THREE.Group | null = null;
  /** Datos del quirófano cargado, para poder informar de su coste. */
  private salaCargada: RoomLoadResult | null = null;
  /** Carga en curso del quirófano; `null` resuelto si no hay modelo. */
  private cargaSala: Promise<RoomLoadResult | null> = Promise.resolve(null);
  /** Cierto si el área jugable no cupo en la ventana ni abriendo el ángulo hasta el tope. */
  private encuadreRecortado = false;
  /** Estado del plano de apertura. */
  private introActivo = false;
  /**
   * Tiempo de animación consumido, que NO es el tiempo de reloj.
   *
   * Se acumula fotograma a fotograma y con el salto de cada uno recortado, porque al entrar en un
   * nivel el hilo se queda bloqueado y con el reloj de pared la animación se gastaba entera sin haber
   * dibujado nada. Ver `MAX_SALTO_MS`.
   */
  private introTranscurrido = 0;
  /** Tiempo real desde el primer fotograma dibujado; limita cuánto puede estirarse el recorte. */
  private introReal = 0;
  /** `0` significa «aún no se ha dibujado ningún fotograma del plano». */
  private introUltimoMs = 0;
  private introMs = 0;
  private introDesde: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private introHasta: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.66;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0c161b');
    this.scene.fog = new THREE.Fog('#0c161b', 6, 16);

    // Environment map PBR: hace que los metales (instrumentos, bandeja, lámpara)
    // reflejen un entorno de habitación. Es la mayor mejora de realismo.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Vista del instrumentista: de pie frente a la mesa, mirando hacia abajo.
    this.camera = new THREE.PerspectiveCamera(CAMERA.baseFovDeg, 1, 0.1, 100);
    this.camera.position.set(...CAMERA.position);
    this.camera.lookAt(...CAMERA.target);

    this.buildRoom();
    this.buildLamp();
    this.buildTable();
    this.buildBin('tray');
    this.resize();

    // Las garantías del layout, comprobadas al arrancar en desarrollo. Si alguien mueve una
    // constante y tapa media mesa, se entera aquí y no jugando.
    if (import.meta.env.DEV) {
      for (const fallo of assertLayout()) console.error(`[layout] ${fallo}`);
    }

    window.addEventListener('resize', () => this.resize());
  }

  // --- Construcción del entorno -----------------------------------------

  /*
   * El decorado PROPIO va todo en un grupo.
   *
   * Así se puede retirar de una vez cuando llega el quirófano de verdad. Antes cada pieza se añadía
   * suelta a la escena y quitarlas habría sido ir una por una acordándose de todas —y olvidarse de
   * una sola significa ver dos suelos o dos techos superpuestos—.
   *
   * Las LUCES se quedan fuera del grupo a propósito: la ambiental y el relleno siguen haciendo falta
   * con el modelo cargado, porque el GLB no trae luces, solo geometría y materiales.
   */
  private buildRoom(): void {
    const propio = new THREE.Group();
    propio.name = 'decorado-propio';
    this.decoradoPropio = propio;
    this.scene.add(propio);

    // Suelo con aspecto de baldosa de quirófano (poco reflejo del env map).
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: '#132026', roughness: 0.9, metalness: 0.0, envMapIntensity: 0.25 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    propio.add(floor);

    // Paredes tipo azulejo verde quirúrgico (mate, poco env).
    const wallMat = new THREE.MeshStandardMaterial({ color: '#233a42', roughness: 0.95, metalness: 0.0, envMapIntensity: 0.25 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(24, 6), wallMat);
    back.position.set(0, 3, -6);
    back.receiveShadow = true;
    propio.add(back);

    const left = new THREE.Mesh(new THREE.PlaneGeometry(24, 6), wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-7, 3, 0);
    propio.add(left);

    const right = new THREE.Mesh(new THREE.PlaneGeometry(24, 6), wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.set(7, 3, 0);
    propio.add(right);

    /*
     * Luz ambiental de sala.
     *
     * Estaba en 0.18, calibrada cuando el fondo eran cuatro siluetas que solo tenían que insinuarse.
     * El quirófano del GLB **no trae ni una luz** —los modelos de escena vienen solo con geometría y
     * materiales—, así que con 0.18 la sala entera quedaba casi negra: se cargaban 735 000
     * triángulos para no ver nada.
     *
     * Sube lo justo para que la sala se lea. El foco de la mesa está en intensidad 48, dos órdenes
     * de magnitud por encima, así que la mesa sigue siendo con diferencia lo más luminoso del cuadro
     * y no se pierde la jerarquía.
     */
    this.scene.add(new THREE.HemisphereLight('#cfe6ec', '#16242b', 0.85));
    const fill = new THREE.DirectionalLight('#bcd8e0', 0.55);
    fill.position.set(-4, 5, 4);
    this.scene.add(fill);

    // Monitor de constantes de fondo (silueta con pantalla emisiva).
    const monitor = new THREE.Group();
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.55, 0.04),
      new THREE.MeshStandardMaterial({ color: '#0a1f1c', emissive: '#0e5f57', emissiveIntensity: 0.6 }),
    );
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6), new THREE.MeshStandardMaterial({ color: '#1c2b31' }));
    stand.position.y = -0.55;
    monitor.add(screen, stand);
    monitor.position.set(2.6, 1.7, -3);
    monitor.rotation.y = -0.5;
    propio.add(monitor);

    // --- Equipo de fondo desaturado (contexto sutil, sin ruido visual) ------
    propio.add(this.buildAnesthesiaTower(-2.9, -3.2));
    propio.add(this.buildIvPole(-1.9, -3.6));
    propio.add(this.buildIvPole(2.1, -3.9));

    // Techo, mesa de operaciones al fondo, negatoscopio y reloj. Ver `room.ts` para por qué nada de
    // esto lleva luz propia.
    propio.add(buildOperatingRoom());

    // Y en paralelo, el quirófano de verdad. No se espera por él: si tarda o no está, se juega con
    // lo de arriba. Se guarda la promesa para que el HUD sepa cuándo (y si) acreditar al autor.
    this.cargaSala = this.cargarQuirofano();
  }

  /**
   * Trae el quirófano real y sustituye al decorado propio.
   *
   * En segundo plano a propósito: el modelo pesa 29 MB y tarda unos segundos: bloquear el arranque
   * por un decorado sería cambiar realismo por una pantalla en blanco.
   */
  private async cargarQuirofano(): Promise<RoomLoadResult | null> {
    const sala = await loadOperatingRoom(import.meta.env.BASE_URL);
    if (!sala) return null;
    this.scene.add(sala.group);
    // El propio se retira DESPUÉS de añadir el nuevo: si se quitara antes, habría unos frames con la
    // mesa flotando sobre la nada.
    if (this.decoradoPropio) {
      this.scene.remove(this.decoradoPropio);
      disposeTree(this.decoradoPropio);
      this.decoradoPropio = null;
    }
    this.salaCargada = sala;
    return sala;
  }

  /**
   * Promesa de la carga del quirófano: `null` si no hay modelo y se juega con el decorado propio.
   *
   * La usa el HUD para acreditar al autor SOLO si de verdad se está viendo su sala.
   */
  whenRoomLoaded(): Promise<RoomLoadResult | null> {
    return this.cargaSala;
  }

  /** Qué quirófano se está viendo y cuánto cuesta. Para poder medirlo desde fuera. */
  getRoomInfo(): RoomLoadResult | null {
    return this.salaCargada;
  }

  /**
   * Plano de apertura: la cámara arranca amplia enseñando el quirófano y baja a la mesa.
   *
   * La sala solo se ve de verdad en estos segundos: durante la partida la cámara mira a la mesa y el
   * fondo queda en una franja del 19 % de la pantalla. Este plano es lo que permite enseñar el
   * quirófano SIN quitarle sitio al juego, que era la contradicción de fondo.
   *
   * Termina exactamente donde manda `fitCamera()` y no en una pose escrita a mano: si acabara en
   * valores fijos, el encuadre de juego dependería de si la animación ha corrido, se ha saltado o se
   * ha redimensionado la ventana a mitad.
   */
  /**
   * Cuánto tarda el plano de apertura.
   *
   * 4,2 s y no 2,6: a la duración anterior el recorrido pasaba tan deprisa que no daba tiempo a ver
   * el quirófano y parecía un fallo de dibujado más que un movimiento de cámara.
   */
  private static readonly INTRO_MS = 4200;

  /**
   * Margen antes de poder saltar el plano.
   *
   * Sin él la apertura no llegaba a verse NUNCA con las manos: el nivel se elige pellizcando, y ese
   * mismo pellizco sigue cerrado cuando arranca la animación, así que el propio gesto de entrar la
   * cortaba en el primer fotograma. Con medio segundo de gracia, el pellizco de selección ya se ha
   * soltado y solo la corta un gesto hecho a propósito.
   */
  private static readonly INTRO_GRACIA_MS = 500;

  playIntro(durationMs = SceneManager.INTRO_MS): void {
    const destino = {
      pos: new THREE.Vector3(...CAMERA.position),
      target: new THREE.Vector3(...CAMERA.target),
    };
    // Quien pide movimiento reducido va directo al final: un travelling envolvente es exactamente
    // lo que esa preferencia existe para evitar.
    const reducido = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducido) {
      this.endIntro();
      return;
    }

    this.introDesde = {
      pos: new THREE.Vector3(-3.4, 3.9, 5.2),
      target: new THREE.Vector3(-0.6, 1.0, -1.6),
    };
    this.introHasta = destino;
    this.introTranscurrido = 0;
    this.introReal = 0;
    this.introUltimoMs = 0; // lo fija el primer fotograma que llegue a dibujarse
    this.introMs = durationMs;
    this.introActivo = true;

    // La cámara se coloca ya en la pose de salida: entre esta llamada y el primer fotograma pasa la
    // carga del nivel, y sin esto ese fotograma saldría todavía desde la pose anterior.
    this.camera.position.copy(this.introDesde.pos);
    this.camera.lookAt(this.introDesde.target);
  }

  /** ¿Está corriendo la apertura? El bucle principal congela la interacción mientras dure. */
  isIntroPlaying(): boolean {
    return this.introActivo;
  }

  /**
   * ¿Se puede saltar ya la apertura?
   *
   * Existe para que el gesto con el que se entra al nivel no cancele de paso la animación. Ver
   * `INTRO_GRACIA_MS`.
   */
  puedeSaltarIntro(): boolean {
    return this.introActivo && this.introTranscurrido >= SceneManager.INTRO_GRACIA_MS;
  }

  /** Corta la apertura y deja la cámara en la pose de juego. */
  endIntro(): void {
    this.introActivo = false;
    this.camera.position.set(...CAMERA.position);
    this.camera.lookAt(...CAMERA.target);
    this.fitCamera();
  }

  /** Avance de la animación. Lo llama `render()` en cada frame. */
  private stepIntro(): void {
    if (!this.introActivo || !this.introDesde || !this.introHasta) return;

    /*
     * El plano avanza con los fotogramas dibujados, no con el reloj de pared.
     *
     * Entrar en un nivel bloquea el hilo un buen rato montando la bandeja: medido, **el primer
     * fotograma tras elegir operación tardó 7012 ms**, con el ritmo en 15,5 ms justo antes. Con
     * `performance.now()` la animación se consumía entera durante ese parón y el primer fotograma que
     * llegaba ya estaba pasado de tiempo, así que se cortaba de golpe y la mesa aparecía sin más. Eso
     * era lo que se veía como un fallo, no la velocidad de la curva.
     *
     * Recortando el salto de cada fotograma, un parón —el de la carga o cualquier tirón posterior—
     * cuesta tiempo real pero no se lleva por delante la animación: esta sigue donde la dejó.
     *
     * El tiempo real se cuenta desde el PRIMER fotograma dibujado, no desde `playIntro()`: si contara
     * el parón de la carga, esos 7 s agotarían de golpe el margen de estiramiento y el recorte
     * quedaría anulado justo en el caso para el que existe.
     *
     * Las cuentas están en `intro.ts` y probadas allí con un reloj de mentira.
     */
    const ahora = performance.now();

    if (this.introUltimoMs === 0) {
      this.introUltimoMs = ahora;
      return; // fotograma de anclaje: fija el origen; la pose de salida ya la puso `playIntro()`
    }

    const avanzado = avanzarIntro(
      { transcurrido: this.introTranscurrido, real: this.introReal },
      ahora - this.introUltimoMs,
      this.introMs,
    );
    this.introTranscurrido = avanzado.transcurrido;
    this.introReal = avanzado.real;
    this.introUltimoMs = ahora;
    const t = Math.min(1, this.introTranscurrido / this.introMs);

    const k = curvaIntro(t);
    this.camera.position.lerpVectors(this.introDesde.pos, this.introHasta.pos, k);
    const mira = new THREE.Vector3().lerpVectors(this.introDesde.target, this.introHasta.target, k);
    this.camera.lookAt(mira);
    if (t >= 1) this.endIntro();
  }

  /** Torre de anestesia: silueta de baja detalle, colores apagados. */
  private buildAnesthesiaTower(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#3a4a52', roughness: 0.8, metalness: 0.2 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.6), bodyMat);
    body.position.y = 0.75;
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.35, 0.03),
      new THREE.MeshStandardMaterial({ color: '#0a1f1c', emissive: '#0c4a44', emissiveIntensity: 0.4 }),
    );
    screen.position.set(0, 1.3, 0.31);
    // botellas de gas
    for (const bx of [-0.2, 0.2]) {
      const bottle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.5, 12),
        new THREE.MeshStandardMaterial({ color: bx < 0 ? '#5a6b52' : '#6b5a52', roughness: 0.6, metalness: 0.3 }),
      );
      bottle.position.set(bx, 0.35, -0.35);
      g.add(bottle);
    }
    g.add(body, screen);
    g.position.set(x, 0, z);
    g.rotation.y = 0.3;
    return g;
  }

  /** Palo de suero con bolsa. */
  private buildIvPole(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: '#9aa4a9', roughness: 0.35, metalness: 0.85 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.9, 10), metal);
    pole.position.y = 0.95;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.008, 8, 16, Math.PI), metal);
    hook.position.set(0.06, 1.85, 0);
    hook.rotation.z = Math.PI / 2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16), metal);
    const bag = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.24, 0.05),
      new THREE.MeshStandardMaterial({ color: '#cfe0d8', roughness: 0.5, transparent: true, opacity: 0.85 }),
    );
    bag.position.set(0.12, 1.6, 0);
    g.add(pole, hook, base, bag);
    g.position.set(x, 0, z);
    return g;
  }

  /**
   * Cúpula de lámpara quirúrgica: la carcasa y sus bombillas emisivas, sin luz real.
   *
   * Separada de `buildLamp` para poder poner una segunda sobre la mesa de operaciones del fondo sin
   * duplicar la geometría. `escala` la encoge para la del fondo, y `brillo` baja su emisión: en
   * penumbra no puede brillar como la que ilumina el juego o robaría la atención.
   */
  private buildLampDome(escala = 1, brillo = 2.4): THREE.Group {
    const lamp = new THREE.Group();
    const dome = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.62, 0.14, 32),
      new THREE.MeshStandardMaterial({ color: '#dfe7ea', metalness: 0.6, roughness: 0.3 }),
    );
    lamp.add(dome);
    // "bombillas" emisivas en la cara inferior.
    const bulbMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff7e0', emissiveIntensity: brillo });
    for (let r = 0; r < 3; r++) {
      const radius = 0.14 + r * 0.16;
      const count = 6 + r * 4;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), bulbMat);
        bulb.rotation.x = Math.PI / 2;
        bulb.position.set(Math.cos(a) * radius, -0.072, Math.sin(a) * radius);
        lamp.add(bulb);
      }
    }
    lamp.scale.setScalar(escala);
    return lamp;
  }

  /** Lámpara quirúrgica cenital con foco potente. */
  private buildLamp(): void {
    const lamp = this.buildLampDome();
    /*
     * La lámpara y el foco apuntan al centro del ÁREA JUGABLE, no al centro de la mesa.
     *
     * Con la mesa más ancha y el pool desplazado a la izquierda, los dos centros ya no coinciden:
     * apuntando al de la mesa, la fila del fondo quedaba fuera del cono y se veía apagada.
     */
    const area = contentBounds();
    const cx = (area.minX + area.maxX) / 2;
    const cz = (area.minZ + area.maxZ) / 2;
    const semidiagonal = Math.hypot(area.maxX - area.minX, area.maxZ - area.minZ) / 2;

    lamp.position.set(cx, LAMP.y, cz);
    this.scene.add(lamp);

    // Brazo desde el techo.
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2), new THREE.MeshStandardMaterial({ color: '#aab4b9', metalness: 0.7 }));
    arm.position.set(cx, LAMP.armY, cz);
    this.scene.add(arm);

    /*
     * El ángulo del cono se DERIVA del área a cubrir en vez de estar escrito a mano: si mañana la
     * mesa crece, la luz crece con ella. La intensidad se compensa por la superficie iluminada, o
     * al abrir el cono la escena se oscurecería.
     */
    const alturaFoco = 2.55 - SURFACE_Y;
    const angulo = Math.atan((semidiagonal * LAMP.coneSlack) / alturaFoco);
    const anguloBase = Math.PI / 5.5;
    const intensidad = 48 * Math.min(2.2, (Math.tan(angulo) / Math.tan(anguloBase)) ** 2);

    const spot = new THREE.SpotLight('#fff8ec', intensidad, 9, angulo, 0.5, 1.6);
    spot.position.set(cx, 2.55, cz);
    spot.target.position.set(cx, SURFACE_Y, cz);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.bias = -0.0004;
    this.scene.add(spot, spot.target);

    // Segundo foco de relleno para suavizar sombras.
    const spot2 = new THREE.SpotLight('#eaf4f7', 16, 10, Math.PI / 4, 0.6, 1.2);
    spot2.position.set(cx - 1.45, 2.4, cz + 1.4);
    spot2.target.position.set(cx, SURFACE_Y, cz);
    this.scene.add(spot2, spot2.target);

    /*
     * Segunda lámpara, sobre la mesa de operaciones del fondo. Es DECORADO: cúpula y brazo, sin luz.
     *
     * Un quirófano tiene dos, y verlas en pareja es de lo que más lo identifica. Pero la de atrás no
     * ilumina nada —brilla a la mitad y no proyecta sombras—: añadir otro foco con sombras costaría
     * un mapa por frame para alumbrar algo que nadie mira.
     */
    const lampFondo = this.buildLampDome(0.75, 0.9);
    lampFondo.position.set(-2.5, 2.3, -3.2);
    const brazoFondo = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 1.4),
      new THREE.MeshStandardMaterial({ color: '#8e989d', metalness: 0.6, roughness: 0.5 }),
    );
    brazoFondo.position.set(-2.5, 3.05, -3.2);
    this.scene.add(lampFondo, brazoFondo);
  }

  private buildTable(): void {
    const mesa = tableBounds();
    const drapeMat = new THREE.MeshStandardMaterial({ color: '#0f302d', roughness: 0.95, metalness: 0.0, envMapIntensity: 0.2 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width, TABLE.thickness, TABLE.depth), drapeMat);
    // El centro del tablero se deriva de la superficie: antes eran dos constantes sueltas que no
    // cuadraban y todo lo apoyado «encima» flotaba cinco milímetros.
    top.position.set(TABLE.centerX, mesa.boxCenterY, TABLE.centerZ);
    top.receiveShadow = true;
    top.castShadow = true;
    this.scene.add(top);

    // Paño quirúrgico colgando por el borde frontal (faldón).
    const skirtMat = new THREE.MeshStandardMaterial({ color: '#183f3b', roughness: 0.9, envMapIntensity: 0.3 });
    const front = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width, TABLE.skirtDrop, 0.02), skirtMat);
    front.position.set(TABLE.centerX, mesa.boxCenterY - TABLE.skirtDrop / 2, mesa.maxZ);
    front.receiveShadow = true;
    this.scene.add(front);

    const legMat = new THREE.MeshStandardMaterial({ color: '#7f8a90', metalness: 0.8, roughness: 0.3 });
    const alturaPata = mesa.boxCenterY - TABLE.thickness / 2;
    const legGeo = new THREE.CylinderGeometry(TABLE.legRadius, TABLE.legRadius, alturaPata);
    // Las patas se derivan de las esquinas de la mesa: antes estaban clavadas a un tablero concreto
    // y al ensancharlo se habrían quedado flotando en mitad del tablero.
    for (const x of [mesa.minX + TABLE.legInset, mesa.maxX - TABLE.legInset]) {
      for (const z of [mesa.minZ + TABLE.legInset, mesa.maxZ - TABLE.legInset]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(x, alturaPata / 2, z);
        this.scene.add(leg);
      }
    }
  }

  /**
   * Construye una zona-recipiente: la bandeja o la cubeta de descartes.
   *
   * Una sola función para las dos porque son la misma forma con otras medidas y otro tono. Tenerlas
   * separadas era garantía de que una recibiera un arreglo y la otra no.
   *
   * El borde es DELIBERADAMENTE BAJO: está por delante del pool y todo lo que sobresalga tapa lo
   * que hay detrás. Es exactamente el fallo que tenía la bandeja anterior, que ocultaba una fila
   * entera de instrumentos por dos milímetros de borde.
   */
  private buildBin(zone: BinZone): void {
    const cfg = TRAY;
    const rect = zoneRect(zone);
    const group = new THREE.Group();

    /*
     * PAÑO ESTÉRIL, no metal pulido.
     *
     * El suelo era acero (`metalness: 0.9, roughness: 0.4`) y los instrumentos son acero igual de
     * pulido. Con el foco quirúrgico apuntando justo ahí, las dos superficies se saturaban a blanco
     * y no había forma de distinguir las piezas: acero brillante sobre acero brillante.
     *
     * La solución no era bajar la luz —eso apagaría el quirófano entero— sino cambiar el material.
     * Y resulta que lo realista y lo legible coinciden: una mesa de instrumentista va cubierta con un
     * paño verde, que además es mate y oscuro, así que el acero destaca solo.
     */
    /*
     * Verde MUY oscuro, no verde quirúrgico de catálogo.
     *
     * Medido: con `#2f5d52` la mediana de luminancia de la bandeja salía en 217 sobre 255 —casi
     * blanco—. El foco apunta justo ahí con intensidad alta, y cualquier tono medio se lava hasta
     * quedar en menta pálido. Para que el acero destaque, el paño tiene que estar muy por debajo de
     * lo que parece razonable mirando el color suelto.
     */
    const floorMat = new THREE.MeshStandardMaterial({
      color: '#0d2b25',
      metalness: 0,
      roughness: 1,
      envMapIntensity: 0.08,
    });
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(cfg.width, cfg.floorThickness, cfg.depth),
      floorMat,
    );
    floor.position.y = cfg.floorThickness / 2;
    floor.receiveShadow = true;
    group.add(floor);

    /*
     * Pliegues del paño cayendo por el borde: dos rollos finos a lo largo.
     *
     * Sin ellos la bandeja se lee como «una bandeja con una alfombrilla dentro»; con ellos, como un
     * campo estéril montado. Son cilindros, lo más barato que transmite tela plegada.
     */
    const pliegueMat = new THREE.MeshStandardMaterial({
      color: '#123a31',
      metalness: 0,
      roughness: 1,
      envMapIntensity: 0.08,
    });
    for (const lado of [-1, 1]) {
      const pliegue = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.016, cfg.width - cfg.wall, 8),
        pliegueMat,
      );
      pliegue.rotation.z = Math.PI / 2;
      pliegue.position.set(0, cfg.floorThickness + 0.008, lado * (cfg.depth / 2 - cfg.wall - 0.014));
      pliegue.castShadow = true;
      group.add(pliegue);
    }

    const rimMat = new THREE.MeshStandardMaterial({
      color: '#aeb9be',
      metalness: 0.95,
      roughness: 0.18,
    });
    const rimY = cfg.floorThickness + cfg.rimHeight / 2;
    const largo = new THREE.BoxGeometry(cfg.width, cfg.rimHeight, cfg.wall);
    const corto = new THREE.BoxGeometry(cfg.wall, cfg.rimHeight, cfg.depth);
    const bordes = [
      new THREE.Mesh(largo, rimMat),
      new THREE.Mesh(largo, rimMat),
      new THREE.Mesh(corto, rimMat),
      new THREE.Mesh(corto, rimMat),
    ];
    bordes[0].position.set(0, rimY, cfg.depth / 2 - cfg.wall / 2);
    bordes[1].position.set(0, rimY, -cfg.depth / 2 + cfg.wall / 2);
    bordes[2].position.set(-cfg.width / 2 + cfg.wall / 2, rimY, 0);
    bordes[3].position.set(cfg.width / 2 - cfg.wall / 2, rimY, 0);
    group.add(...bordes);

    // Resaltado del suelo: se enciende al pasar por encima con algo en la mano.
    // Blanco cálido: sobre el paño verde, el turquesa de antes apenas se distinguía del propio paño.
    const highlight = new THREE.Mesh(
      new THREE.BoxGeometry(cfg.width - cfg.wall * 2, 0.005, cfg.depth - cfg.wall * 2),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0 }),
    );
    highlight.position.y = cfg.floorThickness + 0.003;
    group.add(highlight);
    this.zoneHighlights.set(zone, highlight);

    group.position.set(
      (rect.minX + rect.maxX) / 2,
      SURFACE_Y,
      (rect.minZ + rect.maxZ) / 2,
    );
    this.scene.add(group);
  }

  // --- ISceneApi ---------------------------------------------------------

  layoutInstruments(instruments: Instrument[]): void {
    this.clearInstruments();
    this.hoveredId = null;
    this.cells = { tray: new Array(zoneCapacity('tray')).fill(null) };

    this.instrumentNames = new Map(instruments.map((i) => [i.id, i.name]));
    const celdas = poolLayout(instruments.length);
    instruments.forEach((instrument, i) => {
      const celda = celdas[i];
      if (!celda) return;
      const group = this.factory.create(instrument);
      const pos = new THREE.Vector3(celda.x, celda.y, celda.z);
      group.position.copy(pos);
      group.rotation.y = celda.rotY;
      this.scene.add(group);
      this.slots.set(instrument.id, {
        group,
        poolPosition: pos.clone(),
        baseRotationY: celda.rotY,
        halfLength: 0, // se mide en cuanto el modelo esté montado (el GLB llega tarde)
        zone: 'pool',
        cell: null,
        held: false,
      });
      /*
       * El semilargo se mide en el frame siguiente, no ahora.
       *
       * `factory.create` devuelve el grupo con el modelo procedural puesto y sustituye el GLB cuando
       * termina de descargarlo. Medir aquí daría el tamaño del procedural para las piezas que luego
       * cargan un GLB de otro largo, y la huella de agarre no coincidiría con lo que se ve.
       */
      this.medirHuellaCuandoEsteLista(instrument.id, group);
    });
  }

  /**
   * Mide el semilargo de la pieza, reintentando hasta que el modelo definitivo esté montado.
   *
   * Se conforma con lo que haya y vuelve a medir un par de veces: los GLB se sustituyen de forma
   * asíncrona, y el reintento evita tener que meter un callback en `InstrumentFactory` solo para
   * esto. Si el modelo no cambia, la segunda medida da lo mismo y no pasa nada.
   */
  private medirHuellaCuandoEsteLista(id: string, group: THREE.Group, intentos = 3): void {
    const medir = (): void => {
      const slot = this.slots.get(id);
      if (!slot || slot.group !== group) return; // la mesa se ha rehecho: esta medida ya no vale
      const caja = new THREE.Box3().setFromObject(group);
      const size = caja.getSize(new THREE.Vector3());
      // Sin el giro: la caja se mide en mundo, y `distanceToFootprint` ya aplica `baseRotationY`.
      slot.halfLength = Math.max(size.x, size.z) / 2;
    };
    medir();
    for (let i = 1; i <= intentos; i++) window.setTimeout(medir, i * 700);
  }

  pickNearestInstrument(x: number, y: number): string | null {
    // Con histéresis a favor de lo ya señalado: es la elección que el jugador está viendo.
    return this.pickWithin(x, y, INTERACTION.grabRadius, this.hoveredId);
  }

  /**
   * Instrumento señalado para MIRAR, con mucha menos tolerancia que para coger.
   *
   * Con el radio de agarre bastaba acercar la mano a la zona para que saltara la ficha de un
   * instrumento que ni siquiera se estaba señalando: veinte centímetros son medio pool.
   */
  pickForInspect(x: number, y: number): string | null {
    return this.pickWithin(x, y, INTERACTION.inspectRadius);
  }

  /**
   * Elige la pieza señalada: la más cercana a la HUELLA, con histéresis a favor de la actual.
   *
   * Dos cambios sobre lo que había, cada uno contra un síntoma distinto de «coge la que no quiero»:
   *
   *  - Se mide contra el segmento que ocupa la pieza y no contra su centro. Apuntando a la punta de
   *    una tijera de 31 cm estabas a 15 cm de su propio centro, más lejos que el centro de la
   *    vecina, así que el juego elegía la de al lado.
   *  - La diana vigente conserva la ventaja: otra pieza tiene que estar bastante más cerca para
   *    robársela. Sin eso, el temblor de la mano hacía que «la más cercana» cambiara entre dos
   *    vecinas de un frame a otro y el resaltado parpadeaba.
   *
   * `preferido` es la diana actual. Se pasa como parámetro en lugar de leer `this.hoveredId` para
   * que el dwell pueda pedir una elección sin histéresis y ambos usos no se pisen.
   */
  private pickWithin(x: number, y: number, radius: number, preferido: string | null = null): string | null {
    const point = this.projectToTablePlane(x, y);
    if (!point) return null;
    let best: string | null = null;
    let bestDist = radius;
    for (const [id, slot] of this.slots) {
      let dist = distanceToFootprint(
        point.x,
        point.z,
        slot.group.position.x,
        slot.group.position.z,
        slot.halfLength,
        slot.baseRotationY,
      );
      // La que ya está elegida cuenta como más cerca de lo que está: es la histéresis.
      if (id === preferido) dist *= INTERACTION.targetStickiness;
      if (dist < bestDist) {
        bestDist = dist;
        best = id;
      }
    }
    return best;
  }

  setHovered(instrumentId: string | null): void {
    if (instrumentId === this.hoveredId) return;
    const prev = this.hoveredId ? this.slots.get(this.hoveredId) : undefined;
    this.hoveredId = instrumentId;
    if (prev) this.applyHighlight(prev);
    const next = instrumentId ? this.slots.get(instrumentId) : undefined;
    if (next) this.applyHighlight(next);
    this.mostrarEtiqueta(instrumentId);
  }

  /**
   * Etiqueta flotante con el nombre de la pieza señalada.
   *
   * Quita la duda de cuál se va a coger cuando hay varias juntas, que era la queja; y de paso enseña
   * el nombre del instrumental mientras se juega, que para esto es lo que se quiere aprender.
   *
   * Es un `Sprite` y no un elemento de DOM porque así vive en la escena: sigue a la pieza sin
   * convertir coordenadas cada frame y no depende del tamaño de la ventana.
   */
  private mostrarEtiqueta(instrumentId: string | null): void {
    const slot = instrumentId ? this.slots.get(instrumentId) : undefined;
    if (!slot || !instrumentId) {
      if (this.label) this.label.visible = false;
      return;
    }
    const nombre = this.instrumentNames.get(instrumentId) ?? instrumentId;
    if (!this.label) {
      this.label = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false }),
      );
      this.label.renderOrder = 1001;
      this.scene.add(this.label);
    }
    if (this.labelText !== nombre) {
      this.labelText = nombre;
      const tex = textoATextura(nombre);
      const mat = this.label.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.map = tex.textura;
      mat.needsUpdate = true;
      // Alto fijo en metros; el ancho sale de la proporción del texto para que no se deforme.
      this.label.scale.set(0.055 * tex.proporcion, 0.055, 1);
    }
    this.label.visible = true;
    this.label.position.set(
      slot.group.position.x,
      slot.group.position.y + (slot.held ? 0.2 : 0.11),
      slot.group.position.z,
    );
  }

  moveHeld(instrumentId: string, x: number, y: number): void {
    const slot = this.slots.get(instrumentId);
    if (!slot) return;
    if (!slot.held) {
      slot.held = true;
      this.applyHighlight(slot);
    }
    const point = this.projectToTablePlane(x, y);
    if (point) {
      slot.group.position.set(point.x, SURFACE_Y + INTERACTION.heldLift, point.z);
      slot.group.rotation.y = slot.baseRotationY;
    }
    // Feedback de la zona sobre la que se está: encendida si acepta, roja si está llena.
    const zona = this.zoneAt(x, y);
    for (const z of ZONAS_CON_HUECOS) {
      this.setZoneHighlight(z, zona === z, zona === z && this.freeCell(z) < 0);
    }
    // Y el hueco concreto al que va a ir, para verlo ANTES de abrir los dedos.
    this.marcarHueco(zona === 'pool' ? null : this.freeCell(zona, slot.group.position), zona);
  }

  /**
   * Recuadro sobre el hueco al que caería la pieza que se lleva en la mano.
   *
   * Sin esto, dónde acaba una pieza solo se sabe soltándola: se apuntaba a un sitio de la bandeja y
   * aparecía en otro. Enseñarlo mientras se arrastra convierte el acierto en algo que se ve venir.
   */
  private marcarHueco(idx: number | null, zone: DropZone): void {
    if (idx === null || idx < 0 || zone === 'pool') {
      if (this.cellMarker) this.cellMarker.visible = false;
      return;
    }
    if (!this.cellMarker) {
      const geo = new THREE.RingGeometry(0.035, 0.05, 24);
      geo.rotateX(-Math.PI / 2);
      // Ámbar y no turquesa: el paño de la bandeja es verde, y el turquesa se le confundía encima.
      this.cellMarker = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.85 }),
      );
      this.cellMarker.renderOrder = 999;
      this.scene.add(this.cellMarker);
    }
    const celda = zoneCells(zone)[idx];
    this.cellMarker.visible = true;
    this.cellMarker.position.set(celda.x, celda.y + 0.004, celda.z);
  }

  /**
   * Zona de la superficie bajo el puntero. `pool` es «el resto de la mesa».
   *
   * Antes esto era un booleano `isOverTray` calculado sobre la caja 3D de la bandeja expandida seis
   * centímetros, que invadía las filas traseras del pool: soltar sobre un instrumento del pool
   * contaba como soltar en la bandeja. Ahora son rectángulos declarados, sin sorpresas.
   */
  zoneAt(x: number, y: number): DropZone {
    const point = this.projectToTablePlane(x, y);
    if (!point) return 'pool';
    const t = INTERACTION.zoneTolerance;
    for (const zone of ZONAS_CON_HUECOS) {
      const r = zoneRect(zone);
      if (
        point.x >= r.minX - t &&
        point.x <= r.maxX + t &&
        point.z >= r.minZ - t &&
        point.z <= r.maxZ + t
      ) {
        return zone;
      }
    }
    return 'pool';
  }

  /**
   * Coloca el instrumento en una zona y devuelve dónde ha acabado DE VERDAD.
   *
   * Devuelve la zona real y no void porque puede no ser la pedida: si el recipiente está lleno, la
   * pieza vuelve al pool. El motor tiene que enterarse de eso o su idea de lo que hay en la bandeja
   * dejaría de coincidir con lo que se ve.
   */
  placeIn(instrumentId: string, zone: DropZone): DropZone {
    const slot = this.slots.get(instrumentId);
    if (!slot) return 'pool';

    this.releaseCell(instrumentId, slot);
    slot.held = false;
    for (const z of ZONAS_CON_HUECOS) this.setZoneHighlight(z, false, false);

    let destino: DropZone = zone;
    if (zone !== 'pool') {
      // El hueco libre MÁS CERCANO a donde se ha soltado, no el primero de la lista.
      const idx = this.freeCell(zone, slot.group.position);
      if (idx < 0) {
        destino = 'pool'; // recipiente lleno: se devuelve, y quien llama se entera por el retorno
      } else {
        this.cells[zone][idx] = instrumentId;
        slot.cell = idx;
        const celda = zoneCells(zone)[idx];
        slot.group.position.set(celda.x, celda.y, celda.z);
        slot.group.rotation.set(0, celda.rotY, 0);
      }
    }

    if (destino === 'pool') {
      slot.cell = null;
      slot.group.position.copy(slot.poolPosition);
      slot.group.rotation.set(0, slot.baseRotationY, 0);
    }

    slot.zone = destino;
    this.applyHighlight(slot);
    return destino;
  }

  /**
   * Índice de hueco libre, el más cercano a `cerca` si se da; -1 si no queda ninguno.
   *
   * Antes esto era `indexOf(null)`: SIEMPRE el primer hueco vacío de la lista. Daba igual dónde
   * soltaras dentro de la bandeja, la pieza saltaba al hueco más temprano, normalmente al otro
   * extremo. De ahí la sensación de que «no cae donde la dejo».
   *
   * Sin `cerca` se comporta como antes, que es lo que quiere quien solo pregunta si queda sitio.
   */
  private freeCell(zone: BinZone, cerca?: THREE.Vector3): number {
    const ocupantes = this.cells[zone];
    if (!cerca) return ocupantes.indexOf(null);

    const celdas = zoneCells(zone);
    let mejor = -1;
    let mejorDist = Infinity;
    for (let i = 0; i < ocupantes.length; i++) {
      if (ocupantes[i] !== null) continue;
      const c = celdas[i];
      const d = Math.hypot(c.x - cerca.x, c.z - cerca.z);
      if (d < mejorDist) {
        mejorDist = d;
        mejor = i;
      }
    }
    return mejor;
  }

  /** Libera el hueco que ocupara antes. Es lo que impide que se vayan perdiendo sitios. */
  private releaseCell(instrumentId: string, slot: InstrumentSlot): void {
    if (slot.zone === 'pool' || slot.cell === null) return;
    const ocupantes = this.cells[slot.zone as BinZone];
    if (ocupantes[slot.cell] === instrumentId) ocupantes[slot.cell] = null;
    slot.cell = null;
  }

  updateCursor(pointer: Pointer): void {
    // Mano con landmarks -> guante 3D; ratón -> anillo.
    if (pointer.source === 'hand' && pointer.landmarks && pointer.landmarks.length >= 21) {
      this.updateGlove(pointer);
      return;
    }

    let cursor = this.cursors.get(pointer.id);
    if (!cursor) {
      const color = pointer.source === 'hand' ? '#f4b942' : '#33d1c9';
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.028, 0.04, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 999;
      this.cursors.set(pointer.id, ring);
      this.scene.add(ring);
      cursor = ring;
    }
    const point = this.projectToTablePlane(pointer.x, pointer.y);
    if (point) {
      cursor.position.set(point.x, SURFACE_Y + 0.02, point.z);
      this.lastCursorPos.set(pointer.id, cursor.position.clone());
    }
    const mat = cursor.material as THREE.MeshBasicMaterial;
    mat.opacity = pointer.isPinching ? 1 : 0.6;
    cursor.scale.setScalar(pointer.isPinching ? 0.7 : 1);
  }

  /** Proyecta los 21 landmarks sobre la mesa (con elevación relativa) y actualiza el guante. */
  /**
   * Dibuja el guante a TAMAÑO DE MANO, no al tamaño que salga de proyectar.
   *
   * Proyectar los 21 landmarks por separado daba un guante de 1,006 m —cinco manos reales— porque el
   * tamaño lo dictaba el encuadre: la mesa ocupa 3,2 m de ancho de pantalla, así que una mano que
   * cubre el 22 % del cuadro se convertía en dos tercios de metro, y el estirado de la zona activa
   * la inflaba otro 47 %.
   *
   * Se sigue proyectando igual —así la orientación y la perspectiva salen solas y coinciden con la
   * cámara—, pero después la constelación se ENCOGE alrededor de la yema del índice, que es el punto
   * que de verdad importa porque es el puntero. Reconstruir la mano en un sistema propio habría
   * exigido inventar una base 3D y mantenerla en sintonía con la cámara, para el mismo resultado.
   */
  private updateGlove(pointer: Pointer): void {
    const lms = pointer.landmarks!;
    const wristZ = lms[0].z;
    const points: THREE.Vector3[] = new Array(21);
    for (let i = 0; i < 21; i++) {
      const p = this.projectToTablePlane(lms[i].x, lms[i].y);
      if (!p) return; // mano fuera del plano visible: no actualizar este frame
      // Elevación: dedos/puntos más cerca de la cámara suben un poco.
      p.y = SURFACE_Y + 0.04 + Math.max(0, (wristZ - lms[i].z)) * 0.28;
      points[i] = p;
    }

    /*
     * ESCALA POR LA PALMA Y ANCLAJE EN EL PUNTO DE PINZA. Las dos cosas, y por el mismo motivo.
     *
     * Antes la referencia de escala era muñeca → yema del índice, y el ancla, la propia yema. Las
     * dos se mueven al pellizcar, porque pellizcar ES curvar el índice:
     *
     *  - la distancia muñeca-yema se ENCOGE, así que `k = HAND_LENGTH / largo` crece y **el guante
     *    se infla** justo al cerrar la mano;
     *  - y como además está anclado en la yema, **se desplaza** con ella.
     *
     * Resultado: al ir a agarrar, la mano en pantalla daba un salto atrás y crecía. Había que
     * compensarlo a ojo y ciertos instrumentos resultaban imposibles de coger.
     *
     * Ahora la escala sale de muñeca → nudillo del corazón (0→9), que es una medida RÍGIDA de la
     * palma: no cambia por mucho que se doblen los dedos. Y el ancla es el punto de pinza, el mismo
     * que usa el cursor. Escalando alrededor de él, ese punto queda fijo por construcción —es el
     * punto medio de 4 y 8, y escalar el conjunto no mueve su propio centro—.
     */
    const ancla = points[4].clone().add(points[8]).multiplyScalar(0.5);
    const palma = Math.hypot(points[0].x - points[9].x, points[0].z - points[9].z);
    if (palma > 1e-4) {
      const k = (HAND_LENGTH * PALMA_SOBRE_MANO) / palma;
      for (let i = 0; i < 21; i++) {
        points[i].set(
          ancla.x + (points[i].x - ancla.x) * k,
          ancla.y + (points[i].y - ancla.y) * k,
          ancla.z + (points[i].z - ancla.z) * k,
        );
      }
    }

    /*
     * Y AHORA se lleva el guante entero a donde está el PUNTERO.
     *
     * Hace falta porque los landmarks llegan en coordenadas lineales —sin la curva de aceleración—
     * para que la mano conserve su forma, mientras que el puntero sí lleva la curva. Sin esta
     * traslación, la mano se dibujaría en un sitio y se cogería en otro: apuntarías con el guante a
     * una pieza y el juego agarraría la de al lado.
     *
     * Se traslada, no se reescala: mover no deforma, que es justo lo que se quiere preservar.
     */
    const destino = this.projectToTablePlane(pointer.x, pointer.y);
    if (destino) {
      const dx = destino.x - ancla.x;
      const dz = destino.z - ancla.z;
      for (const p of points) {
        p.x += dx;
        p.z += dz;
      }
      ancla.x += dx;
      ancla.z += dz;
    }
    let glove = this.gloves.get(pointer.id);
    if (!glove) {
      glove = new HandGlove();
      this.gloves.set(pointer.id, glove);
      this.scene.add(glove.group);
    }
    glove.update(points, pointer.isPinching);
    // El anillo del dwell, en el mismo punto de pinza: el juego no puede enseñar una diana y usar otra.
    this.lastCursorPos.set(pointer.id, ancla.clone());
  }

  setDwell(pointerId: string, progress: number): void {
    let ring = this.dwellRings.get(pointerId);
    if (progress <= 0) {
      if (ring) { ring.visible = false; }
      return;
    }
    const anchor = this.lastCursorPos.get(pointerId);
    if (!anchor) return;
    if (!ring) {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.05, 0.07, 32, 1, -Math.PI / 2, Math.PI * 2),
        new THREE.MeshBasicMaterial({ color: 0x33d1c9, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 1000;
      this.dwellRings.set(pointerId, ring);
      this.scene.add(ring);
    }
    ring.visible = true;
    ring.position.set(anchor.x, SURFACE_Y + 0.03, anchor.z);
    // Arco que se llena según el progreso.
    ring.geometry.dispose();
    ring.geometry = new THREE.RingGeometry(0.05, 0.075, 48, 1, Math.PI / 2, -Math.PI * 2 * Math.min(1, progress));
  }

  pickInstrumentAtScreen(clientX: number, clientY: number): string | null {
    return this.pickNearestInstrument(clientX / window.innerWidth, clientY / window.innerHeight);
  }

  removeCursor(pointerId: string): void {
    const cursor = this.cursors.get(pointerId);
    if (cursor) {
      this.scene.remove(cursor);
      (cursor.geometry as THREE.BufferGeometry).dispose();
      this.cursors.delete(pointerId);
    }
    const glove = this.gloves.get(pointerId);
    if (glove) {
      this.scene.remove(glove.group);
      glove.dispose();
      this.gloves.delete(pointerId);
    }
    const ring = this.dwellRings.get(pointerId);
    if (ring) {
      this.scene.remove(ring);
      ring.geometry.dispose();
      this.dwellRings.delete(pointerId);
    }
    this.lastCursorPos.delete(pointerId);
  }

  /**
   * Retira todos los cursores 3D de golpe.
   *
   * Se usa cuando la mano pasa a manejar la interfaz: si no, el anillo se queda congelado sobre la
   * mesa en el último punto donde estuvo, señalando un instrumento que ya no se está apuntando.
   */
  clearCursors(): void {
    for (const id of [...this.cursors.keys(), ...this.gloves.keys()]) this.removeCursor(id);
    this.setHovered(null);
  }

  // --- Render ------------------------------------------------------------

  render(): void {
    this.stepIntro();

    // Parpadeo temporal de instrumentos "localizados" desde el checklist.
    if (this.pulses.size > 0) {
      const now = performance.now();
      for (const [id, until] of this.pulses) {
        const slot = this.slots.get(id);
        if (!slot) { this.pulses.delete(id); continue; }
        if (now >= until) {
          this.pulses.delete(id);
          this.applyHighlight(slot);
        } else {
          const blink = 0.5 + 0.5 * Math.sin(now * 0.02);
          this.setGroupEmissive(slot.group, 0x33d1c9, 0.3 + blink * 0.9);
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  pulseInstrument(instrumentId: string): void {
    if (this.slots.has(instrumentId)) {
      this.pulses.set(instrumentId, performance.now() + 1200);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitCamera();
  }

  /**
   * Abre el campo de visión lo justo para que TODA el área jugable siga en cuadro.
   *
   * La geometría está calculada para una pantalla 16:9, que es donde encaja con el fov base. En una
   * más cuadrada, 4:3, el encuadre se estrecha y la bandeja se saldría por la izquierda. En vez de
   * recolocar las zonas según la ventana —lo que rompería las garantías de no-ocultación, que
   * dependen justamente de las posiciones— se abre el ángulo, que no mueve nada de sitio.
   *
   * El panel del HUD entra en la cuenta: la franja derecha que ocupa se descuenta del espacio
   * disponible, así que «el contenido no queda debajo del panel» pasa de ajuste a ojo a resultado
   * calculado. Cuando el panel baja a la franja inferior esa reserva desaparece, y de saber cuándo
   * ocurre se encarga `CONSULTA_PANEL_ABAJO`, que es la MISMA consulta que aplica el CSS.
   *
   * Si ni abriendo hasta el tope cabe todo, se anota en `encuadreRecortado`. Eso no se puede
   * arreglar con más ángulo —la mesa mide 3,2 m y una pantalla vertical no tiene dónde ponerla— así
   * que quien lo consulte pide girar el dispositivo.
   */
  private fitCamera(): void {
    const camPos = new THREE.Vector3(...CAMERA.position);
    const fwd = new THREE.Vector3(...CAMERA.target).sub(camPos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    const panelAbajo = window.matchMedia?.(CONSULTA_PANEL_ABAJO).matches ?? false;
    const reservaPanel = panelAbajo ? 0 : CAMERA.hudReserveX;
    const limDer = 1 - 2 * (reservaPanel + CAMERA.margin);
    const limIzq = 1 - 2 * CAMERA.margin;
    const limArr = 1 - 2 * CAMERA.topReserve;
    const limAbj = 1 - 2 * CAMERA.margin;

    const v = new THREE.Vector3();
    let tan = Math.tan((CAMERA.baseFovDeg * Math.PI) / 360);
    for (const p of framingPoints()) {
      v.set(p.x, SURFACE_Y, p.z).sub(camPos);
      const d = v.dot(fwd);
      if (d <= 0.01) continue;
      const wc = v.dot(right) / d;
      const hc = v.dot(up) / d;
      // Cada punto impone una tangente mínima; se toma la mayor de todas.
      tan = Math.max(tan, (wc > 0 ? wc / limDer : -wc / limIzq) / this.camera.aspect);
      tan = Math.max(tan, hc > 0 ? hc / limArr : -hc / limAbj);
    }

    const fov = (2 * Math.atan(tan) * 180) / Math.PI;
    this.camera.fov = Math.min(CAMERA.maxFovDeg, Math.max(CAMERA.baseFovDeg, fov));
    this.camera.updateProjectionMatrix();

    // Un pelín de holgura: pedía 62,0001 grados y decir que no cabe sería quisquilloso.
    this.encuadreRecortado = fov > CAMERA.maxFovDeg + 0.01;
  }

  /**
   * ¿Se ha quedado área jugable fuera de la pantalla?
   *
   * Cierto cuando `fitCamera()` ha tenido que recortar el ángulo contra su tope, que es exactamente
   * la condición en la que parte de la mesa no entra. Se expone como una PREGUNTA sobre el encuadre y
   * no como «¿es un móvil?» a propósito: lo que estropea la partida es la proporción de la ventana,
   * no el aparato, y una ventana de escritorio estrecha y alta se rompe igual.
   */
  encuadreCompleto(): boolean {
    return !this.encuadreRecortado;
  }

  /** Proyecta un instrumento a coordenadas de pantalla (px CSS). Para tests. */
  projectInstrumentToScreen(instrumentId: string): { x: number; y: number } | null {
    const slot = this.slots.get(instrumentId);
    if (!slot) return null;
    const v = slot.group.position.clone().project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  // --- Helpers -----------------------------------------------------------

  private applyHighlight(slot: InstrumentSlot): void {
    const isHovered = slot.group.userData.instrumentId === this.hoveredId;
    if (slot.held) {
      this.setGroupEmissive(slot.group, HELD_COLOR, 0.7);
      this.setGroupOpacity(slot.group, 0.55); // transparente al sujetar
    } else if (isHovered) {
      this.setGroupEmissive(slot.group, HOVER_COLOR, 0.45);
      this.setGroupOpacity(slot.group, 0.6); // transparente al apuntar (ver qué se coge)
    } else {
      this.setGroupEmissive(slot.group, 0x000000, 0);
      this.setGroupOpacity(slot.group, 1); // opaco normal
    }
  }

  /** Ajusta la opacidad de todos los materiales del grupo (transparencia de agarre). */
  private setGroupOpacity(group: THREE.Object3D, opacity: number): void {
    const transparent = opacity < 1;
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const apply = (m: THREE.Material) => {
        m.transparent = transparent;
        m.opacity = opacity;
        m.depthWrite = !transparent;
        m.needsUpdate = true;
      };
      if (Array.isArray(mat)) mat.forEach(apply);
      else if (mat) apply(mat);
    });
  }

  private setGroupEmissive(group: THREE.Object3D, color: number, intensity: number): void {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const apply = (m: THREE.Material) => {
        const std = m as THREE.MeshStandardMaterial;
        if (std && std.emissive) {
          std.emissive.setHex(color);
          std.emissiveIntensity = intensity;
        }
      };
      if (Array.isArray(mat)) mat.forEach(apply);
      else if (mat) apply(mat);
    });
  }

  /**
   * Enciende el suelo de una zona mientras se arrastra algo encima.
   *
   * En rojo si está llena: sin ese aviso, la pieza rebotaba al pool sin explicación y parecía que
   * el juego había fallado.
   */
  private setZoneHighlight(zone: BinZone, on: boolean, blocked: boolean): void {
    const mesh = this.zoneHighlights.get(zone);
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = on ? 0.35 : 0;
    mat.color.setHex(blocked ? 0xd05a4a : 0x33d1c9);
  }

  private setRayFromNormalized(x: number, y: number): void {
    const ndc = new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  private projectToTablePlane(x: number, y: number): THREE.Vector3 | null {
    this.setRayFromNormalized(x, y);
    // Sin el margen de 1,5 cm de antes: ahora los modelos se anclan por su base, así que el plano
    // lógico y la superficie real son el mismo.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SURFACE_Y);
    const point = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(plane, point);
    return hit ? point : null;
  }

  /**
   * Vacía la mesa. Público porque al volver al menú hay que DESMONTAR la partida: antes los
   * dieciséis instrumentos se quedaban detrás del menú, en una partida que ya no existía.
   */
  clearInstruments(): void {
    /*
     * Además de sacarlos de la escena hay que LIBERAR geometrías y materiales.
     *
     * Cada instrumento crea sus propios materiales —hace falta para poder iluminarlos de uno en uno
     * al señalarlos— así que cambiar de operación dejaba atrás una quincena de modelos completos.
     * En una sesión larga eso se acumula en la memoria de la tarjeta.
     */
    for (const slot of this.slots.values()) {
      this.scene.remove(slot.group);
      slot.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
    this.slots.clear();
  }
}

/**
 * Pinta un texto en un canvas y lo devuelve como textura, con su proporción.
 *
 * Se devuelve también la proporción porque el `Sprite` se escala en metros y hay que darle un ancho
 * acorde al texto: fijando solo el alto, «Gasa» y «Pinza de campo (Backhaus)» saldrían igual de
 * anchas y una de las dos deformada.
 */
/**
 * Libera geometrías y materiales de un subárbol entero.
 *
 * Hace falta al cambiar el decorado propio por el del GLB: quitarlo de la escena solo lo desengancha
 * del grafo, pero sus buffers siguen en la memoria de la GPU hasta que se liberan a mano.
 */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat?.dispose();
  });
}

function textoATextura(texto: string): { textura: THREE.CanvasTexture; proporcion: number } {
  const FUENTE = 44;
  const PAD = 22;
  const medidor = document.createElement('canvas').getContext('2d')!;
  medidor.font = `600 ${FUENTE}px ui-sans-serif, system-ui, sans-serif`;
  const ancho = Math.ceil(medidor.measureText(texto).width) + PAD * 2;
  const alto = FUENTE + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = ancho;
  canvas.height = alto;
  const ctx = canvas.getContext('2d')!;

  // Fondo redondeado y oscuro: sobre el verde del quirófano el texto claro solo no se lee.
  ctx.fillStyle = 'rgba(6, 14, 18, 0.86)';
  ctx.beginPath();
  ctx.roundRect(0, 0, ancho, alto, alto / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(51, 209, 201, 0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.font = `600 ${FUENTE}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#e6f0f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(texto, ancho / 2, alto / 2 + 2);

  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  return { textura, proporcion: ancho / alto };
}
