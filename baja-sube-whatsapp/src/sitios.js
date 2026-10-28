/**
 * Revisa en qué páginas sigue publicado un código: web de Cindy en Tiendanube, catálogo mayorista de Travel Blue y
 * tienda travelblue.com.ar. Solo lectura (la tienda de Cindy, mientras esté en construcción, con su clave de acceso). No da de baja nada: avisa.
 *
 * Criterio de "sigue publicado" (decidido 28/10/2026):
 *  - Cindy (Tiendanube): aparece en la búsqueda y se puede comprar (el código o, si es padre, alguna de sus variantes).
 *  - Catálogo TB: visible y DISPONIBLE. "Agotado" cuenta como dado de baja.
 *  - Tienda TB: publicado y con stock.
 * Si una página falla, las otras se informan igual (cada una trae su propio `error`).
 */
import { CODIGO_SEGURO } from './logica.js'
import { consultarCindy } from './cindy.js'
import { consultarCatalogo, consultarTienda } from './travelblue.js'

export const SITIOS = [
  { clave: 'cindy', nombre: 'Web Cindy (Tiendanube)', consultar: consultarCindy },
  { clave: 'catalogo', nombre: 'Catálogo Travel Blue', consultar: consultarCatalogo },
  { clave: 'tienda', nombre: 'Tienda Travel Blue', consultar: consultarTienda },
]

/** @returns {Promise<{cindy:object, catalogo:object, tienda:object, publicadoEn:string[], aBajar:boolean, conError:boolean}>} */
export async function consultarSitios(codigo, fetchFn = fetch) {
  if (!CODIGO_SEGURO.test(codigo)) throw new Error(`Código con caracteres no permitidos: ${JSON.stringify(codigo)}`)
  const res = {}
  // Secuencial a propósito: tres pedidos por código alcanzan y no hay apuro (no martillar las páginas).
  for (const s of SITIOS) {
    try {
      res[s.clave] = await s.consultar(codigo, fetchFn)
    } catch (err) {
      res[s.clave] = { estado: 'error', error: err.message }
    }
  }
  const publicadoEn = SITIOS.filter((s) => res[s.clave].estado === 'publicado').map((s) => s.clave)
  return {
    ...res,
    publicadoEn,
    aBajar: publicadoEn.length > 0,
    conError: SITIOS.some((s) => res[s.clave].estado === 'error'),
  }
}
