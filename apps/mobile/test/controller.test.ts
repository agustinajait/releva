import { describe, expect, it, beforeEach } from 'vitest';
import {
  DirectAnswerInterpreter,
  MemoryOutboxStore,
  Outbox,
  SAMPLE_QUESTIONNAIRE,
  parseQuestionnaire,
  type LocationFix,
  type SurveySyncItem,
  type SyncItemResult,
} from '@releva/core';
import { AppController, type RouteContext } from '../src/engine/controller';

const def = (() => {
  const r = parseQuestionnaire(SAMPLE_QUESTIONNAIRE);
  if (!r.ok) throw new Error();
  return r.definition;
})();

const ROUTE: RouteContext = {
  projectId: '00000000-0000-4000-8000-000000000001',
  projectName: 'Demo',
  routeId: '00000000-0000-4000-8000-000000000002',
  routeName: 'Centro',
  zoneName: 'Microcentro',
  questionnaireVersionId: '00000000-0000-4000-8000-000000000003',
  definition: def,
};

function setup(opts: { gpsFails?: boolean; online?: boolean } = {}) {
  const spoken: string[] = [];
  const sent: SurveySyncItem[] = [];
  const drafts = new Map<string, SurveySyncItem>();
  let online = opts.online ?? true;
  let n = 0;
  const store = new MemoryOutboxStore();
  const outbox = new Outbox(
    store,
    {
      async send(items): Promise<SyncItemResult[]> {
        if (!online) throw new Error('Sin conexión');
        sent.push(...items);
        return items.map((i) => ({ clientUuid: i.clientUuid, status: 'accepted', surveyId: 's', pointId: 'p', matchedExistingPoint: false }));
      },
    },
    { baseDelayMs: 0 },
  );
  const c = new AppController({
    location: {
      async captureFix(): Promise<LocationFix> {
        if (opts.gpsFails) throw new Error('sin señal');
        return { lat: -34.6037, lng: -58.3816, accuracy: 6, altitude: 25, capturedAt: '2026-09-28T23:10:00.000-03:00' };
      },
    },
    tts: { id: 'fake', async speak(t) { spoken.push(t); }, async stop() {} },
    interpreter: new DirectAnswerInterpreter(),
    outbox,
    drafts: { async saveDraft(i) { drafts.set(i.clientUuid, i); }, async deleteDraft(id) { drafts.delete(id); } },
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => '2026-09-28T23:10:00.000-03:00',
  });
  return { c, spoken, sent, drafts, store, setOnline: (v: boolean) => { online = v; } };
}

async function stoppedOnRoute(env: ReturnType<typeof setup>) {
  await env.c.startRoute(ROUTE);
  env.c.simulateMotion('stopped');
}

