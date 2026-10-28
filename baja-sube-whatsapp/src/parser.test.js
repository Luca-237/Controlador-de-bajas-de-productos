import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extraerCodigos, esMensajeLimpio } from './parser.js'

// Todos estos mensajes son reales (grupo "Código que no hay más", 10-15/10/2026).
const REALES = [
  ['3264106', ['3264106']],
  ['439787', ['439787']],
  ['816201PHI', ['816201PHI']],
  ['167.0800127', ['167.0800127']],
  ['167.7400033', ['167.7400033']],
  ['367.c3289.3', ['367.C3289.3']], // minúscula -> mayúscula (Manager lo tiene en mayúscula)
  ['854928', ['854928']],
  ['129518', ['129518']],
]

for (const [texto, esperado] of REALES) {
  test(`mensaje real: ${texto}`, () => {
    const r = extraerCodigos(texto)
    assert.deepEqual(r.codigos, esperado)
    assert.deepEqual(r.sobrantes, [])
    assert.ok(esMensajeLimpio(r))
  })
}

test('varios códigos en líneas separadas (mensaje real de Agustina)', () => {
  const r = extraerCodigos('167.0800268\n167.0800267\n167.0800127\n167.0800021')
  assert.deepEqual(r.codigos, ['167.0800268', '167.0800267', '167.0800127', '167.0800021'])
  assert.ok(esMensajeLimpio(r))
})

test('variantes con guion y alfanuméricos cortos', () => {
  assert.deepEqual(extraerCodigos('83606-FU').codigos, ['83606-FU'])
  assert.deepEqual(extraerCodigos('8B115').codigos, ['8B115'])
})

test('repetidos dentro del mismo mensaje se colapsan', () => {
  assert.deepEqual(extraerCodigos('131904 131904\n131904').codigos, ['131904'])
})

test('formato de WhatsApp alrededor del código (*negrita*, comas, punto final)', () => {
  assert.deepEqual(extraerCodigos('*131904*').codigos, ['131904'])
  assert.deepEqual(extraerCodigos('131904, 148214.').codigos, ['131904', '148214'])
  assert.deepEqual(extraerCodigos('(129518)').codigos, ['129518'])
})

test('texto libre: se extrae el código pero el mensaje queda como ambiguo', () => {
  const r = extraerCodigos('no hay más 131904 gracias')
  assert.deepEqual(r.codigos, ['131904'])
  assert.deepEqual(r.sobrantes, ['NO', 'HAY', 'MÁS', 'GRACIAS'])
  assert.equal(esMensajeLimpio(r), false)
})

test('palabras sin dígitos nunca son código', () => {
  const r = extraerCodigos('gracias ok listo')
  assert.deepEqual(r.codigos, [])
  assert.equal(esMensajeLimpio(r), false)
})

test('demasiado corto (<4) o demasiado largo (>25) no cuenta', () => {
  assert.deepEqual(extraerCodigos('123').codigos, [])
  assert.deepEqual(extraerCodigos('1'.repeat(26)).codigos, [])
})

test('entradas no string o vacías no rompen', () => {
  assert.deepEqual(extraerCodigos(undefined).codigos, [])
  assert.deepEqual(extraerCodigos('').codigos, [])
  assert.deepEqual(extraerCodigos('   \n  ').codigos, [])
})
