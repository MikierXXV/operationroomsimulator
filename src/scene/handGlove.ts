import * as THREE from 'three';

/** Topología de los 21 landmarks de MediaPipe Hands (pares conectados). */
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], // pulgar
  [0, 5], [5, 6], [6, 7], [7, 8], // índice
  [5, 9], [9, 10], [10, 11], [11, 12], // medio
  [9, 13], [13, 14], [14, 15], [15, 16], // anular
  [13, 17], [17, 18], [18, 19], [19, 20], // meñique
  [0, 17], // base de la palma
];

/** Anillo de vértices que delimita la palma (para el relleno en abanico). */
const PALM_LOOP = [5, 9, 13, 17, 0];

const GLOVE_COLOR = new THREE.Color('#57c6d0');
const PINCH_COLOR = new THREE.Color('#f4b942');

/**
 * Guante quirúrgico 3D a partir de los 21 landmarks de una mano: palma rellena,
 * dedos con nudillos, puño (cuff) y material de látex semiopaco. Se abre/cierra
 * solo porque las posiciones vienen de la mano real. Reutiliza geometría.
 */
export class HandGlove {
  readonly group = new THREE.Group();
  private joints: THREE.InstancedMesh;
  private bones: THREE.InstancedMesh;
  private palm: THREE.Mesh;
  private cuff: THREE.Mesh;
  private dummy = new THREE.Object3D();
  private material: THREE.MeshStandardMaterial;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor() {
    this.material = new THREE.MeshStandardMaterial({
      color: GLOVE_COLOR,
      emissive: GLOVE_COLOR.clone().multiplyScalar(0.12),
      transparent: true,
      opacity: 0.82,
      roughness: 0.35,
      metalness: 0.05,
      envMapIntensity: 0.8,
      side: THREE.DoubleSide,
    });

    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 14), this.material, 21);
    this.joints.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(21 * 3), 3);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), this.material, HAND_CONNECTIONS.length);

    // Palma: abanico de triángulos (centro + bucle PALM_LOOP). 5 triángulos.
    const palmGeo = new THREE.BufferGeometry();
    palmGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PALM_LOOP.length * 3 * 3), 3));
    palmGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(PALM_LOOP.length * 3 * 3), 3));
    this.palm = new THREE.Mesh(palmGeo, this.material);
    this.palm.frustumCulled = false;

    this.cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, 0.05, 16, 1, true), this.material);
    this.cuff.frustumCulled = false;

    for (const m of [this.joints, this.bones]) {
      m.frustumCulled = false;
      m.renderOrder = 998;
    }
    this.palm.renderOrder = 997;
    this.group.add(this.palm, this.cuff, this.bones, this.joints);
  }

  update(points: THREE.Vector3[], pinching: boolean): void {
    if (points.length < 21) return;

    const tips = new Set([4, 8, 12, 16, 20]);
    for (let i = 0; i < 21; i++) {
      const r = i === 0 ? 0.022 : tips.has(i) ? 0.014 : 0.016;
      this.dummy.position.copy(points[i]);
      this.dummy.scale.setScalar(r);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.joints.setMatrixAt(i, this.dummy.matrix);
      const highlight = pinching && (i === 4 || i === 8);
      this.joints.setColorAt(i, highlight ? PINCH_COLOR : GLOVE_COLOR);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;

    // Huesos (dedos gruesos).
    const up = new THREE.Vector3(0, 1, 0);
    HAND_CONNECTIONS.forEach(([a, b], c) => {
      const pa = points[a];
      const pb = points[b];
      this.tmpA.subVectors(pb, pa);
      const len = this.tmpA.length() || 0.0001;
      this.tmpB.addVectors(pa, pb).multiplyScalar(0.5);
      this.dummy.position.copy(this.tmpB);
      this.dummy.quaternion.setFromUnitVectors(up, this.tmpA.clone().normalize());
      this.dummy.scale.set(0.013, len, 0.013);
      this.dummy.updateMatrix();
      this.bones.setMatrixAt(c, this.dummy.matrix);
    });
    this.bones.instanceMatrix.needsUpdate = true;

    // Palma: abanico desde el centro.
    const center = this.tmpA.set(0, 0, 0);
    for (const idx of PALM_LOOP) center.add(points[idx]);
    center.multiplyScalar(1 / PALM_LOOP.length);
    const pos = this.palm.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < PALM_LOOP.length; i++) {
      const a = points[PALM_LOOP[i]];
      const b = points[PALM_LOOP[(i + 1) % PALM_LOOP.length]];
      const base = i * 9;
      pos.array[base + 0] = center.x; pos.array[base + 1] = center.y; pos.array[base + 2] = center.z;
      pos.array[base + 3] = a.x; pos.array[base + 4] = a.y; pos.array[base + 5] = a.z;
      pos.array[base + 6] = b.x; pos.array[base + 7] = b.y; pos.array[base + 8] = b.z;
    }
    pos.needsUpdate = true;
    this.palm.geometry.computeVertexNormals();

    // Puño (cuff): en la muñeca, orientado hacia fuera de los dedos.
    const wrist = points[0];
    const mid = points[9];
    this.tmpB.subVectors(wrist, mid).normalize(); // dirección hacia el antebrazo
    this.dummy.position.copy(wrist).addScaledVector(this.tmpB, 0.03);
    this.dummy.quaternion.setFromUnitVectors(up, this.tmpB);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    this.cuff.matrix.copy(this.dummy.matrix);
    this.cuff.matrixAutoUpdate = false;
  }

  dispose(): void {
    this.joints.geometry.dispose();
    this.bones.geometry.dispose();
    this.palm.geometry.dispose();
    this.cuff.geometry.dispose();
    this.material.dispose();
  }
}
