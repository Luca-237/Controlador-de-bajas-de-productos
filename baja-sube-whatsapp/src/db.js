/**
 * Base de datos SQLite (node:sqlite, sin dependencias nativas) compartida por el listener y el panel.
 * Modo WAL + busy_timeout para que dos procesos (listener y panel) puedan escribir sin pisarse.
 *
 * Modelo:
 *  - `reportes`: cada vez que alguien manda un código al grupo (una fila por mensaje+código).
 *  - `codigos`: una fila por código distinto, con su estado actual según Manager.
 *      estado: por_validar | pendiente | procesado | no_existe | no_vigente
 *      La verdad del estado la da SIEMPRE Manager (`Sube`); la reacción de una persona en el grupo es
 *      solo una señal secundaria (se guarda en `reportes.reaccion_*`).
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reportes (
  id INTEGER PRIMARY KEY,
  msg_id TEXT NOT NULL,
  codigo TEXT NOT NULL,
  de TEXT,
  jid TEXT,
  ts TEXT NOT NULL,
  reaccion_emoji TEXT,
  reaccion_de TEXT,
  reaccion_ts TEXT,
  UNIQUE (msg_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_reportes_codigo ON reportes (codigo);
CREATE INDEX IF NOT EXISTS idx_reportes_msg ON reportes (msg_id);

CREATE TABLE IF NOT EXISTS codigos (
  codigo TEXT PRIMARY KEY,
  estado TEXT NOT NULL DEFAULT 'por_validar',
  descripcion TEXT,
  id_articulo INTEGER,
  sube INTEGER,
  no_vigente INTEGER,
  variantes TEXT,
  a_bajar TEXT,
  veces INTEGER NOT NULL DEFAULT 1,
  primer_reporte TEXT,
  ultimo_reporte TEXT,
  validado_ts TEXT,
  procesado_ts TEXT,
  ya_estaba INTEGER NOT NULL DEFAULT 0,
  descartado INTEGER NOT NULL DEFAULT 0,
  nota TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_codigos_estado ON codigos (estado);

CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);

-- Historial de bajas: un evento cada vez que cambia lo que se ve de un código en una página.
--   tipo: seguia_publicado (al revisarlo por primera vez seguía en esa página)
--         ya_no_estaba     (al revisarlo por primera vez ya no estaba)
--         baja             (estaba publicado y dejó de estar: alguien lo dio de baja)
--         reaparecio       (no estaba y volvió a aparecer)
-- Solo se agregan filas, nunca se editan: es el registro de qué pasó y cuándo.
CREATE TABLE IF NOT EXISTS historial (
  id INTEGER PRIMARY KEY,
  codigo TEXT NOT NULL,
  sitio TEXT NOT NULL,
  tipo TEXT NOT NULL,
  estado TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_historial_ts ON historial (ts);
CREATE INDEX IF NOT EXISTS idx_historial_codigo ON historial (codigo);
`

// Columnas agregadas después de la primera versión (la base del VPS ya existe): se suman si faltan.
//  - web: JSON con lo que se vio en cada página ({cindy, catalogo, tienda, publicadoEn}); web_ts: cuándo se consultó;
//  - web_a_bajar: 1 si sigue publicado en alguna página; web_error: 1 si alguna página falló.
const COLUMNAS_NUEVAS = { web: 'TEXT', web_ts: 'TEXT', web_a_bajar: 'INTEGER NOT NULL DEFAULT 0', web_error: 'INTEGER NOT NULL DEFAULT 0' }

export function abrirDb(ruta = process.env.DB_PATH || './data/bajas.db') {
  const abs = ruta === ':memory:' ? ruta : path.resolve(process.cwd(), ruta)
  if (abs !== ':memory:') fs.mkdirSync(path.dirname(abs), { recursive: true })
  const db = new DatabaseSync(abs)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  const existentes = new Set(db.prepare('PRAGMA table_info(codigos)').all().map((c) => c.name))
  for (const [nombre, tipo] of Object.entries(COLUMNAS_NUEVAS)) {
    if (!existentes.has(nombre)) db.exec(`ALTER TABLE codigos ADD COLUMN ${nombre} ${tipo}`)
  }
  return db
}

const ahoraIso = () => new Date().toISOString()

/**
 * Registra un código reportado en el grupo. Idempotente por (msg_id, codigo): re-procesar el mismo
 * mensaje (por ejemplo al reconectar y recibir historial) no duplica nada.
 * Si el código ya estaba procesado y lo vuelven a reportar, se re-valida (puede haber vuelto a Sube=1).
 * @returns {{nuevo:boolean, repetido:boolean}}
 */
