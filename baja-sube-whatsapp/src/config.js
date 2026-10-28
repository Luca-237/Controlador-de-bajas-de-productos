/**
 * Configuración editable desde el panel: qué grupo de WhatsApp escucha el bot.
 * Se guarda en la tabla `meta` de la base (la comparten listener y panel). Si nunca se tocó desde el
 * panel, vale lo del .env (GRUPO_NOMBRE / GRUPO_JID), así el VPS sigue igual que antes al desplegar.
 *
 * El número NO se configura acá: es el teléfono que escaneó el QR (sesión en ./auth). El panel solo lo
 * muestra; para cambiarlo hay que volver a vincular con el QR (pasos en la sección Configuración del panel).
 */
import { getMeta, setMeta } from './db.js'

export const GRUPO_POR_DEFECTO = 'Código que no hay más'

// JID de grupo: "120363025246125486@g.us" (nuevo) o "5493534123456-1609459200@g.us" (grupos viejos).
export const JID_GRUPO = /^\d{10,25}(-\d{6,12})?@g\.us$/

/** Normaliza para comparar nombres de grupo: sin acentos, sin emojis/signos, minúscula. */
export const normalizarNombre = (s) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/** @returns {{nombre:string, jid:string, origen:'panel'|'env'}} */
export function leerConfigGrupo(db, env = process.env) {
  const nombre = getMeta(db, 'config_grupo_nombre')
  const jid = getMeta(db, 'config_grupo_jid')
  if (nombre !== null || jid !== null) return { nombre: nombre || '', jid: jid || '', origen: 'panel' }
  return { nombre: (env.GRUPO_NOMBRE || GRUPO_POR_DEFECTO).trim(), jid: (env.GRUPO_JID || '').trim(), origen: 'env' }
}

/**
 * Valida y guarda. Hace falta al menos uno de los dos. Devuelve la config guardada o tira Error con un
 * mensaje pensado para mostrarse tal cual en el panel.
 */
export function guardarConfigGrupo(db, { nombre = '', jid = '' } = {}) {
  nombre = String(nombre).trim()
  jid = String(jid).trim()
  if (!nombre && !jid) throw new Error('Completá el nombre del grupo o su JID.')
  if (nombre && (nombre.length < 3 || nombre.length > 100)) throw new Error('El nombre tiene que tener entre 3 y 100 caracteres.')
  if (nombre && !normalizarNombre(nombre)) throw new Error('El nombre tiene que tener al menos una letra o número.')
  if (jid && !JID_GRUPO.test(jid)) throw new Error('El JID no tiene forma de grupo. Ejemplo: 120363025246125486@g.us')
  setMeta(db, 'config_grupo_nombre', nombre)
  setMeta(db, 'config_grupo_jid', jid)
  return { nombre, jid, origen: 'panel' }
}

/** Vuelve a lo que diga el .env. */
export function borrarConfigGrupo(db) {
  db.prepare(`DELETE FROM meta WHERE clave IN ('config_grupo_nombre', 'config_grupo_jid')`).run()
}

/** Decide si un grupo es el configurado. Con JID manda el JID; si no, el nombre ("contiene", normalizado). */
export function coincideGrupo(config, jid, asunto) {
  if (config.jid) return jid === config.jid
  if (!config.nombre || asunto == null) return false
  return normalizarNombre(asunto).includes(normalizarNombre(config.nombre))
}

// ---- QR de vinculación ----
// WhatsApp entrega un QR nuevo cada ~20 s mientras nadie escanea. El listener guarda el último acá y el
// panel lo muestra (solo con sesión iniciada). Se borra al conectarse. Pasado QR_VIGENCIA_MS se lo da
// por vencido aunque siga en la base (por ejemplo, si el listener se cayó mientras esperaba).
export const QR_VIGENCIA_MS = 60_000

export function publicarQr(db, qr, ahora = new Date()) {
  setMeta(db, 'wa_qr', qr)
  setMeta(db, 'wa_qr_ts', ahora.toISOString())
}

export function borrarQr(db) {
  db.prepare(`DELETE FROM meta WHERE clave IN ('wa_qr', 'wa_qr_ts')`).run()
}

/** El QR vigente o null. */
export function leerQr(db, ahora = Date.now()) {
  const qr = getMeta(db, 'wa_qr')
  const ts = getMeta(db, 'wa_qr_ts')
  if (!qr || !ts || ahora - Date.parse(ts) > QR_VIGENCIA_MS) return null
  return { qr, ts }
}

/** Grupos de la línea vinculada (los guarda el listener al conectar) para elegir desde el panel. */
export function guardarGruposDisponibles(db, grupos) {
  const lista = grupos
    .map((g) => ({ jid: g.id, nombre: g.subject || '(sin nombre)', participantes: g.participants?.length ?? null }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  setMeta(db, 'grupos_disponibles', JSON.stringify(lista))
  setMeta(db, 'grupos_disponibles_ts', new Date().toISOString())
}

export function leerGruposDisponibles(db) {
  try {
    return { grupos: JSON.parse(getMeta(db, 'grupos_disponibles') || '[]'), actualizado: getMeta(db, 'grupos_disponibles_ts') }
  } catch {
    return { grupos: [], actualizado: null }
  }
}
