/**
 * Panel web de bajas. Proceso aparte del listener (si el panel falla, el bot sigue escuchando).
 * Lee/escribe la base SQLite local; NUNCA toca Manager ni WhatsApp. La única salida a internet es
 * "Consultar un código": busca ese código en las páginas (solo lectura, igual que el bot).
 * Escucha únicamente en 127.0.0.1: se expone al exterior (si se decide) a través de nginx con HTTPS.
 */
import 'dotenv/config'
import express from 'express'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  abrirDb, listar, codigosABajar, codigosPublicados, pedirRevisionSitios, conteos, descartar, getMeta, listarHistorial, resumenHistorial,
  registrarReporte, guardarSitios,
} from '../db.js'
import { SITIOS, consultarSitios } from '../sitios.js'
import { CODIGO_SEGURO } from '../logica.js'
import { leerConfigGrupo, guardarConfigGrupo, borrarConfigGrupo, leerGruposDisponibles, leerQr } from '../config.js'
import {
  verificarClave, crearSesion, sesionValida, leerCookie, ponerCookie, borrarCookie,
  limitarIntentos, reiniciarIntentos, exigirSesion,
} from './auth.js'

const PUERTO = Number(process.env.PANEL_PORT || 3010)
const HASH = process.env.PANEL_PASSWORD_HASH
const LOG_DIR = path.resolve(process.cwd(), process.env.LOG_DIR || './logs')
const PUBLICO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

if (!HASH) {
  console.error('[panel] Falta PANEL_PASSWORD_HASH en el .env. Corré `npm run set-password` para definir la clave.')
  process.exit(1)
}

const db = abrirDb()
const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '10kb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// ---- sesión ----
app.get('/api/sesion', (req, res) => res.json({ autenticado: sesionValida(leerCookie(req)) }))

app.post('/api/login', (req, res) => {
  if (!limitarIntentos(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' })
  const clave = typeof req.body?.clave === 'string' ? req.body.clave : ''
  if (!clave || !verificarClave(clave, HASH)) return res.status(401).json({ error: 'Clave incorrecta' })
  reiniciarIntentos(req.ip)
  ponerCookie(req, res, crearSesion())
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  borrarCookie(res)
  res.json({ ok: true })
})

// ---- API (requiere sesión) ----
const api = express.Router()
api.use(exigirSesion)

function leerEstadoJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'estado.json'), 'utf8'))
  } catch {
    return null
  }
}

function estadoDelBot() {
  const e = leerEstadoJson()
  if (!e) return { conectado: false, vivo: false, ultimoMensajeGrupo: null, noDescifradosGrupo: null }
  // El latido se escribe cada 60 s: si pasó más del doble, el listener no está vivo aunque diga "conectado".
  const vivo = e.latido && Date.now() - new Date(e.latido).getTime() < 150_000
  return { conectado: !!e.conectado && !!vivo, vivo: !!vivo, ultimoMensajeGrupo: e.ultimoMensajeGrupo || null, noDescifradosGrupo: e.noDescifradosGrupo ?? null }
}

api.get('/resumen', (req, res) => {
  res.json({
    conteos: conteos(db),
    aBajar: codigosABajar(db).length,
    bot: estadoDelBot(),
    ultimaReconciliacion: getMeta(db, 'ultima_reconciliacion'),
    ultimaRevisionSitios: getMeta(db, 'ultima_revision_sitios'),
    // Para el aviso con sonido: el panel compara este id con el último que vio.
    ultimoReporteId: db.prepare('SELECT MAX(id) id FROM reportes').get().id ?? 0,
    sitios: SITIOS.map(({ clave, nombre }) => ({ clave, nombre })),
    ahora: new Date().toISOString(),
  })
})

const FILTROS = new Set(['publicados', 'no_publicados', 'revisando', 'pendientes', 'errores', 'procesados', 'todos'])
api.get('/lista', (req, res) => {
  const filtro = FILTROS.has(req.query.filtro) ? req.query.filtro : 'publicados'
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : ''
  res.json({ filas: listar(db, { filtro, q }) })
})

api.get('/a-bajar', (req, res) => res.json({ codigos: codigosABajar(db) }))

