import { describe, expect, it } from 'vitest';
import {
  SAMPLE_QUESTIONNAIRE,
  ScriptedInterpreter,
  applyProposals,
  completionStatus,
  confirmFacts,
  confirmationItems,
  confirmationSentence,
  nextQuestion,
  parseQuestionnaire,
  parseYesNo,
  type FactMap,
  type QuestionnaireDefinition,
} from '../src/index.js';

const def = (() => {
  const r = parseQuestionnaire(SAMPLE_QUESTIONNAIRE);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.definition;
})();

const NOW = '2026-09-28T23:10:00.000-03:00';

/** Simula el ciclo PREGUNTAR → ESCUCHAR → INTERPRETAR → ESTRUCTURAR → DETECTAR QUÉ FALTA. */
async function runDialogue(d: QuestionnaireDefinition, interpreter: ScriptedInterpreter, answers: string[]) {
  let facts: FactMap = {};
  const asked: string[] = [];
  const transcript: string[] = [];
  for (const answer of answers) {
    const q = nextQuestion(d, { facts, asked });
    if (!q) break;
    asked.push(q.key);
    transcript.push(`RELEVA: ${q.text}`, `RELEVADOR: ${answer}`);
    const { proposals } = await interpreter.interpret({ definition: d, question: q, answer, known: facts, locale: 'es-AR' });
    facts = applyProposals(d, facts, proposals, { questionKey: q.key, rawAnswer: answer, now: NOW }).facts;
  }
  return { facts, asked, transcript };
}

describe('diálogo de referencia de la especificación', () => {
  const interpreter = new ScriptedInterpreter({
    'hay una persona sola, está sobre un colchón y tiene dos mantas.': [
      { fieldKey: 'personas', value: 1, explicit: false, evidence: 'una persona sola' },
      { fieldKey: 'composicion', value: 'sola', explicit: true },
      { fieldKey: 'colchon', value: true, explicit: true },
      { fieldKey: 'mantas', value: 2, explicit: true },
    ],
    'no.': [{ fieldKey: 'menores', value: false, explicit: true }],
    'sí, una mochila.': [
      { fieldKey: 'pertenencias', value: true, explicit: true },
      { fieldKey: 'pertenencias_tipo', value: ['mochila'], explicit: true },
    ],
    'sí, un perro.': [
      { fieldKey: 'animales', value: true, explicit: true },
      { fieldKey: 'animales_tipo', value: ['perro'], explicit: true },
      { fieldKey: 'animales_cantidad', value: 1, explicit: false },
    ],
  });

  it('hace exactamente las preguntas del ejemplo, sin repetir lo ya dicho', async () => {
    const { asked, facts } = await runDialogue(def, interpreter, [
      'Hay una persona sola, está sobre un colchón y tiene dos mantas.',
      'No.',
      'Sí, una mochila.',
      'Sí, un perro.',
    ]);
    expect(asked).toEqual(['que_ves', 'menores', 'pertenencias', 'animales']);
    expect(completionStatus(def, { facts, asked }).complete).toBe(true);
  });

  it('determina solo que el punto está completo y arma la confirmación', async () => {
    const { facts } = await runDialogue(def, interpreter, [
      'Hay una persona sola, está sobre un colchón y tiene dos mantas.',
      'No.',
      'Sí, una mochila.',
      'Sí, un perro.',
    ]);
    const sentence = confirmationSentence(confirmationItems(def, facts));
    expect(sentence).toBe('Registré 1 persona(s), persona sola, colchón, 2 manta(s), mochila y perro. ¿Está correcto?');
  });

  it('distingue lo mencionado de lo estructurado y confirma', async () => {
    const { facts } = await runDialogue(def, interpreter, ['Hay una persona sola, está sobre un colchón y tiene dos mantas.']);
    expect(facts.personas?.status).toBe('extracted');
    expect(facts.mantas?.status).toBe('mentioned');
    expect(facts.mantas?.rawAnswer).toBe('Hay una persona sola, está sobre un colchón y tiene dos mantas.');
    expect(facts.mantas?.questionKey).toBe('que_ves');
    const confirmed = confirmFacts(facts, Object.keys(facts), NOW);
    expect(Object.values(confirmed).every((f) => f.status === 'confirmed')).toBe(true);
  });
});

