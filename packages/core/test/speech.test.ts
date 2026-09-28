import { describe, expect, it } from 'vitest';
import {
  DirectAnswerInterpreter,
  SAMPLE_QUESTIONNAIRE,
  parseCommand,
  parseQuestionnaire,
  parseSpokenNumber,
  type FactMap,
} from '../src/index.js';

const def = (() => {
  const r = parseQuestionnaire(SAMPLE_QUESTIONNAIRE);
  if (!r.ok) throw new Error();
  return r.definition;
})();
const q = (key: string) => def.questions.find((x) => x.key === key)!;
const interp = new DirectAnswerInterpreter();
const ask = (key: string, answer: string, known: FactMap = {}) =>
  interp.interpret({ definition: def, question: q(key), answer, known, locale: 'es-AR' });

describe('comandos de voz', () => {
  it.each([
    ['RELEVA, tomá latitud.', 'tomar_ubicacion'],
    ['Releva tomar ubicación', 'tomar_ubicacion'],
    ['releva marcá el punto', 'tomar_ubicacion'],
    ['RELEVA, repetí', 'repetir'],
    ['RELEVA cancelá el punto', 'cancelar_punto'],
    ['Releva, sincronizá', 'sincronizar'],
    ['releva terminar recorrido', 'finalizar_recorrido'],
  ])('%s → %s', (t, cmd) => expect(parseCommand(t)).toBe(cmd));

  it('sin la palabra RELEVA no dispara nada (evita falsos positivos)', () => {
    expect(parseCommand('tomá latitud')).toBeNull();
    expect(parseCommand('tomá latitud', { requireWakeWord: false })).toBe('tomar_ubicacion');
    expect(parseCommand('RELEVA qué hora es')).toBeNull();
  });
});

describe('números hablados', () => {
  it.each([
    ['dos mantas', 2],
    ['hay 3', 3],
    ['una sola persona', 1],
    ['ninguno', 0],
    ['doce', 12],
    ['muchos', null],
  ])('%s → %s', (t, n) => expect(parseSpokenNumber(t)).toBe(n));
});

describe('intérprete de respuestas directas', () => {
  it('sí/no para la pregunta actual', async () => {
    expect((await ask('menores', 'No.')).proposals).toEqual([{ fieldKey: 'menores', value: false, explicit: true, evidence: 'No.' }]);
    expect((await ask('animales', 'Sí')).proposals[0]).toMatchObject({ fieldKey: 'animales', value: true });
  });

  it('"Sí, una mochila" completa el sí y el detalle', async () => {
    const r = await ask('pertenencias', 'Sí, una mochila.');
    expect(r.proposals.map((p) => [p.fieldKey, p.value])).toEqual([
      ['pertenencias', true],
      ['pertenencias_tipo', ['mochila']],
    ]);
  });

  it('"Sí, un perro" → animales, tipo y cantidad', async () => {
    const r = await ask('animales', 'Sí, un perro');
    expect(r.proposals.map((p) => [p.fieldKey, p.value])).toEqual([
      ['animales', true],
      ['animales_tipo', ['perro']],
      ['animales_cantidad', 1],
    ]);
  });

  it('"no sé" queda como desconocido, no como "no"', async () => {
    const r = await ask('menores', 'No sé, no se ve bien');
    expect(r.proposals[0]).toMatchObject({ fieldKey: 'menores', unknown: true, value: null });
  });

  it('no inventa: si no entiende, no propone nada', async () => {
    const r = await ask('menores', 'eh... mirá vos');
    expect(r).toMatchObject({ proposals: [], intent: 'unclear' });
  });

  it('no extrae datos de la respuesta libre de apertura (eso es del intérprete con IA)', async () => {
    const r = await ask('que_ves', 'Hay una persona sola sobre un colchón con dos mantas');
    // Solo el primer campo de la pregunta, y solo si la respuesta es directa.
    expect(r.proposals.length).toBeLessThanOrEqual(1);
  });

  it('reconoce el pedido de repetir', async () => {
    expect((await ask('menores', '¿Cómo?')).intent).toBe('repeat');
  });

  it('usa números para cantidades', async () => {
    const r = await ask('menores_cuantos', 'dos');
    expect(r.proposals[0]).toMatchObject({ fieldKey: 'menores_cantidad', value: 2 });
  });
});