describe('app: flujo del relevador', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('relevamiento completo por voz, como en el ejemplo de la especificación', async () => {
    await stoppedOnRoute(env);
    await env.c.answer('RELEVA, tomá latitud.');
    expect(env.spoken.slice(-2)).toEqual(['Latitud tomada.', '¿Qué estás viendo?']);
    expect(env.c.state.snapshot.state).toBe('ESCUCHANDO');

    await env.c.answer('Hay una persona sola, está sobre un colchón y tiene dos mantas.');
    expect(env.spoken.at(-1)).toBe('¿Ves algún menor?');
    await env.c.answer('No.');
    expect(env.spoken.at(-1)).toBe('¿Tiene pertenencias?');
    await env.c.answer('Sí, una mochila.');
    expect(env.spoken.at(-1)).toBe('¿Hay algún animal?');
    await env.c.answer('Sí, un perro.');
    expect(env.c.state.snapshot.state).toBe('CONFIRMANDO');
    expect(env.spoken.at(-1)).toMatch(/^Registré .*mochila y perro\. ¿Está correcto\?$/);

    await env.c.answer('Sí.');
    expect(env.spoken.at(-1)).toBe('Punto guardado. Podés continuar.');
    expect(env.c.state.snapshot.state).toBe('VEHICULO_DETENIDO');
    expect(env.c.state.saveStatus).toBe('saved');

    // Se sincronizó con la transcripción completa y los datos confirmados.
    await new Promise((r) => setTimeout(r, 0));
    expect(env.sent).toHaveLength(1);
    const item = env.sent[0]!;
    expect(item.status).toBe('completed');
    expect(item.location).toMatchObject({ lat: -34.6037, accuracy: 6 });
    expect(Object.fromEntries(item.facts.map((f) => [f.fieldKey, f.value]))).toEqual({
      personas: 1,
      menores: false,
      pertenencias: true,
      pertenencias_tipo: ['mochila'],
      animales: true,
      animales_tipo: ['perro'],
      animales_cantidad: 1,
    });
    expect(item.facts.find((f) => f.fieldKey === 'menores')?.rawAnswer).toBe('No.');
    expect(item.utterances.length).toBeGreaterThan(8);
    expect(env.drafts.size).toBe(0);
  });

  it('SEGURIDAD: no permite relevar con el vehículo en movimiento', async () => {
    await env.c.startRoute(ROUTE);
    env.c.simulateMotion('moving');
    await env.c.takeLocation();
    expect(env.c.state.snapshot.state).toBe('VEHICULO_EN_MOVIMIENTO');
    expect(env.spoken.at(-1)).toBe('Detené el vehículo antes de relevar');
  });

  it('si el vehículo arranca, pausa la entrevista y al detenerse retoma la misma pregunta', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    await env.c.answer('Hay una persona');
    expect(env.spoken.at(-1)).toBe('¿Ves algún menor?');
    env.c.simulateMotion('moving');
    expect(env.c.state.snapshot.state).toBe('VEHICULO_EN_MOVIMIENTO');
    await env.c.answer('No'); // ignorado: no se escucha en movimiento
    expect(env.c.state.knownCount).toBe(1);
    env.c.simulateMotion('stopped');
    await new Promise((r) => setTimeout(r, 0));
    expect(env.spoken.at(-1)).toBe('¿Ves algún menor?');
    expect(env.c.state.snapshot.state).toBe('ESCUCHANDO');
  });

  it('guarda el borrador tras cada respuesta (no se pierde si se cierra la app)', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    await env.c.answer('Hay dos personas');
    const [draft] = [...env.drafts.values()];
    expect(draft?.facts.find((f) => f.fieldKey === 'personas')?.value).toBe(2);
  });

  it('respuesta no entendida: repite la pregunta, sin inventar', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    await env.c.answer('Hay una persona');
    await env.c.answer('eh, mirá vos');
    expect(env.spoken.at(-1)).toBe('No te entendí. ¿Ves algún menor?');
    expect(env.c.state.knownCount).toBe(1);
  });

  it('si no se completan los obligatorios, pregunta si guarda el punto incompleto', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    await env.c.answer('Hay una persona');
    for (let i = 0; i < 3; i++) await env.c.answer('mmm');
    for (const a of ['No', 'No']) await env.c.answer(a);
    expect(env.spoken.at(-1)).toMatch(/^Faltan datos: hay menores\..*¿Guardo el punto incompleto\?$/);
    await env.c.answer('Sí');
    await new Promise((r) => setTimeout(r, 0));
    expect(env.sent[0]?.status).toBe('incomplete');
  });

  it('sin conexión: guarda en el teléfono y sincroniza al volver la red', async () => {
    env = setup({ online: false });
    env.c.setOnline(false);
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    for (const a of ['Hay una persona', 'No', 'No', 'No', 'Sí']) await env.c.answer(a);
    await new Promise((r) => setTimeout(r, 0));
    expect(env.sent).toHaveLength(0);
    expect(env.c.state.sync.pending).toBe(1);
    expect(env.c.state.sync.lastError).toBe('Sin conexión');

    env.setOnline(true);
    env.c.setOnline(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(env.sent).toHaveLength(1);
    expect(env.c.state.sync.pending).toBe(0);
  });

  it('si falla el GPS vuelve a detenido y avisa', async () => {
    env = setup({ gpsFails: true });
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    expect(env.c.state.snapshot).toMatchObject({ state: 'VEHICULO_DETENIDO' });
    expect(env.c.state.snapshot.error).toMatch(/sin señal/);
    expect(env.spoken.at(-1)).toBe('No pude tomar la ubicación. Probá de nuevo.');
  });

  it('descartar un punto lo envía marcado como descartado (trazabilidad)', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    await env.c.answer('RELEVA, cancelá el punto');
    await env.c.sync();
    expect(env.sent[0]?.status).toBe('discarded');
    expect(env.c.state.snapshot.state).toBe('VEHICULO_DETENIDO');
  });

  it('confirmación negativa vuelve a preguntar', async () => {
    await stoppedOnRoute(env);
    await env.c.takeLocation();
    for (const a of ['Hay una persona', 'No', 'No', 'No']) await env.c.answer(a);
    expect(env.c.state.snapshot.state).toBe('CONFIRMANDO');
    await env.c.answer('No, está mal');
    expect(env.spoken.at(-1)).toBe('Entendido, lo corregimos. ¿Qué estás viendo?');
    expect(env.c.state.snapshot.state).toBe('ESCUCHANDO');
  });
});
