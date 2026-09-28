import { describe, expect, it } from 'vitest';
import {
  MemoryOutboxStore,
  MotionDetector,
  Outbox,
  distanceMeters,
  findMatchingPoint,
  can,
  assignableRoles,
  type SurveySyncItem,
  type SyncTransport,
} from '../src/index.js';

describe('geo', () => {
  it('distancia conocida (Obelisco → Casa Rosada ≈ 1.3 km)', () => {
    const d = distanceMeters({ lat: -34.6037, lng: -58.3816 }, { lat: -34.6081, lng: -58.3703 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1300);
  });

  it('elige el punto existente más cercano dentro del radio', () => {
    const base = { lat: -34.6, lng: -58.4 };
    const near = { id: 'near', lat: -34.60005, lng: -58.4 }; // ~5.5 m
    const mid = { id: 'mid', lat: -34.6001, lng: -58.4 }; // ~11 m
    const far = { id: 'far', lat: -34.601, lng: -58.4 }; // ~111 m
    expect(findMatchingPoint(base, [far, mid, near], 25)?.id).toBe('near');
    expect(findMatchingPoint(base, [far], 25)).toBeNull();
  });
});

describe('detección de movimiento', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 28, 3, 0, s)).toISOString();
  it('usa histéresis: una lectura rápida aislada no cambia el estado', () => {
    const m = new MotionDetector();
    expect(m.push({ lat: 0, lng: 0, accuracy: 5, speed: 8, capturedAt: at(0) })).toBeNull();
    expect(m.push({ lat: 0, lng: 0, accuracy: 5, speed: 0.1, capturedAt: at(1) })).toBeNull();
    expect(m.current).toBe('unknown');
  });

  it('declara movimiento y luego detención sostenida', () => {
    const m = new MotionDetector();
    m.push({ lat: 0, lng: 0, accuracy: 5, speed: 8, capturedAt: at(0) });
    expect(m.push({ lat: 0, lng: 0, accuracy: 5, speed: 9, capturedAt: at(1) })).toBe('moving');
    for (let s = 2; s < 5; s++) expect(m.push({ lat: 0, lng: 0, accuracy: 5, speed: 0.2, capturedAt: at(s) })).toBeNull();
    expect(m.push({ lat: 0, lng: 0, accuracy: 5, speed: 0.2, capturedAt: at(6) })).toBe('stopped');
  });

  it('ignora lecturas imprecisas', () => {
    const m = new MotionDetector();
    m.push({ lat: 0, lng: 0, accuracy: 500, speed: 20, capturedAt: at(0) });
    m.push({ lat: 0, lng: 0, accuracy: 500, speed: 20, capturedAt: at(1) });
    expect(m.current).toBe('unknown');
  });

  it('calcula velocidad por desplazamiento si el GPS no la informa', () => {
    const m = new MotionDetector();
    m.push({ lat: -34.6, lng: -58.4, accuracy: 5, capturedAt: at(0) });
    m.push({ lat: -34.6001, lng: -58.4, accuracy: 5, capturedAt: at(1) }); // 11 m/s
    expect(m.push({ lat: -34.6002, lng: -58.4, accuracy: 5, capturedAt: at(2) })).toBe('moving');
  });
});

describe('cola offline', () => {
  const item = (n: number): SurveySyncItem => ({
    clientUuid: `00000000-0000-4000-8000-00000000000${n}`,
    projectId: '00000000-0000-4000-8000-000000000100',
    questionnaireVersionId: '00000000-0000-4000-8000-000000000200',
    location: { lat: -34.6, lng: -58.4, accuracy: 8, capturedAt: '2026-09-28T23:00:00.000Z' },
    status: 'completed',
    startedAt: '2026-09-28T23:00:00.000Z',
    facts: [],
    utterances: [],
  });

  it('sin red no pierde nada y reintenta con espera', async () => {
    let now = 0;
    let online = false;
    const sent: string[] = [];
    const transport: SyncTransport = {
      async send(items) {
        if (!online) throw new Error('Network request failed');
        sent.push(...items.map((i) => i.clientUuid));
        return items.map((i) => ({ clientUuid: i.clientUuid, status: 'accepted', surveyId: 's', pointId: 'p', matchedExistingPoint: false }));
      },
    };
    const store = new MemoryOutboxStore();
    const outbox = new Outbox(store, transport, { now: () => now, baseDelayMs: 1000 });
    await outbox.enqueue(item(1));
    await outbox.enqueue(item(2));

    const r1 = await outbox.flush();
    expect(r1.networkError).toBe('Network request failed');
    expect(await outbox.pendingCount()).toBe(2);

    online = true;
    now = 500; // todavía en espera
    expect((await outbox.flush()).deferred).toBe(2);
    expect(sent).toHaveLength(0);

    now = 1000;
    const r3 = await outbox.flush();
    expect(r3.synced).toBe(2);
    expect(await outbox.pendingCount()).toBe(0);
    expect(await store.count('synced')).toBe(2);
  });

  it('lo rechazado queda guardado para revisión y lo duplicado cuenta como sincronizado', async () => {
    const transport: SyncTransport = {
      async send(items) {
        return items.map((i, idx) =>
          idx === 0
            ? { clientUuid: i.clientUuid, status: 'duplicate' as const, surveyId: 's', pointId: 'p' }
            : { clientUuid: i.clientUuid, status: 'rejected' as const, error: 'Proyecto inexistente' },
        );
      },
    };
    const store = new MemoryOutboxStore();
    const outbox = new Outbox(store, transport);
    await outbox.enqueue(item(1));
    await outbox.enqueue(item(2));
    const r = await outbox.flush();
    expect(r).toMatchObject({ synced: 1, rejected: 1 });
    expect((await store.get(item(2).clientUuid))?.lastError).toBe('Proyecto inexistente');
  });

  it('no permite modificar algo ya sincronizado', async () => {
    const transport: SyncTransport = {
      async send(items) {
        return items.map((i) => ({ clientUuid: i.clientUuid, status: 'accepted' as const, surveyId: 's', pointId: 'p', matchedExistingPoint: false }));
      },
    };
    const outbox = new Outbox(new MemoryOutboxStore(), transport);
    await outbox.enqueue(item(1));
    await outbox.flush();
    await expect(outbox.enqueue(item(1))).rejects.toThrow('ya fue sincronizado');
  });

  it('llamadas concurrentes no envían dos veces', async () => {
    let calls = 0;
    const transport: SyncTransport = {
      async send(items) {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return items.map((i) => ({ clientUuid: i.clientUuid, status: 'accepted' as const, surveyId: 's', pointId: 'p', matchedExistingPoint: false }));
      },
    };
    const outbox = new Outbox(new MemoryOutboxStore(), transport);
    await outbox.enqueue(item(1));
    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()]);
    expect(calls).toBe(1);
  });
});

describe('permisos', () => {
  it('el relevador no ve indicadores ni administra', () => {
    expect(can('surveyor', 'surveys:create')).toBe(true);
    expect(can('surveyor', 'indicators:read')).toBe(false);
    expect(can('surveyor', 'users:manage')).toBe(false);
  });
  it('el analista de Gobierno solo lee', () => {
    expect(can('analyst', 'points:read')).toBe(true);
    expect(can('analyst', 'questionnaires:manage')).toBe(false);
  });
  it('un admin de cliente no puede crear super admins', () => {
    expect(assignableRoles('client_admin')).not.toContain('super_admin');
    expect(assignableRoles('surveyor')).toEqual([]);
  });
});