export function registrarReporte(db, { msg_id, codigo, de = null, jid = null, ts }) {
  const r = db.prepare('INSERT OR IGNORE INTO reportes (msg_id, codigo, de, jid, ts) VALUES (?, ?, ?, ?, ?)').run(msg_id, codigo, de, jid, ts)
  if (!r.changes) return { nuevo: false, repetido: false } // mensaje ya registrado antes

  const previo = db.prepare('SELECT estado FROM codigos WHERE codigo = ?').get(codigo)
  if (!previo) {
    db.prepare('INSERT INTO codigos (codigo, estado, primer_reporte, ultimo_reporte) VALUES (?, ?, ?, ?)').run(codigo, 'por_validar', ts, ts)
    return { nuevo: true, repetido: false }
  }
  // Re-reporte: sube el contador y se vuelve a validar (descartado se mantiene como lo dejó una persona).
  db.prepare(
    `UPDATE codigos SET veces = veces + 1, ultimo_reporte = ?, estado = 'por_validar', validado_ts = NULL, ya_estaba = 0, web_ts = NULL WHERE codigo = ?`
  ).run(ts, codigo)
  return { nuevo: false, repetido: true }
}

/** Guarda la reacción de una persona sobre un mensaje con códigos. Emoji vacío = quitó la reacción. */
export function registrarReaccion(db, { objetivo_msg_id, emoji, de = null, ts }) {
  if (!objetivo_msg_id) return 0
  if (!emoji) {
    return db.prepare('UPDATE reportes SET reaccion_emoji = NULL, reaccion_de = NULL, reaccion_ts = NULL WHERE msg_id = ?').run(objetivo_msg_id).changes
  }
  return db.prepare('UPDATE reportes SET reaccion_emoji = ?, reaccion_de = ?, reaccion_ts = ? WHERE msg_id = ?').run(emoji, de, ts, objetivo_msg_id).changes
}

export const codigosPorValidar = (db, limite = 50) =>
  db.prepare(`SELECT codigo FROM codigos WHERE estado = 'por_validar' ORDER BY ultimo_reporte LIMIT ?`).all(limite).map((r) => r.codigo)

export const codigosPendientes = (db) =>
  db.prepare(`SELECT codigo FROM codigos WHERE estado = 'pendiente' ORDER BY ultimo_reporte`).all().map((r) => r.codigo)

/**
 * Aplica el resultado de consultar Manager a un código.
 * @param {{estado:string, aBajar:string[], articulo?:{id?:number, descripcion?:string, sube?:number|null, noVigente?:boolean}, variantes?:any[]}} res
 */
export function aplicarValidacion(db, codigo, res, ahora = ahoraIso()) {
  const fila = db.prepare('SELECT estado, validado_ts, procesado_ts FROM codigos WHERE codigo = ?').get(codigo)
  if (!fila) return
  const a = res.articulo || {}
  // "Ya estaba": la primera vez que lo validamos tras un reporte, Manager ya tenía todo en Sube=0.
  const yaEstaba = res.estado === 'procesado' && fila.validado_ts === null ? 1 : null
  const procesadoTs =
    res.estado === 'procesado' ? (fila.estado === 'procesado' && fila.procesado_ts ? fila.procesado_ts : ahora) : null
  db.prepare(
    `UPDATE codigos SET estado = ?, descripcion = ?, id_articulo = ?, sube = ?, no_vigente = ?, variantes = ?, a_bajar = ?,
       validado_ts = ?, procesado_ts = ?, ya_estaba = COALESCE(?, ya_estaba), error = NULL WHERE codigo = ?`
  ).run(
    res.estado,
    a.descripcion ?? null,
    a.id ?? null,
    a.sube == null ? null : Number(a.sube),
    a.noVigente == null ? null : a.noVigente ? 1 : 0,
    JSON.stringify(res.variantes || []),
    JSON.stringify(res.aBajar || []),
    ahora,
    procesadoTs,
    yaEstaba,
    codigo
  )
}

