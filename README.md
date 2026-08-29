# 🏥 Simulador de Quirófano · Mesa del Instrumentista

Simulador web donde preparas la **mesa del instrumentista** con los utensilios
correctos según la operación. Interacción por **reconocimiento de manos con la
webcam** (MediaPipe) o **ratón/táctil** como alternativa. 100 % en el navegador,
desplegable en **GitHub Pages** (sin backend).

## Stack
- **three.js** — escena 3D (quirófano, mesa, bandeja, instrumentos).
- **@mediapipe/tasks-vision** — detección de manos y gesto de pinza en el navegador.
- **Vite + TypeScript** — build y tipos compartidos.
- **Vitest** — tests de la lógica de operaciones.

## Arquitectura (módulos desacoplados por `src/types/contracts.ts`)
| Módulo | Carpeta | Responsabilidad |
|---|---|---|
| Escena 3D | `src/scene/` | Render, mesa, bandeja, instrumentos, raycast (`ISceneApi`) |
| Entrada | `src/input/` | Manos (`HandTracker`) + ratón (`MouseAdapter`) → `Pointer[]` |
| Interacción | `src/interaction/` | `GrabController`: coger/arrastrar/soltar (pegamento) |
| Motor | `src/engine/` | Operaciones data-driven (JSON) + validación y nota |
| UI | `src/ui/` | HUD: menú, checklist, resultado, estado de cámara |

El puntero unificado (`Pointer`) hace que **manos y ratón alimenten la misma
lógica**. El catálogo es **data-driven**: añade operaciones/instrumentos en
`src/engine/catalog.json` sin tocar código.

## Desarrollo
```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests del motor
npm run build      # typecheck + build de producción
npm run preview    # sirve dist/
```

> La webcam requiere **HTTPS** (o `localhost`). Sin cámara/permiso, cae a ratón.

## Despliegue en GitHub Pages

Publicado en https://mikierxxv.github.io/operationroomsimulator/ desde
[`MikierXXV/operationroomsimulator`](https://github.com/MikierXXV/operationroomsimulator).

El workflow `.github/workflows/deploy.yml` construye y publica en cada push a `main`. Sólo hace falta
tener puesto **Settings → Pages → Source: GitHub Actions**.

> El `base` de Vite se ajusta a `/operationroomsimulator/` en CI, y **tiene que coincidir con el
> nombre del repositorio**: si no, el sitio sale en blanco porque el HTML pide los assets de una ruta
> que no existe. Si renombras el repo, actualiza `vite.config.ts`.

La webcam necesita HTTPS, que Pages ya da. Cada visitante tiene que conceder el permiso; si lo
deniega, el juego cae a ratón y sigue siendo jugable.

## Añadir modelos 3D reales
Ver `public/assets/instruments/README.md`. Mientras no haya GLB, se usan
placeholders automáticos.