// Reportes que llegaron después de `desde` (id), para avisar con sonido qué códigos entraron.
// Las consultas manuales del panel no cuentan: no llegaron por WhatsApp.
api.get('/reportes-nuevos', (req, res) => {
  const desde = Math.max(0, Number.parseInt(req.query.desde, 10) || 0)
  const filas = db
    .prepare(`SELECT id, codigo, de FROM reportes WHERE id > ? AND msg_id NOT LIKE 'panel-%' ORDER BY id LIMIT 50`)
    .all(desde)
  res.json({ reportes: filas.map((f) => ({ ...f })) })
})
api.get('/publicados', (req, res) => res.json({ codigos: codigosPublicados(db) }))

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
api.get('/exportar.csv', (req, res) => {
  const filtro = FILTROS.has(req.query.filtro) ? req.query.filtro : 'publicados'
  const filas = listar(db, { filtro })
  const lineas = [['codigo', 'nombre', ...SITIOS.map((s) => s.nombre), 'reporto', 'ultimo_reporte', 'veces'].map(csv).join(',')]
  for (const f of filas) {
    const nombre = f.descripcion || SITIOS.map((s) => f.web?.[s.clave]?.nombre || f.web?.[s.clave]?.descripcion).find(Boolean)
    const estados = SITIOS.map((s) => f.web?.[s.clave]?.estado ?? 'sin revisar')
    lineas.push([f.codigo, nombre, ...estados, f.ultimo_de, f.ultimo_reporte, f.veces].map(csv).join(','))
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="bajas-${filtro}-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('﻿' + lineas.join('\r\n')) // BOM para que Excel respete los acentos
})

// ---- historial de bajas ----
const PERIODOS = { hoy: 0, '7d': 7, '30d': 30, todo: null }
function opcionesHistorial(req) {
  const tipo = req.query.tipo === 'bajas' ? 'bajas' : 'todos'
  const periodo = Object.hasOwn(PERIODOS, req.query.periodo) ? req.query.periodo : '30d'
  let desde = null
  if (periodo === 'hoy') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    desde = d.toISOString()
  } else if (PERIODOS[periodo]) desde = new Date(Date.now() - PERIODOS[periodo] * 86_400_000).toISOString()
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase().slice(0, 40) : ''
  return { tipo, desde, q }
}

api.get('/historial', (req, res) => {
  res.json({ eventos: listarHistorial(db, opcionesHistorial(req)), resumen: resumenHistorial(db) })
})

