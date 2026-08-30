/**
 * Geometría de la escena: origen ÚNICO de todas las medidas.
 *
 * POR QUÉ EXISTE. Antes cada número vivía escrito a mano dentro de `SceneManager`, y varios
 * estaban repetidos: el ancho de la bandeja aparecía seis veces, la altura de la mesa tres, y la
 * rejilla del pool y el encaje en la bandeja estaban calibrados a ojo contra esas medidas. Mover
 * la bandeja un centímetro obligaba a tocar ocho sitios de forma coherente, y bastaba olvidar uno
 * para romper algo lejano. De hecho así se rompieron tres cosas a la vez:
 *
 *  - el borde trasero de la bandeja tapaba una fila entera de instrumentos —por dos milímetros—;
 *  - la caja de la bandeja invadía el pool, así que soltar sobre un instrumento del pool contaba
 *    como soltar en la bandeja;
 *  - la bandeja tenía nueve huecos y la apendicectomía pide once, de modo que del décimo en
 *    adelante los instrumentos aterrizaban fuera de la mesa, flotando en el aire.
 *
 * Aquí las constantes se declaran una vez y todo lo demás se DERIVA. Las garantías que antes eran
 * «se ve bien» pasan a ser funciones comprobables, y `assertLayout()` las verifica en desarrollo.
 *
 * Ejes: X ancho (derecha +), Y altura, Z profundidad (hacia la cámara +).
 * Unidades: metros.
 */

/** Cara superior de la mesa. La única altura de referencia; todo lo demás se apoya en ella. */
export const SURFACE_Y = 0.95;

export const TABLE = {
  width: 3.2,
  depth: 1.8,
  thickness: 0.05,
  centerX: 0,
  centerZ: -0.46,
  legRadius: 0.025,
  /** Cuánto se meten las patas hacia dentro desde la esquina. */
  legInset: 0.15,
  skirtDrop: 0.5,
} as const;

/**
 * Rejilla de instrumentos disponibles, al fondo de la mesa.
 *
 * Se ancla por la fila FRONTAL y crece hacia atrás. Es lo que mantiene constante la separación
 * con la bandeja tanto si la operación trae diez instrumentos como si trae dieciséis; anclándola
 * por detrás, el hueco cambiaba con cada operación y la garantía de no-ocultación dependía del
 * número de piezas.
 */
export const POOL = {
  maxCols: 6,
  pitchX: 0.28,
  pitchZ: 0.26,
  frontZ: -0.58,
  centerX: -0.6,
  maxRows: 3,
} as const;

/*
 * La bandeja ocupa la banda frontal, que es la ZONA MÁS ESTRECHA de la escena: la perspectiva
 * encoge el encuadre según se acerca a la cámara, y además el panel del HUD se come la derecha.
 * Medido con el fov base a 16:9, a z=0.26 solo hay hueco entre x=-1.15 y x=+0.42.
 *
 * Antes esa banda la compartía con una cubeta de descartes. Se ha eliminado: para el motor,
 * «descartado» y «en el pool» eran exactamente el mismo estado —no está en la bandeja—, así que era
 * una tercera zona sin significado propio; y una cubeta rotulada como «incorrectos» sugiere que el
 * juego valida lo que echas ahí, justo la pista que ahora no debe darse. Dejar el instrumento en la
 * mesa ya es descartarlo.
 *
 * Con esa anchura liberada, la bandeja se ensancha y se CENTRA respecto al pool (ambos en x=-0.6),
 * que además es lo que da holgura entre piezas ahora que son más grandes. Los `layout.test.ts` de
 * encuadre son los que vigilan que siga cabiendo.
 */
export const TRAY = {
  centerX: -0.6,
  centerZ: -0.03,
  /*
   * 1.16 y no más. Centrada en x=-0.6 como el pool, el límite lo pone el borde IZQUIERDO del
   * encuadre: a z=0.26 la perspectiva ya solo deja ver hasta x≈-1.22, y los tests de encuadre
   * rechazaron 1.42 por exactamente eso. No es un número elegido a ojo: es el que cabe.
   */
  width: 1.16,
  depth: 0.58,
  wall: 0.02,
  floorThickness: 0.02,
  rimHeight: 0.045,
  /*
   * 3 columnas × 5 filas = 15 huecos, y el reparto no es indiferente.
   *
   * Hacen falta 14 como mínimo: la apendicectomía admite 11 obligatorias más 3 opcionales, y cuando
   * la bandeja se quedaba corta la última pieza REBOTABA al pool sin explicación —el fallo de «no me
   * deja poner la gasa»—.
   *
   * El reparto sale de cómo se tumban los instrumentos: eje largo en X, y ahora un 25 % más grandes,
   * hasta 30 cm. A lo ancho estorban, así que se baja a 3 columnas para dar 37 cm de paso en X y que
   * no se crucen. De fondo miden dos o tres centímetros, así que crecer en filas es gratis: con 5,
   * el paso en Z es de 10,8 cm, de sobra para una pieza que ocupa tres.
   */
  cols: 3,
  rows: 5,
} as const;

