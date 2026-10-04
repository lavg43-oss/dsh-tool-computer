# Origen y atribuciones

## Codigo propio

`computer/index.js` y `computer/lib/computer.ps1` son codigo original escrito
para este proyecto. La implementacion —captura con GDI, inyeccion de entrada por
`SendInput`/`SetCursorPos`, enumeracion de ventanas por `EnumWindows`, el
protocolo JSON de linea, el servidor persistente y el cliente Node— no esta
copiada de ningun otro proyecto.

## Interoperabilidad con DeepSeek Harness

Este plugin se conecta a **DeepSeek Harness** (DSH). Sus paquetes
`@deepseek-ai/dsh-*` son software libre bajo licencia **MIT**,
`Copyright (c) 2026 DeepSeek`.

Para escribir un plugin que DSH cargue hubo que averiguar su contrato publico:
la forma del modulo (`{ name, Config, inject, apply }`), el formato de
`Config['~standard'].validate`, la forma de `ctx.tools.register`
(`parameters` en forma de autor y `output.schema` en JSON Schema crudo), el
patron `finalizeContent` para adjuntar contenido —imagen incluida— a un
resultado, y las referencias de adjunto (`attachmentId`, `mediaType`, `bytes`,
`width`, `height`).

Eso es **informacion de interfaz**: nombres y formas que cualquier plugin de DSH
necesita conocer, y que se leyeron del propio DSH instalado y de su
documentacion incluida. No se copio codigo de DSH en este repositorio.

Si en el futuro se incorporara codigo de DSH, esta bajo MIT y habria que
conservar su aviso de copyright; hoy no hay ninguno.

## Nada de Anthropic

No hay codigo de Anthropic en este repositorio, ni podria haberlo: su
herramienta de computer use es un servicio propietario y no publica
implementacion. La idea de "capturar pantalla e inyectar entrada para que un
modelo actue" es una tecnica general; la implementacion de aqui es propia, y
tampoco se reproduce texto de su documentacion.

## Referencias

- DeepSeek Harness — <https://github.com/deepseek-ai/deepseek-harness>
- Documentacion de computer use de Anthropic (solo como referencia de
  comportamiento, sin copia) —
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