const TIPOS_HISTORIAL = { baja: 'Dado de baja', seguia_publicado: 'Seguía publicado al reportarlo', ya_no_estaba: 'Ya no estaba al reportarlo', reaparecio: 'Volvió a aparecer' }
api.get('/historial.csv', (req, res) => {
  const nombreSitio = Object.fromEntries(SITIOS.map((s) => [s.clave, s.nombre]))
  const lineas = [['fecha', 'codigo', 'nombre', 'pagina', 'evento', 'estado', 'reportado', 'reporto', 'demora_horas'].map(csv).join(',')]
  for (const e of listarHistorial(db, { ...opcionesHistorial(req), limite: 5000 })) {
    const horas = e.demora_ms == null ? '' : (e.demora_ms / 3_600_000).toFixed(1).replace('.', ',')
    lineas.push([e.ts, e.codigo, e.nombre, nombreSitio[e.sitio] || e.sitio, TIPOS_HISTORIAL[e.tipo] || e.tipo, e.estado, e.primer_reporte, e.primer_de, horas].map(csv).join(','))
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="historial-bajas-${new Date().toISOString().slice(0, 10)}.csv"`)
  res.send('\ufeff' + lineas.join('\r\n'))
})

// ---- consultar un código a mano ----
// Busca el código en las páginas en el momento (sin esperar a WhatsApp). Si se pide `agregar`, además
// lo suma a la lista como si lo hubieran reportado ("Consulta manual"), así el bot lo sigue revisando
// y queda en el historial. Una consulta a la vez y como mucho 20 por minuto: cada una hace 3 a 5
// pedidos a las páginas y no conviene que el panel las martille.
let consultaEnCurso = false
const consultasRecientes = []
api.post('/consultar', async (req, res) => {
  const codigo = String(req.body?.codigo ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!CODIGO_SEGURO.test(codigo)) {
    return res.status(400).json({ error: 'Código inválido: entre 4 y 25 letras, números, puntos o guiones (ej. 2TX43, 167.0800127, 3M201-GRE).' })
  }
  const ahora = Date.now()
  while (consultasRecientes.length && ahora - consultasRecientes[0] > 60_000) consultasRecientes.shift()
  if (consultaEnCurso || consultasRecientes.length >= 20) {
    return res.status(429).json({ error: 'Hay muchas consultas seguidas. Esperá unos segundos y probá de nuevo.' })
  }
  consultaEnCurso = true
  consultasRecientes.push(ahora)
  try {
    const resultado = await consultarSitios(codigo)
    let agregado = false
    if (req.body?.agregar === true) {
      const ts = new Date().toISOString()
      registrarReporte(db, { msg_id: `panel-${ahora}`, codigo, de: 'Consulta manual', ts })
      guardarSitios(db, codigo, resultado, ts)
      agregado = true
    }
    const enLista = !!db.prepare('SELECT 1 FROM codigos WHERE codigo = ? AND descartado = 0').get(codigo)
    res.json({ codigo, resultado, agregado, enLista, sitios: SITIOS.map(({ clave, nombre }) => ({ clave, nombre })) })
  } catch (err) {
    console.error('[panel] Error consultando', codigo, err.message)
    res.status(502).json({ error: 'No se pudo consultar las páginas. Probá de nuevo en un rato.' })
  } finally {
    consultaEnCurso = false
  }
})

api.post('/codigos/:codigo/descartar', (req, res) => {
  const cambios = descartar(db, req.params.codigo.toUpperCase(), !!req.body?.descartado, typeof req.body?.nota === 'string' ? req.body.nota.slice(0, 200) : null)
  res.json({ ok: cambios > 0 })
})

// "Actualizar": manda los pendientes a re-validar con Manager y todos a revisar otra vez en las páginas;
// el listener los toma en unos segundos.
api.post('/revalidar', (req, res) => {
  const r = db.prepare(`UPDATE codigos SET estado = 'por_validar' WHERE estado = 'pendiente'`).run()
  res.json({ ok: true, codigos: r.changes, paginas: pedirRevisionSitios(db) })
})

// ---- configuración: número vinculado (solo lectura) y grupo que se escucha (editable) ----
function respuestaConfig() {
  const e = leerEstadoJson() || {}
  const bot = estadoDelBot()
  return {
    linea: { numero: e.numero || null, nombre: e.nombreLinea || null, conectado: bot.conectado, desde: e.desde || null },
    grupo: leerConfigGrupo(db),
    detectado: { jid: e.grupoJid || null, nombre: e.grupoNombre || null },
    disponibles: leerGruposDisponibles(db),
  }
}

api.get('/config', (req, res) => res.json(respuestaConfig()))

// Vinculación de WhatsApp: estado de la línea y, si está esperando, el QR como imagen (PNG en data URL).
// Solo con sesión iniciada: quien escanea ese QR conecta su WhatsApp al bot.
api.get('/vinculacion', async (req, res) => {
  const e = leerEstadoJson() || {}
  const bot = estadoDelBot()
  const qr = bot.vivo ? leerQr(db) : null
  res.json({
    botVivo: bot.vivo,
    conectado: bot.conectado,
    vinculado: !!e.vinculado || bot.conectado,
    numero: e.numero || null,
    qr: qr ? await QRCode.toDataURL(qr.qr, { margin: 2, width: 280, errorCorrectionLevel: 'L' }) : null,
    qrTs: qr?.ts || null,
  })
})

api.put('/config/grupo', (req, res) => {
  try {
    guardarConfigGrupo(db, { nombre: req.body?.nombre ?? '', jid: req.body?.jid ?? '' })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
  res.json(respuestaConfig())
})

api.delete('/config/grupo', (req, res) => {
  borrarConfigGrupo(db)
  res.json(respuestaConfig())
})

app.use('/api', api)
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }))
app.use(express.static(PUBLICO, { index: 'index.html', maxAge: 0 }))

app.use((err, req, res, next) => {
  console.error('[panel] Error:', err.message)
  res.status(500).json({ error: 'Error interno' })
})

app.listen(PUERTO, '127.0.0.1', () => console.log(`[panel] Escuchando en http://127.0.0.1:${PUERTO}`))