/**
 * Escala de los instrumentos respecto a su tamaño de referencia.
 *
 * Se suben un 25 % porque a la escala anterior costaba apuntarlos con la mano: el cursor va
 * suavizado y una pieza de 15 cm vista desde la cámara ocupa muy poco en pantalla. Es un factor
 * único y no una tabla nueva para que la proporción ENTRE instrumentos —la hoja pequeña, la sierra
 * grande— se mantenga tal cual.
 */
export const INSTRUMENT_SCALE = 1.25;

/**
 * Largo del guante 3D sobre la mesa, de muñeca a yema del índice.
 *
 * Es un tamaño DECIDIDO, no heredado del encuadre. Antes los 21 puntos de la mano se proyectaban
 * uno a uno sobre la mesa, y como la mesa ocupa 3,2 m de ancho de pantalla, una mano que cubre el
 * 22 % del cuadro se convertía en **1,006 m de guante**: cinco manos reales, el triple que el
 * instrumento más largo, tapando media mesa. El estirado de la zona activa lo agravó otro 47 %.
 */
export const HAND_LENGTH = 0.19;

/**
 * Proporción entre la palma (muñeca → nudillo del corazón) y el largo total de la mano.
 *
 * La escala del guante se calcula sobre la PALMA y no sobre muñeca → yema del índice, porque esa
 * segunda medida se encoge al pellizcar —pellizcar es curvar el índice— y hacía que el guante se
 * inflara justo en el momento de agarrar. La palma es rígida: no cambia por doblar los dedos.
 *
 * 0,42 es la proporción anatómica habitual, y es lo que convierte `HAND_LENGTH` en la medida de
 * palma equivalente para que el guante conserve el mismo tamaño en pantalla que antes.
 */
export const PALMA_SOBRE_MANO = 0.42;

export const INTERACTION = {
  /**
   * Tolerancia para COGER. Algo menos que el paso de la rejilla, o se cogen dos a la vez.
   *
   * Sube con el tamaño de las piezas: si los instrumentos crecen y el radio no, apuntar sigue
   * costando lo mismo. El techo lo pone `pitchX` del pool (0.28), que es la distancia a la que están
   * dos vecinos.
   */
  /*
   * 0.19, de vuelta al valor con el que coger funcionaba bien.
   *
   * Se había bajado a 0.12 razonando que un radio menor daría más precisión. **Era un error de
   * concepto**: entre dos piezas vecinas no decide el radio, decide cuál está más cerca. Apretarlo no
   * evita ni un solo agarre equivocado; lo único que hace es quitar alcance, y medido costó la mitad
   * del margen de puntería (el área de captura en el pool cayó de 1267 a 674 cm²).
   *
   * El límite real es `POOL.pitchX` (0.28), la separación entre piezas, y lo vigila `layout.test.ts`.
   */
  grabRadius: 0.19,
  /**
   * Tolerancia para MIRAR (dwell). Mucho menor que la de coger, y esa es la clave: con el radio de
   * agarre bastaba pasar la mano cerca para que saltara la ficha de un instrumento que ni siquiera
   * se estaba señalando.
   */
  inspectRadius: 0.07,
  /**
   * Cuánto más cerca tiene que estar una pieza rival para robarle la diana a la actual.
   *
   * Sin este margen, con el temblor de la mano «la más cercana» cambiaba de frame a frame entre dos
   * piezas vecinas y el resaltado parpadeaba. Es el mismo recurso que la histéresis de la pinza en
   * `HandTracker` contra el mismo problema: una señal ruidosa cruzando un umbral.
   *
   * El valor no es a ojo: sale del requisito de aguantar **1 cm de temblor** justo en el punto medio
   * entre dos filas de la bandeja (separadas 0.108). Ahí la diana vigente está a 0.064 y la rival a
   * 0.044, así que hace falta 0.044/0.064 ≈ 0.69 o menos. Con 0.75 solo se aguantaban 7,7 mm y el
   * resaltado seguía saltando. Lo vigila `layout.test.ts`.
   */
  targetStickiness: 0.65,
  /** Cuánto se eleva el instrumento agarrado sobre la superficie. */
  heldLift: 0.12,
  /** Holgura al decidir si se ha soltado sobre la bandeja. */
  zoneTolerance: 0.05,
} as const;

