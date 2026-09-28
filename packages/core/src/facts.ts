import type { Field, QuestionnaireDefinition } from './questionnaire/schema.js';

/**
 * Un dato relevado. La voz es solo el medio de captura: lo que se guarda
 * es esto, con trazabilidad completa de dónde salió.
 */

export const FACT_STATUSES = ['mentioned', 'extracted', 'confirmed', 'unknown'] as const;
/**
 * - mentioned: el relevador lo dijo literalmente ("dos mantas" → mantas = 2).
 * - extracted: el intérprete lo estructuró a partir de lo dicho ("una persona sola" → personas = 1).
 * - confirmed: el relevador confirmó el dato.
 * - unknown: se preguntó y no se sabe. Queda registrado como desconocido, nunca se inventa.
 */
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_SOURCES = ['voice', 'manual', 'system'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export type FactValue = number | boolean | string | string[] | null;

export interface Fact {
  fieldKey: string;
  value: FactValue;
  status: FactStatus;
  source: FactSource;
  /** Pregunta que se estaba haciendo cuando se obtuvo el dato. */
  questionKey?: string;
  /** Respuesta original del relevador, tal cual se reconoció. */
  rawAnswer?: string;
  /** ISO 8601. */
  recordedAt: string;
  /** Valores anteriores si el dato fue corregido. */
  previous?: Omit<Fact, 'previous'>[];
}

export type FactMap = Readonly<Record<string, Fact>>;

/** Propuesta de dato hecha por el intérprete. Todavía no es un dato. */
export interface FactProposal {
  fieldKey: string;
  value: unknown;
  /** true si el relevador lo dijo literalmente; false si es una estructuración. */
  explicit: boolean;
  /** Fragmento de la respuesta que justifica el dato. */
  evidence?: string;
  /** El relevador dijo que no sabe / no se ve. */
  unknown?: boolean;
}

export interface RejectedProposal {
  proposal: FactProposal;
  reason: string;
}

/** Valida y normaliza un valor contra la definición del campo. */
export function coerceValue(field: Field, raw: unknown): { ok: true; value: FactValue } | { ok: false; reason: string } {
  switch (field.type) {
    case 'integer': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, reason: 'no es un número entero' };
      if (field.min !== undefined && n < field.min) return { ok: false, reason: `menor que ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, reason: `mayor que ${field.max}` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'si' || raw === 'sí') return { ok: true, value: true };
      if (raw === 'false' || raw === 'no') return { ok: true, value: false };
      return { ok: false, reason: 'no es sí/no' };
    }
    case 'single_choice': {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      if (typeof raw !== 'string' || !allowed.has(raw)) return { ok: false, reason: 'opción no válida' };
      return { ok: true, value: raw };
    }
    case 'multi_choice': {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      const arr = Array.isArray(raw) ? raw : [raw];
      if (arr.length === 0 || !arr.every((v) => typeof v === 'string' && allowed.has(v))) {
        return { ok: false, reason: 'opciones no válidas' };
      }
      return { ok: true, value: [...new Set(arr as string[])] };
    }
    case 'text': {
      if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'texto vacío' };
      return { ok: true, value: raw.trim().slice(0, 2000) };
    }
  }
}

export interface ApplyContext {
  questionKey?: string;
  rawAnswer?: string;
  source?: FactSource;
  now: string;
}

/**
 * Incorpora las propuestas del intérprete a los datos conocidos.
 * Las reglas del sistema tienen la última palabra: lo que no valida contra
 * el cuestionario se descarta y se informa. Nunca se inventa información.
 */
export function applyProposals(
  def: QuestionnaireDefinition,
  facts: FactMap,
  proposals: readonly FactProposal[],
  ctx: ApplyContext,
): { facts: Record<string, Fact>; accepted: Fact[]; rejected: RejectedProposal[] } {
  const next: Record<string, Fact> = { ...facts };
  const accepted: Fact[] = [];
  const rejected: RejectedProposal[] = [];
  const byKey = new Map(def.fields.map((f) => [f.key, f]));

  for (const p of proposals) {
    const field = byKey.get(p.fieldKey);
    if (!field) {
      rejected.push({ proposal: p, reason: 'campo inexistente en el cuestionario' });
      continue;
    }
    let fact: Fact;
    if (p.unknown) {
      fact = base(field.key, null, 'unknown');
    } else {
      const c = coerceValue(field, p.value);
      if (!c.ok) {
        rejected.push({ proposal: p, reason: c.reason });
        continue;
      }
      fact = base(field.key, c.value, p.explicit ? 'mentioned' : 'extracted');
    }
    const prev = next[field.key];
    if (prev) {
      if (sameValue(prev.value, fact.value) && prev.status !== 'unknown') continue; // nada nuevo
      const { previous = [], ...prevCore } = prev;
      fact.previous = [...previous, prevCore];
    }
    next[field.key] = fact;
    accepted.push(fact);
  }
  return { facts: next, accepted, rejected };

  function base(fieldKey: string, value: FactValue, status: FactStatus): Fact {
    const f: Fact = { fieldKey, value, status, source: ctx.source ?? 'voice', recordedAt: ctx.now };
    if (ctx.questionKey) f.questionKey = ctx.questionKey;
    if (ctx.rawAnswer !== undefined) f.rawAnswer = ctx.rawAnswer;
    return f;
  }
}

/** Marca como confirmados los datos leídos en la confirmación final. */
export function confirmFacts(facts: FactMap, keys: readonly string[], now: string): Record<string, Fact> {
  const next: Record<string, Fact> = { ...facts };
  for (const k of keys) {
    const f = next[k];
    if (f && f.status !== 'unknown' && f.status !== 'confirmed') {
      next[k] = { ...f, status: 'confirmed', recordedAt: now };
    }
  }
  return next;
}

function sameValue(a: FactValue, b: FactValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
  }
  return a === b;
}

/** Valores planos (campo → valor) para evaluar condiciones. Los desconocidos quedan como null. */
export function valuesOf(facts: FactMap): Record<string, FactValue> {
  const out: Record<string, FactValue> = {};
  for (const [k, f] of Object.entries(facts)) out[k] = f.value;
  return out;
}
