/**
 * Autenticación del panel, sin dependencias:
 *  - contraseña única guardada como hash scrypt en PANEL_PASSWORD_HASH (se genera con `npm run set-password`,
 *    la clave nunca pasa por el chat ni queda en texto plano);
 *  - sesión = cookie firmada con HMAC-SHA256 (HttpOnly, SameSite=Strict, Secure detrás de HTTPS);
 *  - límite de intentos de login por IP;
 *  - las rutas que escriben exigen el header X-Requested-With (defensa extra contra CSRF).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const COOKIE = 'bajas_sid'
const DURACION_MS = 12 * 60 * 60 * 1000
const MAX_INTENTOS = 5
const VENTANA_MS = 10 * 60 * 1000

export function hashearClave(clave) {
  const sal = crypto.randomBytes(16)
  const hash = crypto.scryptSync(clave, sal, 64)
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`
}

export function verificarClave(clave, guardado) {
  const [tipo, salHex, hashHex] = String(guardado || '').split('$')
  if (tipo !== 'scrypt' || !salHex || !hashHex) return false
  const esperado = Buffer.from(hashHex, 'hex')
  const calculado = crypto.scryptSync(clave, Buffer.from(salHex, 'hex'), esperado.length)
  return crypto.timingSafeEqual(esperado, calculado)
}

function secretoDeSesion() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  const archivo = path.resolve(process.cwd(), process.env.SESSION_KEY_FILE || './data/session.key')
  if (!fs.existsSync(archivo)) {
    fs.mkdirSync(path.dirname(archivo), { recursive: true })
    fs.writeFileSync(archivo, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return fs.readFileSync(archivo, 'utf8').trim()
}

export function crearSesion() {
  const secreto = secretoDeSesion()
  const carga = Buffer.from(JSON.stringify({ exp: Date.now() + DURACION_MS })).toString('base64url')
  const firma = crypto.createHmac('sha256', secreto).update(carga).digest('base64url')
  return `${carga}.${firma}`
}

export function sesionValida(valor) {
  if (!valor || !valor.includes('.')) return false
  const [carga, firma] = valor.split('.')
  const esperada = crypto.createHmac('sha256', secretoDeSesion()).update(carga).digest('base64url')
  const a = Buffer.from(firma)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    return JSON.parse(Buffer.from(carga, 'base64url').toString()).exp > Date.now()
  } catch {
    return false
  }
}

export function leerCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

export function ponerCookie(req, res, valor) {
  const seguro = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(DURACION_MS / 1000)}${seguro ? '; Secure' : ''}`
  )
}

export function borrarCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
}

const intentos = new Map() // ip -> { n, desde }
export function limitarIntentos(ip) {
  const ahora = Date.now()
  const r = intentos.get(ip)
  if (!r || ahora - r.desde > VENTANA_MS) {
    intentos.set(ip, { n: 1, desde: ahora })
    return true
  }
  r.n++
  return r.n <= MAX_INTENTOS
}
export const reiniciarIntentos = (ip) => intentos.delete(ip)

export function exigirSesion(req, res, next) {
  if (!sesionValida(leerCookie(req))) return res.status(401).json({ error: 'No autenticado' })
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'panel') {
    return res.status(403).json({ error: 'Solicitud no permitida' })
  }
  next()
}
