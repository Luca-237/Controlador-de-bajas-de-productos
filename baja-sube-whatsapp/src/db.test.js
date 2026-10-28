import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abrirDb, registrarReporte, registrarReaccion, codigosPorValidar, aplicarValidacion, listar, codigosABajar, conteos, descartar,
  codigosParaRevisarSitios, guardarSitios, listarHistorial, resumenHistorial,
} from './db.js'

const rep = (msg_id, codigo, ts = '2026-10-17T14:00:00.000Z', de = 'Agustina') => ({ msg_id, codigo, de, jid: 'x@lid', ts })

test('un reporte nuevo queda por_validar; el mismo mensaje no se duplica', () => {
  const db = abrirDb(':memory:')
  assert.deepEqual(registrarReporte(db, rep('M1', '131904')), { nuevo: true, repetido: false })
  assert.deepEqual(registrarReporte(db, rep('M1', '131904')), { nuevo: false, repetido: false })
  assert.deepEqual(codigosPorValidar(db), ['131904'])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reportes').get().n, 1)
})

test('varios códigos en el mismo mensaje se guardan por separado', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '167.0800268'))
  registrarReporte(db, rep('M1', '167.0800267'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM codigos').get().n, 2)
})

test('un código repetido en otro mensaje sube el contador y se vuelve a validar', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '132059', '2026-10-16T10:00:00.000Z'))
  aplicarValidacion(db, '132059', { estado: 'procesado', aBajar: [], articulo: { sube: 0 } })
  assert.equal(db.prepare("SELECT ya_estaba FROM codigos WHERE codigo='132059'").get().ya_estaba, 1)
  const r = registrarReporte(db, rep('M2', '132059', '2026-10-17T10:00:00.000Z'))
  assert.deepEqual(r, { nuevo: false, repetido: true })
  const c = db.prepare("SELECT veces, estado, ya_estaba FROM codigos WHERE codigo='132059'").get()
  assert.equal(c.veces, 2)
  assert.equal(c.estado, 'por_validar')
  assert.equal(c.ya_estaba, 0)
})

test('"ya estaba" solo se marca si Manager ya lo tenía en 0 en la primera validación', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', 'A1111'))
  aplicarValidacion(db, 'A1111', { estado: 'pendiente', aBajar: ['A1111'], articulo: { sube: 1 } })
  aplicarValidacion(db, 'A1111', { estado: 'procesado', aBajar: [], articulo: { sube: 0 } }) // lo bajó una persona
  const c = db.prepare("SELECT estado, ya_estaba, procesado_ts FROM codigos WHERE codigo='A1111'").get()
  assert.equal(c.estado, 'procesado')
  assert.equal(c.ya_estaba, 0)
  assert.ok(c.procesado_ts)
})

test('procesado_ts no se pisa en validaciones posteriores', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', 'B2222'))
  aplicarValidacion(db, 'B2222', { estado: 'procesado', aBajar: [] }, '2026-10-17T10:00:00.000Z')
  aplicarValidacion(db, 'B2222', { estado: 'procesado', aBajar: [] }, '2026-10-17T11:00:00.000Z')
  assert.equal(db.prepare("SELECT procesado_ts p FROM codigos WHERE codigo='B2222'").get().p, '2026-10-17T10:00:00.000Z')
})

test('codigosABajar junta padre+variantes pendientes sin repetidos y respeta descartados', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '129518'))
  registrarReporte(db, rep('M2', '129518-NEG'))
  registrarReporte(db, rep('M3', '99999'))
  aplicarValidacion(db, '129518', { estado: 'pendiente', aBajar: ['129518-BEI', '129518-NEG'] })
  aplicarValidacion(db, '129518-NEG', { estado: 'pendiente', aBajar: ['129518-NEG'] })
  aplicarValidacion(db, '99999', { estado: 'pendiente', aBajar: ['99999'] })
  assert.deepEqual(codigosABajar(db), ['129518-BEI', '129518-NEG', '99999'])
  descartar(db, '99999', true, 'falso positivo')
  assert.deepEqual(codigosABajar(db), ['129518-BEI', '129518-NEG'])
})

