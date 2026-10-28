/**
 * Bot de bajas (Sube=1 -> 0) — Fases 1 y 2.
 *
 * Escucha SOLO el grupo configurado (desde el panel, o GRUPO_NOMBRE / GRUPO_JID del .env), extrae los códigos con parser.js,
 * los registra en logs/shadow-YYYY-MM-DD.jsonl y en la base SQLite, y el validador los chequea contra
 * Manager (solo SELECT) para el panel. NO escribe en Manager, NO reacciona, NO manda mensajes:
 * en este archivo no existe ninguna llamada a sendMessage (eso es la fase 3). Cualquier chat que no
 * sea ese grupo se descarta sin leerse ni guardarse.
 *
 * Diseño completo: proyectos/tiendaquick-baja-informacion-whatsapp.md en el vault.
 */
import 'dotenv/config'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  WAMessageStubType,
} from '@whiskeysockets/baileys'
import { pino } from 'pino'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { extraerCodigos, esMensajeLimpio } from './parser.js'
import { registrar, escribirEstado } from './shadowLog.js'
import { abrirDb } from './db.js'
import { ingestarEntrada } from './ingesta.js'
import { iniciarValidador } from './validador.js'
import { leerConfigGrupo, coincideGrupo, guardarGruposDisponibles, publicarQr, borrarQr } from './config.js'

const db = abrirDb()

const AUTH_DIR = path.resolve(process.cwd(), process.env.AUTH_DIR || './auth')
const GUARDAR_TEXTO_AMBIGUO = process.env.SHADOW_GUARDAR_TEXTO_AMBIGUO === 'true'
const logger = pino({ level: 'silent' })

// Grupo a escuchar: se relee de la base cada 30 s, así un cambio hecho en el panel se toma sin reiniciar.
let config = leerConfigGrupo(db)

const estado = {
  conectado: false,
  desde: null,
  numero: null, // número de la línea vinculada (el teléfono que escaneó el QR)
  nombreLinea: null,
  ultimoMensajeGrupo: null,
  mensajesRegistrados: 0,
  noDescifradosGrupo: 0, // mensajes DEL GRUPO que no se pudieron descifrar (códigos potencialmente perdidos)
  fallosDescifradoTotal: 0, // errores de libsignal de cualquier chat (ruido, ver abajo)
  reconexiones: 0,
  grupoJid: config.jid || null,
  grupoNombre: null, // nombre real del grupo detectado (para mostrar en el panel)
}

// libsignal imprime con console.error cada fallo de descifrado de CUALQUIER chat de la línea
// (se vieron ~27.000 en 42 h = 20 MB de log). Se cuentan en estado.json en vez de volcarse al log.
const RUIDO_LIBSIGNAL = /Failed to decrypt message|Session error|Bad MAC|Over 2000 messages/
const consoleErrorOriginal = console.error.bind(console)
console.error = (...args) => {
  const primero = typeof args[0] === 'string' ? args[0] : args[0]?.message || ''
  if (RUIDO_LIBSIGNAL.test(primero)) {
    estado.fallosDescifradoTotal++
    return
  }
  consoleErrorOriginal(...args)
}

/** jid -> true/false: si ese grupo es el nuestro. Se resuelve una sola vez por grupo (evita rate-limit). */
const gruposResueltos = new Map()

function recargarConfig() {
  const nueva = leerConfigGrupo(db)
  if (nueva.jid === config.jid && nueva.nombre === config.nombre) return
  config = nueva
  gruposResueltos.clear() // con otro grupo configurado, lo ya resuelto deja de valer
  estado.grupoJid = config.jid || null
  estado.grupoNombre = null
  console.log(`[shadow] Grupo configurado cambiado (${config.origen}): ${config.jid || `"${config.nombre}"`}`)
}

async function esGrupoObjetivo(sock, jid) {
  if (config.jid) return coincideGrupo(config, jid)
  if (gruposResueltos.has(jid)) return gruposResueltos.get(jid)
  let esNuestro = false
  try {
    const meta = await sock.groupMetadata(jid)
    esNuestro = coincideGrupo(config, jid, meta.subject)
    if (esNuestro) {
      estado.grupoJid = jid
      estado.grupoNombre = meta.subject
      console.log(`[shadow] Grupo objetivo identificado: "${meta.subject}" (${jid}). Conviene fijar ese JID desde el panel.`)
    }
  } catch (err) {
    console.error('[shadow] No pude leer metadata del grupo', jid, err.message)
    return false // no se cachea: se reintenta en el próximo mensaje de ese grupo
  }
  gruposResueltos.set(jid, esNuestro)
  return esNuestro
}

