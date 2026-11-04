# QA de Delamain — 2026-11-03

Instancia de desarrollo de VS Code iniciada con el repositorio abierto y la extensión compilada.
Codex y Claude están configurados, autenticados y abiertos en terminales separados.

## Resultados

| Comprobación | Resultado |
| --- | --- |
| `npm test` (verificación anterior) | 155 pruebas, 18 archivos: todas pasan |
| `npm run test:ui` (verificación anterior) | 17 pruebas Chromium: todas pasan |
| Regresiones de esta continuación | 16 pruebas en `git.test.ts`, `preset-install.test.ts` y `harness-service.test.ts`: todas pasan; cuatro son nuevas |
| `npm run typecheck` | Los cuatro paquetes pasan |
| `npm run build` | Webview, schemas y extensión compilados |
| Setup desde una carpeta vacía | Proveedores y favoritos generados correctamente |
| Repetir el setup existente | Sin cambios en el contenido del archivo |
| Configuración del proyecto | Sin errores de validación |
| Codex: consulta real mediante CliAdapter | `DELAMAIN_CODEX_OK`, sin errores |
| Claude: consulta real mediante CliAdapter | `DELAMAIN_CLAUDE_OK`, sin errores |
| Diálogos nativos de Windows | Exportar/importar YAML, cancelar ambos diálogos y rechazar un YAML inválido: correcto |
| Presets desde Git | Clonado real por URL `file://`; conservar, sobrescribir y cancelar: correcto tras corregir cancelación |
| `npm run package` desde un estado sin bundle webview | VSIX completo tras corregir el build previo; inspección de los 12 archivos del ZIP |
| Instalación del VSIX | Instalado y activado en un perfil aislado, sin `extensionDevelopmentPath` |
| `single-agent` con Codex y con Claude | Dos sesiones reales en VS Code: edición, tres tests, aprobación y conservación de la rama |
| Flujo `default` con Codex y Claude | Spec, worker, tests, QA, bugbot, comprobaciones finales y aprobación: `succeeded` |
| Diff después de conservar la rama | Correcto tras corregir el acceso al worktree eliminado |
| Descubrimiento local real | Jan responde con catálogo; inferencia del modelo local agotó el timeout de 45 s |

Las consultas de conexión originales fueron mínimas, sin herramientas ni modificaciones de archivos. Las
pruebas de interfaz usan el bundle real con un host de VS Code simulado; se complementaron
con navegación y comprobaciones en una instancia real de Extension Development Host.

En esta continuación se ejecutaron además las tareas reales de código descritas abajo. No se
repitieron las suites completas de Vitest/Chromium: se verificaron los paquetes afectados, los
tipos y el build requerido para el VSIX; no hubo cambios nuevos en la interfaz web.

## Cobertura

| Función | Evidencia |
| --- | --- |
| Proveedores | Alta, validación, eliminación, mensajes de guardado, health y claves; ambos CLI online en VS Code |
| Modelos | Catálogos, búsqueda, favoritos; catálogos reales de ambos CLI cargados en VS Code |
| Router | Reglas, condiciones, simulador, selección de Codex y cadena con Claude |
| Capas de configuración | Preset/global/proyecto, conservación de cambios sin guardar al recibir actualizaciones del host |
| Orquestaciones | Creación, edición, cancelación de ajustes, guardado y dry runs de los cuatro presets |
| Editor visual | Grafo del preset completo a 320, 640, 960 y 1280 px; diálogo a 420 × 440 px |
| Chat | Envío, parada, confirmación de comandos, resultado, conservación de rama y reanudación |
| Temas | Cuatro pestañas de configuración en temas claro/oscuro a 320, 640 y 1280 px |
| Motor | Bucles, dependencias, escalaciones, findings, límites y routing cubiertos por Vitest |
| Git y persistencia | Worktrees, merges/conflictos, sesiones, YAML y circuito completo con proveedor simulado en repositorios temporales |
| CLI en Windows | Wrappers `.cmd`, rutas con espacios, stdin, rechazo de argumentos multilínea y cancelación previa |
| Comandos | Salidas, códigos de retorno y timeout que termina procesos descendientes |

