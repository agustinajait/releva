/**
 * Máquina de estados de la app RELEVA.
 *
 * Es una función pura (estado + evento → estado): no conoce la UI, el GPS ni la voz.
 * Así se puede testear exhaustivamente y garantizar la regla de seguridad principal:
 * la entrevista solo empieza con el vehículo detenido.
 */

export const APP_STATES = [
  'INICIO',
  'RECORRIDO',
  'VEHICULO_EN_MOVIMIENTO',
  'VEHICULO_DETENIDO',
  'CAPTURANDO_UBICACION',
  'PUNTO_ACTIVO',
  'ESCUCHANDO',
  'PROCESANDO_RESPUESTA',
  'PREGUNTANDO',
  'CONFIRMANDO',
  'GUARDANDO',
  'PUNTO_COMPLETADO',
  'SINCRONIZANDO',
  'ERROR',
] as const;
export type AppState = (typeof APP_STATES)[number];

export type AppEvent =
  | { type: 'INICIAR_RECORRIDO'; routeId: string }
  | { type: 'FINALIZAR_RECORRIDO' }
  | { type: 'VEHICULO_EN_MOVIMIENTO' }
  | { type: 'VEHICULO_DETENIDO' }
  | { type: 'TOMAR_UBICACION' }
  | { type: 'UBICACION_OBTENIDA'; pointId: string }
  | { type: 'UBICACION_FALLIDA'; reason: string }
  | { type: 'PREGUNTAR'; questionKey: string }
  | { type: 'ESCUCHAR' }
  | { type: 'RESPUESTA_RECIBIDA' }
  | { type: 'RESPUESTA_PROCESADA'; completo: boolean }
  | { type: 'CONFIRMACION_SI' }
  | { type: 'CONFIRMACION_NO' }
  | { type: 'GUARDADO' }
  | { type: 'CONTINUAR' }
  | { type: 'DESCARTAR_PUNTO' }
  | { type: 'SINCRONIZAR' }
  | { type: 'SINCRONIZACION_TERMINADA' }
  | { type: 'FALLA'; reason: string }
  | { type: 'REINTENTAR' };

export interface Snapshot {
  state: AppState;
  routeId: string | null;
  pointId: string | null;
  questionKey: string | null;
  /** Último movimiento conocido del vehículo. */
  moving: boolean;
  /** Estado al que se vuelve tras una pausa por movimiento, sincronización o error. */
  resumeTo: AppState | null;
  error: string | null;
}

export const initialSnapshot: Snapshot = {
  state: 'INICIO',
  routeId: null,
  pointId: null,
  questionKey: null,
  moving: false,
  resumeTo: null,
  error: null,
};

/** Estados en los que hay una entrevista en curso. */
export const INTERVIEW_STATES: ReadonlySet<AppState> = new Set<AppState>([
  'PUNTO_ACTIVO',
  'PREGUNTANDO',
  'ESCUCHANDO',
  'PROCESANDO_RESPUESTA',
  'CONFIRMANDO',
]);

const IDLE_STATES: ReadonlySet<AppState> = new Set<AppState>([
  'INICIO',
  'RECORRIDO',
  'VEHICULO_DETENIDO',
  'PUNTO_COMPLETADO',
]);

export type TransitionResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; snapshot: Snapshot; reason: string };