/**
 * Distancia de un punto al SEGMENTO que ocupa una pieza tumbada, en el plano de la mesa.
 *
 * Medir contra el centro —que es lo que se hacía— falla justo cuando más molesta: apuntando a la
 * punta de una tijera de 31 cm estás a 15 cm de su propio centro, más lejos que el centro de la
 * vecina, así que el juego cogía la de al lado. Contra el segmento, señalar cualquier parte de la
 * pieza la elige a ella.
 */
export function distanceToFootprint(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  halfLength: number,
  rotY: number,
): number {
  // Eje largo de la pieza en el plano. `rotY` es el giro alrededor de Y con el que se coloca.
  const ax = Math.cos(rotY);
  const az = -Math.sin(rotY);
  const dx = px - cx;
  const dz = pz - cz;
  // Proyección sobre el eje, recortada a la mitad del largo: fuera de ella manda el extremo.
  const t = Math.max(-halfLength, Math.min(halfLength, dx * ax + dz * az));
  return Math.hypot(dx - ax * t, dz - az * t);
}

/**
 * Cuándo el panel del HUD deja de estar en el lateral y baja a la franja inferior.
 *
 * Vive aquí, con el resto de medidas, porque la usan DOS sitios que tienen que decir lo mismo: el CSS
 * la aplica para mover el panel y `fitCamera()` la consulta para saber si tiene que reservarle sitio
 * a la derecha. Antes era el número 640 escrito a mano en cada uno; si alguien cambiaba solo el CSS,
 * la cámara seguía encuadrando para dejar hueco a un panel que ya no estaba ahí.
 *
 * Debe coincidir LITERALMENTE con la `@media` de `styles.css`.
 */
export const CONSULTA_PANEL_ABAJO = '(max-width: 640px)';

export const CAMERA = {
  position: [0, 2.35, 1.15] as const,
  target: [0, 0.88, -0.35] as const,
  baseFovDeg: 46,
  /**
   * Tope del campo de visión. Por encima el encuadre se deforma y los instrumentos quedan diminutos.
   *
   * Que este tope se alcance significa que el área jugable NO cabe en la ventana. No es un detalle
   * estético: medido, en un móvil en vertical el borde izquierdo de la bandeja se va a x=-0,67, o sea
   * a dos tercios de pantalla fuera. Por eso `fitCamera()` avisa cuando recorta, y quien lo escucha
   * pide girar el dispositivo en lugar de dejar jugar con media mesa invisible.
   */
  maxFovDeg: 62,
  /** Fracción del ancho que ocupa el panel del HUD por la derecha. */
  hudReserveX: 0.3,
  topReserve: 0.09,
  margin: 0.03,
} as const;

export const LAMP = {
  y: 2.6,
  armY: 3.2,
  /** Margen del cono de luz sobre el área jugable, para que no se vea el borde del foco. */
  coneSlack: 1.15,
} as const;

