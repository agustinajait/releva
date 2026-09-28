import { describe, expect, it } from 'vitest';
import {
  APP_STATES,
  INTERVIEW_STATES,
  initialSnapshot,
  transition,
  type AppEvent,
  type Snapshot,
} from '../src/index.js';

function run(events: AppEvent[], from: Snapshot = initialSnapshot): Snapshot {
  let s = from;
  for (const e of events) {
    const r = transition(s, e);
    if (!r.ok) throw new Error(`${e.type} en ${s.state}: ${r.reason}`);
    s = r.snapshot;
  }
  return s;
}

const toStopped: AppEvent[] = [{ type: 'INICIAR_RECORRIDO', routeId: 'r1' }, { type: 'VEHICULO_DETENIDO' }];
const toQuestion: AppEvent[] = [
  ...toStopped,
  { type: 'TOMAR_UBICACION' },
  { type: 'UBICACION_OBTENIDA', pointId: 'p1' },
  { type: 'PREGUNTAR', questionKey: 'que_ves' },
];

describe('máquina de estados', () => {
  it('recorre el flujo completo de un punto', () => {
    const s = run([
      ...toQuestion,
      { type: 'ESCUCHAR' },
      { type: 'RESPUESTA_RECIBIDA' },
      { type: 'RESPUESTA_PROCESADA', completo: false },
      { type: 'ESCUCHAR' },
      { type: 'RESPUESTA_RECIBIDA' },
      { type: 'RESPUESTA_PROCESADA', completo: true },
      { type: 'CONFIRMACION_SI' },
      { type: 'GUARDADO' },
    ]);
    expect(s.state).toBe('PUNTO_COMPLETADO');
    expect(run([{ type: 'CONTINUAR' }], s).state).toBe('VEHICULO_DETENIDO');
  });

  it('SEGURIDAD: no se puede tomar ubicación con el vehículo en movimiento', () => {
    const moving = run([{ type: 'INICIAR_RECORRIDO', routeId: 'r1' }, { type: 'VEHICULO_EN_MOVIMIENTO' }]);
    const r = transition(moving, { type: 'TOMAR_UBICACION' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Detené el vehículo antes de relevar');
  });

  it('SEGURIDAD: no se puede relevar sin confirmar detención (estado RECORRIDO)', () => {
    const s = run([{ type: 'INICIAR_RECORRIDO', routeId: 'r1' }]);
    expect(transition(s, { type: 'TOMAR_UBICACION' }).ok).toBe(false);
  });

  it('SEGURIDAD: ningún estado de entrevista es alcanzable estando en movimiento', () => {
    // Exploración exhaustiva de todos los estados alcanzables con todos los eventos.
    const events: AppEvent[] = [
      { type: 'INICIAR_RECORRIDO', routeId: 'r' },
      { type: 'FINALIZAR_RECORRIDO' },
      { type: 'VEHICULO_EN_MOVIMIENTO' },
      { type: 'VEHICULO_DETENIDO' },
      { type: 'TOMAR_UBICACION' },
      { type: 'UBICACION_OBTENIDA', pointId: 'p' },
      { type: 'UBICACION_FALLIDA', reason: 'x' },
      { type: 'PREGUNTAR', questionKey: 'q' },
      { type: 'ESCUCHAR' },
      { type: 'RESPUESTA_RECIBIDA' },
      { type: 'RESPUESTA_PROCESADA', completo: true },
      { type: 'RESPUESTA_PROCESADA', completo: false },
      { type: 'CONFIRMACION_SI' },
      { type: 'CONFIRMACION_NO' },
      { type: 'GUARDADO' },
      { type: 'CONTINUAR' },
      { type: 'DESCARTAR_PUNTO' },
      { type: 'SINCRONIZAR' },
      { type: 'SINCRONIZACION_TERMINADA' },
      { type: 'FALLA', reason: 'x' },
      { type: 'REINTENTAR' },
    ];
    const key = (s: Snapshot) => JSON.stringify(s);
    const seen = new Map<string, Snapshot>([[key(initialSnapshot), initialSnapshot]]);
    const queue = [initialSnapshot];
    while (queue.length) {
      const s = queue.shift()!;
      for (const e of events) {
        const r = transition(s, e);
        if (!r.ok) continue;
        const n = r.snapshot;
        if (INTERVIEW_STATES.has(n.state) || n.state === 'CAPTURANDO_UBICACION') {
          expect(n.moving, `${s.state} --${e.type}--> ${n.state} con vehículo en movimiento`).toBe(false);
        }
        if (!seen.has(key(n)) && seen.size < 5000) {
          seen.set(key(n), n);
          queue.push(n);
        }
      }
    }
    const reached = new Set([...seen.values()].map((s) => s.state));
    expect([...reached].sort()).toEqual([...APP_STATES].sort());
  });

  it('si el vehículo arranca durante la entrevista, la pausa y la retoma al detenerse', () => {
    const paused = run([...toQuestion, { type: 'ESCUCHAR' }, { type: 'VEHICULO_EN_MOVIMIENTO' }]);
    expect(paused.state).toBe('VEHICULO_EN_MOVIMIENTO');
    expect(paused.pointId).toBe('p1');
    const resumed = run([{ type: 'VEHICULO_DETENIDO' }], paused);
    expect(resumed.state).toBe('PREGUNTANDO');
    expect(resumed.pointId).toBe('p1');
  });

  it('no permite finalizar el recorrido con un punto pausado', () => {
    const paused = run([...toQuestion, { type: 'VEHICULO_EN_MOVIMIENTO' }]);
    expect(transition(paused, { type: 'FINALIZAR_RECORRIDO' }).ok).toBe(false);
  });

  it('se puede descartar el punto mientras RELEVA escucha o confirma', () => {
    const listening = run([...toQuestion, { type: 'ESCUCHAR' }]);
    expect(run([{ type: 'DESCARTAR_PUNTO' }], listening)).toMatchObject({ state: 'VEHICULO_DETENIDO', pointId: null });
    const confirming = run([{ type: 'RESPUESTA_RECIBIDA' }, { type: 'RESPUESTA_PROCESADA', completo: true }], listening);
    expect(run([{ type: 'DESCARTAR_PUNTO' }], confirming).state).toBe('VEHICULO_DETENIDO');
  });

  it('confirmación negativa vuelve a preguntar', () => {
    const s = run([
      ...toQuestion,
      { type: 'ESCUCHAR' },
      { type: 'RESPUESTA_RECIBIDA' },
      { type: 'RESPUESTA_PROCESADA', completo: true },
      { type: 'CONFIRMACION_NO' },
    ]);
    expect(s.state).toBe('PREGUNTANDO');
  });

  it('un error durante el procesamiento no pierde el punto', () => {
    const s = run([...toQuestion, { type: 'ESCUCHAR' }, { type: 'RESPUESTA_RECIBIDA' }, { type: 'FALLA', reason: 'sin red' }]);
    expect(s).toMatchObject({ state: 'ERROR', pointId: 'p1', resumeTo: 'PREGUNTANDO' });
    expect(run([{ type: 'REINTENTAR' }], s)).toMatchObject({ state: 'PREGUNTANDO', pointId: 'p1', error: null });
  });

  it('si falla el GPS vuelve a detenido con el error visible', () => {
    const s = run([...toStopped, { type: 'TOMAR_UBICACION' }, { type: 'UBICACION_FALLIDA', reason: 'sin señal' }]);
    expect(s).toMatchObject({ state: 'VEHICULO_DETENIDO', error: 'sin señal' });
  });

  it('sincronización vuelve al estado anterior', () => {
    const s = run([...toStopped, { type: 'SINCRONIZAR' }, { type: 'SINCRONIZACION_TERMINADA' }]);
    expect(s.state).toBe('VEHICULO_DETENIDO');
  });

  it('rechaza eventos fuera de lugar sin cambiar el estado', () => {
    const r = transition(initialSnapshot, { type: 'GUARDADO' });
    expect(r.ok).toBe(false);
    expect(r.snapshot).toBe(initialSnapshot);
  });
});
