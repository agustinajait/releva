import {
  applyProposals,
  completionStatus,
  confirmFacts,
  confirmationItems,
  confirmationSentence,
  parseYesNo,
  progressRatio,
  type Fact,
  type Interpreter,
  type LocationFix,
  type Question,
  type QuestionnaireDefinition,
  type SurveySyncItem,
} from '@releva/core';

/**
 * Sesión de relevamiento de UN punto.
 *
 * Implementa el ciclo PREGUNTAR → ESCUCHAR → INTERPRETAR → ESTRUCTURAR →
 * DETECTAR QUÉ FALTA → PREGUNTAR → CONFIRMAR usando las reglas del núcleo.
 * No conoce la UI ni el dispositivo: recibe texto y devuelve lo que RELEVA debe decir.
 */

export type SessionPhase = 'asking' | 'confirming' | 'done';

export interface Prompt {
  /** Lo que RELEVA dice en voz alta. */
  say: string;
  phase: SessionPhase;
  question: Question | null;
  /** Respuesta no entendida: se repite la pregunta. */
  retry?: boolean;
}

export interface Utterance {
  speaker: 'releva' | 'surveyor';
  text: string;
  at: string;
}

export interface SessionDeps {
  interpreter: Interpreter;
  now: () => string;
  locale?: string;
}

const MAX_UNCLEAR = 2;

export class PointSession {
  readonly startedAt: string;
  private facts: Record<string, Fact> = {};
  private asked: string[] = [];
  private utterances: Utterance[] = [];
  private current: Question | null = null;
  private unclear = 0;
  private _phase: SessionPhase = 'asking';
  private incomplete = false;
  private completedAt: string | null = null;
  lastRecognized: string | null = null;

  constructor(
    readonly id: string,
    readonly definition: QuestionnaireDefinition,
    readonly versionId: string,
    readonly projectId: string,
    readonly routeId: string | null,
    readonly fix: LocationFix,
    private readonly deps: SessionDeps,
  ) {
    this.startedAt = deps.now();
  }

  get phase() {
    return this._phase;
  }
  get currentQuestion() {
    return this.current;
  }
  get knownFacts(): Readonly<Record<string, Fact>> {
    return this.facts;
  }
  get transcript(): readonly Utterance[] {
    return this.utterances;
  }
  get progress(): number {
    return this.phase === 'done' ? 1 : progressRatio(this.definition, this.facts);
  }

  /** Primera pregunta (la de apertura). */
  start(): Prompt {
    return this.advance();
  }

  /** Repite lo último que dijo RELEVA. */
  repeat(): Prompt {
    const last = [...this.utterances].reverse().find((u) => u.speaker === 'releva');
    const say = last?.text ?? this.current?.text ?? '';
    return { say, phase: this._phase, question: this.current };
  }

  async answer(text: string): Promise<Prompt> {
    const clean = text.trim();
    this.lastRecognized = clean;
    this.log('surveyor', clean);

    if (this._phase === 'confirming') return this.handleConfirmation(clean);
    if (this._phase === 'done' || !this.current) return { say: '', phase: this._phase, question: null };

    const question = this.current;
    const res = await this.deps.interpreter.interpret({
      definition: this.definition,
      question,
      answer: clean,
      known: this.facts,
      locale: this.deps.locale ?? 'es-AR',
    });

    if (res.intent === 'repeat') return this.say(question.text, question);

    const applied = applyProposals(this.definition, this.facts, res.proposals, {
      questionKey: question.key,
      rawAnswer: clean,
      source: 'voice',
      now: this.deps.now(),
    });
    this.facts = applied.facts;

    if (applied.accepted.length === 0) {
      this.unclear += 1;
      if (this.unclear <= MAX_UNCLEAR) {
        return { ...this.say(`No te entendí. ${question.text}`, question), retry: true };
      }
      // Tras varios intentos, se sigue adelante: el dato queda faltante, nunca inventado.
    }
    this.unclear = 0;
    return this.advance();
  }

  /** Arma la carga para la cola de sincronización. */
  toSyncItem(status: SurveySyncItem['status']): SurveySyncItem {
    return {
      clientUuid: this.id,
      projectId: this.projectId,
      routeId: this.routeId,
      questionnaireVersionId: this.versionId,
      location: {
        lat: this.fix.lat,
        lng: this.fix.lng,
        accuracy: this.fix.accuracy,
        altitude: this.fix.altitude ?? null,
        capturedAt: this.fix.capturedAt,
      },
      status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      facts: Object.values(this.facts).map((f) => ({
        fieldKey: f.fieldKey,
        value: f.value,
        status: f.status,
        source: f.source,
        ...(f.questionKey ? { questionKey: f.questionKey } : {}),
        ...(f.rawAnswer ? { rawAnswer: f.rawAnswer } : {}),
        recordedAt: f.recordedAt,
      })),
      utterances: this.utterances.map((u) => ({ ...u })),
    };
  }

  get resultStatus(): 'completed' | 'incomplete' {
    return this.incomplete ? 'incomplete' : 'completed';
  }

  // ── internos ───────────────────────────────────────────────────────────

  private advance(): Prompt {
    const status = completionStatus(this.definition, { facts: this.facts, asked: this.asked });
    if (status.next) {
      this.current = status.next;
      this.asked.push(status.next.key);
      return this.say(status.next.text, status.next);
    }
    this.current = null;
    this.incomplete = !status.complete;
    if (!this.definition.completion.requireConfirmation && status.complete) return this.finish();
    this._phase = 'confirming';
    const items = confirmationItems(this.definition, this.facts);
    if (this.incomplete) {
      const missing = status.missing.map((f) => f.label.toLowerCase()).join(', ');
      return this.say(`Faltan datos: ${missing}. ${items.length ? confirmationSentence(items).replace(' ¿Está correcto?', '') + ' ' : ''}¿Guardo el punto incompleto?`, null);
    }
    return this.say(confirmationSentence(items), null);
  }

  private handleConfirmation(text: string): Prompt {
    const yn = parseYesNo(text);
    if (yn === 'yes') {
      const keys = confirmationItems(this.definition, this.facts).map((i) => i.fieldKey);
      this.facts = confirmFacts(this.facts, keys, this.deps.now());
      return this.finish();
    }
    if (yn === 'no') {
      // Provisorio hasta el motor conversacional: se vuelve a preguntar todo.
      // Lo dicho queda en la transcripción; los datos anteriores no se guardan como válidos.
      this.facts = {};
      this.asked = [];
      this._phase = 'asking';
      this.incomplete = false;
      const first = this.advance();
      return { ...first, say: `Entendido, lo corregimos. ${first.say}` };
    }
    return this.say('Decime sí o no. ' + (this.lastReleva() ?? ''), null);
  }

  private finish(): Prompt {
    this._phase = 'done';
    this.completedAt = this.deps.now();
    return this.say('Punto guardado. Podés continuar.', null);
  }

  private lastReleva() {
    return [...this.utterances].reverse().find((u) => u.speaker === 'releva' && !u.text.startsWith('Decime sí o no'))?.text;
  }

  private say(text: string, question: Question | null): Prompt {
    this.log('releva', text);
    return { say: text, phase: this._phase, question };
  }

  private log(speaker: Utterance['speaker'], text: string) {
    this.utterances.push({ speaker, text, at: this.deps.now() });
  }
}