export type DropZone = 'pool' | 'tray';
/** Las zonas que son recipientes, es decir, todo menos la mesa desnuda. */
export type BinZone = Exclude<DropZone, 'pool'>;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Cell {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

// --- Mesa -----------------------------------------------------------------

export function tableBounds(): Rect & { topY: number; boxCenterY: number } {
  return {
    minX: TABLE.centerX - TABLE.width / 2,
    maxX: TABLE.centerX + TABLE.width / 2,
    minZ: TABLE.centerZ - TABLE.depth / 2,
    maxZ: TABLE.centerZ + TABLE.depth / 2,
    topY: SURFACE_Y,
    /*
     * El centro del `Box` del tablero se DERIVA de la superficie, no al revés. Antes eran dos
     * constantes independientes (0.92 y 0.95) y no cuadraban: la cara superior real caía en 0.945,
     * así que todo lo colocado «sobre la mesa» flotaba cinco milímetros y las sombras no casaban.
     */
    boxCenterY: SURFACE_Y - TABLE.thickness / 2,
  };
}

// --- Zonas ----------------------------------------------------------------

/*
 * Queda una sola zona con huecos. Se conserva la indirección `BIN` en vez de escribir `TRAY` en
 * todas partes porque es lo que permitió meter y sacar el descarte tocando un sitio; volver a
 * cablear la bandeja a mano desharía justo eso.
 */
const BIN = { tray: TRAY } as const;

export function zoneRect(zone: BinZone): Rect {
  const b = BIN[zone];
  return {
    minX: b.centerX - b.width / 2,
    maxX: b.centerX + b.width / 2,
    minZ: b.centerZ - b.depth / 2,
    maxZ: b.centerZ + b.depth / 2,
  };
}

/** Altura a la que se apoya lo que se deja en la zona. */
export function zoneFloorY(zone: BinZone): number {
  return SURFACE_Y + BIN[zone].floorThickness;
}

/** Cima del borde: es lo que puede tapar lo que hay detrás. */
export function zoneRimTopY(zone: BinZone): number {
  return zoneFloorY(zone) + BIN[zone].rimHeight;
}

export function zoneCapacity(zone: BinZone): number {
  return BIN[zone].cols * BIN[zone].rows;
}

export const TRAY_CAPACITY = zoneCapacity('tray');

/**
 * Los huecos de una zona, en coordenadas de mundo.
 *
 * Rejilla centrada dentro del interior útil (descontando las paredes). Al derivar el paso del
 * interior en lugar de escribirlo a mano, cambiar `rows` o `cols` recoloca todo solo: subir la
 * bandeja de 12 a 16 huecos es cambiar un número.
 */
export function zoneCells(zone: BinZone): Cell[] {
  const b = BIN[zone];
  const innerW = b.width - b.wall * 2;
  const innerD = b.depth - b.wall * 2;
  const pitchX = innerW / b.cols;
  const pitchZ = innerD / b.rows;
  const y = zoneFloorY(zone);

  const cells: Cell[] = [];
  for (let row = 0; row < b.rows; row++) {
    for (let col = 0; col < b.cols; col++) {
      cells.push({
        x: b.centerX - innerW / 2 + pitchX * (col + 0.5),
        y,
        z: b.centerZ - innerD / 2 + pitchZ * (row + 0.5),
        rotY: 0,
      });
    }
  }
  return cells;
}

// --- Pool -----------------------------------------------------------------

/**
 * Reparte `n` instrumentos en filas equilibradas ancladas por delante.
 *
 * Equilibradas y no «llenar filas de seis hasta que se acaben»: dieciséis instrumentos daban
 * 6+6+4, con una última fila corta y descentrada que se leía como un error. Repartidos salen
 * 6+5+5, y los que sobran van a la fila frontal, que es la que se ve más grande.
 */
export function poolLayout(n: number): Cell[] {
  if (n <= 0) return [];
  const rows = Math.min(POOL.maxRows, Math.ceil(n / POOL.maxCols));
  const base = Math.floor(n / rows);
  const extra = n % rows;

  const cells: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    const count = base + (row < extra ? 1 : 0);
    for (let col = 0; col < count; col++) {
      cells.push({
        x: POOL.centerX + (col - (count - 1) / 2) * POOL.pitchX,
        y: SURFACE_Y,
        z: POOL.frontZ - row * POOL.pitchZ,
        /*
         * Giro variado pero DETERMINISTA: da aspecto de mesa preparada a mano sin que la escena
         * cambie entre recargas, lo que haría imposible comparar capturas o depurar una posición.
         */
        rotY: -0.25 + ((col + row) % 3) * 0.25,
      });
    }
  }
  return cells;
}

// --- Encuadre y visibilidad -----------------------------------------------

/** Rectángulo que abarca las tres zonas: lo que la cámara y la luz tienen que cubrir. */
export function contentBounds(): Rect {
  /*
   * El margen de media pieza se aplica SOLO al pool.
   *
   * Las posiciones del pool son centros de instrumento, así que hay que ensanchar para cubrir la
   * pieza entera. Los rectángulos de las zonas, en cambio, ya son su extensión real —incluyen las
   * paredes— y ensancharlos también hacía creer que la escena era 24 cm más ancha de lo que es. Con
   * ese margen de más, el encuadre daba por imposible una disposición que sí cabía.
   */
  const half = 0.12;
  const pool = poolLayout(POOL.maxCols * POOL.maxRows);
  const rects = [zoneRect('tray')];
  return {
    minX: Math.min(...pool.map((c) => c.x - half), ...rects.map((r) => r.minX)),
    maxX: Math.max(...pool.map((c) => c.x + half), ...rects.map((r) => r.maxX)),
    minZ: Math.min(...pool.map((c) => c.z - half), ...rects.map((r) => r.minZ)),
    maxZ: Math.max(...pool.map((c) => c.z + half), ...rects.map((r) => r.maxZ)),
  };
}

