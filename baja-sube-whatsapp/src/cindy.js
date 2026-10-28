/**
 * Lector de la web de Cindy en Tiendanube (cindymayorista2.mitiendanube.com). SOLO LECTURA.
 * Reemplaza a la búsqueda en TiendaQuick (cindymayorista.com.ar) desde el 28/10/2026.
 *
 * Usa la misma búsqueda que la gente: `/search/?q=<código>`. Cada producto del resultado es un
 * `.js-item-product` del tema (Ipanema) con `data-variants` (JSON con las variantes: sku, stock,
 * available). Un código está publicado si alguna variante tiene ese SKU idéntico y está disponible;
 * si buscás el padre (`3M201`) y salen sus variantes (`3M201-GRE`), sigue publicado a través de ellas.
 * Si aparece pero ninguna variante está disponible, queda como `sin_stock` (no se puede comprar).
 *
 * Mientras la tienda esté en "modo construcción" pide una contraseña de acceso: el bot la toma de
 * TIENDANUBE_CLAVE_TIENDA (solo en el .env, nunca en el código ni en el chat), la manda una vez y
 * guarda la cookie de sesión de la tienda. Sin esa variable, la consulta falla con un error claro.
 */
const BASE_URL = (process.env.CINDY_TIENDA_URL || 'https://cindymayorista2.mitiendanube.com').replace(/\/$/, '')
const TIMEOUT_MS = 20_000
const UA = 'Mozilla/5.0 (bot de bajas Cindy)'

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', deg: '°' }
export const decodificar = (s) =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTIDADES[e] ?? m)

const limpiarTexto = (s) => decodificar(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * Productos de una página de resultados de Tiendanube:
 * [{nombre, url, variantes: [{sku, disponible}]}]. Un producto sin `data-variants` legible se ignora.
 */
export function leerProductos(html) {
  return String(html)
    .split(/(?=<div[^>]*\bjs-item-product\b)/)
    .filter((bloque) => /^<div[^>]*\bjs-item-product\b/.test(bloque)) // descarta lo que hay antes de la primera tarjeta
    .map((bloque) => {
      const crudo = /data-variants\s*=\s*"([^"]*)"/.exec(bloque)?.[1] ?? /data-variants\s*=\s*'([^']*)'/.exec(bloque)?.[1]
      if (crudo == null) return null
      let variantes
      try {
        variantes = JSON.parse(decodificar(crudo))
      } catch {
        return null
      }
      if (!Array.isArray(variantes)) return null
      const url = /href="([^"]*\/productos\/[^"]*)"/.exec(bloque)?.[1]
      const nombre =
        limpiarTexto(/class="[^"]*\bjs-item-name\b[^"]*"[^>]*>([\s\S]*?)<\//.exec(bloque)?.[1]) ||
        decodificar(/<a[^>]*\btitle="([^"]+)"/.exec(bloque)?.[1] || '').trim() ||
        null
      return {
        nombre,
        url: url ? new URL(decodificar(url), BASE_URL).href : null,
        variantes: variantes.map((v) => ({
          sku: String(v.sku ?? '').trim().toUpperCase(),
          // `available` es lo que usa el tema para habilitar "Comprar"; stock null = sin control de stock.
          disponible: v.available !== false && (v.stock == null || Number(v.stock) > 0),
        })),
      }
    })
    .filter(Boolean)
}

// ---- sesión de la tienda (cookie) ----
let cookies = new Map()
const cabeceraCookies = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
function guardarCookies(resp) {
  const lista = typeof resp.headers?.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
  for (const c of lista) {
    const [par] = c.split(';')
    const i = par.indexOf('=')
    if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim())
  }
}
/** Solo para tests: arranca sin sesión. */
export const reiniciarSesion = () => (cookies = new Map())

const esPaginaDeClave = (resp) => resp.status >= 300 && resp.status < 400 && /\/password\/?$/.test(resp.headers.get('location') || '')

async function pedir(fetchFn, url, opciones = {}) {
  const resp = await fetchFn(url, {
    redirect: 'manual', // la redirección a /password/ se detecta acá, no se sigue
    ...opciones,
    headers: { 'User-Agent': UA, Cookie: cabeceraCookies(), ...opciones.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  guardarCookies(resp)
  return resp
}

async function desbloquear(fetchFn, clave) {
  const resp = await pedir(fetchFn, `${BASE_URL}/password/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: clave }).toString(),
  })
  // Clave correcta: redirige fuera de /password/. Incorrecta: vuelve a mostrar el formulario (200) o redirige a /password/.
  if (esPaginaDeClave(resp) || resp.status === 200) throw new Error('La tienda de Tiendanube rechazó la contraseña de acceso (TIENDANUBE_CLAVE_TIENDA)')
}

/** estado: publicado | sin_stock | no_esta. Con `variantes` si llegó publicado solo a través de sus variantes. */
export async function consultarCindy(codigo, fetchFn = fetch, { clave = process.env.TIENDANUBE_CLAVE_TIENDA } = {}) {
  const url = `${BASE_URL}/search/?q=${encodeURIComponent(codigo)}`
  let resp = await pedir(fetchFn, url)
  if (esPaginaDeClave(resp)) {
    if (!clave) throw new Error('La tienda de Tiendanube pide contraseña: falta TIENDANUBE_CLAVE_TIENDA en el .env')
    await desbloquear(fetchFn, clave)
    resp = await pedir(fetchFn, url)
    if (esPaginaDeClave(resp)) throw new Error('La tienda de Tiendanube sigue pidiendo contraseña después de ingresarla')
  }
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status} en ${new URL(BASE_URL).host}`)
  const productos = leerProductos(await resp.text())

  const conVariante = (pred) =>
    productos.flatMap((p) => p.variantes.filter((v) => pred(v.sku)).map((v) => ({ ...v, nombre: p.nombre, url: p.url })))

  const exactas = conVariante((sku) => sku === codigo)
  if (exactas.length) {
    const v = exactas.find((x) => x.disponible) || exactas[0]
    return { estado: v.disponible ? 'publicado' : 'sin_stock', nombre: v.nombre, url: v.url }
  }
  const hijas = conVariante((sku) => sku.startsWith(codigo + '-'))
  if (hijas.length) {
    const disponibles = hijas.filter((v) => v.disponible)
    const ref = disponibles[0] || hijas[0]
    return {
      estado: disponibles.length ? 'publicado' : 'sin_stock',
      nombre: ref.nombre,
      url: ref.url,
      variantes: (disponibles.length ? disponibles : hijas).map((v) => v.sku),
    }
  }
  return { estado: 'no_esta' }
}
