/**
 * Lector de Travel Blue. SOLO LECTURA y solo endpoints públicos (sin credenciales):
 *  - Catálogo mayorista (bagsstore.com.ar/travelblue, ver proyectos/travelblue-catalogo-mayorista.md):
 *      `check_codigo` dice si el producto existe (aunque esté oculto) y `productos&q=` devuelve solo los
 *      visibles (`mostrar=1`) con su `estado` DISPONIBLE/AGOTADO.
 *  - Tienda minorista (travelblue.com.ar, WooCommerce): Store API `wc/store/v1/products?sku=`. Solo
 *      devuelve productos publicados. El SKU de Woo es el CodigoArticulo de Manager; las variantes
 *      (`8988-BLU`) no se encuentran por SKU directo, así que se busca el padre y se recorren sus variaciones.
 *
 * Los dos sitios usan el mismo código que Manager, así que un código del grupo se busca tal cual.
 * Los códigos vienen de WhatsApp (texto de terceros): sitios.js los valida con CODIGO_SEGURO antes de
 * llegar acá, y van siempre con encodeURIComponent.
 */
const CATALOGO_URL = process.env.TB_CATALOGO_URL || 'https://bagsstore.com.ar/travelblue/api.php'
const TIENDA_URL = process.env.TB_TIENDA_URL || 'https://travelblue.com.ar/wp-json/wc/store/v1/products'
const TIMEOUT_MS = 20_000

/** Padre de un código de variante (`8988-BLU` -> `8988`), o null si no tiene forma de variante. */
export function padreDe(codigo) {
  const m = /^(.+)-[A-Z]{2,6}$/.exec(codigo)
  return m ? m[1] : null
}

async function getJson(fetchFn, url) {
  const resp = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} en ${new URL(url).host}`)
  return resp.json()
}

/**
 * Catálogo mayorista. estado: publicado | agotado | oculto | no_esta.
 * El catálogo guarda los productos por código padre (los colores van aparte), así que una variante
 * se resuelve por su padre (`porPadre: true`).
 */
export async function consultarCatalogo(codigo, fetchFn = fetch) {
  const candidatos = [codigo, padreDe(codigo)].filter(Boolean)
  for (const c of candidatos) {
    const { exists } = await getJson(fetchFn, `${CATALOGO_URL}?action=check_codigo&codigo=${encodeURIComponent(c)}`)
    if (!exists) continue
    const visibles = await getJson(fetchFn, `${CATALOGO_URL}?action=productos&q=${encodeURIComponent(c)}`)
    const p = (Array.isArray(visibles) ? visibles : []).find((x) => String(x.codigo).toUpperCase() === c)
    const estado = !p ? 'oculto' : p.estado === 'AGOTADO' ? 'agotado' : 'publicado'
    return { estado, codigo: c, porPadre: c !== codigo, descripcion: p?.descripcion ?? null }
  }
  return { estado: 'no_esta' }
}

/** Tienda minorista WooCommerce. estado: publicado | sin_stock | no_esta (no existe o no está publicado). */
export async function consultarTienda(codigo, fetchFn = fetch) {
  const porSku = async (sku) => {
    const r = await getJson(fetchFn, `${TIENDA_URL}?sku=${encodeURIComponent(sku)}`)
    return (Array.isArray(r) ? r : []).find((x) => String(x.sku).toUpperCase() === sku) || null
  }
  const resultado = (p, extra = {}) => ({
    estado: p.is_in_stock ? 'publicado' : 'sin_stock',
    nombre: p.name ?? null,
    url: p.permalink ?? null,
    ...extra,
  })

  const directo = await porSku(codigo)
  if (directo) return resultado(directo)

  const padre = padreDe(codigo)
  if (!padre) return { estado: 'no_esta' }
  const prodPadre = await porSku(padre)
  if (!prodPadre) return { estado: 'no_esta' }
  // Secuencial a propósito: son pocas variaciones y no hay apuro (no martillar el sitio).
  for (const v of prodPadre.variations || []) {
    const variacion = await getJson(fetchFn, `${TIENDA_URL}/${encodeURIComponent(v.id)}`)
    if (String(variacion.sku).toUpperCase() === codigo) return resultado(variacion, { nombre: prodPadre.name ?? null })
  }
  // El padre está publicado pero esa variante no aparece: no se publica (o ya se sacó).
  return { estado: 'no_esta', padrePublicado: true }
}
