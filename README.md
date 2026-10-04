# dsh-tool-computer

**Computer use para DeepSeek Harness**, en dos vías:

- `browser` — control de Chrome o Edge por el protocolo de depuración, **sin
  dependencias**. La vía rápida y determinista para cualquier tarea web.
- `computer` — control del escritorio de Windows: captura con visión real, clic,
  teclado y ventanas. Para lo que salga del navegador.

Escrito para resolver un caso concreto: que el agente pueda mirar y actuar, con la
imagen llegando al modelo de verdad, y sin pagar una inferencia visual por cada
clic.

## Por qué dos vías

El bucle clásico *pixel-to-action* cuesta caro: capturar la pantalla entera, mandar
la imagen al modelo, que estime coordenadas, mover el ratón, esperar, y repetir.
Son segundos por paso, y el clic queda aproximado.

Cuando la tarea vive en el navegador no hace falta adivinar nada: la página ya dice
qué elementos tiene, cómo se llaman y dónde están. Medido en un equipo real:

| Operación | Vía `browser` (CDP) | Bucle de píxeles |
| --- | --- | --- |
| Leer la página entera | **28 ms** | 0.5–1 s + inferencia visual |
| Hacer clic en un elemento | **139 ms** | 2–6 s (estimar coordenadas) |
| Leer un dato exacto | **9 ms** | inferencia visual |
| Escribir en un campo | **152 ms** | 2–6 s |
| Captura de la pestaña | **165 ms** | 0.5–1 s |
| Navegar | 2.9–3.3 s | 2.9–3.3 s (es la red) |

Y no es solo velocidad: un clic por referencia **no falla** por un píxel de
diferencia, ni por un cambio de resolución, ni porque aparezca una barra.

## Las tres vías, y por qué se eligen por tarea

El navegador no se conecta de una sola forma, porque el compartimento cambia
según lo que estés haciendo. La herramienta tiene tres vías y **el agente no las
adivina**: si una llamada no declara cuál usar, falla y pide preguntarte.

| Vía | Qué hace | Para qué |
| --- | --- | --- |
| `perfil-propio` | Chrome con un perfil nuevo y aislado; no toca tus pestañas ni sesiones | Trabajo normal. Hay que iniciar sesión en la plataforma una vez |
| `perfil-real` | Tu Chrome de siempre, con tus sesiones abiertas | Cuando ya estás dentro y no quieres volver a autenticarte. Exige cerrar Chrome antes |
| `sin-navegador` | No toca el navegador en absoluto | Banca, trámites personales, cualquier cosa que no quieras exponer |

La elección **no se hereda** entre tareas: cada llamada lleva su `mode`, y el
plugin cierra la conexión anterior si la vía cambia, para no reutilizar un
navegador abierto con otro perfil. Si le pides al agente algo con el navegador y
no sabe qué vía quieres, te lo pregunta con las tres opciones y sus consecuencias.

Si prefieres no responder cada vez, fija una vía en la configuración:

```yaml
config:
  browserMode: perfil-propio   # o perfil-real, o sin-navegador
```

Y para la vía del perfil real, si tu Chrome no está en la ruta por defecto:

```yaml
config:
  browserMode: perfil-real
  browserProfileDir: "C:\\Users\\tu-usuario\\AppData\\Local\\Chrome\\User Data"
```

## Herramienta `browser` (9 acciones)

| Acción | Qué hace |
| --- | --- |
| `snapshot` | Lee la página: elementos interactivos indexados (`e1`, `e2`…) con su texto, estado y foco, más el texto visible |
| `click` | Clic en un elemento por `ref` del snapshot o por selector CSS |
| `type` | Escribe en un campo, con opción de vaciarlo y de pulsar Enter |
| `press` | Pulsa una tecla, con modificadores |
| `navigate` | Va a una dirección y devuelve el snapshot |
| `evaluate` | Ejecuta JavaScript y devuelve el resultado: para leer datos exactos |
| `screenshot` | Captura la pestaña como imagen, cuando la vista importa |
| `wait` | Espera a que aparezca un texto o un selector |
| `tabs` | Lista las pestañas abiertas |

Todas llevan el parámetro `mode`. El flujo es: `snapshot` → leer las referencias →
`click`/`type` con ese `ref` → `snapshot` nuevo. El modelo nunca inventa un
selector ni una coordenada.

Se conecta a un navegador que ya tenga depuración remota, o lanza uno. Si un
puerto está ocupado por una instancia que no responde, prueba el siguiente en vez
de quedarse clavado, y si el perfil real está en uso lo dice al instante (y cómo
seguir) en lugar de esperar a un puerto que no va a llegar.

## Herramienta `computer` (16 acciones)

| Acción | Qué hace |
| --- | --- |
| `screenshot` | Captura la pantalla y devuelve **la imagen al modelo** |
| `click`, `double_click`, `right_click` | Clic en x,y |
| `move`, `drag` | Mover el cursor, arrastrar |
| `scroll` | Rueda del ratón |
| `type` | Escribe texto en la ventana con foco |
| `key`, `keys` | Una tecla, o una combinación (`["ctrl","shift","s"]`) |
| `cursor` | Dónde está el cursor y qué tiene el foco |
| `windows` | Enumera ventanas: título, proceso, PID, rectángulo, foco |
| `focus_window`, `close_window` | Traer al frente, pedir cerrar |
| `start_app` | Abrir una app de una lista cerrada |
| `wait` | Esperar a que la interfaz se asiente |

