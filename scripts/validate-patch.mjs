/**
 * Valida la ESTRUCTURA del patch del perfil sin depender de un parser YAML:
 * comprueba lo que el loader necesita (array top-level de entradas, la fila
 * insertada con su id/name/config, indentacion consistente y sin tabuladores).
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')
const lines = text.split(/\r?\n/)

const problems = []
const topLevelEntries = []
const inserts = []

if (text.includes('\t')) problems.push('el archivo contiene tabuladores (YAML no los admite en la indentacion)')

for (const [index, line] of lines.entries()) {
  const number = index + 1
  if (line.trim() === '' || line.trimStart().startsWith('#')) continue
  const indent = line.length - line.trimStart().length
  if (indent % 2 !== 0) problems.push(`linea ${number}: indentacion impar (${indent})`)
  if (indent === 0 && line.startsWith('- ')) topLevelEntries.push({ number, head: line.slice(2) })
  const insertMatch = /^\s*- insert:\s*$/.exec(line)
  if (insertMatch) inserts.push({ number, indent, rows: [] })
}

// Dentro de cada bloque `insert`, las filas deben ir un nivel mas adentro.
for (const block of inserts) {
  let current = null
  for (let index = block.number; index < lines.length; index++) {
    const line = lines[index]
    const number = index + 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= block.indent && line.startsWith('- ')) break
    const rowMatch = /^(\s*)- id:\s*(\S+)\s*$/.exec(line)
    if (rowMatch) {
      current = { id: rowMatch[2], number, indent: rowMatch[1].length, name: null, config: false }
      block.rows.push(current)
      continue
    }
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && current !== null && current.name === null) current.name = nameMatch[1].replace(/^["']|["']$/g, '')
    if (/^\s*config:\s*$/.test(line) && current !== null) current.config = true
    if (current === null) problems.push(`linea ${number}: contenido suelto dentro de insert (${JSON.stringify(line.trim())})`)
  }
}

const allRows = inserts.flatMap((block) => block.rows)
const mine = allRows.filter((row) => row.id === 'tool-computer')

console.log(`archivo: ${path}`)
console.log(`lineas: ${lines.length}`)
console.log(`entradas top-level: ${topLevelEntries.length}`)
console.log(`bloques insert: ${inserts.length}`)
console.log(`filas en bloques insert: ${allRows.length}`)
console.log('\nfilas insertadas:')
for (const row of allRows) console.log(`  linea ${row.number}: id=${row.id} name=${row.name ?? '(sin name)'} config=${row.config}`)

if (mine.length !== 1) problems.push(`esperaba exactamente una fila tool-computer, encontre ${mine.length}`)
else {
  const row = mine[0]
  const resolvable = /^file:\/\/\//.test(row.name) || /^\.{1,2}\//.test(row.name) || /^[A-Za-z]:[\\/]/.test(row.name)
  if (!resolvable) problems.push(`name no resoluble en la fila: ${row.name}`)
  if (!row.config) problems.push('la fila tool-computer no declara config')
}

// Cada entrada top-level debe ser un override con id o un bloque insert; nada mas.
for (const entry of topLevelEntries) {
  const isInsert = /^- insert:\s*$/.test(`- ${entry.head}`)
  const isOverride = /^- id:\s*\S+/.test(`- ${entry.head}`)
  if (!isInsert && !isOverride) problems.push(`linea ${entry.number}: entrada top-level inesperada (${JSON.stringify(entry.head)})`)
}
for (const block of inserts) {
  if (block.rows.length === 0) problems.push(`linea ${block.number}: bloque insert vacio`)
  for (const row of block.rows) {
    if (row.name === null) problems.push(`linea ${row.number}: la fila ${row.id} no declara name`)
  }
}

if (problems.length > 0) {
  console.log('\nPROBLEMAS:')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}
console.log('\nOK: estructura valida y la fila tool-computer esta bien formada.')