/**
 * Códigos a revisar en las páginas: los que nunca se consultaron (o se re-reportaron) y, cada
 * `recheckMs`, los que seguían a la venta o dieron error (así se ve solo cuándo alguien los bajó).
 * Independiente del estado de Manager: si Manager está caído o no está configurado, se revisa igual.
 */
export function codigosParaRevisarSitios(db, { limite = 10, recheckMs = 10 * 60_000, ahora = Date.now() } = {}) {
  const corte = new Date(ahora - recheckMs).toISOString()
  return db
    .prepare(
      `SELECT codigo FROM codigos WHERE descartado = 0 AND estado NOT IN ('no_existe', 'no_vigente')
         AND (web_ts IS NULL OR ((web_a_bajar = 1 OR web_error = 1) AND web_ts < ?))
       ORDER BY web_ts IS NOT NULL, ultimo_reporte DESC LIMIT ?`
    )
    .all(corte, limite)
    .map((r) => r.codigo)
}

const PAGINAS = ['cindy', 'catalogo', 'tienda']

/**
 * Guarda el resultado de consultarSitios (sitios.js) para un código y anota en `historial` lo que cambió.
 * `conocido` (dentro del JSON `web`) es el último estado que se pudo leer de cada página: un error de
 * red no cuenta como baja, así que se compara siempre contra el último dato bueno.
 */
export function guardarSitios(db, codigo, res, ahora = ahoraIso()) {
  const fila = db.prepare('SELECT web FROM codigos WHERE codigo = ?').get(codigo)
  if (!fila) return
  const previo = fila.web ? JSON.parse(fila.web) : {}
  const conocido = { ...(previo.conocido || {}) }
  const evento = db.prepare('INSERT INTO historial (codigo, sitio, tipo, estado, ts) VALUES (?, ?, ?, ?, ?)')

  for (const p of PAGINAS) {
    const nuevo = res[p]?.estado
    if (!nuevo || nuevo === 'error') continue
    const antes = conocido[p]
    const publicadoAhora = nuevo === 'publicado'
    if (antes === undefined) evento.run(codigo, p, publicadoAhora ? 'seguia_publicado' : 'ya_no_estaba', nuevo, ahora)
    else if (antes === 'publicado' && !publicadoAhora) evento.run(codigo, p, 'baja', nuevo, ahora)
    else if (antes !== 'publicado' && publicadoAhora) evento.run(codigo, p, 'reaparecio', nuevo, ahora)
    conocido[p] = nuevo
  }

  db.prepare('UPDATE codigos SET web = ?, web_ts = ?, web_a_bajar = ?, web_error = ? WHERE codigo = ?').run(
    JSON.stringify({ cindy: res.cindy, catalogo: res.catalogo, tienda: res.tienda, publicadoEn: res.publicadoEn || [], conocido }),
    ahora,
    res.aBajar ? 1 : 0,
    res.conError ? 1 : 0,
    codigo
  )
}

/**
 * Historial para el panel, del más nuevo al más viejo. Cada evento trae el nombre del producto y el
 * primer reporte del código (quién y cuándo), para ver cuánto tardó la baja.
 * @param {{q?:string, tipo?:'bajas'|'todos', desde?:string, limite?:number}} opts
 */