// Tipos internos del protocolo de WhatsApp que no son mensajes de la gente: no se registran.
const TIPOS_PROTOCOLO = new Set(['senderKeyDistributionMessage', 'protocolMessage', 'messageContextInfo'])

function textoDelMensaje(msg) {
  // normalizeMessageContent desenvuelve ephemeralMessage/viewOnce: el grupo puede tener mensajes temporales.
  const contenido = normalizeMessageContent(msg.message)
  if (!contenido) return { tipo: 'vacio', texto: '' }
  if (contenido.conversation) return { tipo: 'texto', texto: contenido.conversation }
  if (contenido.extendedTextMessage?.text) return { tipo: 'texto', texto: contenido.extendedTextMessage.text }
  if (contenido.imageMessage) return { tipo: 'imagen', texto: contenido.imageMessage.caption || '' }
  if (contenido.videoMessage) return { tipo: 'video', texto: contenido.videoMessage.caption || '' }
  if (contenido.reactionMessage) {
    // Las reacciones hoy son el "ya lo bajé" del equipo: se guarda el emoji y a qué mensaje responden.
    return {
      tipo: 'reaccion',
      texto: '',
      extra: { emoji: contenido.reactionMessage.text || '', objetivo_msg_id: contenido.reactionMessage.key?.id || null },
    }
  }
  return { tipo: Object.keys(contenido)[0] || 'otro', texto: '' }
}

async function procesarMensaje(sock, msg) {
  const jid = msg.key.remoteJid
  // Todo lo que no sea un grupo (chats 1:1, estados, listas de difusión) se descarta sin mirarlo.
  if (!jid || !jid.endsWith('@g.us')) return
  if (!(await esGrupoObjetivo(sock, jid))) return

  if (!msg.message) {
    // Mensaje del grupo que no se pudo descifrar: se registra (no se descarta en silencio) porque
    // podría ser un código perdido. WhatsApp suele reintentar y reentregarlo descifrado después.
    if (msg.messageStubType === WAMessageStubType.CIPHERTEXT) {
      estado.noDescifradosGrupo++
      registrar({
        ts: new Date().toISOString(),
        msg_id: msg.key.id,
        de: msg.pushName || null,
        jid_remitente: msg.key.participant || null,
        tipo: 'no_descifrado',
        codigos: [],
        limpio: null,
      })
      console.warn(`[shadow] Mensaje del grupo NO descifrado (de ${msg.pushName || '?'}, id ${msg.key.id})`)
    }
    return
  }

  const { tipo, texto, extra } = textoDelMensaje(msg)
  if (TIPOS_PROTOCOLO.has(tipo)) return
  const ahora = new Date()
  const extraido = extraerCodigos(texto)
  // "limpio" solo tiene sentido para mensajes con texto; reacciones, fotos sin texto, etc. quedan en null.
  const limpio = tipo === 'texto' ? esMensajeLimpio(extraido) : null

  const entrada = {
    ts: ahora.toISOString(),
    ts_whatsapp: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : null,
    msg_id: msg.key.id,
    de: msg.pushName || null,
    jid_remitente: msg.key.participant || null,
    propio: !!msg.key.fromMe,
    tipo,
    codigos: extraido.codigos,
    limpio,
    sobrantes: extraido.sobrantes.length,
  }
  if (extra) Object.assign(entrada, extra)
  if (limpio === false && GUARDAR_TEXTO_AMBIGUO && texto) entrada.texto = texto.slice(0, 200)

  registrar(entrada) // el JSONL sigue siendo el registro crudo de respaldo
  try {
    ingestarEntrada(db, entrada)
  } catch (err) {
    console.error('[shadow] Error guardando en la base:', err.message) // un fallo de la base no debe cortar el listener
  }
  estado.mensajesRegistrados++
  estado.ultimoMensajeGrupo = entrada.ts
  const detalle = tipo === 'reaccion' ? `[reacción ${extra.emoji || '(quitó)'}]` : extraido.codigos.join(', ') || '(sin código)'
  console.log(`[shadow] ${entrada.de || '?'}: ${detalle}${limpio === false ? ' [ambiguo]' : ''}`)
}

let reconectarEn = 2000