export function transition(s: Snapshot, e: AppEvent): TransitionResult {
  const ok = (patch: Partial<Snapshot>): TransitionResult => ({ ok: true, snapshot: { ...s, ...patch } });
  const no = (reason: string): TransitionResult => ({ ok: false, snapshot: s, reason });

  // La falla es alcanzable desde cualquier estado y recuerda a dónde volver.
  if (e.type === 'FALLA') {
    if (s.state === 'ERROR') return ok({ error: e.reason });
    return ok({ state: 'ERROR', error: e.reason, resumeTo: safeResumeState(s) });
  }

  // El movimiento se registra siempre; qué hace depende del estado.
  if (e.type === 'VEHICULO_EN_MOVIMIENTO') {
    if (s.state === 'INICIO') return no('No hay un recorrido iniciado');
    if (INTERVIEW_STATES.has(s.state)) {
      // Seguridad: se pausa la entrevista. El punto no se pierde.
      return ok({ state: 'VEHICULO_EN_MOVIMIENTO', moving: true, resumeTo: 'PREGUNTANDO' });
    }
    if (s.state === 'CAPTURANDO_UBICACION') {
      return ok({ state: 'VEHICULO_EN_MOVIMIENTO', moving: true, resumeTo: null });
    }
    if (s.state === 'RECORRIDO' || s.state === 'VEHICULO_DETENIDO' || s.state === 'PUNTO_COMPLETADO') {
      return ok({ state: 'VEHICULO_EN_MOVIMIENTO', moving: true, pointId: s.state === 'PUNTO_COMPLETADO' ? null : s.pointId });
    }
    // GUARDANDO, SINCRONIZANDO, ERROR, VEHICULO_EN_MOVIMIENTO: solo se anota.
    return ok({ moving: true });
  }

  if (e.type === 'VEHICULO_DETENIDO') {
    if (s.state === 'INICIO') return no('No hay un recorrido iniciado');
    if (s.state === 'VEHICULO_EN_MOVIMIENTO' || s.state === 'RECORRIDO') {
      if (s.resumeTo && s.pointId) {
        return ok({ state: s.resumeTo, moving: false, resumeTo: null });
      }
      return ok({ state: 'VEHICULO_DETENIDO', moving: false, resumeTo: null });
    }
    return ok({ moving: false });
  }

  switch (s.state) {
    case 'INICIO':
      if (e.type === 'INICIAR_RECORRIDO') return ok({ state: 'RECORRIDO', routeId: e.routeId, error: null });
      if (e.type === 'SINCRONIZAR') return ok({ state: 'SINCRONIZANDO', resumeTo: 'INICIO' });
      break;

    case 'RECORRIDO':
    case 'VEHICULO_DETENIDO':
      if (e.type === 'TOMAR_UBICACION') {
        if (s.state !== 'VEHICULO_DETENIDO' || s.moving) {
          return no('Detené el vehículo antes de relevar');
        }
        return ok({ state: 'CAPTURANDO_UBICACION', pointId: null, questionKey: null });
      }
      if (e.type === 'FINALIZAR_RECORRIDO') return ok({ ...initialSnapshot });
      if (e.type === 'SINCRONIZAR') return ok({ state: 'SINCRONIZANDO', resumeTo: s.state });
      break;

    case 'VEHICULO_EN_MOVIMIENTO':
      if (e.type === 'TOMAR_UBICACION') return no('Detené el vehículo antes de relevar');
      if (e.type === 'FINALIZAR_RECORRIDO') {
        if (s.resumeTo && s.pointId) return no('Hay un punto en curso: detenete para terminarlo o descartarlo');
        return ok({ ...initialSnapshot });
      }
      if (e.type === 'DESCARTAR_PUNTO') return ok({ pointId: null, questionKey: null, resumeTo: null });
      break;

    case 'CAPTURANDO_UBICACION':
      if (e.type === 'UBICACION_OBTENIDA') return ok({ state: 'PUNTO_ACTIVO', pointId: e.pointId });
      if (e.type === 'UBICACION_FALLIDA') return ok({ state: 'VEHICULO_DETENIDO', error: e.reason });
      break;

    case 'PUNTO_ACTIVO':
      if (e.type === 'PREGUNTAR') return ok({ state: 'PREGUNTANDO', questionKey: e.questionKey });
      if (e.type === 'DESCARTAR_PUNTO') return ok({ state: 'VEHICULO_DETENIDO', pointId: null, questionKey: null });
      break;

    case 'PREGUNTANDO':
      if (e.type === 'ESCUCHAR') return ok({ state: 'ESCUCHANDO' });
      if (e.type === 'PREGUNTAR') return ok({ questionKey: e.questionKey });
      if (e.type === 'DESCARTAR_PUNTO') return ok({ state: 'VEHICULO_DETENIDO', pointId: null, questionKey: null });
      break;

    case 'ESCUCHANDO':
      if (e.type === 'RESPUESTA_RECIBIDA') return ok({ state: 'PROCESANDO_RESPUESTA' });
      if (e.type === 'PREGUNTAR') return ok({ state: 'PREGUNTANDO', questionKey: e.questionKey }); // repetir
      if (e.type === 'DESCARTAR_PUNTO') return ok({ state: 'VEHICULO_DETENIDO', pointId: null, questionKey: null });
      break;

    case 'PROCESANDO_RESPUESTA':
      if (e.type === 'RESPUESTA_PROCESADA') {
        return ok({ state: e.completo ? 'CONFIRMANDO' : 'PREGUNTANDO' });
      }
      break;

    case 'CONFIRMANDO':
      if (e.type === 'CONFIRMACION_SI') return ok({ state: 'GUARDANDO' });
      if (e.type === 'CONFIRMACION_NO') return ok({ state: 'PREGUNTANDO' });
      if (e.type === 'DESCARTAR_PUNTO') return ok({ state: 'VEHICULO_DETENIDO', pointId: null, questionKey: null });
      break;

    case 'GUARDANDO':
      if (e.type === 'GUARDADO') return ok({ state: 'PUNTO_COMPLETADO', questionKey: null });
      break;

    case 'PUNTO_COMPLETADO':
      if (e.type === 'CONTINUAR') {
        return ok({ state: s.moving ? 'VEHICULO_EN_MOVIMIENTO' : 'VEHICULO_DETENIDO', pointId: null });
      }
      if (e.type === 'SINCRONIZAR') return ok({ state: 'SINCRONIZANDO', pointId: null, resumeTo: 'VEHICULO_DETENIDO' });
      break;

    case 'SINCRONIZANDO':
      if (e.type === 'SINCRONIZACION_TERMINADA') {
        const back = s.resumeTo ?? (s.routeId ? 'VEHICULO_DETENIDO' : 'INICIO');
        const state = back === 'VEHICULO_DETENIDO' && s.moving ? 'VEHICULO_EN_MOVIMIENTO' : back;
        return ok({ state, resumeTo: null });
      }
      break;

    case 'ERROR':
      if (e.type === 'REINTENTAR') {
        let state = s.resumeTo ?? 'INICIO';
        // Nunca se retoma una entrevista con el vehículo en movimiento.
        if (s.moving && INTERVIEW_STATES.has(state)) {
          return ok({ state: 'VEHICULO_EN_MOVIMIENTO', resumeTo: 'PREGUNTANDO', error: null });
        }
        if (s.moving && state === 'VEHICULO_DETENIDO') state = 'VEHICULO_EN_MOVIMIENTO';
        return ok({ state, resumeTo: null, error: null });
      }
      if (e.type === 'DESCARTAR_PUNTO') {
        return ok({ state: s.routeId ? 'VEHICULO_DETENIDO' : 'INICIO', pointId: null, questionKey: null, resumeTo: null, error: null });
      }
      break;
  }

  return no(`Evento ${e.type} no válido en ${s.state}`);
}

