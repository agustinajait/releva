import { describe, expect, it } from 'vitest';
import { SAMPLE_QUESTIONNAIRE, evaluateCondition, parseQuestionnaire } from '../src/index.js';

const clone = <T>(x: T): T => structuredClone(x);

describe('validación del cuestionario', () => {
  it('el cuestionario de ejemplo es válido', () => {
    expect(parseQuestionnaire(SAMPLE_QUESTIONNAIRE).ok).toBe(true);
  });

  it('aplica valores por defecto', () => {
    const r = parseQuestionnaire(SAMPLE_QUESTIONNAIRE);
    if (!r.ok) throw new Error();
    const colchon = r.definition.fields.find((f) => f.key === 'colchon');
    expect(colchon?.required).toBe(false);
    expect(colchon?.confirm).toBe(true);
  });

  it.each([
    ['pregunta con campo inexistente', (d: any) => d.questions[0].fields.push('no_existe'), 'Campo inexistente: no_existe'],
    ['condición con campo inexistente', (d: any) => (d.fields[3].visibleIf = { field: 'fantasma', op: 'known' }), 'La condición usa un campo inexistente: fantasma'],
    ['campo duplicado', (d: any) => d.fields.push({ ...d.fields[0] }), 'Campo duplicado: personas'],
    ['opciones faltantes', (d: any) => delete d.fields[1].options, 'El campo composicion necesita opciones'],
    ['apertura inexistente', (d: any) => (d.openingQuestion = 'nada'), 'Pregunta de apertura inexistente: nada'],
    ['seguimiento inexistente', (d: any) => d.questions[2].followUps.push('zzz'), 'Pregunta inexistente: zzz'],
    ['obligatorio sin pregunta', (d: any) => d.fields.push({ key: 'huerfano', label: 'H', type: 'boolean', required: true }), 'El campo obligatorio huerfano no está en ninguna pregunta'],
    ['min > max', (d: any) => (d.fields[0].min = 99), 'En personas, min es mayor que max'],
    ['categoría inexistente', (d: any) => (d.fields[0].category = 'otra'), 'Categoría inexistente: otra'],
    ['auto-dependencia', (d: any) => (d.fields[3].visibleIf = { field: 'menores_cantidad', op: 'known' }), 'menores_cantidad no puede depender de sí mismo'],
  ])('detecta: %s', (_name, mutate, message) => {
    const d = clone(SAMPLE_QUESTIONNAIRE);
    mutate(d);
    const r = parseQuestionnaire(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message)).toContain(message);
  });

  it('rechaza claves con formato inválido', () => {
    const d: any = clone(SAMPLE_QUESTIONNAIRE);
    d.fields[0].key = 'Personas Totales';
    expect(parseQuestionnaire(d).ok).toBe(false);
  });

  it('rechaza propiedades desconocidas (evita errores de tipeo silenciosos)', () => {
    const d: any = clone(SAMPLE_QUESTIONNAIRE);
    d.fields[0].requried = true;
    expect(parseQuestionnaire(d).ok).toBe(false);
  });

  it('rechaza condiciones anidadas sin límite sin desbordar la pila', () => {
    const d: any = clone(SAMPLE_QUESTIONNAIRE);
    let c: any = { field: 'personas', op: 'known' };
    for (let i = 0; i < 5000; i++) c = { not: c };
    d.fields[3].visibleIf = c;
    const r = parseQuestionnaire(d);
    expect(r.ok).toBe(false);
  });

  it('nunca lanza con basura', () => {
    expect(parseQuestionnaire(null).ok).toBe(false);
    expect(parseQuestionnaire('texto').ok).toBe(false);
    expect(parseQuestionnaire({ schemaVersion: 2 }).ok).toBe(false);
  });
});

describe('condiciones', () => {
  const v = { a: 3, b: true, c: 'x', d: ['perro', 'gato'], n: null };
  it.each([
    [{ field: 'a', op: 'gt', value: 2 }, true],
    [{ field: 'a', op: 'lte', value: 2 }, false],
    [{ field: 'b', op: 'eq', value: true }, true],
    [{ field: 'c', op: 'in', value: ['x', 'y'] }, true],
    [{ field: 'd', op: 'contains', value: 'gato' }, true],
    [{ field: 'n', op: 'known' }, false],
    [{ field: 'n', op: 'unknown' }, true],
    [{ field: 'zz', op: 'eq', value: 1 }, false],
    [{ field: 'n', op: 'eq', value: null }, false],
    [{ all: [{ field: 'a', op: 'gte', value: 3 }, { field: 'b', op: 'truthy' }] }, true],
    [{ any: [{ field: 'a', op: 'lt', value: 0 }, { field: 'c', op: 'eq', value: 'x' }] }, true],
    [{ not: { field: 'b', op: 'truthy' } }, false],
    [{ field: 'a', op: 'gt', value: '2' }, false],
  ] as const)('%j → %s', (c, expected) => {
    expect(evaluateCondition(c as any, v)).toBe(expected);
  });
});
