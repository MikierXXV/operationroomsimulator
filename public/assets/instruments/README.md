# Modelos 3D de instrumentos (GLB)

Coloca aquí los ficheros `.glb` de los instrumentos y referéncialos desde
`src/engine/catalog.json` con el campo `glb`, por ejemplo:

```json
{ "id": "scalpel-3", "name": "Mango de bisturí nº3", "category": "corte", "glb": "assets/instruments/scalpel-3.glb" }
```

- La ruta es relativa a `/public` (sin barra inicial).
- Si `glb` falta o el modelo no carga, se usa automáticamente un modelo
  **procedural** según la `category`. Así el simulador es funcional desde el primer día.
- El `InstrumentFactory` tumba, escala y asienta el modelo automáticamente, y refuerza los reflejos
  PBR, así que no necesitas normalizarlo a mano. La escala de referencia es la **longitud del modelo
  procedural al que sustituye** (así la hoja de bisturí sigue siendo pequeña y la sierra grande);
  puedes forzarla con `glbLength` en metros. Además se limita la altura a 6 cm para que una pieza no
  tape la fila de atrás.
- Si la heurística lo tumba mal (pasa en piezas casi cúbicas), impón la orientación con
  `glbRotation: [x, y, z]` en radianes.

## Sets: varios instrumentos en un mismo fichero

Buena parte del instrumental libre se publica en **sets**: siete u ocho piezas alineadas dentro de
una única malla. No hace falta abrirlos en Blender — `scene/glbParts.ts` los separa solo. Basta con
que varios instrumentos compartan `glb` y cada uno indique su `glbPart` (índice desde 0, **en el
orden en que las piezas están alineadas en el fichero**):

```json
{ "id": "mayo-scissors", "glb": "assets/instruments/surgical_instrument.glb", "glbPart": 0 },
{ "id": "scalpel-3",    "glb": "assets/instruments/surgical_instrument.glb", "glbPart": 2 }
```

El fichero se descarga y se trocea **una sola vez**, aunque lo usen cinco instrumentos. Si el índice
no existe, se avisa por consola y esa pieza se queda con su modelo procedural.

Para averiguar qué número tiene cada pieza, carga el set y mira el orden de izquierda a derecha; si
te equivocas se nota al instante en la mesa.

## Atribución (obligatoria para CC-BY)

Añade el campo `credit`; aparecerá automáticamente en el panel **"Créditos de modelos"**:

```json
{
  "id": "bone-saw", "name": "Sierra ósea", "category": "traumatologia",
  "glb": "assets/instruments/bone-saw.glb",
  "credit": { "author": "normal|studio", "license": "CC BY 4.0",
              "url": "https://sketchfab.com/3d-models/surgical-saw-14fc8a0f46144779bb038e881e072f47" }
}
```

## Modelos CC BY 4.0 verificados (descargables en Sketchfab)

Descarga (cuenta gratuita) con **"Download 3D model" → glTF/GLB**, guarda el `.glb` aquí y
añade `glb` + `credit` en el catálogo:

| id sugerido | Modelo · autor | Enlace |
|---|---|---|
| **set de 7 piezas (en uso)** · da `mayo-scissors` (0), `mosquito-forceps` (1), `scalpel-3` (2), `metzenbaum-scissors` (3) y `adson-forceps` (6); las piezas 4 (tijera curva de vendaje) y 5 (pinza de disección larga) siguen **libres** | SURGICAL INSTRUMENT · ferofluid | https://sketchfab.com/3d-models/surgical-instrument-2971a44d334b45ff926792e92a6bcee7 |
| set / decorado | Surgical instruments · Wenschel | https://sketchfab.com/3d-models/surgical-instruments-bd0ad0180f5148f1b3b331b8ebe6e494 |
| bandeja decorado | VR Surgical Tool Set · vaulted.dev | https://sketchfab.com/3d-models/vr-surgical-tool-set-c61f5a8aa3c14ec192428de4b1ad9c42 |
| `kelly-forceps` | Medical Forceps · Fhay.Alonso | https://sketchfab.com/3d-models/medical-forceps-46e4d6704bcb42d0a0ea907275e3c780 |
| `bone-saw` | Surgical Saw · normal\|studio | https://sketchfab.com/3d-models/surgical-saw-14fc8a0f46144779bb038e881e072f47 |
| `retractor-farabeuf` | Coupland Elevator · SDEO | https://sketchfab.com/3d-models/coupland-elevator-4578b63ca7bb445fa2f93919a58f7856 |

Buscar más (filtro descargable + CC BY/CC0 ya aplicado):
https://sketchfab.com/search?q=surgical+instrument&type=models&downloadable=true&licenses=322a749bcfa841b29dff1e8a1bb74b0b&licenses=7c23a1ba438d4306920229c12afcb5f9

## Los 10 instrumentos que siguen sin GLB

Con `glbPart`, **bajar un set rinde mucho más que buscar pieza a pieza**. Por orden de utilidad:

