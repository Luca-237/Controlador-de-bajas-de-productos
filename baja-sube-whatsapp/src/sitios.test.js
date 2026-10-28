import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consultarSitios } from './sitios.js'

/** fetch falso: `rutas` = { 'fragmento de URL': JSON | 'html' | {status} }. Gana el fragmento más largo. */
function fetchFalso(rutas) {
  const llamadas = []
  const fn = async (url) => {
    llamadas.push(url)
    const clave = Object.keys(rutas).filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0]
    const r = clave === undefined ? (url.includes('/search/') ? '' : []) : rutas[clave]
    const headers = { get: () => null, getSetCookie: () => [] }
    if (r?.status) return { ok: false, status: r.status, headers, json: async () => ({}), text: async () => '' }
    const texto = typeof r === 'string' ? r : JSON.stringify(r)
    return { ok: true, status: 200, headers, json: async () => JSON.parse(texto), text: async () => texto }
  }
  fn.llamadas = llamadas
  return fn
}

// Tarjeta de la tienda de Cindy en Tiendanube (tema Ipanema): las variantes van en data-variants.
const tarjetaCindy = (codigo) =>
  `<div class="js-item-product" data-variants="${JSON.stringify([{ sku: codigo, stock: 3, available: true }]).replace(/"/g, '&quot;')}"><a href="/productos/p/"><div class="js-item-name">PRODUCTO</div></a></div>`

test('publicado en Cindy y en la tienda TB; agotado en el catálogo no cuenta', async () => {
  const f = fetchFalso({
    'search/?q=8125': tarjetaCindy('8125'),
    'check_codigo&codigo=8125': { exists: true },
    'productos&q=8125': [{ codigo: '8125', estado: 'AGOTADO' }],
    'sku=8125': [{ id: 1, sku: '8125', is_in_stock: true }],
  })
  const r = await consultarSitios('8125', f)
  assert.equal(r.cindy.estado, 'publicado')
  assert.equal(r.catalogo.estado, 'agotado')
  assert.equal(r.tienda.estado, 'publicado')
  assert.deepEqual(r.publicadoEn, ['cindy', 'tienda'])
  assert.equal(r.aBajar, true)
  assert.equal(r.conError, false)
})

test('en ninguna página -> no hay que avisar', async () => {
  const r = await consultarSitios('3264106', fetchFalso({ check_codigo: { exists: false } }))
  assert.deepEqual(r.publicadoEn, [])
  assert.equal(r.aBajar, false)
})

test('si una página falla, las otras se informan igual', async () => {
  const f = fetchFalso({ '/search/': { status: 503 }, check_codigo: { status: 503 }, 'sku=8216': [{ id: 1, sku: '8216', is_in_stock: true }] })
  const r = await consultarSitios('8216', f)
  assert.equal(r.cindy.estado, 'error')
  assert.match(r.cindy.error, /HTTP 503/)
  assert.equal(r.catalogo.estado, 'error')
  assert.equal(r.tienda.estado, 'publicado')
  assert.equal(r.aBajar, true)
  assert.equal(r.conError, true)
})

test('rechaza códigos con caracteres peligrosos sin llamar a ninguna página', async () => {
  const f = fetchFalso({})
  await assert.rejects(consultarSitios("8216'&action=eliminar", f))
  assert.equal(f.llamadas.length, 0)
})