/**
 * Los puntos que la cámara tiene que mantener en cuadro.
 *
 * No sirve el rectángulo envolvente: su esquina delantera-izquierda cae donde no hay nada —delante
 * solo llega la bandeja, y el pool más ancho está al fondo— y exigir que esa esquina fantasma entre
 * en pantalla obliga a abrir el campo de visión sin motivo. Aquí van las extensiones REALES: las
 * esquinas de cada zona y la huella de cada instrumento del pool.
 */
export function framingPoints(): { x: number; z: number }[] {
  const half = 0.12;
  const puntos: { x: number; z: number }[] = [];

  for (const zona of ['tray'] as BinZone[]) {
    const r = zoneRect(zona);
    puntos.push(
      { x: r.minX, z: r.minZ },
      { x: r.maxX, z: r.minZ },
      { x: r.minX, z: r.maxZ },
      { x: r.maxX, z: r.maxZ },
    );
  }
  for (const c of poolLayout(POOL.maxCols * POOL.maxRows)) {
    puntos.push(
      { x: c.x - half, z: c.z - half },
      { x: c.x + half, z: c.z - half },
      { x: c.x - half, z: c.z + half },
      { x: c.x + half, z: c.z + half },
    );
  }
  return puntos;
}

/**
 * Hasta dónde llega, hacia el fondo, la sombra visual de un borde de altura `edgeTopY` situado en
 * `edgeZ`. Lo que esté por detrás de ese punto queda tapado desde la cámara.
 *
 * Es la fórmula que faltaba: el borde de la bandeja tapaba una fila del pool por dos milímetros y
 * no había forma de saberlo salvo mirando la pantalla desde el ángulo justo.
 */
export function occlusionReachZ(edgeZ: number, edgeTopY: number): number {
  const [, camY, camZ] = CAMERA.position;
  const dz = camZ - edgeZ;
  const dy = camY - edgeTopY;
  if (dy <= 0) return -Infinity; // el borde está por encima de la cámara: tapa todo
  return camZ - ((camY - SURFACE_Y) * dz) / dy;
}

// --- Invariantes ----------------------------------------------------------

/*
 * Aquí vivía `overlaps`, que comprobaba que bandeja y descarte no se pisaran. Con una sola zona no
 * hay nada que solapar; se retira en lugar de dejarla muerta «por si acaso».
 */

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minZ >= outer.minZ &&
    inner.maxZ <= outer.maxZ
  );
}

/**
 * Las cuatro garantías del diseño, como aserciones y no como impresión visual.
 *
 * Se llama en desarrollo al construir la escena. Si alguien mueve una constante y rompe una de
 * ellas, se entera al instante y no tres semanas después viendo un instrumento flotando.
 */
export function assertLayout(): string[] {
  const fallos: string[] = [];
  const mesa = tableBounds();
  const zonas: BinZone[] = ['tray'];

  for (const z of zonas) {
    if (!contains(mesa, zoneRect(z))) fallos.push(`la zona "${z}" se sale de la mesa`);
  }

  // Nada del pool puede caer dentro de una zona ni quedar tapado por su borde.
  const pool = poolLayout(POOL.maxCols * POOL.maxRows);
  for (const z of zonas) {
    const r = zoneRect(z);
    const alcance = occlusionReachZ(r.minZ, zoneRimTopY(z));
    for (const c of pool) {
      if (c.x > r.minX && c.x < r.maxX && c.z > r.minZ && c.z < r.maxZ) {
        fallos.push(`un hueco del pool cae dentro de "${z}"`);
        break;
      }
    }
    const masCercano = Math.max(...pool.map((c) => c.z));
    if (masCercano > alcance - 0.08) {
      fallos.push(
        `el borde de "${z}" tapa el pool: alcanza z=${alcance.toFixed(3)} y el pool llega a z=${masCercano.toFixed(3)}`,
      );
    }
  }

  const conMargen = { ...contentBounds() };
  if (!contains(mesa, conMargen)) fallos.push('el contenido no cabe en la mesa');

  /*
   * 14 = la operación más exigente del catálogo (apendicectomía: 11 obligatorias + 3 opcionales).
   * El número vive aquí como mínimo defensivo; quien vigila de verdad que no se quede corto es el
   * test que lee el catálogo, porque este se olvidaría de actualizar al añadir una operación nueva.
   */
  if (TRAY_CAPACITY < 14) fallos.push(`la bandeja solo tiene ${TRAY_CAPACITY} huecos y hacen falta 14`);

  return fallos;
}