| Fuente | Licencia | Qué cubre de lo que falta |
|---|---|---|
| ~~[Surgical instruments · Wenschel](https://sketchfab.com/3d-models/surgical-instruments-bd0ad0180f5148f1b3b331b8ebe6e494)~~ | CC BY ✔ | **Ya descargado y exprimido: rindió UN instrumento.** Ver abajo |
| [Surgical_needle Holder · Mmmighty_Atom](https://sketchfab.com/3d-models/surgical-needle-holder-24864e4443df42f5b1439eea4631f136) | CC BY (confírmala en la página) | `needle-holder` suelto y específico |
| [Retractor V1 · Judith Solomon](https://sketchfab.com/3d-models/retractor-v1-39b64baa59fd4acfb8adf68fec0186de) | sin verificar | `retractor-deaver` (hecho para simulación de cesárea) |
| [Surgical instruments · KaDmiy](https://sketchfab.com/3d-models/surgical-instruments-ee7e2d11e3424227b2fbaa5f4df06299) | sin verificar | Otro set: fórceps, lanceta, tijera, sierra, gancho |
| [Surgical Instruments collection · Digital Surgery](https://sketchfab.com/3d-models/surgical-instruments-collection-46f5799ca36240efae3abec6e61d4c8a) | **CC BY-NC** ⚠ | Tijera, bisturí, clamps, separador y batea. **No comercial**: sirve para docencia, no si algún día se monetiza. Además son 614 k triángulos, hay que decimarlo |

Etiquetas para rebuscar: [forceps](https://sketchfab.com/tags/forceps) · [clamp](https://sketchfab.com/tags/clamp) ·
[surgicalinstrument](https://sketchfab.com/tags/surgicalinstrument) · [surgery](https://sketchfab.com/tags/surgery)

**Tres no existen como modelo libre** por más que se busque: `suction-yankauer`, `towel-clamp`
(Backhaus) y `electrocautery`. Son demasiado específicos. Para ellos, o se deja el procedural —que
para el aspirador y el electrobisturí ya se distingue bastante— o se genera uno con imagen→3D.

## Qué salió del set de Wenschel (y por qué tan poco)

El fichero original pesa **57 MB y 1,2 M de triángulos**, y su contenido real no es el que sugiere la
descripción: los «bisturíes» son **elevadores de periostio** (instrumental dental, no un mango
Bard-Parker), y ellos solos y las dos bateas se llevan **1,15 M de esos 1,2 M de triángulos**.
Lo demás son pinzas hemostáticas repetidas en rejilla, agujas de sutura curvas y dos ganchos finos.

Piezas extraídas a ficheros propios, con el material sustituido por acero liso (el original traía
atlas de 1024² innecesarios para una pieza cromada):

| Fichero | KB | Uso |
|---|---|---|
| `wenschel_hemostat.glb` | 105 | **`needle-holder`** — en uso |
| `wenschel_scissors.glb` | 79 | de reserva; ya hay tijeras mejores del otro set |
| `wenschel_suture_needle.glb` | 50 | de reserva. **No se usa a propósito**: las dos suturas se distinguen hoy por el color del hilo (seda negra, Vicryl violeta) y ponerles a ambas la misma aguja de acero las volvería idénticas |

El original **no está en `public/`**: se movió a `assets-originales/` en la raíz del proyecto. Vite
copia `public/` tal cual al build, así que dejarlo ahí habría metido 57 MB en cada despliegue para
usar 105 KB. No hace falta para nada más; si se borra, no se rompe nada.

## Compresión de los GLB

Los modelos del repositorio están comprimidos: **43,6 MB → 7,0 MB**. Eso llevó el despliegue de
GitHub Pages de 79,5 MB a 10,6 MB, que es la diferencia entre una primera visita interminable y una
razonable. Se hace con [glTF-Transform](https://gltf-transform.dev) v3 (la v4 pide un Node más
nuevo), y **el orden importa**:

```sh
npx @gltf-transform/cli@3 webp    entrada.glb  paso1.glb   # texturas a WebP
npx @gltf-transform/cli@3 meshopt paso1.glb    salida.glb  # geometría cuantizada + comprimida
```

Al revés no sirve: `webp` descomprime el meshopt que ya hubiera y el fichero acaba **más grande** que
antes de pasar por él.

Para que carguen hace falta el decodificador de meshopt, y por eso todo el proyecto pide el cargador
a `scene/gltf.ts` en lugar de hacerse un `new GLTFLoader()`. Sin él **los modelos no cargan**, no es
que se vean peor.

### `surgical_instrument.glb` va SIN comprimir, y tiene que seguir así

Comprimirlo lo deja en 187 KB, pero **rompe tres instrumentos**: salen como esquirlas puntiagudas en
vez de piezas alargadas. No es falta de precisión —probado con `--quantize-position 16` y
`--quantization-volume scene`, sale igual de roto—: es que ese fichero no es un instrumento sino un
**set**, y `glbParts.ts` lo trocea por los huecos entre piezas. La compresión reordena y suelda la
malla, y el troceo deja de encontrar los huecos donde estaban.

Cuesta 1,6 MB de los 7. Si algún día se quiere recuperar, hay que trocear el set en ficheros
separados **antes** de comprimir, no ajustar parámetros.

Los cuatro modelos de menos de 1 MB tampoco se comprimen: juntos suman 0,3 MB y no cambian nada.

## Otras fuentes
- **Poly Pizza** (https://poly.pizza) — modelos CC0 listos en GLB.
- Generación por IA (imagen → 3D) exportando a GLB.
