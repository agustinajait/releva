import type { FactProposal } from './facts.js';
import type { Field } from './questionnaire/schema.js';
import type { Interpreter, InterpretRequest, InterpretResponse } from './voice.js';

/**
 * Normaliza texto hablado: minúsculas, sin tildes ni puntuación.
 */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Comandos de voz ────────────────────────────────────────────────────────

export type VoiceCommand = 'tomar_ubicacion' | 'repetir' | 'cancelar_punto' | 'sincronizar' | 'finalizar_recorrido';

const COMMANDS: [VoiceCommand, RegExp][] = [
  ['tomar_ubicacion', /\b(toma|tomar|marca|marcar|guarda|guardar)\s+((la|el)\s+)?(latitud|ubicacion|posicion|punto)\b/],
  ['repetir', /\b(repeti|repetir|repetime|de nuevo|otra vez)\b/],
  ['cancelar_punto', /\b(cancela|cancelar|descarta|descartar)\s+(el\s+)?punto\b/],
  ['sincronizar', /\b(sincroniza|sincronizar)\b/],
  ['finalizar_recorrido', /\b(finaliza|finalizar|termina|terminar)\s+(el\s+)?recorrido\b/],
];

/**
 * Reconoce comandos operativos. Exige la palabra "RELEVA" al inicio para no
 * disparar acciones por conversaciones de fondo ("tomá la ubicación" dicho a otra persona).
 */
export function parseCommand(text: string, opts: { requireWakeWord?: boolean } = {}): VoiceCommand | null {
  const t = normalizeSpeech(text);
  const requireWake = opts.requireWakeWord ?? true;
  const m = /^(releva|re leva|relevá)\b\s*(.*)$/.exec(t);
  if (requireWake && !m) return null;
  const rest = m ? m[2]! : t;
  for (const [cmd, re] of COMMANDS) if (re.test(rest)) return cmd;
  return null;
}

// ── Números hablados ───────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, ninguno: 0, ninguna: 0, nadie: 0,
};

/** Primer número de la frase, en cifras o en palabras (0–20). */
export function parseSpokenNumber(text: string): number | null {
  const t = normalizeSpeech(text);
  const digits = /\b(\d{1,3})\b/.exec(t);
  if (digits) return Number(digits[1]);
  for (const w of t.split(' ')) if (w in NUMBER_WORDS) return NUMBER_WORDS[w]!;
  return null;
}

const UNKNOWN_RE = /^(no se|no lo se|no sabria|no se ve|no puedo ver|no se distingue|ni idea|desconocido)\b/;
const YES_RE = /^(si|sip|afirmativo|correcto|claro|hay)\b/;
const NO_RE = /^(no|nop|negativo|ninguno|ninguna|nada|no hay)\b/;

function answerForField(field: Field, text: string): FactProposal | null {
  const t = normalizeSpeech(text);
  if (UNKNOWN_RE.test(t)) return { fieldKey: field.key, value: null, explicit: true, unknown: true, evidence: text };
  switch (field.type) {
    case 'boolean':
      if (YES_RE.test(t)) return { fieldKey: field.key, value: true, explicit: true, evidence: text };
      if (NO_RE.test(t)) return { fieldKey: field.key, value: false, explicit: true, evidence: text };
      return null;
    case 'integer': {
      const n = parseSpokenNumber(t);
      return n === null ? null : { fieldKey: field.key, value: n, explicit: true, evidence: text };
    }
    case 'single_choice':
    case 'multi_choice': {
      const hits = (field.options ?? []).filter((o) => {
        const label = normalizeSpeech(o.label);
        return new RegExp(`\\b${label}\\b`).test(t) || new RegExp(`\\b${o.value.replace(/_/g, ' ')}\\b`).test(t);
      });
      if (hits.length === 0) return null;
      const value = field.type === 'single_choice' ? hits[0]!.value : hits.map((h) => h.value);
      return { fieldKey: field.key, value, explicit: true, evidence: text };
    }
    case 'text':
      return null;
  }
}

/**
 * Intérprete de respuestas DIRECTAS, sin IA: sí/no, "no sé", números y opciones
 * nombradas, solo para el primer campo pendiente de la pregunta que se hizo.
 *
 * Es deliberadamente conservador: si no entiende, no propone nada y RELEVA
 * vuelve a preguntar. No extrae varios datos de una frase libre ("una mujer con
 * un chico y tres bolsos"): eso lo hará el intérprete con IA en la próxima etapa,
 * con el mismo contrato `Interpreter`.
 */
export class DirectAnswerInterpreter implements Interpreter {
  readonly id = 'direct-answer';

  async interpret(req: InterpretRequest): Promise<InterpretResponse> {
    const t = normalizeSpeech(req.answer);
    if (!t) return { proposals: [], intent: 'unclear', provider: this.id };
    if (/\b(repeti|repetir|de nuevo|otra vez|como)\b/.test(t) && t.split(' ').length <= 3) {
      return { proposals: [], intent: 'repeat', provider: this.id };
    }
    const fields = new Map(req.definition.fields.map((f) => [f.key, f]));
    const pending = req.question.fields.map((k) => fields.get(k)).filter((f): f is Field => !!f && req.known[f.key] === undefined);
    const target = pending[0];
    if (!target) return { proposals: [], intent: 'answer', provider: this.id };
    const proposals: FactProposal[] = [];
    const first = answerForField(target, req.answer);
    if (first) {
      proposals.push(first);
      // "Sí, una mochila": el detalle que sigue al sí/no puede completar el siguiente campo de la misma pregunta.
      if (target.type === 'boolean' && first.value === true) {
        const rest = req.answer.replace(/^\s*\S+[\s,]*/, '');
        for (const next of pending.slice(1)) {
          if (!rest) break;
          const p = answerForField(next, rest);
          if (p && !p.unknown) proposals.push(p);
        }
      }
    }
    return { proposals, intent: proposals.length ? 'answer' : 'unclear', provider: this.id };
  }
}
