import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Un `GLTFLoader` capaz de leer los modelos comprimidos.
 *
 * Los GLB del proyecto van con la geometría cuantizada y comprimida (`EXT_meshopt_compression`) y las
 * texturas en WebP (`EXT_texture_webp`). Entre las dos cosas, los assets pasaron de 43,6 MB a 5,3 MB,
 * que es la diferencia entre una primera carga interminable y una razonable.
 *
 * WebP lo entiende `GLTFLoader` sin ayuda, pero meshopt necesita este decodificador: **sin él los
 * modelos no cargan, no es que se vean peor**. Por eso todo el proyecto pide el cargador aquí en vez
 * de construirse el suyo: si alguien hace `new GLTFLoader()` por su cuenta, se le caerán los modelos.
 */
export function crearCargadorGltf(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
