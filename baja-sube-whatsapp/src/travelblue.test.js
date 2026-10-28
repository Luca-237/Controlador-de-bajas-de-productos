import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padreDe, consultarCatalogo, consultarTienda } from './travelblue.js'

/**
 * fetch falso: responde según la URL con datos copiados de los sitios reales (28/10/2026).
 * `rutas` = { 'fragmento de URL': respuesta | Error }. Gana el fragmento más largo que coincida.
 */
function fetchFalso(rutas) {
  const llamadas = []
  const fn = async (url) => {
    llamadas.push(url)
    const clave = Object.keys(rutas).filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0]
    if (clave === undefined) return { ok: true, status: 200, json: async () => [] }
    const r = rutas[clave]
    if (r instanceof Error) throw r
    if (r?.status) return { ok: false, status: r.status, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => r }
  }
  fn.llamadas = llamadas
  return fn
}

const NO_EXISTE = { exists: false }
const EXISTE = { exists: true }

test('padreDe: solo códigos con sufijo de color', () => {
  assert.equal(padreDe('8988-BLU'), '8988')
  assert.equal(padreDe('167.0800127-BEI'), '167.0800127')
  assert.equal(padreDe('8988'), null)
  assert.equal(padreDe('83606-1'), null)
})

test('catálogo: visible y disponible -> publicado', async () => {
  const f = fetchFalso({
    'check_codigo&codigo=8216': EXISTE,
    'productos&q=8216': [{ codigo: '8216', estado: 'DISPONIBLE', descripcion: 'ALMOHADA CERVICAL' }],
  })
  assert.deepEqual(await consultarCatalogo('8216', f), { estado: 'publicado', codigo: '8216', porPadre: false, descripcion: 'ALMOHADA CERVICAL' })
})

test('catálogo: visible pero AGOTADO -> agotado', async () => {
  const f = fetchFalso({ 'check_codigo&codigo=8125': EXISTE, 'productos&q=8125': [{ codigo: '8125', estado: 'AGOTADO' }] })
  assert.equal((await consultarCatalogo('8125', f)).estado, 'agotado')
})

test('catálogo: existe pero no aparece en los visibles -> oculto', async () => {
  const f = fetchFalso({ 'check_codigo&codigo=8230': EXISTE, 'productos&q=8230': [] })
  assert.equal((await consultarCatalogo('8230', f)).estado, 'oculto')
})

test('catálogo: la búsqueda es LIKE, solo cuenta la coincidencia exacta del código', async () => {
  const f = fetchFalso({ 'check_codigo&codigo=8216': EXISTE, 'productos&q=8216': [{ codigo: '82160', estado: 'DISPONIBLE' }] })
  assert.equal((await consultarCatalogo('8216', f)).estado, 'oculto')
})

test('catálogo: una variante se resuelve por su padre', async () => {
  const f = fetchFalso({
    'check_codigo&codigo=8988-BLU': NO_EXISTE,
    'check_codigo&codigo=8988': EXISTE,
    'productos&q=8988': [{ codigo: '8988', estado: 'DISPONIBLE' }],
  })
  const r = await consultarCatalogo('8988-BLU', f)
  assert.equal(r.estado, 'publicado')
  assert.equal(r.porPadre, true)
})

test('catálogo: código de Cindy que no es de Travel Blue -> no_esta', async () => {
  const f = fetchFalso({ check_codigo: NO_EXISTE })
  assert.deepEqual(await consultarCatalogo('3264106', f), { estado: 'no_esta' })
})

test('tienda: producto simple por SKU, con y sin stock', async () => {
  const p = { id: 6886, sku: '8216', name: 'Almohada cervical', permalink: 'https://travelblue.com.ar/producto/almohada/', is_in_stock: true }
  assert.deepEqual(await consultarTienda('8216', fetchFalso({ 'sku=8216': [p] })), {
    estado: 'publicado', nombre: 'Almohada cervical', url: 'https://travelblue.com.ar/producto/almohada/',
  })
  assert.equal((await consultarTienda('8216', fetchFalso({ 'sku=8216': [{ ...p, is_in_stock: false }] }))).estado, 'sin_stock')
})

test('tienda: variante -> busca el padre y recorre sus variaciones', async () => {
  const f = fetchFalso({
    'sku=8988-VIO': [],
    'sku=8988': [{ id: 6357, sku: '8988', name: 'Cable USB 2 en 1', variations: [{ id: 6439 }, { id: 6440 }] }],
    'products/6439': { id: 6439, sku: '8988-BLU', is_in_stock: true, permalink: 'u-blu' },
    'products/6440': { id: 6440, sku: '8988-VIO', is_in_stock: true, permalink: 'u-vio' },
  })
  assert.deepEqual(await consultarTienda('8988-VIO', f), { estado: 'publicado', nombre: 'Cable USB 2 en 1', url: 'u-vio' })
})

test('tienda: padre publicado pero esa variante no -> no_esta con aviso', async () => {
  const f = fetchFalso({
    'sku=8988': [{ id: 6357, sku: '8988', variations: [{ id: 6439 }] }],
    'products/6439': { id: 6439, sku: '8988-BLU', is_in_stock: true },
  })
  assert.deepEqual(await consultarTienda('8988-ROS', f), { estado: 'no_esta', padrePublicado: true })
})

test('tienda: no publicado -> no_esta (sin buscar padre si no es variante)', async () => {
  const f = fetchFalso({})
  assert.deepEqual(await consultarTienda('3264106', f), { estado: 'no_esta' })
  assert.equal(f.llamadas.length, 1)
})
