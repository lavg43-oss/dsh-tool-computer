/**
 * Imprime lo que se envia a la API por cada herramienta, para comprobarlo a ojo.
 * Uso: node scripts/inspect-wire-schema.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'computer', 'index.js')).href)

const registered = []
plugin.apply({
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  attachments: { saveImage: async () => ({}) },
  get: () => undefined,
  on: () => {},
}, {})

let bad = 0
for (const tool of registered) {
  const schema = tool.parameters
  const serialized = JSON.stringify(schema)
  const booleans = (serialized.match(/"required":true/g) ?? []).length
  if (booleans > 0) bad++
  console.log(`\n${tool.name}`)
  console.log(`  type: ${schema.type}`)
  console.log(`  additionalProperties: ${schema.additionalProperties}`)
  console.log(`  required (root): ${JSON.stringify(schema.required)}`)
  console.log(`  properties: ${Object.keys(schema.properties).length}`)
  console.log(`  booleanos "required":true que quedan: ${booleans}`)
  console.log(`  bytes del esquema: ${serialized.length}`)
  for (const [name, field] of Object.entries(schema.properties)) {
    const flags = []
    if (field.type === 'array') flags.push(`items=${JSON.stringify(field.items)}`)
    if (field.enum) flags.push(`enum(${field.enum.length})`)
    console.log(`    - ${name}: ${field.type}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`)
  }
}

console.log(bad === 0
  ? '\nOK: no queda ningun booleano donde el esquema espera un array.'
  : `\nFALLO: ${bad} herramienta(s) con booleanos "required" en el esquema.`)
process.exit(bad === 0 ? 0 : 1)
