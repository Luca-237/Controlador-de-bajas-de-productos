/**
 * Lector de Manager2Max (API MaxWeb2). SOLO LECTURA: únicamente `SELECT` vía /Api/sqlexecute/ExecuteSelect.
 *
 * Reglas del vault (conocimiento/manager2max.md):
 *  - credencial `ClientifyAPI` de solo lectura; usuario y clave SOLO por variables de entorno
 *    MANAGER_USER / MANAGER_PASS (nunca en el código ni en el repo);
 *  - nunca se manda un endpoint de escritura ni SQL que no empiece con SELECT;
 *  - ExecuteSelect es SQL crudo y los códigos vienen de WhatsApp (texto de terceros): cada código se
 *    valida con CODIGO_SEGURO antes de interpolarse. Defensa en profundidad además del parser.
 *  - ojo: los literales de fecha 'YYYY-MM-DD' se interpretan mal en esta API; acá no se usan fechas.
 */
import { CODIGO_SEGURO, filtrarVariantes } from './logica.js'

const BASE_URL = process.env.MANAGER_BASE_URL || 'http://190.123.85.167:2022'
const ID_EMPRESA = Number(process.env.MANAGER_ID_EMPRESA || 3)
const TIMEOUT_MS = 60_000

let token = null

async function post(ruta, cuerpo, conToken = true) {
  const headers = { 'Content-Type': 'application/json' }
  if (conToken && token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(BASE_URL + ruta, {
    method: 'POST',
    headers,
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (resp.status === 401) return { ErrCode: 401, ErrMessage: 'No autorizado (token vencido)' }
  if (!resp.ok) throw new Error(`Manager respondió HTTP ${resp.status}`)
  return JSON.parse(await resp.text())
}

async function login() {
  const usuario = process.env.MANAGER_USER
  const clave = process.env.MANAGER_PASS
  if (!usuario || !clave) throw new Error('Faltan MANAGER_USER / MANAGER_PASS en el entorno de este proceso')
  const d = await post('/Api/Login/LoginUsuarioEmpresa', { CodigoUsuario: usuario, 'Contraseña': clave, IDEmpresa: ID_EMPRESA }, false)
  if (d.ErrCode !== 200) throw new Error(`Login a Manager fallido: ${d.ErrMessage}`)
  token = d.Token
}

/** Ejecuta un SELECT. Reintenta una vez con login nuevo si el token venció. */
async function select(sql) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Solo se permiten consultas SELECT')
  if (!token) await login()
  let d = await post('/Api/sqlexecute/ExecuteSelect', { SQL: sql, ReturnFormat: 'json' })
  if (d.ErrCode === 401 || /token|autoriz/i.test(String(d.ErrMessage || ''))) {
    await login()
    d = await post('/Api/sqlexecute/ExecuteSelect', { SQL: sql, ReturnFormat: 'json' })
  }
  if (d.ErrCode !== 200) throw new Error(`Manager: ${d.ErrMessage}`)
  const data = d.Data?.data
  return typeof data === 'string' ? JSON.parse(data) : data || []
}

function asegurar(codigos) {
  for (const c of codigos) {
    if (!CODIGO_SEGURO.test(c)) throw new Error(`Código con caracteres no permitidos, no se consulta: ${JSON.stringify(c)}`)
  }
}

const FROM = `FROM StkArticulo a LEFT JOIN ECMArticulo e ON e.IDArticulo = a.IDArticulo`

const aArticulo = (r) => ({
  existe: true,
  id: r.IDArticulo,
  codigo: String(r.CodigoArticulo).trim().toUpperCase(),
  descripcion: String(r.Descripcion || '').trim(),
  noVigente: !!r.NoVigente,
  sube: r.Sube == null ? null : Number(r.Sube),
})

/**
 * Busca varios códigos de una vez. El match es exacto sobre CodigoArticulo (la colación de Manager no
 * distingue mayúsculas, por eso se normaliza a mayúsculas del lado nuestro).
 * @returns {Promise<Map<string, ReturnType<typeof aArticulo>>>} solo los que existen
 */
export async function consultarCodigos(codigos) {
  const unicos = [...new Set(codigos)]
  asegurar(unicos)
  const resultado = new Map()
  for (let i = 0; i < unicos.length; i += 50) {
    const lote = unicos.slice(i, i + 50)
    const lista = lote.map((c) => `'${c}'`).join(',')
    const filas = await select(
      `SELECT a.IDArticulo, a.CodigoArticulo, a.Descripcion, a.NoVigente, e.Sube ${FROM} WHERE a.CodigoArticulo IN (${lista})`
    )
    for (const f of filas) {
      const art = aArticulo(f)
      resultado.set(art.codigo, art)
    }
  }
  return resultado
}

/** Variantes reales de un padre: hijos `PADRE-XXX` filtrados con la heurística validada en el sync a Odoo. */
export async function consultarVariantes(padre, descPadre) {
  asegurar([padre])
  const filas = await select(
    `SELECT a.IDArticulo, a.CodigoArticulo, a.Descripcion, a.NoVigente, e.Sube ${FROM} WHERE a.CodigoArticulo LIKE '${padre}-%'`
  )
  const candidatos = filas.map(aArticulo).map((a) => ({
    codigo: a.codigo, descripcion: a.descripcion, sube: a.sube, noVigente: a.noVigente,
  }))
  return filtrarVariantes(padre, descPadre, candidatos)
}
