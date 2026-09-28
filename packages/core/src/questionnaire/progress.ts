import type { Field, Question, QuestionnaireDefinition } from './schema.js';
import { evaluateCondition } from './conditions.js';
import { valuesOf, type FactMap, type FactValue } from '../facts.js';

/**
 * Estado del relevamiento de un punto respecto del cuestionario:
 * qué se sabe, qué falta y cuál es la próxima pregunta.
 * Funciones puras: las usan la app (offline) y la API (validación al sincronizar).
 */

export function isFieldVisible(field: Field, values: Record<string, FactValue>): boolean {
  return field.visibleIf ? evaluateCondition(field.visibleIf, values) : true;
}

export function isFieldRequired(field: Field, values: Record<string, FactValue>): boolean {
  if (!isFieldVisible(field, values)) return false;
  if (field.required) return true;
  return field.requiredIf ? evaluateCondition(field.requiredIf, values) : false;
}

/** Un campo está resuelto si hay un dato, aunque sea "desconocido": no se vuelve a preguntar. */
export function isResolved(facts: FactMap, key: string): boolean {
  return facts[key] !== undefined;
}

export function missingRequiredFields(def: QuestionnaireDefinition, facts: FactMap): Field[] {
  const values = valuesOf(facts);
  return def.fields.filter((f) => isFieldRequired(f, values) && !isResolved(facts, f.key));
}

export interface ProgressState {
  facts: FactMap;
  /** Preguntas ya formuladas en este punto. */
  asked: readonly string[];
}

/** Campos de la pregunta que todavía aportarían información. */
function pendingFieldsOf(q: Question, def: QuestionnaireDefinition, facts: FactMap, values: Record<string, FactValue>) {
  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  const required: Field[] = [];
  const optional: Field[] = [];
  for (const k of q.fields) {
    const f = byKey.get(k);
    if (!f || !isFieldVisible(f, values) || isResolved(facts, k)) continue;
    (isFieldRequired(f, values) ? required : optional).push(f);
  }
  return { required, optional };
}

/**
 * Elige la próxima pregunta:
 * 1. Solo preguntas visibles y no formuladas en este punto.
 * 2. Debe aportar algún campo obligatorio faltante, o ser `askAlways` con campos pendientes.
 * 3. Se priorizan los seguimientos de la última pregunta formulada.
 * 4. Luego, la que cubre más obligatorios faltantes; a igualdad, el orden definido por el admin.
 * La apertura siempre va primero.
 */
export function nextQuestion(def: QuestionnaireDefinition, state: ProgressState): Question | null {
  const values = valuesOf(state.facts);
  const asked = new Set(state.asked);

  if (!asked.has(def.openingQuestion)) {
    return def.questions.find((q) => q.key === def.openingQuestion) ?? null;
  }

  const candidates = def.questions
    .map((q, order) => ({ q, order, ...pendingFieldsOf(q, def, state.facts, values) }))
    .filter(({ q, required, optional }) => {
      if (asked.has(q.key)) return false;
      if (q.visibleIf && !evaluateCondition(q.visibleIf, values)) return false;
      return required.length > 0 || (q.askAlways && optional.length > 0);
    });
  if (candidates.length === 0) return null;

  const last = state.asked[state.asked.length - 1];
  const lastQ = last ? def.questions.find((q) => q.key === last) : undefined;
  const followUps = lastQ?.followUps ?? [];
  for (const fu of followUps) {
    const hit = candidates.find((c) => c.q.key === fu);
    if (hit) return hit.q;
  }

  candidates.sort((a, b) => b.required.length - a.required.length || a.order - b.order);
  return candidates[0]!.q;
}

export interface CompletionStatus {
  complete: boolean;
  missing: Field[];
  conditionMet: boolean;
  next: Question | null;
}

/**
 * Un punto está completo cuando no faltan obligatorios, se cumple la condición
 * de completitud del cuestionario y no quedan preguntas pertinentes.
 * El relevador no tiene que decir "fin": RELEVA lo determina con esto.
 */
export function completionStatus(def: QuestionnaireDefinition, state: ProgressState): CompletionStatus {
  const missing = missingRequiredFields(def, state.facts);
  const conditionMet = def.completion.condition
    ? evaluateCondition(def.completion.condition, valuesOf(state.facts))
    : true;
  const next = nextQuestion(def, state);
  return { complete: missing.length === 0 && conditionMet && next === null, missing, conditionMet, next };
}

/** Progreso 0..1 para mostrar en pantalla. */
export function progressRatio(def: QuestionnaireDefinition, facts: FactMap): number {
  const values = valuesOf(facts);
  const required = def.fields.filter((f) => isFieldRequired(f, values));
  if (required.length === 0) return 1;
  const done = required.filter((f) => isResolved(facts, f.key)).length;
  return done / required.length;
}

// ── Confirmación ───────────────────────────────────────────────────────────

function formatValue(field: Field, value: FactValue): string {
  if (value === null) return 'desconocido';
  if (field.type === 'boolean') return value ? 'sí' : 'no';
  const label = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
  if (field.type === 'single_choice' && typeof value === 'string') return label(value);
  if (field.type === 'multi_choice' && Array.isArray(value)) return value.map(label).join(', ');
  return String(value);
}

export interface ConfirmationItem {
  fieldKey: string;
  label: string;
  display: string;
  spoken: string;
}

/**
 * Lo que RELEVA lee antes de guardar. Solo incluye datos efectivamente
 * obtenidos (nunca completa lo que falta) y campos visibles marcados para confirmar.
 * Los booleanos negativos no se leen salvo que el campo defina cómo decirlo.
 */
export function confirmationItems(def: QuestionnaireDefinition, facts: FactMap): ConfirmationItem[] {
  const values = valuesOf(facts);
  const items: ConfirmationItem[] = [];
  for (const field of def.fields) {
    const fact = facts[field.key];
    if (!fact || fact.status === 'unknown' || !field.confirm || !isFieldVisible(field, values)) continue;
    const display = formatValue(field, fact.value);
    let spoken: string;
    if (field.spoken) {
      if (field.type === 'boolean' && fact.value === false) continue;
      spoken = field.spoken.replace('{value}', display);
    } else {
      spoken = `${field.label}: ${display}`;
    }
    items.push({ fieldKey: field.key, label: field.label, display, spoken });
  }
  return items;
}

export function confirmationSentence(items: readonly ConfirmationItem[]): string {
  if (items.length === 0) return 'No registré datos todavía. ¿Querés continuar?';
  const parts = items.map((i) => i.spoken);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
  return `Registré ${list}. ¿Está correcto?`;
}
