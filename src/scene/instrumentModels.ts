import * as THREE from 'three';
import type { Instrument } from '../types/contracts';

/**
 * Modelos procedurales de instrumental quirúrgico. Construidos con primitivas
 * compuestas a escala ~real (0.14–0.22 m de largo), tumbados sobre el eje X y
 * centrados en el origen. Cada instrumento crea SUS PROPIOS materiales (no se
 * comparten) para poder resaltarlo individualmente (emissive) al hacer hover.
 *
 * Devuelve un Group con `userData.instrumentId` propagado en todos los hijos.
 */
export function buildInstrumentModel(instrument: Instrument): THREE.Group {
  const archetype = ARCHETYPE[instrument.id] ?? fallbackArchetype(instrument.category);
  const builder = BUILDERS[archetype];
  const group = builder(new THREE.Color(instrument.placeholderColor ?? '#c9d2d8'));
  group.name = `model:${instrument.id}`;
  group.traverse((o) => {
    o.userData.instrumentId = instrument.id;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    }
  });
  return group;
}

// --- Materiales ------------------------------------------------------------

function steel(color: THREE.Color, rough = 0.28): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 1.0,
    roughness: rough,
    envMapIntensity: 1.4, // refleja con fuerza el environment map (acero pulido)
  });
}
function matte(hex: string, rough = 0.85): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    metalness: 0.05,
    roughness: rough,
    envMapIntensity: 0.6,
  });
}

// --- Archetipos ------------------------------------------------------------

type Archetype =
  | 'scalpel' | 'blade' | 'scissors' | 'ringForceps' | 'tweezers'
  | 'suturePack' | 'retractor' | 'gauze' | 'suction' | 'towelClamp'
  | 'cauteryPen' | 'saw' | 'generic';

const ARCHETYPE: Record<string, Archetype> = {
  'scalpel-3': 'scalpel',
  'blade-10': 'blade',
  'mayo-scissors': 'scissors',
  'metzenbaum-scissors': 'scissors',
  'kelly-forceps': 'ringForceps',
  'mosquito-forceps': 'ringForceps',
  'babcock-forceps': 'ringForceps',
  'needle-holder': 'ringForceps',
  'adson-forceps': 'tweezers',
  'suture-silk': 'suturePack',
  'suture-vicryl': 'suturePack',
  'retractor-farabeuf': 'retractor',
  'retractor-deaver': 'retractor',
  gauze: 'gauze',
  'suction-yankauer': 'suction',
  'towel-clamp': 'towelClamp',
  electrocautery: 'cauteryPen',
  'bone-saw': 'saw',
};

function fallbackArchetype(category: string): Archetype {
  switch (category) {
    case 'corte': return 'scalpel';
    case 'pinza': return 'ringForceps';
    case 'sutura': return 'ringForceps';
    case 'separador': return 'retractor';
    case 'consumible': return 'gauze';
    case 'aspiracion': return 'suction';
    default: return 'generic';
  }
}

const BUILDERS: Record<Archetype, (c: THREE.Color) => THREE.Group> = {
  scalpel: buildScalpel,
  blade: buildBlade,
  scissors: (c) => buildRinged(c, { jaw: 'straight', ratchet: false }),
  ringForceps: (c) => buildRinged(c, { jaw: 'curved', ratchet: true }),
  tweezers: buildTweezers,
  suturePack: buildSuturePack,
  retractor: buildRetractor,
  gauze: buildGauze,
  suction: buildSuction,
  towelClamp: (c) => buildRinged(c, { jaw: 'pointed', ratchet: true }),
  cauteryPen: buildCauteryPen,
  saw: buildSaw,
  generic: (c) => buildRinged(c, { jaw: 'straight', ratchet: false }),
};

// --- Constructores concretos ----------------------------------------------

function buildScalpel(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const handleMat = steel(color, 0.35);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.011, 0.022), handleMat);
  handle.position.x = -0.02;
  // ranurado del mango (detalle)
  for (let i = 0; i < 6; i++) {
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.013, 0.024), steel(color.clone().multiplyScalar(0.85), 0.4));
    notch.position.set(-0.075 + i * 0.008, 0, 0);
    g.add(notch);
  }
  const bladeMat = steel(new THREE.Color('#eef2f5'), 0.15);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.002, 0.02), bladeMat);
  blade.position.set(0.075, 0.002, 0);
  const bevel = new THREE.Mesh(new THREE.CylinderGeometry(0.0005, 0.011, 0.05, 3), bladeMat);
  bevel.rotation.z = Math.PI / 2;
  bevel.position.set(0.075, -0.002, 0);
  g.add(handle, blade, bevel);
  return g;
}

function buildBlade(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(new THREE.Color('#eef2f5'), 0.15);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.0015, 0.02), mat);
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(0.0004, 0.01, 0.04, 3), mat);
  edge.rotation.z = Math.PI / 2;
  edge.position.y = -0.002;
  g.add(blade, edge);
  void color;
  return g;
}

interface RingedOpts { jaw: 'straight' | 'curved' | 'pointed'; ratchet: boolean; }