## Correcciones

- Los perfiles de credenciales ahora se distribuyen según el ancho disponible.
- Los mensajes largos de conexión, rutas y etiquetas dejan de ensanchar la página.
- Las pestañas, condiciones y controles se adaptan a paneles estrechos.
- La tabla de orquestaciones tiene desplazamiento horizontal dentro de su contenedor.
- Los ajustes de bloques mantienen sus acciones dentro de ventanas bajas, con desplazamiento
  del contenido, foco de teclado contenido en el diálogo y Escape para cancelar.
- Los botones de favoritos y ajustes tienen nombres accesibles.
- Los proveedores CLI ya no muestran un campo Base URL obligatorio que no utilizan.
- Codex instalado mediante npm puede ejecutarse desde el adaptador en Windows.
- Los prompts multilínea se envían por stdin; se rechaza pasarlos por argumentos en Windows.
- Los timeouts terminan también los procesos hijos, evitando comandos que continúan después
  de cerrar su consola.
- Las cuatro pruebas originales incompatibles con comandos/rutas Unix son portables a Windows.
- F5 abre el repositorio en la instancia de desarrollo; se añadieron tareas para los dos CLI.
- Cancelar la elección de sobrescritura al instalar un preset ya no copia archivos nuevos.
- El empaquetado reconstruye webview y extensión con `vscode:prepublish`; antes podía producir
  un VSIX aparentemente correcto sin `main.js` ni `main.css` desde un estado limpio.
- `Show diff` funciona después de `Keep on session branch`: consulta la rama conservada cuando
  su worktree ya se eliminó. Se comprobó también en la extensión instalada desde el VSIX.

## Verificaciones reales de esta continuación

Se conservaron la instancia de desarrollo y los terminales originales. Las pruebas usaron otro
perfil de VS Code y repositorios independientes bajo `.qa/continuation/`. Los hashes SHA-256 de
`.harness/config.yml` y `.vscode/tasks.json` coinciden con los del inicio. No se hicieron commits
en Delamain; los commits de fixtures y sesiones pertenecen exclusivamente a los repositorios de QA.

La exportación y la importación usaron los botones de la extensión y los diálogos nativos de
Windows, controlados mediante UI Automation/Win32. Se comparó el YAML exportado con el importado:
los datos son idénticos. Un archivo con `providers: not-an-array` produjo el error visible y no
modificó la configuración. Cancelar no escribió archivos. Los presets se clonaron con Git real
desde un repositorio `file://`; la interfaz real probó cancelar, conservar y sobrescribir. Las
tres pruebas nuevas de Vitest utilizan Git real con las respuestas de los diálogos simuladas.

Las dos sesiones `single-agent` partieron de un fixture con `sum(a,b)` implementado como resta.
Codex y Claude, por separado, cambiaron solo `sum.cjs`, conservaron los tests existentes y pasaron
las tres pruebas de suma positiva, negativa y con cero. Las confirmaciones de comando, aprobación
y conservación de rama se recorrieron en la interfaz real. `main` mantuvo la implementación
inicial; cada resultado quedó en su rama `harness/...`.

El flujo `default` se ejecutó con `FlowEngine`, adaptadores CLI, comandos y worktrees reales:
Codex hizo el spec y el cambio; Claude verificó los criterios y revisó el diff; Codex emitió el
veredicto final. El runner de QA respondió automáticamente las confirmaciones y la aprobación
tras comprobar el diff. Esas respuestas humanas están simuladas; los proveedores y la ejecución
de código no. La configuración temporal fijó el routing de worker a Codex y QA/reviewer a Claude.
Resultado: una tarea aprobada, tests y sintaxis correctos, rama `harness/real-default`, sin cambios
en `main` y diff accesible después de retirar los worktrees.