/** A dónde volver después de un error sin perder trabajo. */
function safeResumeState(s: Snapshot): AppState {
  switch (s.state) {
    case 'ESCUCHANDO':
    case 'PROCESANDO_RESPUESTA':
    case 'PUNTO_ACTIVO':
      return 'PREGUNTANDO';
    case 'CAPTURANDO_UBICACION':
      return 'VEHICULO_DETENIDO';
    case 'SINCRONIZANDO':
      return s.resumeTo ?? (s.routeId ? 'VEHICULO_DETENIDO' : 'INICIO');
    case 'ERROR':
      return s.resumeTo ?? 'INICIO';
    default:
      return s.state;
  }
}

export function isIdle(state: AppState): boolean {
  return IDLE_STATES.has(state);
}

/** Texto corto para la barra de estado de la app. */
export const STATE_LABELS: Record<AppState, string> = {
  INICIO: 'Listo para iniciar',
  RECORRIDO: 'Recorrido iniciado',
  VEHICULO_EN_MOVIMIENTO: 'En movimiento',
  VEHICULO_DETENIDO: 'Detenido',
  CAPTURANDO_UBICACION: 'Tomando ubicación…',
  PUNTO_ACTIVO: 'Punto activo',
  ESCUCHANDO: 'Escuchando…',
  PROCESANDO_RESPUESTA: 'Procesando respuesta…',
  PREGUNTANDO: 'Preguntando',
  CONFIRMANDO: 'Confirmando',
  GUARDANDO: 'Guardando…',
  PUNTO_COMPLETADO: 'Punto guardado',
  SINCRONIZANDO: 'Sincronizando…',
  ERROR: 'Error',
};
