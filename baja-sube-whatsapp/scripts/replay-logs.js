/**
 * Carga en la base el historial de logs/shadow-*.jsonl (lo que el listener ya registró en la fase 1).
 * Idempotente: se puede correr varias veces, no duplica reportes.
 *   node scripts/replay-logs.js [carpeta-de-logs]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { abrirDb, conteos } from '../src/db.js'
import { ingestarEntrada } from '../src/ingesta.js'

const dir = path.resolve(process.cwd(), process.argv[2] || process.env.LOG_DIR || './logs')
const db = abrirDb()
const archivos = fs.readdirSync(dir).filter((f) => /^shadow-.*\.jsonl$/.test(f)).sort()
let lineas = 0
for (const f of archivos) {
  for (const linea of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!linea.trim()) continue
    ingestarEntrada(db, JSON.parse(linea))
    lineas++
  }
}
console.log(`Replay: ${lineas} entradas de ${archivos.length} archivo(s). Estado:`, conteos(db))
