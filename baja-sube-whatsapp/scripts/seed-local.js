/**
 * Prepara un entorno local de prueba del panel, sin WhatsApp ni Manager:
 *  - base aparte (DB_PATH, por defecto ./data/bajas-local.db) con códigos falsos en todos los estados;
 *  - si el .env no tiene PANEL_PASSWORD_HASH, genera una clave al azar, guarda SOLO el hash en .env
 *    y la clave en clave-panel-local.txt (gitignorado). Nunca se imprime.
 *   npm run seed-local
 */
import 'dotenv/config'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { abrirDb, registrarReporte, aplicarValidacion, marcarErrorConsulta } from '../src/db.js'
import { hashearClave } from '../src/panel/auth.js'
import { borrarConfigGrupo, guardarGruposDisponibles } from '../src/config.js'

const RUTA_DB = process.env.DB_PATH || './data/bajas-local.db'
const ENV = path.resolve(process.cwd(), '.env')

if (!process.env.PANEL_PASSWORD_HASH) {
  const clave = crypto.randomBytes(12).toString('base64url')
  const actual = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : ''
  fs.writeFileSync(ENV, actual.replace(/\n?$/, '\n') + `PANEL_PASSWORD_HASH=${hashearClave(clave)}\nDB_PATH=${RUTA_DB}\n`, { mode: 0o600 })
  fs.writeFileSync('clave-panel-local.txt', clave + '\n', { mode: 0o600 })
  console.log('Clave local generada: está en clave-panel-local.txt (hash en .env).')
}

// Se vacían las tablas en vez de borrar el archivo: en Windows el panel corriendo lo tiene abierto.
const db = abrirDb(RUTA_DB)
db.exec('DELETE FROM reportes; DELETE FROM codigos; DELETE FROM historial; DELETE FROM meta;')
const hace = (min) => new Date(Date.now() - min * 60_000).toISOString()

// [codigo, quién lo mandó, hace cuántos minutos, resultado de Manager simulado]
const CASOS = [
  ['TEST1001', 'Prueba A', 50, { estado: 'pendiente', aBajar: ['TEST1001'], articulo: { id: 1, descripcion: 'MOCHILA PRUEBA', sube: 1 } }],
  ['TEST1002', 'Prueba B', 40, {
    estado: 'pendiente', aBajar: ['TEST1002-AZ', 'TEST1002-RO'],
    articulo: { id: 2, descripcion: 'VALIJA PRUEBA', sube: 0 },
    variantes: [{ codigo: 'TEST1002-AZ', sube: 1 }, { codigo: 'TEST1002-RO', sube: 1 }],
  }],
  ['TEST1003', 'Prueba A', 30, { estado: 'procesado', aBajar: [], articulo: { id: 3, descripcion: 'BILLETERA PRUEBA', sube: 0 } }],
  ['TEST1004', 'Prueba C', 20, { estado: 'no_existe', aBajar: [] }],
  ['TEST1005', 'Prueba B', 10, null], // queda por validar con error de consulta
  ['TEST1006', 'Prueba C', 5, undefined], // queda por validar, sin intentos todavía
  // Códigos reales de Travel Blue (para probar `npm run revisar-tb` contra los sitios reales, solo lectura).
  // Sin resultado de Manager simulado: quedan "por validar", como cuando Manager está caído.
  ['8216', 'Prueba A', 4, undefined],
  ['8125', 'Prueba B', 3, undefined],
  ['8988-BLU', 'Prueba C', 2, undefined],
  ['3264106', 'Prueba A', 1, undefined], // código de Cindy que ya no está en ninguna página
  // Códigos reales de la web de Cindy: uno exacto y un padre que sigue publicado por sus variantes.
  ['1C63-SUE', 'Prueba B', 0.5, undefined],
  ['3M201', 'Prueba C', 0.2, undefined],
]

for (const [codigo, de, min, res] of CASOS) {
  registrarReporte(db, { msg_id: `local-${codigo}`, codigo, de, ts: hace(min) })
  if (res) aplicarValidacion(db, codigo, res)
  else if (res === null) marcarErrorConsulta(db, codigo, 'Simulado: Manager respondió HTTP 408')
}
console.log(`Base de prueba lista en ${RUTA_DB} con ${CASOS.length} códigos de prueba.`)

// Simula lo que escribe el listener al conectarse, para ver la sección Configuración sin WhatsApp.
// Número y grupos inventados (ejemplos), nunca datos reales.
borrarConfigGrupo(db)
guardarGruposDisponibles(db, [
  { id: '120363025246125486@g.us', subject: 'Código que no hay más', participants: Array(14).fill({}) },
  { id: '120363011112222333@g.us', subject: 'Depósito Central', participants: Array(9).fill({}) },
  { id: '5493534123456-1609459200@g.us', subject: 'Armadores Villa María', participants: Array(6).fill({}) },
])
const LOG_DIR = path.resolve(process.env.LOG_DIR || './logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
fs.writeFileSync(
  path.join(LOG_DIR, 'estado.json'),
  JSON.stringify({
    conectado: true, desde: hace(90), latido: new Date().toISOString(), numero: '5493534123456', nombreLinea: 'Prueba local',
    grupoJid: '120363025246125486@g.us', grupoNombre: 'Código que no hay más', ultimoMensajeGrupo: hace(1), noDescifradosGrupo: 0,
  }, null, 2)
)
console.log('estado.json de prueba escrito (el latido vence en 2,5 min: volvé a correr el seed para verlo "conectado").')
