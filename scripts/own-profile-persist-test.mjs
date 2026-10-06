/**
 * Prueba de integracion de `ownProfileDir` contra Chrome de verdad.
 *
 * La promesa tiene dos mitades y aqui se comprueban las dos: con `ownProfileDir`
 * el navegador aislado usa ese directorio y **lo conserva** al cerrarse, que es lo
 * que hace que un login sobreviva entre tareas; sin el, sigue usando un perfil
 * temporal que se borra al cerrar, que es el comportamiento de siempre.
 *
 * Uso: node scripts/own-profile-persist-test.mjs   (desde la raiz del repositorio)
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

/**
 * Levanta el plugin con una configuracion y devuelve la herramienta registrada.
 * @param config - configuracion del plugin.
 * @returns la herramienta `browser` y los disposers de limpieza.
 */
function start(config) {
  const registered = []
  const disposers = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    attachments: { saveImage: async () => ({ attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'a' }) },
    get: () => undefined,
    on: (event, handler) => { if (event === 'dispose') disposers.push(handler) },
  }
  plugin.apply(ctx, config)
  const tool = registered.find((entry) => entry.name === 'browser')
  if (tool === undefined) throw new Error('la herramienta browser no se registro')
  return { tool, disposers }
}

const exec = {
  agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } },
  signal: new AbortController().signal,
  callId: 'own-profile-persist',
}

/**
 * Decide si un directorio ya parece un perfil de Chrome usado.
 * @param dir - ruta a revisar.
 * @returns si contiene los marcadores que Chrome escribe al arrancar.
 */
function looksLikeProfile(dir) {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir)
  return entries.includes('Local State') || entries.includes('Default')
}

/** @returns los nombres de perfiles temporales que el plugin deja en %TEMP%. */
function tempProfiles() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-cdp-'))
}

/**
 * Espera, para dar tiempo a que el sistema libere procesos y directorios.
 * @param ms - milisegundos a esperar.
 */
async function settle(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

let failures = 0
/**
 * Registra el resultado de una comprobacion.
 * @param label - que se comprobo.
 * @param ok - si paso.
 * @param detail - dato util cuando falla.
 */
function check(label, ok, detail) {
  const suffix = detail === undefined ? '' : ` -- ${detail}`
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${label}${suffix}`)
  if (!ok) failures++
}

// --- 0. la configuracion que va a llevar el perfil se acepta ----------------
console.log('--- 0. validacion de la configuracion ---')
const accepted = plugin.Config['~standard'].validate({
  browserMode: 'perfil-propio',
  ownProfileDir: 'C:\\Users\\LAVG\\.dsh\\profiles\\desktop\\chrome-agent',
  browserPorts: [9222],
  browserExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  maxElements: 80,
  maxTextChars: 4000,
})
check('la configuracion nueva se acepta', accepted.issues === undefined, JSON.stringify(accepted.issues ?? []))
const refused = plugin.Config['~standard'].validate({ browserMode: 'perfil-propio', ownProfileDir: 42, browserPorts: 'x' })
check('una configuracion invalida se rechaza', Array.isArray(refused.issues) && refused.issues.length > 0, JSON.stringify(refused.issues ?? []))

// --- 1. con ownProfileDir: el perfil se usa y se conserva al cerrar ---------
console.log('\n--- 1. ownProfileDir configurado ---')
const holder = mkdtempSync(join(tmpdir(), 'dsh-own-'))
const persistent = join(holder, 'agent-profile')
const tempsBefore = tempProfiles().length
const first = start({ browserMode: 'perfil-propio', ownProfileDir: persistent, browserPorts: [9334] })
const navigated = await first.tool.execute({ action: 'navigate', url: 'https://example.com' }, exec)
check('navega con el perfil propio persistente', navigated.result.ok === true, navigated.result.title)
check('Chrome uso el directorio indicado', looksLikeProfile(persistent), persistent)
for (const disposer of first.disposers) disposer()
await settle(4000)
check('el perfil SOBREVIVE al cierre (el login se conserva)', existsSync(persistent))
check('no dejo perfiles temporales de mas', tempProfiles().length === tempsBefore, `antes ${tempsBefore}, ahora ${tempProfiles().length}`)

// --- 2. sin ownProfileDir: temporal, y se borra al cerrar ------------------
console.log('\n--- 2. sin ownProfileDir (comportamiento de siempre) ---')
const seenBefore = new Set(tempProfiles())
const second = start({ browserMode: 'perfil-propio', browserPorts: [9335] })
const navigatedTemp = await second.tool.execute({ action: 'navigate', url: 'https://example.com' }, exec)
check('navega con perfil temporal', navigatedTemp.result.ok === true, navigatedTemp.result.title)
const created = tempProfiles().filter((name) => !seenBefore.has(name))
check('creo un perfil temporal dsh-cdp-*', created.length === 1, created.join(', ') || 'ninguno')
for (const disposer of second.disposers) disposer()
await settle(6000)
const leftover = created.filter((name) => existsSync(join(tmpdir(), name)))
check('el perfil temporal se borro al cerrar', leftover.length === 0, leftover.join(', ') || 'ninguno')

// --- 3. el mismo directorio se reutiliza en una pasada nueva ---------------
// Es el caso real: DSH se reinicia y vuelve a abrir el perfil del agente. Si al
// cerrarse quedara un `lockfile` obsoleto, el guard lo tomaria por "en uso" y el
// perfil quedaria inservible despues del primer uso.
console.log('\n--- 3. reutilizacion del mismo directorio ---')
const lockLeft = existsSync(join(persistent, 'lockfile'))
const singletonLeft = existsSync(join(persistent, 'SingletonLock'))
console.log(`     marcas tras cerrar: lockfile=${lockLeft} SingletonLock=${singletonLeft}`)
const third = start({ browserMode: 'perfil-propio', ownProfileDir: persistent, browserPorts: [9336] })
try {
  const again = await third.tool.execute({ action: 'navigate', url: 'https://example.com' }, exec)
  check('reutiliza el perfil persistente en una pasada nueva', again.result.ok === true, again.result.title)
} catch (error) {
  check('reutiliza el perfil persistente en una pasada nueva', false, error.message.slice(0, 160))
}
for (const disposer of third.disposers) disposer()
await settle(4000)

// Limpieza del directorio de prueba, que es un mkdtemp propio.
rmSync(holder, { recursive: true, force: true })
check('el directorio de prueba se limpio', existsSync(holder) === false)

console.log(failures === 0
  ? '\ntodo bien: ownProfileDir persiste y el modo por defecto sigue siendo desechable'
  : `\n${failures} comprobaciones fallaron`)
process.exit(failures === 0 ? 0 : 1)
