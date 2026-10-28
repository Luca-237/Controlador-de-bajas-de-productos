/**
 * Corre UNA pasada de la revisión de páginas (web de Cindy + catálogo y tienda de Travel Blue) sobre
 * la base del .env (DB_PATH), sin WhatsApp ni Manager. Solo lectura. Sirve para probar en local.
 *   npm run revisar-sitios
 */
import 'dotenv/config'
import { abrirDb, listar } from '../src/db.js'
import { revisarSitios } from '../src/validador.js'
import { SITIOS } from '../src/sitios.js'

const db = abrirDb()
const n = await revisarSitios(db, { limite: 50 })
console.log(`Códigos revisados: ${n}`)
for (const f of listar(db, { filtro: 'todos' })) {
  if (!f.web) continue
  const marca = f.web_a_bajar ? 'PUBLICADO' : f.web_error ? 'ERROR    ' : 'no está  '
  const detalle = SITIOS.map((s) => `${s.nombre}: ${f.web[s.clave]?.estado ?? '—'}`).join(' | ')
  console.log(`${marca} ${f.codigo.padEnd(12)} ${detalle}`)
}