La primera ejecución completa se detuvo porque Claude en `acceptEdits` no tenía permiso para
ejecutar `node --test` de forma no interactiva. La repetición correcta añadió únicamente en el
fixture `--allowedTools "Bash(node --test)" "PowerShell(node --test)"` y `--strict-mcp-config`.
La sesión de Claude desde VS Code usó el mismo permiso limitado. No se cambiaron permisos
globales ni el comando original de Claude. La aprobación de Harness no concede permisos al CLI;
véase [la documentación de ejecución no interactiva de Claude](https://code.claude.com/docs/en/headless#auto-approve-tools).

## Setup

La configuración está en `.harness/config.yml`. No contiene credenciales. El setup preserva
proveedores, modelos y preferencias existentes. El comando de Claude incluye la ruta nativa
detectada en esta máquina. Los modelos concretos se eligen según la configuración de cada CLI.

El flujo inicial es `single-agent`, con aprobación `review`. Los comandos de verificación son
`npm test` y `npm run typecheck`. Se conservó el cambio previo del usuario en la tarea de build.

## Límites y avisos restantes

- `local-only` no puede ejecutarse con estos dos proveedores cloud: requiere un servidor local
  como Ollama, Jan o LM Studio. Sus cuatro avisos son correctos; no se marcó a los CLI como
  modelos locales para ocultarlos. En esta continuación Jan respondió en `127.0.0.1:1337`:
  el catálogo mezcla modelos `owned_by: llama.cpp` y `owned_by: remote`. Se seleccionó solo
  `Jan-v3.5-4B-Q4_K_XL` (`llama.cpp`) para una consulta mínima mediante el adaptador real, pero
  agotó 45 s sin respuesta. Por ello no se verificó una ejecución completa de `local-only` ni se
  añadió Jan a la configuración. Un catálogo accesible no prueba que la inferencia esté lista,
  y alojar un proxy en localhost no convierte sus modelos remotos en locales.
- El preset `default` conserva un aviso de hasta 36 ejecuciones de worker por tarea y modelo,
  por encima del umbral 20. `single-agent` y `review-only` no tienen problemas en el dry run.
- Las API de Anthropic/OpenAI/OpenRouter/DeepSeek tienen pruebas con respuestas simuladas.
  El descubrimiento cuenta con esas pruebas y con la consulta real al catálogo de Jan indicada
  arriba. No se verificaron todas las cuentas ni todos los servidores reales.
- Las credenciales/transporte HTTPS o SSH de presets remotos no se probaron: se utilizó una URL
  Git local real. Los temas de terceros siguen fuera de cobertura.
- El proyecto usa la licencia PolyForm Small Business 1.0.0; `LICENSE` se incluye en la raíz y
  en `packages/extension/`. El VSIX se instaló localmente; no se publicó en Marketplace.
- Los CLI no reportan uso/coste mediante el adaptador actual: `0 tok / $0.00` significa ausencia
  de métricas, no ejecución gratuita. En `single-agent`, el resumen muestra `0 task(s)` porque
  cuenta las tareas de un spec explícito, aunque el cambio y los tests sí se completaron.
- Las sesiones de trabajo parten de `HEAD`: los cambios aún sin commit no aparecen en los
  nuevos worktrees. Este trabajo quedó sin commit.

Capturas locales: `.qa/providers-final.png`, `.qa/editor-final.png`, `.qa/chat-final.png` y
`.qa/setup-final.png`. Informe navegable de Chromium: `playwright-report/index.html`.

Evidencias adicionales: `.qa/continuation/summary.json`, `vsix-contents.json`, `exported.yml`,
`import-success.png`, `preset-cancel.png`, `preset-overwrite.png`, `session-approve.png` y
`full-flow-permitted/result.json`, `full-flow-permitted/delivery.diff`. El log del flujo completo
está en `.qa/continuation/full-flow-permitted.log`; el intento detenido está en `full-flow.log`.
El catálogo y la consulta local están en `jan-models.json` y `local-smoke.json` de esa carpeta.
Los scripts de `.qa/` incluyen automatización que abre diálogos o ejecuta proveedores: deben
inspeccionarse antes de ejecutarlos; no constituyen una suite que se pueda lanzar en bloque.

Para repetir las comprobaciones: `npm test`, `npm run typecheck`, `npm run build` y
`npm run test:ui`. Las pruebas de procesos y compilación se verificaron fuera del sandbox
restringido de Windows, que impedía consultar el perfil de usuario y terminar procesos hijos.