Las coordenadas se pueden dar en píxeles de pantalla (`space: "screen"`) o
**medidas en la captura que el modelo acaba de ver** (`space: "image"`, por
defecto): el plugin guarda el mapeo imagen→pantalla y traduce.

## Cómo llega la imagen al modelo

Es la parte que más cuesta acertar. El registro de herramientas de DSH valida el
valor que devuelve `execute` contra `output.schema`, y lo hace en serio: con
`additionalProperties: false`, meter el contenido dentro del valor lo invalida
entero (`INVALID_TOOL_OUTPUT`) y el modelo no recibe nada — ni texto ni imagen.

El camino correcto es `finalizeContent`: el valor sale limpio (`{ action, result }`),
se valida, y el contenido —bloques de texto e imagen— se adjunta después:

```js
const pendingContent = new WeakMap()

// en execute(): publica la captura y registra sus bloques
const reference = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name })
pendingContent.set(exec, [
  { type: 'text', text: 'captura frame 7: 1600x664 px ...' },
  { type: 'image', attachment: reference },
])
return { action, result }

// en la definición de la herramienta
finalizeContent(exec) {
  const content = pendingContent.get(exec)
  pendingContent.delete(exec)
  return content
}
```

El runtime adjunta esa imagen al contexto del modelo en el mismo turno, así que
la ve en el paso siguiente.

## Rendimiento del escritorio

Cada acción de `computer` cuesta lo que cuesta arrancar PowerShell… salvo que no
arranques uno por acción. Medido en un equipo con dos monitores a 5206x2160:

| | Por acción |
| --- | --- |
| Proceso nuevo por acción | 8.6 – 10.4 s |
| **Servidor persistente** (por defecto) | **12 ms** tras el arranque |

El runner tiene dos modos y comparte la misma lógica (`Invoke-Request`):

- **Servidor** (`-Server`): un PowerShell vivo por sesión, una petición JSON por
  línea, respuesta JSON por línea.
- **Proceso único**: el respaldo, y el modo cómodo para probar a mano.

El plugin arranca el servidor en segundo plano al montarse, lo cierra tras 10
minutos sin uso, lo cierra con el proceso de DSH, y **cae al modo de proceso único
si el servidor falla, se cae o no responde** en vez de romper la acción.

## Instalación

1. Copia esta carpeta a `$DSH_HOME/profiles/<perfil>/plugins/computer/`.
2. Añade la fila al parche del perfil
   (`$DSH_HOME/profiles/<perfil>/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: tool-computer
         name: ./plugins/computer/index.js
         config:
           maxWidth: 1600
           maxHeight: 1000
   ```

   `name` es relativo a la carpeta del perfil, porque el `baseUrl` del loader
   apunta ahí. Desde una capa `--patch` de otro sitio, usa una URL `file:///...`.

3. Reinicia DSH: el árbol de plugins se compone al arrancar.

El plugin **no necesita dependencias**: el `node_modules` de un perfil está vacío,
así que implementa a mano el `Config['~standard'].validate` que Cordis consume y
registra la herramienta con objetos planos. No importa nada de `@deepseek-ai/*`.

## Requisitos y límites

- **Windows.** Usa GDI para capturar y `SendInput`/`SetCursorPos` para la entrada.
- **El proceso que aloja el plugin debe poder tocar el escritorio.** En DSH, las
  llamadas de shell se confinan con un token restringido de baja integridad, y ese
  token **no puede** mover el cursor ni inyectar entrada (comprobado: dentro del
  sandbox `SetCursorPos` devuelve `False`). El plugin ejecuta el runner desde el
  proceso anfitrión, no a través del shell confinado. Esto es una decisión
  consciente y está en [SECURITY.md](SECURITY.md).
- **El modelo activo debe aceptar imágenes**, o `screenshot` se rechaza con un
  mensaje claro. Es el mismo requisito que la herramienta `read_image` de DSH.
- **Multi-monitor**: `screenshot` captura el escritorio virtual completo. La
  captura normaliza a un máximo de píxeles, y el mapeo de coordenadas se ajusta
  solo.
- **Capturar la pantalla captura todo lo que haya en ella.** Si lo que quieres
  supervisar está en una ventana, captura esa ventana y no el escritorio entero.

## Antes de publicar

El repositorio está listo para subirse tal cual. Dos detalles que quizá quieras
personalizar, ninguno obligatorio:

- **La licencia** dice `Copyright (c) 2026 dsh-tool-computer contributors`. Si
  prefieres tu nombre, cambia esa línea en [LICENSE](LICENSE).
- **El idioma.** El código, los comentarios y las descripciones de las acciones
  están en español, porque el proyecto nació para un uso concreto en español. Para
  una audiencia internacional conviene traducir las descripciones de las acciones
  —son texto, no lógica— y los comentarios.

Para comprobar que sigue todo en orden antes de publicar:

```sh
node scripts/audit-repo.mjs .
node scripts/browser-integration.mjs
```

El primero verifica que no haya rutas de una máquina concreta, secretos, ni
importaciones fuera de Node; el segundo lanza un navegador de verdad y prueba las
nueve acciones de `browser`, cerrando el navegador al terminar incluso si algo
falla.

## Otros proyectos

Si eres nuevo en computer use, mira primero la
[herramienta de Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool):
es la referencia de comportamiento y su diseño de acciones por despachador
(`action` + parámetros) es el que sigue esta herramienta. Aquí no hay código suyo
—no publica implementación— y tampoco se reproduce su documentación; ver
[NOTICE.md](NOTICE.md).

## Licencia

MIT. Ver [LICENSE](LICENSE).