export function listarHistorial(db, { q = '', tipo = 'todos', desde = null, limite = 500 } = {}) {
  const where = []
  const params = []
  if (tipo === 'bajas') where.push(`h.tipo = 'baja'`)
  if (desde) {
    where.push('h.ts >= ?')
    params.push(desde)
  }
  if (q) {
    where.push('h.codigo LIKE ?')
    params.push(`%${q}%`)
  }
  const filas = db
    .prepare(
      `SELECT h.*, c.web, c.descripcion, c.primer_reporte,
              (SELECT de FROM reportes r WHERE r.codigo = h.codigo ORDER BY r.ts LIMIT 1) primer_de
       FROM historial h LEFT JOIN codigos c ON c.codigo = h.codigo
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY h.ts DESC, h.id DESC LIMIT ?`
    )
    .all(...params, limite)
  return filas.map(({ web, ...h }) => {
    const w = web ? JSON.parse(web) : {}
    const nombre = h.descripcion || PAGINAS.map((p) => w[p]?.nombre || w[p]?.descripcion).find(Boolean) || null
    return { ...h, nombre, demora_ms: h.tipo === 'baja' && h.primer_reporte ? Date.parse(h.ts) - Date.parse(h.primer_reporte) : null }
  })
}

/** Resumen del historial: bajas de hoy, de los últimos 7 días y demora promedio entre reporte y baja. */
export function resumenHistorial(db, ahora = new Date()) {
  const hoy = new Date(ahora)
  hoy.setHours(0, 0, 0, 0)
  const semana = new Date(ahora.getTime() - 7 * 86_400_000)
  const cuenta = (desde) => db.prepare(`SELECT COUNT(*) n FROM historial WHERE tipo = 'baja' AND ts >= ?`).get(desde.toISOString()).n
  const demora = db
    .prepare(
      `SELECT AVG((julianday(h.ts) - julianday(c.primer_reporte)) * 86400000) ms
       FROM historial h JOIN codigos c ON c.codigo = h.codigo WHERE h.tipo = 'baja' AND h.ts >= ?`
    )
    .get(semana.toISOString()).ms
  return { bajasHoy: cuenta(hoy), bajasSemana: cuenta(semana), demoraPromedioMs: demora == null ? null : Math.round(demora) }
}

/** Falló la consulta a Manager (red, token, etc.): el código queda por validar y se reintenta. */
export function marcarErrorConsulta(db, codigo, mensaje) {
  db.prepare('UPDATE codigos SET error = ? WHERE codigo = ?').run(String(mensaje).slice(0, 300), codigo)
}

export function descartar(db, codigo, descartado, nota = null) {
  return db.prepare('UPDATE codigos SET descartado = ?, nota = COALESCE(?, nota) WHERE codigo = ?').run(descartado ? 1 : 0, nota, codigo).changes
}

/**
 * Lista para el panel.
 * filtro por páginas: 'publicados' (siguen en alguna) | 'no_publicados' (en ninguna) | 'revisando' (todavía sin revisar nunca, o con error).
 * Un código que se manda a revisar de nuevo conserva su último resultado hasta que llegue el nuevo.
 * filtro por Manager: 'pendientes' | 'errores' | 'procesados'. Y 'todos'.
 * Cada fila trae las variantes, lo que hay que bajar y lo visto en las páginas ya parseado, el último reporte y las reacciones.
 */
