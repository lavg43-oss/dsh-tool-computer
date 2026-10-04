# Seguridad

Esta herramienta le da a un agente control real de tu escritorio. Eso es toda su
gracia y todo su riesgo. Lo que hay que saber antes de instalarla.

## Qué puede hacer

- **Ver la pantalla.** `screenshot` captura el escritorio virtual completo — todos
  los monitores — y entrega la imagen al modelo. Todo lo que esté visible entra:
  correo, mensajes, gestores de contraseñas abiertos, sesiones de banca.
- **Actuar sobre ella.** Mover el cursor, hacer clic, arrastrar, escribir, pulsar
  teclas y combinaciones, y abrir aplicaciones de una lista cerrada.
- **Leer y manipular ventanas.** Enumerarlas, traerlas al frente y pedirles que se
  cierren.

## Qué NO hace

- No toca el sistema de archivos, salvo escribir sus capturas en
  `%TEMP%\dsh-computer\` (conserva las 5 últimas). No lee archivos.
- No abre procesos arbitrarios: `start_app` solo acepta una lista cerrada
  (`notepad`, `calculator`, `paint`, `explorer`, `cmd`, `powershell`).
- No se ejecuta en segundo plano por su cuenta: responde a las llamadas del
  agente, y su servidor de PowerShell se cierra a los 10 minutos sin uso y con el
  proceso que lo aloja.

## La decisión que hay que entender

En DeepSeek Harness, las llamadas de shell se confinan con un token restringido de
baja integridad. Ese token **no puede** inyectar entrada en el escritorio: su
acceso a la ventana de entrada falla la comprobación de integridad. Comprobado en
un equipo real:

| | `SetCursorPos` |
| --- | --- |
| Proceso confinado | `False`, sin código de error |
| Proceso sin confinar | `True` |

Por eso este plugin ejecuta su runner **desde el proceso que aloja el plugin**, no
a través de la herramienta de shell confinada. Sin eso, la herramienta diría que
hace clic y no haría nada.

Es una decisión consciente con una consecuencia clara: **las acciones de entrada
no pasan por el sandbox de archivos**. No es una vía para escribir archivos
—el runner no lo hace—, pero conviene saberlo antes de instalarlo.

## Control humano

Por defecto no hay fricción. Para supervisar, declara qué acciones exigen
autorización explícita:

```yaml
config:
  requireApprovalFor: ["screenshot", "type", "key", "click"]
```

El plugin pide entonces permiso por el servicio de aprobación de DSH, el mismo que
usan las escalaciones de archivos, y sigue solo con `allowed-once`. El fallo es
cerrado: sin servicio de aprobación montado, la acción se rechaza con un mensaje
que dice exactamente cuál y por qué.

## Recomendaciones

- Empieza con `requireApprovalFor` puesto, y quítalo cuando confíes en el flujo.
- Trabaja sobre una ventana concreta, no sobre el escritorio entero: así lo que
  captura es lo que quieres mostrar.
- Cierra lo que no quieras que aparezca en una captura.
- Ten presente que un clic compite con tu ratón: si estás usando la máquina a la
  vez que el agente, los dos moveréis el cursor.

## Reportar

Si encuentras una forma de que esta herramienta haga algo que no está descrito
aquí, es un fallo y merece un informe.
