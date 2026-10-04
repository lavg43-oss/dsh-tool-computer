/**
 * Auditoria previa a publicar: comprueba lo que un repositorio publico no puede
 * permitirse. Devuelve un informe y sale con codigo 1 si encuentra algo grave.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] ?? '.'
const problems = []
const notes = []

/** Recorre el arbol y devuelve los archivos de texto relevantes. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(root)
const codeFiles = files.filter((file) => /\.(js|mjs|ps1|json|yml|yaml)$/.test(file))
const docFiles = files.filter((file) => /\.(md)$/.test(file))
// Este auditor nombra los patrones que busca, asi que se excluye de sus propias
// comprobaciones; y en los documentos el ejemplo con "tu-usuario" es legible a
// proposito, no una ruta real.
const audited = (file) => relative(root, file) !== join('scripts', 'audit-repo.mjs')
const allText = [...codeFiles, ...docFiles].filter(audited)

console.log(`archivos: ${files.length} (${codeFiles.length} de codigo, ${docFiles.length} de documentacion)\n`)

// 1) Rutas de la maquina del autor: no deben aparecer en lo que se publica. La
//    comprobacion no lleva ningun nombre de usuario dentro, porque este archivo
//    tambien se publica: busca el patron de ruta absoluta, y avisa aparte si
//    huele a carpeta de usuario de Windows.
const machinePaths = []
for (const file of allText) {
  const text = readFileSync(file, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    const isExampleInDoc = file.endsWith('.md') && /tu-usuario|tu_perfil|<usuario>/i.test(line)
    if (isExampleInDoc) continue
    const windowsUserPath = /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z][^\\\s"']*/.test(line)
    const unixUserPath = /\/home\/[a-z][^/\s"']*|\/Users\/[A-Za-z][^/\s"']*/.test(line)
    if (windowsUserPath || unixUserPath) {
      machinePaths.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 110)}`)
    }
  }
}
if (machinePaths.length > 0) problems.push(`rutas de la maquina del autor:\n    ${machinePaths.join('\n    ')}`)

// 2) Secretos evidentes.
const secretPatterns = [/sk-[A-Za-z0-9]{16,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/, /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{20,}/i]
const secrets = []
for (const file of allText) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of secretPatterns) {
    const found = pattern.exec(text)
    if (found) secrets.push(`${relative(root, file)}: ${found[0].slice(0, 24)}...`)
  }
}
if (secrets.length > 0) problems.push(`posibles secretos:\n    ${secrets.join('\n    ')}`)

// 3) Credenciales referenciadas por nombre (correcto) frente a valores (mal).
const credentialFiles = allText.filter((file) => /credential|password|token/i.test(readFileSync(file, 'utf8')) && !relative(root, file).endsWith('.md'))
if (credentialFiles.length > 0) notes.push(`mencionan credenciales (revisar que sean nombres, no valores): ${credentialFiles.map((f) => relative(root, f)).join(', ')}`)

// 4) Dependencias externas declaradas: el plugin debe poder instalarse sin red.
const pkg = JSON.parse(readFileSync(join(root, 'computer', 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})
if (deps.length > 0) notes.push(`package.json declara dependencias: ${deps.join(', ')} (el plugin promete cero)`)
else notes.push('package.json sin dependencias: coherente con la promesa de cero instalacion')

// 5) Importaciones de terceros en el codigo: solo se admiten builtins de Node.
const builtinPrefix = 'node:'
const thirdParty = []
for (const file of codeFiles.filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith(builtinPrefix)) continue
    thirdParty.push(`${relative(root, file)}: ${specifier}`)
  }
}
if (thirdParty.length > 0) problems.push(`importaciones fuera de Node y del propio plugin:\n    ${thirdParty.join('\n    ')}`)

// 6) Marcadores sin rellenar.
const placeholders = []
for (const file of allText) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/<[A-Z][A-Z ]{2,}>|TODO|FIXME|XXX/g)) {
    placeholders.push(`${relative(root, file)}: ${match[0]}`)
  }
}
if (placeholders.length > 0) notes.push(`marcadores pendientes:\n    ${placeholders.join('\n    ')}`)

// 7) Documentos que un repositorio publico espera.
for (const expected of ['README.md', 'LICENSE', 'NOTICE.md', 'SECURITY.md']) {
  if (!files.some((file) => relative(root, file) === expected)) problems.push(`falta ${expected}`)
}

// 8) Los ficheros de codigo deben ser sintacticamente validos (delegado a node --check).
notes.push(`archivos de codigo a verificar con node --check: ${codeFiles.filter((f) => f.endsWith('.js')).length}`)

console.log('PROBLEMAS:')
if (problems.length === 0) console.log('  ninguno')
for (const problem of problems) console.log(`  - ${problem}`)

console.log('\nNOTAS:')
for (const note of notes) console.log(`  - ${note}`)

process.exit(problems.length === 0 ? 0 : 1)
