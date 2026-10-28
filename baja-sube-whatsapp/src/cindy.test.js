import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { leerProductos, consultarCindy, decodificar, reiniciarSesion } from './cindy.js'

/** Tarjeta con la estructura del tema Ipanema de Tiendanube (recortada). `data-variants` va escapado como en el HTML real. */
const tarjeta = (nombre, slug, variantes) => `
<div class="js-item-product col-6 item-product" data-product-id="1" data-variants="${JSON.stringify(variantes).replace(/"/g, '&quot;')}">
  <a href="https://cindymayorista2.mitiendanube.com/productos/${slug}/" title="${nombre}">
    <div class="js-item-name item-name">${nombre}</div>
  </a>
</div>`
const pagina = (...t) => `<html><body><div class="js-product-table">${t.join('')}</div></body></html>`

/**
 * fetch falso de la tienda. `clave` = la contraseña correcta (null = tienda abierta).
 * Sin la cookie de sesión, /search/ redirige a /password/ como la tienda real.
 */
function tiendaFalsa(html, { clave = null, status = 200 } = {}) {
  const llamadas = []
  const fn = async (url, op = {}) => {
    llamadas.push({ url, metodo: op.method || 'GET', cuerpo: op.body })
    const desbloqueada = (op.headers?.Cookie || '').includes('store_login_session=ok')
    const resp = (status, extra = {}) => ({
      status,
      ok: status < 400,
      headers: { get: (h) => (h.toLowerCase() === 'location' ? extra.location ?? null : null), getSetCookie: () => extra.cookies || [] },
      text: async () => extra.html ?? '',
    })
    if (url.endsWith('/password/') && op.method === 'POST') {
      return new URLSearchParams(op.body).get('password') === clave
        ? resp(302, { location: 'https://cindymayorista2.mitiendanube.com/', cookies: ['store_login_session=ok; path=/; secure'] })
        : resp(200, { html: '<form id="password-form">' })
    }
    if (clave && !desbloqueada) return resp(302, { location: 'https://cindymayorista2.mitiendanube.com/password/' })
    return resp(status, { html })
  }
  fn.llamadas = llamadas
  return fn
}

beforeEach(() => reiniciarSesion())

const MOCHILA = tarjeta('Mochila Flow Chimola', 'mochila-flow', [
  { id: 1, sku: '3M201-GRE', stock: 4, available: true },
  { id: 2, sku: '3M201-PAL', stock: 0, available: false },
])

test('decodifica entidades HTML', () => {
  assert.equal(decodificar('Mu&ntilde;eca &amp; coche&#039;s'), "Muñeca & coche's")
})

test('lee nombre, link y SKU/disponibilidad de cada variante', () => {
  assert.deepEqual(leerProductos(pagina(MOCHILA)), [
    {
      nombre: 'Mochila Flow Chimola',
      url: 'https://cindymayorista2.mitiendanube.com/productos/mochila-flow/',
      variantes: [{ sku: '3M201-GRE', disponible: true }, { sku: '3M201-PAL', disponible: false }],
    },
  ])
})

test('SKU exacto disponible -> publicado; sin stock -> sin_stock', async () => {
  assert.equal((await consultarCindy('3M201-GRE', tiendaFalsa(pagina(MOCHILA)))).estado, 'publicado')
  const r = await consultarCindy('3M201-PAL', tiendaFalsa(pagina(MOCHILA)))
  assert.equal(r.estado, 'sin_stock')
  assert.equal(r.url, 'https://cindymayorista2.mitiendanube.com/productos/mochila-flow/')
})

test('padre: publicado por sus variantes disponibles', async () => {
  const r = await consultarCindy('3M201', tiendaFalsa(pagina(MOCHILA)))
  assert.equal(r.estado, 'publicado')
  assert.deepEqual(r.variantes, ['3M201-GRE'])
})

test('la búsqueda es por texto: otros productos o un SKU parecido no cuentan', async () => {
  const otro = tarjeta('Mochila 3M2010', 'otra', [{ sku: '3M2010', stock: 5, available: true }])
  assert.deepEqual(await consultarCindy('3M20', tiendaFalsa(pagina(MOCHILA, otro))), { estado: 'no_esta' })
  assert.deepEqual(await consultarCindy('3264106', tiendaFalsa(pagina())), { estado: 'no_esta' })
})

test('stock null (sin control de stock) cuenta como disponible', async () => {
  const p = tarjeta('Taza', 'taza', [{ sku: '9X1', stock: null, available: true }])
  assert.equal((await consultarCindy('9X1', tiendaFalsa(pagina(p)))).estado, 'publicado')
})

test('tienda con contraseña: entra con la clave del .env y reusa la sesión', async () => {
  const f = tiendaFalsa(pagina(MOCHILA), { clave: 'secreta' })
  assert.equal((await consultarCindy('3M201-GRE', f, { clave: 'secreta' })).estado, 'publicado')
  assert.deepEqual(f.llamadas.map((l) => l.metodo), ['GET', 'POST', 'GET'])
  await consultarCindy('3M201', f, { clave: 'secreta' })
  assert.equal(f.llamadas.length, 4) // segunda consulta: ya tiene la cookie, no vuelve a mandar la clave
})

test('tienda con contraseña: sin clave o con clave incorrecta da un error claro', async () => {
  await assert.rejects(consultarCindy('3M201', tiendaFalsa(pagina(MOCHILA), { clave: 'secreta' }), { clave: '' }), /falta TIENDANUBE_CLAVE_TIENDA/)
  await assert.rejects(consultarCindy('3M201', tiendaFalsa(pagina(MOCHILA), { clave: 'secreta' }), { clave: 'otra' }), /rechazó la contraseña/)
})

test('error HTTP de la tienda -> lanza', async () => {
  await assert.rejects(consultarCindy('3M201', tiendaFalsa('', { status: 503 })), /HTTP 503/)
})