export function listar(db, { filtro = 'publicados', q = '', incluirDescartados = false } = {}) {
  const where = []
  const params = []
  if (!incluirDescartados) where.push('c.descartado = 0')
  if (filtro === 'publicados') where.push('c.web_a_bajar = 1')
  else if (filtro === 'no_publicados') where.push('c.web IS NOT NULL AND c.web_a_bajar = 0 AND c.web_error = 0')
  else if (filtro === 'revisando') where.push(`(c.web IS NULL OR (c.web_error = 1 AND c.web_a_bajar = 0)) AND c.estado NOT IN ('no_existe', 'no_vigente')`)
  else if (filtro === 'pendientes') where.push(`c.estado IN ('pendiente', 'por_validar')`)
  else if (filtro === 'errores') where.push(`c.estado IN ('no_existe', 'no_vigente')`)
  else if (filtro === 'procesados') where.push(`c.estado = 'procesado'`)
  if (q) {
    where.push('(c.codigo LIKE ? OR c.descripcion LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }
  const filas = db
    .prepare(`SELECT c.* FROM codigos c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.ultimo_reporte DESC LIMIT 500`)
    .all(...params)
  const reportesDe = db.prepare('SELECT msg_id, de, ts, reaccion_emoji, reaccion_de, reaccion_ts FROM reportes WHERE codigo = ? ORDER BY ts DESC LIMIT 10')
  return filas.map((c) => {
    const reportes = reportesDe.all(c.codigo)
    const reaccionado = reportes.some((r) => r.reaccion_emoji)
    return {
      ...c,
      variantes: JSON.parse(c.variantes || '[]'),
      a_bajar: JSON.parse(c.a_bajar || '[]'),
      web: c.web ? JSON.parse(c.web) : null,
      reportes,
      ultimo_de: reportes[0]?.de || null,
      reaccionado,
      // Alerta útil: alguien reaccionó ("ya lo bajé") pero Manager todavía tiene algo en Sube=1.
      reaccionado_pero_pendiente: reaccionado && c.estado === 'pendiente',
    }
  })
}

/** Códigos que siguen publicados en alguna página, con dónde: [{codigo, publicadoEn}]. */
export function codigosPublicados(db) {
  return db
    .prepare(`SELECT codigo, web FROM codigos WHERE web_a_bajar = 1 AND descartado = 0 ORDER BY codigo`)
    .all()
    .map((f) => ({ codigo: f.codigo, publicadoEn: JSON.parse(f.web || '{}').publicadoEn || [] }))
}

/** Pide revisar otra vez las páginas de todos los códigos visibles (el ciclo los toma en segundos). */
export function pedirRevisionSitios(db) {
  return db.prepare(`UPDATE codigos SET web_ts = NULL WHERE descartado = 0 AND estado NOT IN ('no_existe', 'no_vigente')`).run().changes
}

/** Códigos que hay que cargar con Sube=0, sin repetidos, de todos los pendientes no descartados. */
export function codigosABajar(db) {
  const filas = db.prepare(`SELECT a_bajar FROM codigos WHERE estado = 'pendiente' AND descartado = 0`).all()
  const set = new Set()
  for (const f of filas) for (const c of JSON.parse(f.a_bajar || '[]')) set.add(c)
  return [...set].sort()
}

export function conteos(db) {
  const base = db.prepare(`SELECT estado, COUNT(*) n FROM codigos WHERE descartado = 0 GROUP BY estado`).all()
  const por = Object.fromEntries(base.map((r) => [r.estado, r.n]))
  const hoy = new Date()
  hoy.setUTCHours(0, 0, 0, 0)
  const procesadosHoy = db.prepare(`SELECT COUNT(*) n FROM codigos WHERE estado = 'procesado' AND descartado = 0 AND procesado_ts >= ?`).get(hoy.toISOString()).n
  const web = db
    .prepare(
      `SELECT SUM(web_a_bajar = 1) publicados,
              SUM(web IS NOT NULL AND web_a_bajar = 0 AND web_error = 0) noPublicados,
              SUM((web IS NULL OR (web_error = 1 AND web_a_bajar = 0)) AND estado NOT IN ('no_existe', 'no_vigente')) revisando
       FROM codigos WHERE descartado = 0`
    )
    .get()
  return {
    publicados: web.publicados || 0,
    noPublicados: web.noPublicados || 0,
    revisando: web.revisando || 0,
    pendientes: (por.pendiente || 0) + (por.por_validar || 0),
    errores: (por.no_existe || 0) + (por.no_vigente || 0),
    procesados: por.procesado || 0,
    procesadosHoy,
    total: Object.values(por).reduce((a, b) => a + b, 0),
  }
}

export function setMeta(db, clave, valor) {
  db.prepare('INSERT INTO meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, String(valor))
}
export const getMeta = (db, clave) => db.prepare('SELECT valor FROM meta WHERE clave = ?').get(clave)?.valor ?? null
