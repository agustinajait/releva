import type { FactMap, FactProposal } from './facts.js';
import type { Question, QuestionnaireDefinition } from './questionnaire/schema.js';

/**
 * Contratos de voz e IA. La app depende de estas interfaces, nunca de un
 * proveedor concreto: cambiar de proveedor es escribir un adaptador nuevo.
 */

// ── Voz ────────────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  /** 0..1 si el proveedor la informa. */
  confidence?: number;
  /** Proveedor que produjo la transcripción, para auditoría. */
  provider: string;
}

export interface SpeechToText {
  readonly id: string;
  /** Escucha hasta que el relevador termina de hablar (o se agota el tiempo). */
  listen(opts: { locale: string; timeoutMs: number; signal?: { readonly aborted: boolean } }): Promise<TranscriptionResult>;
  isAvailable(): Promise<boolean>;
}

export interface TextToSpeech {
  readonly id: string;
  speak(text: string, opts: { locale: string }): Promise<void>;
  stop(): Promise<void>;
}

// ── Intérprete (IA) ────────────────────────────────────────────────────────

export interface InterpretRequest {
  definition: QuestionnaireDefinition;
  /** Pregunta que se acaba de hacer. */
  question: Question;
  /** Respuesta del relevador (transcripción). */
  answer: string;
  /** Lo que ya se sabe del punto, para no repetir y resolver referencias. */
  known: FactMap;
  locale: string;
}

export interface InterpretResponse {
  /** Datos propuestos. El núcleo los valida contra el cuestionario antes de aceptarlos. */
  proposals: FactProposal[];
  /** El relevador pidió repetir, dijo algo inentendible, etc. */
  intent?: 'answer' | 'repeat' | 'unclear' | 'cancel';
  provider: string;
}

/**
 * Convierte lenguaje natural en propuestas de datos estructurados.
 * Contrato: solo propone datos que estén en la respuesta; jamás completa
 * lo que no se dijo. Lo que no se sabe se propone con `unknown: true`.
 */
export interface Interpreter {
  readonly id: string;
  interpret(req: InterpretRequest): Promise<InterpretResponse>;
}

/** Intérprete para pruebas: devuelve respuestas guionadas según el texto recibido. */
export class ScriptedInterpreter implements Interpreter {
  readonly id = 'scripted';
  constructor(private readonly script: Record<string, FactProposal[]>) {}
  async interpret(req: InterpretRequest): Promise<InterpretResponse> {
    const proposals = this.script[req.answer.trim().toLowerCase()];
    return proposals
      ? { proposals, intent: 'answer', provider: this.id }
      : { proposals: [], intent: 'unclear', provider: this.id };
  }
}

/** Respuestas afirmativas/negativas para la confirmación final. Deliberadamente estricto. */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  if (/^(si|sí|correcto|esta bien|dale|confirmo|exacto|afirmativo)\b/.test(t)) return 'yes';
  if (/^(no|incorrecto|esta mal|corregir|negativo)\b/.test(t)) return 'no';
  return null;
}
