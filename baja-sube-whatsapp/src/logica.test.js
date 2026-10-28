import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mismoTipoProducto, tieneFormaDeVariante, filtrarVariantes, calcularEstado, CODIGO_SEGURO } from './logica.js'

test('forma de variante: PADRE-XXX con 2 a 6 letras mayúsculas', () => {
  assert.ok(tieneFormaDeVariante('83606', '83606-FU'))
  assert.ok(tieneFormaDeVariante('129518', '129518-NEG'))
  assert.ok(tieneFormaDeVariante('167.0800127', '167.0800127-BEI'))
  assert.ok(!tieneFormaDeVariante('13190', '131904-BEI')) // prefijo parecido pero no es hijo
  assert.ok(!tieneFormaDeVariante('83606', '83606-1')) // sufijo numérico no es variante de color
  assert.ok(!tieneFormaDeVariante('83606', '83606-F')) // muy corto
  assert.ok(!tieneFormaDeVariante('81ROM-X02-00001', '81ROM-X02-00001-AB-CD'))
})

test('el punto del padre no se interpreta como comodín de regex', () => {
  assert.ok(!tieneFormaDeVariante('167.0800127', '167X0800127-BEI'))
})

test('mismo tipo de producto: descripciones reales de la muestra', () => {
  assert.ok(mismoTipoProducto('CARTERA OREIRO', 'CARTERA OREIRO NEGRO'))
  assert.ok(mismoTipoProducto('MOCHILA BOERSS', 'MOCHILA BOERSS AZUL'))
  assert.ok(!mismoTipoProducto('CARTERA OREIRO', 'GORRO COYA RAYAS'))
  assert.ok(!mismoTipoProducto('', 'CARTERA'))
})

test('tolera errores de tipeo en la primera palabra (Levenshtein), igual que en Odoo', () => {
  assert.ok(mismoTipoProducto('CARTUCHERA BOERS', 'CATUCHERA BOERS ROJA'))
})

test('filtrarVariantes descarta hijos de otro producto y ordena', () => {
  const candidatos = [
    { codigo: '129518-NUD', descripcion: 'MOCHILA OREIRO NUDE', sube: 1, noVigente: false },
    { codigo: '129518-BEI', descripcion: 'MOCHILA OREIRO BEIGE', sube: 1, noVigente: false },
    { codigo: '129518-ZZ', descripcion: 'LLAVERO DISTINTO', sube: 1, noVigente: false },
    { codigo: '129518-7', descripcion: 'MOCHILA OREIRO', sube: 1, noVigente: false },
  ]
  const r = filtrarVariantes('129518', 'MOCHILA OREIRO', candidatos)
  assert.deepEqual(r.map((v) => v.codigo), ['129518-BEI', '129518-NUD'])
})

test('estado: código inexistente o no vigente', () => {
  assert.deepEqual(calcularEstado('X1234', { existe: false }), { estado: 'no_existe', aBajar: [] })
  assert.deepEqual(calcularEstado('X1234', { existe: true, noVigente: true, sube: 1 }), { estado: 'no_vigente', aBajar: [] })
})

test('estado: variante reportada con Sube=1 -> pendiente solo ella', () => {
  assert.deepEqual(calcularEstado('131904-NEG', { existe: true, noVigente: false, sube: 1 }, []), {
    estado: 'pendiente',
    aBajar: ['131904-NEG'],
  })
})

test('estado: padre en Sube=0 con variantes en Sube=1 (caso real 129518) -> pendientes las variantes', () => {
  const variantes = [
    { codigo: '129518-BEI', sube: 1, noVigente: false },
    { codigo: '129518-NEG', sube: 1, noVigente: false },
    { codigo: '129518-NUD', sube: 1, noVigente: false },
  ]
  const r = calcularEstado('129518', { existe: true, noVigente: false, sube: 0 }, variantes)
  assert.equal(r.estado, 'pendiente')
  assert.deepEqual(r.aBajar, ['129518-BEI', '129518-NEG', '129518-NUD'])
})

test('estado: padre y todas las variantes en 0 -> procesado', () => {
  const variantes = [{ codigo: '132059-BEI', sube: 0, noVigente: false }]
  assert.deepEqual(calcularEstado('132059', { existe: true, noVigente: false, sube: 0 }, variantes), {
    estado: 'procesado',
    aBajar: [],
  })
})

test('estado: falso grupo (padre Sube=1, hijos en 0) -> solo se baja el padre', () => {
  const variantes = [
    { codigo: '823728-AZ', sube: 0, noVigente: false },
    { codigo: '823728-RO', sube: 0, noVigente: false },
  ]
  assert.deepEqual(calcularEstado('823728', { existe: true, noVigente: false, sube: 1 }, variantes), {
    estado: 'pendiente',
    aBajar: ['823728'],
  })
})

test('estado: variantes no vigentes con Sube=1 no cuentan; Sube nulo se trata como 0', () => {
  const variantes = [{ codigo: '1F223-BEI', sube: 1, noVigente: true }, { codigo: '1F223-NEG', sube: null, noVigente: false }]
  assert.deepEqual(calcularEstado('1F223', { existe: true, noVigente: false, sube: null }, variantes), {
    estado: 'procesado',
    aBajar: [],
  })
})

test('CODIGO_SEGURO rechaza comillas, espacios y operadores SQL', () => {
  for (const malo of ["1234'; DROP TABLE x;--", '12 34', '1234)', "ab'cd1", '1234%', '12;34']) {
    assert.ok(!CODIGO_SEGURO.test(malo), malo)
  }
  for (const bueno of ['131904', '167.0800127', '81ROM-X02-00008', '367.C3289.3', '1LTX24']) {
    assert.ok(CODIGO_SEGURO.test(bueno), bueno)
  }
})