function buildRinged(color: THREE.Color, opts: RingedOpts): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(color);
  const L = 0.2;

  for (const side of [-1, 1] as const) {
    // anilla para el dedo
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.017, 0.004, 10, 20), mat);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(-L * 0.44, 0, side * 0.016);
    g.add(ring);
    // vástago desde la anilla hasta el pivote
    const shank = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, 0.006, 0.005), mat);
    shank.position.set(-L * 0.17, 0, side * 0.009);
    shank.rotation.y = side * 0.05;
    g.add(shank);
  }

  // pivote / caja
  const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.016, 12), mat);
  pivot.rotation.x = Math.PI / 2;
  g.add(pivot);

  // mordazas
  for (const side of [-1, 1] as const) {
    const jawGeo: THREE.BufferGeometry =
      opts.jaw === 'pointed'
        ? new THREE.ConeGeometry(0.006, L * 0.4, 8)
        : new THREE.BoxGeometry(L * 0.4, 0.004, 0.004);
    const jaw = new THREE.Mesh(jawGeo, mat);
    if (opts.jaw === 'curved') {
      jaw.position.set(L * 0.2, side * 0.006, side * 0.003);
      jaw.rotation.z = side * 0.12;
    } else if (opts.jaw === 'pointed') {
      jaw.rotation.z = -Math.PI / 2 + side * 0.1;
      jaw.position.set(L * 0.22, 0, side * 0.004);
    } else {
      jaw.position.set(L * 0.2, 0, side * 0.003);
    }
    g.add(jaw);
  }

  if (opts.ratchet) {
    const ratchet = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.003), mat);
    ratchet.position.set(-L * 0.28, -0.008, 0.012);
    g.add(ratchet);
  }
  return g;
}

function buildTweezers(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(color, 0.32);
  const L = 0.15;
  for (const side of [-1, 1] as const) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(L, 0.004, 0.004), mat);
    arm.position.set(0, 0, side * 0.006);
    arm.rotation.y = side * 0.06; // se juntan en la punta (+x)
    g.add(arm);
  }
  // unión trasera
  const joint = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.016), mat);
  joint.position.set(-L * 0.5, 0, 0);
  g.add(joint);
  return g;
}

function buildSuturePack(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.008, 0.06), matte('#e8e2d0', 0.7));
  g.add(pack);
  // etiqueta de color según el hilo
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.009, 0.03), matte('#' + color.getHexString(), 0.6));
  label.position.set(0.01, 0.001, 0);
  g.add(label);
  // aguja curva metálica
  const needle = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0012, 8, 16, Math.PI * 1.2), steel(new THREE.Color('#eef2f5'), 0.2));
  needle.position.set(-0.03, 0.006, 0.02);
  needle.rotation.x = Math.PI / 2;
  g.add(needle);
  return g;
}

function buildRetractor(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(color);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.008, 0.014), mat);
  handle.position.x = -0.02;
  g.add(handle);
  // pala/gancho curvo en el extremo
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.007, 0.05), mat);
  blade.position.set(0.06, 0, 0);
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.03, 0.05), mat);
  hook.position.set(0.073, -0.015, 0);
  g.add(blade, hook);
  return g;
}

function buildGauze(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const cloth = matte('#f4f4ec', 0.95);
  // dos capas ligeramente desplazadas para aspecto de gasa doblada
  const a = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, 0.08), cloth);
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.075), cloth);
  b.position.set(0.006, 0.014, 0.006);
  b.rotation.y = 0.2;
  g.add(a, b);
  void color;
  return g;
}

function buildSuction(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(color, 0.3);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 14), mat);
  shaft.rotation.z = Math.PI / 2;
  g.add(shaft);
  // punta curva (codo)
  const elbow = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.008, 10, 16, Math.PI / 2), mat);
  elbow.position.set(0.08, 0.02, 0);
  elbow.rotation.z = Math.PI;
  g.add(elbow);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.005, 0.04, 12), mat);
  tip.position.set(0.1, 0.04, 0);
  g.add(tip);
  return g;
}

function buildCauteryPen(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.13, 16), matte('#2c3138', 0.6));
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.004, 0.05, 8), steel(new THREE.Color('#e9c04a'), 0.3));
  tip.rotation.z = Math.PI / 2;
  tip.position.x = 0.085;
  g.add(tip);
  // cable saliendo por detrás
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.065, 0, 0),
    new THREE.Vector3(-0.11, -0.005, 0.03),
    new THREE.Vector3(-0.14, 0, 0.08),
  ]);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.003, 8), matte('#1a1d22', 0.7));
  g.add(cable);
  void color;
  return g;
}

function buildSaw(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const mat = steel(color);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.014, 0.018), matte('#3a3f45', 0.6));
  handle.position.x = -0.06;
  g.add(handle);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.001, 0.03), steel(new THREE.Color('#dfe4e8'), 0.15));
  blade.position.set(0.045, 0, 0);
  g.add(blade);
  // dientes
  for (let i = 0; i < 14; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.003, 0.006, 4), mat);
    tooth.rotation.x = Math.PI;
    tooth.position.set(0.0 + i * 0.0072, 0, -0.016);
    g.add(tooth);
  }
  return g;
}