describe('extracción de varios datos en una respuesta', () => {
  it('"una mujer con un chico y tres bolsos" no vuelve a preguntar menores ni pertenencias', () => {
    const { facts } = applyProposals(
      def,
      {},
      [
        { fieldKey: 'personas', value: 2, explicit: false },
        { fieldKey: 'menores', value: true, explicit: false },
        { fieldKey: 'menores_cantidad', value: 1, explicit: false },
        { fieldKey: 'pertenencias', value: true, explicit: false },
        { fieldKey: 'pertenencias_tipo', value: ['bolsos'], explicit: true },
      ],
      { questionKey: 'que_ves', now: NOW },
    );
    const q = nextQuestion(def, { facts, asked: ['que_ves'] });
    expect(q?.key).toBe('animales');
  });

  it('pregunta de seguimiento cuando falta el detalle', () => {
    const { facts } = applyProposals(def, {}, [{ fieldKey: 'menores', value: true, explicit: true }], { now: NOW });
    const q = nextQuestion(def, { facts, asked: ['que_ves', 'menores'] });
    expect(q?.key).toBe('menores_cuantos');
  });

  it('no pregunta la cantidad de menores si no hay menores (regla de salto)', () => {
    const { facts } = applyProposals(
      def,
      {},
      [
        { fieldKey: 'personas', value: 1, explicit: true },
        { fieldKey: 'menores', value: false, explicit: true },
        { fieldKey: 'pertenencias', value: false, explicit: true },
        { fieldKey: 'animales', value: false, explicit: true },
      ],
      { now: NOW },
    );
    expect(completionStatus(def, { facts, asked: ['que_ves'] }).complete).toBe(true);
  });
});

describe('RELEVA nunca inventa información', () => {
  it('rechaza valores fuera del cuestionario', () => {
    const r = applyProposals(
      def,
      {},
      [
        { fieldKey: 'personas', value: 'muchas', explicit: true },
        { fieldKey: 'animales_tipo', value: ['caballo'], explicit: true },
        { fieldKey: 'nombre', value: 'Juan', explicit: true },
        { fieldKey: 'personas', value: 400, explicit: true },
      ],
      { now: NOW },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'no es un número entero',
      'opciones no válidas',
      'campo inexistente en el cuestionario',
      'mayor que 50',
    ]);
  });

  it('lo desconocido queda explícito, no se completa, y no se vuelve a preguntar', () => {
    const { facts } = applyProposals(def, {}, [{ fieldKey: 'menores', value: null, explicit: true, unknown: true }], { now: NOW });
    expect(facts.menores).toMatchObject({ status: 'unknown', value: null });
    expect(nextQuestion(def, { facts, asked: ['que_ves', 'cuantas_personas'] })?.key).toBe('pertenencias');
    expect(confirmationItems(def, facts)).toHaveLength(0);
  });

  it('una corrección conserva el valor anterior', () => {
    const a = applyProposals(def, {}, [{ fieldKey: 'mantas', value: 2, explicit: true }], { now: NOW }).facts;
    const b = applyProposals(def, a, [{ fieldKey: 'mantas', value: 3, explicit: true }], { now: NOW }).facts;
    expect(b.mantas?.value).toBe(3);
    expect(b.mantas?.previous?.[0]?.value).toBe(2);
  });

  it('la confirmación sin datos no inventa un resumen', () => {
    expect(confirmationSentence([])).toBe('No registré datos todavía. ¿Querés continuar?');
  });
});

describe('interpretación de sí/no en la confirmación', () => {
  it.each([
    ['Sí', 'yes'],
    ['si, está bien', 'yes'],
    ['Correcto', 'yes'],
    ['No, falta el perro', 'no'],
    ['está mal', 'no'],
    ['mmm', null],
    ['sinceramente no sé', null],
  ])('%s → %s', (t, r) => expect(parseYesNo(t)).toBe(r));
});