async function conectar() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  // Sin sesión guardada, cada conexión solo sirve para mostrar QR: se reintenta rápido, sin backoff.
  const vinculado = !!state.creds?.registered
  estado.vinculado = vinculado
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false, markOnlineOnConnect: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // El QR va a la terminal y a la base, para que el panel lo muestre (detrás del login) al desplegar.
      publicarQr(db, qr)
      escribirEstado({ ...estado, latido: new Date().toISOString() }) // el panel muestra el QR solo si el bot está vivo
      console.log('\n[shadow] Escaneá este QR (también está en el panel, Configuración) desde WhatsApp > Dispositivos vinculados > Vincular un dispositivo:\n')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }
    if (connection === 'open') {
      borrarQr(db)
      estado.vinculado = true
      estado.conectado = true
      estado.desde = new Date().toISOString()
      reconectarEn = 2000
      estado.numero = sock.user?.id?.split(/[:@]/)[0] || null
      estado.nombreLinea = sock.user?.name || null
      console.log(`[shadow] Conectado como ${estado.numero || '?'}. Escuchando ${config.jid || `"${config.nombre}"`} en modo sombra.`)
      escribirEstado({ ...estado, latido: new Date().toISOString() })
      // Lista de grupos de esta línea, para que el panel ofrezca elegir el grupo (solo nombre, JID y cantidad).
      try {
        const grupos = Object.values(await sock.groupFetchAllParticipating())
        guardarGruposDisponibles(db, grupos)
        const nuestro = grupos.find((g) => coincideGrupo(config, g.id, g.subject))
        if (nuestro) {
          estado.grupoJid = nuestro.id
          estado.grupoNombre = nuestro.subject
        }
      } catch (err) {
        console.error('[shadow] No pude listar los grupos de la línea:', err.message)
      }
    }
    if (connection === 'close') {
      estado.conectado = false
      const codigo = lastDisconnect?.error?.output?.statusCode
      if (codigo === DisconnectReason.loggedOut) {
        // Se desvinculó desde el teléfono: esa sesión ya no sirve. Se borra y se arranca de cero, así el
        // panel muestra un QR nuevo y se puede volver a vincular (con este u otro número) sin entrar al servidor.
        console.error('[shadow] Sesión cerrada desde el celular. Se borra la sesión vieja y se genera un QR nuevo.')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        Object.assign(estado, { vinculado: false, numero: null, nombreLinea: null, grupoNombre: null })
        escribirEstado({ ...estado, latido: new Date().toISOString(), error: 'logged_out' })
        reconectarEn = 2000
        setTimeout(() => conectar().catch((e) => console.error('[shadow] Error reconectando:', e.message)), 2000)
        return
      }
      if (!vinculado) {
        // Venció la tanda de QR sin que nadie escaneara (código 408): se pide otra enseguida.
        borrarQr(db)
        setTimeout(() => conectar().catch((e) => console.error('[shadow] Error reconectando:', e.message)), 3000)
        return
      }
      estado.reconexiones++
      console.warn(`[shadow] Conexión cerrada (código ${codigo ?? '?'}). Reintentando en ${reconectarEn / 1000}s.`)
      setTimeout(() => conectar().catch((e) => console.error('[shadow] Error reconectando:', e.message)), reconectarEn)
      reconectarEn = Math.min(reconectarEn * 2, 60_000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = mensajes nuevos en vivo; 'append' = historial sincronizado al (re)conectar, útil para no perder los de la caída.
    if (type !== 'notify' && type !== 'append') return
    for (const msg of messages) {
      procesarMensaje(sock, msg).catch((e) => console.error('[shadow] Error procesando mensaje:', e.message))
    }
  })
}

// Validación (solo lectura). Travel Blue siempre; Manager solo si hay credenciales en el entorno.
const conManager = !!(process.env.MANAGER_USER && process.env.MANAGER_PASS)
iniciarValidador(db, { conManager })
if (conManager) console.log('[shadow] Validador contra Manager activo (solo lectura).')
else console.warn('[shadow] MANAGER_USER/MANAGER_PASS no están definidos: no se valida contra Manager (Travel Blue sí).')

// Latido cada minuto: permite chequear desde afuera (estado.json) que el listener sigue vivo.
setInterval(() => escribirEstado({ ...estado, latido: new Date().toISOString() }), 60_000)
setInterval(recargarConfig, 30_000)

conectar().catch((e) => {
  console.error('[shadow] Error fatal al iniciar:', e)
  process.exit(1)
})