test('reacción de una persona: alerta si Manager todavía tiene Sube=1', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '862.3100006'))
  aplicarValidacion(db, '862.3100006', { estado: 'pendiente', aBajar: ['862.3100006'] })
  assert.equal(registrarReaccion(db, { objetivo_msg_id: 'M1', emoji: '👍', de: 'Luca', ts: '2026-10-17T15:00:00.000Z' }), 1)
  const [c] = listar(db, { filtro: 'pendientes' })
  assert.equal(c.reaccionado, true)
  assert.equal(c.reaccionado_pero_pendiente, true)
  // Quita la reacción -> sin alerta
  registrarReaccion(db, { objetivo_msg_id: 'M1', emoji: '', ts: '2026-10-17T15:01:00.000Z' })
  assert.equal(listar(db, { filtro: 'pendientes' })[0].reaccionado_pero_pendiente, false)
})

test('reacción a un mensaje sin códigos no hace nada', () => {
  const db = abrirDb(':memory:')
  assert.equal(registrarReaccion(db, { objetivo_msg_id: 'NO-EXISTE', emoji: '👍', ts: '2026-10-17T15:00:00.000Z' }), 0)
})

test('listar filtra por estado y búsqueda; conteos coherentes', () => {
  const db = abrirDb(':memory:')
  for (const [i, c] of ['A1111', 'B2222', 'C3333'].entries()) registrarReporte(db, rep('M' + i, c, `2026-10-17T1${i}:00:00.000Z`))
  aplicarValidacion(db, 'A1111', { estado: 'pendiente', aBajar: ['A1111'], articulo: { descripcion: 'MOCHILA TRENDY' } })
  aplicarValidacion(db, 'B2222', { estado: 'no_existe', aBajar: [] })
  aplicarValidacion(db, 'C3333', { estado: 'procesado', aBajar: [] })
  assert.deepEqual(listar(db, { filtro: 'pendientes' }).map((c) => c.codigo), ['A1111'])
  assert.deepEqual(listar(db, { filtro: 'errores' }).map((c) => c.codigo), ['B2222'])
  assert.deepEqual(listar(db, { filtro: 'todos' }).map((c) => c.codigo), ['C3333', 'B2222', 'A1111']) // más reciente primero
  assert.deepEqual(listar(db, { filtro: 'todos', q: 'mochila' }).map((c) => c.codigo), ['A1111'])
  const n = conteos(db)
  assert.equal(n.pendientes, 1)
  assert.equal(n.errores, 1)
  assert.equal(n.procesados, 1)
  assert.equal(n.total, 3)
})

const TB_PUBLICADO = { catalogo: { estado: 'publicado' }, tienda: { estado: 'no_esta' }, aBajar: true, conError: false }
const TB_NADA = { catalogo: { estado: 'no_esta' }, tienda: { estado: 'no_esta' }, aBajar: false, conError: false }

test('páginas: códigos nuevos se consultan aunque Manager no los haya validado', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216'))
  assert.deepEqual(codigosParaRevisarSitios(db), ['8216'])
  guardarSitios(db, '8216', TB_NADA, '2026-10-28T10:00:00.000Z')
  assert.deepEqual(codigosParaRevisarSitios(db, { ahora: Date.parse('2026-10-28T10:05:00.000Z') }), [])
})

test('páginas: lo que sigue a la venta se vuelve a revisar pasado el intervalo; lo demás no', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216'))
  registrarReporte(db, rep('M2', '3264106'))
  guardarSitios(db, '8216', TB_PUBLICADO, '2026-10-28T10:00:00.000Z')
  guardarSitios(db, '3264106', TB_NADA, '2026-10-28T10:00:00.000Z')
  const despues = Date.parse('2026-10-28T10:11:00.000Z')
  assert.deepEqual(codigosParaRevisarSitios(db, { ahora: despues }), ['8216'])
  assert.equal(conteos(db).publicados, 1)
  const [fila] = listar(db, { filtro: 'todos', q: '8216' })
  assert.equal(fila.web.catalogo.estado, 'publicado')
})

test('páginas: un re-reporte fuerza consultar de nuevo; descartados y no_existe no se consultan', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216'))
  guardarSitios(db, '8216', TB_NADA)
  registrarReporte(db, rep('M2', '8216'))
  assert.deepEqual(codigosParaRevisarSitios(db), ['8216'])
  descartar(db, '8216', true)
  registrarReporte(db, rep('M3', 'NOEXISTE1'))
  aplicarValidacion(db, 'NOEXISTE1', { estado: 'no_existe', aBajar: [] })
  assert.deepEqual(codigosParaRevisarSitios(db), [])
})

test('una base vieja sin columnas de páginas se migra sola al abrirla', () => {
  const db = abrirDb(':memory:')
  const cols = db.prepare('PRAGMA table_info(codigos)').all().map((c) => c.name)
  for (const c of ['web', 'web_ts', 'web_a_bajar', 'web_error']) assert.ok(cols.includes(c), c)
})

// ---- historial de bajas ----
const sitios = (cindy, catalogo, tienda) => {
  const r = { cindy: { estado: cindy }, catalogo: { estado: catalogo }, tienda: { estado: tienda } }
  r.publicadoEn = Object.keys(r).filter((k) => r[k].estado === 'publicado')
  r.aBajar = r.publicadoEn.length > 0
  r.conError = [cindy, catalogo, tienda].includes('error')
  return r
}
const eventos = (db) => db.prepare('SELECT codigo, sitio, tipo, estado FROM historial ORDER BY id').all().map((e) => ({ ...e }))

test('historial: primera revisión anota dónde seguía y dónde ya no estaba', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216'))
  guardarSitios(db, '8216', sitios('publicado', 'agotado', 'no_esta'), '2026-10-28T10:00:00.000Z')
  assert.deepEqual(eventos(db), [
    { codigo: '8216', sitio: 'cindy', tipo: 'seguia_publicado', estado: 'publicado' },
    { codigo: '8216', sitio: 'catalogo', tipo: 'ya_no_estaba', estado: 'agotado' },
    { codigo: '8216', sitio: 'tienda', tipo: 'ya_no_estaba', estado: 'no_esta' },
  ])
})

test('historial: publicado -> no está es una baja; sin cambios no se anota nada', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216', '2026-10-28T09:00:00.000Z', 'Agustina'))
  guardarSitios(db, '8216', sitios('publicado', 'publicado', 'no_esta'), '2026-10-28T10:00:00.000Z')
  guardarSitios(db, '8216', sitios('publicado', 'publicado', 'no_esta'), '2026-10-28T10:10:00.000Z')
  assert.equal(eventos(db).length, 3) // la segunda revisión no cambió nada
  guardarSitios(db, '8216', sitios('no_esta', 'agotado', 'no_esta'), '2026-10-28T11:00:00.000Z')
  const bajas = listarHistorial(db, { tipo: 'bajas' })
  assert.deepEqual(bajas.map((b) => [b.sitio, b.estado]), [['catalogo', 'agotado'], ['cindy', 'no_esta']]) // más nuevo primero
  assert.equal(bajas[0].primer_de, 'Agustina')
  assert.equal(bajas[0].demora_ms, 2 * 3600_000) // reportado 9:00, bajado 11:00
})

test('historial: un error de red no cuenta como baja ni pisa el último dato bueno', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216'))
  guardarSitios(db, '8216', sitios('publicado', 'no_esta', 'no_esta'), '2026-10-28T10:00:00.000Z')
  guardarSitios(db, '8216', sitios('error', 'no_esta', 'no_esta'), '2026-10-28T10:10:00.000Z')
  assert.equal(eventos(db).filter((e) => e.tipo === 'baja').length, 0)
  guardarSitios(db, '8216', sitios('no_esta', 'no_esta', 'no_esta'), '2026-10-28T10:20:00.000Z')
  assert.deepEqual(eventos(db).at(-1), { codigo: '8216', sitio: 'cindy', tipo: 'baja', estado: 'no_esta' })
})

test('historial: si vuelve a aparecer se anota; resumen cuenta las bajas', () => {
  const db = abrirDb(':memory:')
  registrarReporte(db, rep('M1', '8216', '2026-10-28T09:00:00.000Z'))
  guardarSitios(db, '8216', sitios('publicado', 'no_esta', 'no_esta'), '2026-10-28T10:00:00.000Z')
  guardarSitios(db, '8216', sitios('no_esta', 'no_esta', 'no_esta'), '2026-10-28T11:00:00.000Z')
  guardarSitios(db, '8216', sitios('publicado', 'no_esta', 'no_esta'), '2026-10-28T12:00:00.000Z')
  assert.equal(eventos(db).at(-1).tipo, 'reaparecio')
  const r = resumenHistorial(db, new Date('2026-10-28T15:00:00.000Z'))
  assert.equal(r.bajasSemana, 1)
  assert.equal(r.demoraPromedioMs, 2 * 3600_000)
  assert.equal(listarHistorial(db, { q: '82' }).length, 5) // 3 de la primera revisión + baja + reapareció
  assert.equal(listarHistorial(db, { q: 'XYZ' }).length, 0)
})
