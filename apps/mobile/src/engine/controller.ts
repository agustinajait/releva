import {
  INTERVIEW_STATES,
  MotionDetector,
  Outbox,
  initialSnapshot,
  parseCommand,
  transition,
  type AppEvent,
  type Interpreter,
  type LocationFix,
  type MotionState,
  type QuestionnaireDefinition,
  type Snapshot,
  type SurveySyncItem,
  type TextToSpeech,
  type VoiceCommand,
} from '@releva/core';
import { PointSession, type Prompt } from './point-session';

/**
 * Controlador de la app: une la máquina de estados, el GPS, la voz, la sesión
 * del punto y la cola offline. No depende de React Native: todo llega por
 * interfaces, así el flujo completo se prueba sin dispositivo.
 */

export interface LocationProvider {
  /** Mejor lectura posible dentro del tiempo dado. Lanza si no hay señal. */
  captureFix(opts: { timeoutMs: number; desiredAccuracyM: number }): Promise<LocationFix>;
}

export interface DraftStore {
  /** Guarda el punto en curso tras cada respuesta: si la app se cierra, no se pierde. */
  saveDraft(item: SurveySyncItem): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}

export interface RouteContext {
  projectId: string;
  projectName: string;
  routeId: string | null;
  routeName: string;
  zoneName: string | null;
  questionnaireVersionId: string;
  definition: QuestionnaireDefinition;
}

export interface ControllerDeps {
  location: LocationProvider;
  tts: TextToSpeech;
  interpreter: Interpreter;
  outbox: Outbox;
  drafts: DraftStore;
  uuid: () => string;
  now?: () => string;
  locale?: string;
}

export interface SyncInfo {
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  online: boolean;
  running: boolean;
}

export interface ControllerView {
  snapshot: Snapshot;
  route: RouteContext | null;
  lastFix: LocationFix | null;
  motion: MotionState;
  pointFix: LocationFix | null;
  question: string | null;
  lastSpoken: string | null;
  recognized: string | null;
  progress: number;
  knownCount: number;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  lastSaved: { id: string; status: string } | null;
  sync: SyncInfo;
  message: string | null;
}

export class AppController {
  private snap: Snapshot = initialSnapshot;
  private route: RouteContext | null = null;
  private session: PointSession | null = null;
  private motion = new MotionDetector();
  private motionOverride: MotionState | null = null;
  private listeners = new Set<(v: ControllerView) => void>();
  private view: ControllerView;
  private readonly now: () => string;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.view = {
      snapshot: this.snap,
      route: null,
      lastFix: null,
      motion: 'unknown',
      pointFix: null,
      question: null,
      lastSpoken: null,
      recognized: null,
      progress: 0,
      knownCount: 0,
      saveStatus: 'idle',
      lastSaved: null,
      sync: { pending: 0, lastSyncAt: null, lastError: null, online: false, running: false },
      message: null,
    };
  }

  // ── Suscripción de la UI ─────────────────────────────────────────────────

  subscribe(l: (v: ControllerView) => void): () => void {
    this.listeners.add(l);
    l(this.view);
    return () => this.listeners.delete(l);
  }

  get state(): ControllerView {
    return this.view;
  }

  private emit(patch: Partial<ControllerView> = {}) {
    const s = this.session;
    this.view = {
      ...this.view,
      ...patch,
      snapshot: this.snap,
      route: this.route,
      pointFix: s?.fix ?? null,
      question: s?.currentQuestion?.text ?? null,
      recognized: s?.lastRecognized ?? (patch.recognized !== undefined ? patch.recognized : this.view.recognized),
      progress: s?.progress ?? 0,
      knownCount: s ? Object.keys(s.knownFacts).length : 0,
    };
    for (const l of this.listeners) l(this.view);
  }

  private dispatch(e: AppEvent): boolean {
    const r = transition(this.snap, e);
    if (!r.ok) {
      this.emit({ message: r.reason });
      return false;
    }
    this.snap = r.snapshot;
    this.emit({ message: null });
    return true;
  }

  private async speak(text: string) {
    if (!text) return;
    this.emit({ lastSpoken: text });
    try {
      await this.deps.tts.speak(text, { locale: this.deps.locale ?? 'es-AR' });
    } catch {
      // Si falla la voz, el texto sigue visible en pantalla.
    }
  }

  // ── Recorrido ────────────────────────────────────────────────────────────

  async startRoute(ctx: RouteContext) {
    this.route = ctx;
    this.motion = new MotionDetector();
    if (this.dispatch({ type: 'INICIAR_RECORRIDO', routeId: ctx.routeId ?? 'libre' })) {
      await this.refreshPending();
      await this.speak(`Recorrido ${ctx.routeName} iniciado.`);
    }
  }

  async endRoute() {
    if (this.dispatch({ type: 'FINALIZAR_RECORRIDO' })) {
      this.route = null;
      this.session = null;
      this.emit();
      void this.sync();
    }
  }

  // ── Movimiento ───────────────────────────────────────────────────────────

  /** Cada lectura del GPS en segundo plano. */
  onLocation(fix: LocationFix) {
    const changed = this.motionOverride ? null : this.motion.push(fix);
    this.emit({ lastFix: fix });
    if (changed) this.applyMotion(changed);
  }

  /** Solo para pruebas en emulador: fuerza detenido / en movimiento. */
  simulateMotion(state: MotionState | null) {
    this.motionOverride = state;
    if (state) this.applyMotion(state);
  }

  private applyMotion(m: MotionState) {
    this.emit({ motion: m });
    if (this.snap.state === 'INICIO') return;
    const wasInterview = INTERVIEW_STATES.has(this.snap.state);
    if (m === 'moving') {
      this.dispatch({ type: 'VEHICULO_EN_MOVIMIENTO' });
      if (wasInterview) {
        void this.deps.tts.stop();
        this.emit({ message: 'Entrevista en pausa: el vehículo está en movimiento.' });
      }
    } else if (m === 'stopped') {
      const paused = this.snap.state === 'VEHICULO_EN_MOVIMIENTO' && !!this.snap.resumeTo && !!this.session;
      this.dispatch({ type: 'VEHICULO_DETENIDO' });
      if (paused) void this.resumeQuestion();
    }
  }

  // ── Punto ────────────────────────────────────────────────────────────────

  async takeLocation() {
    if (!this.route) return;
    if (!this.dispatch({ type: 'TOMAR_UBICACION' })) {
      await this.speak(this.view.message ?? 'No se puede tomar la ubicación ahora.');
      return;
    }
    let fix: LocationFix;
    try {
      fix = await this.deps.location.captureFix({ timeoutMs: 15_000, desiredAccuracyM: 20 });
    } catch (err) {
      this.dispatch({ type: 'UBICACION_FALLIDA', reason: `No se pudo obtener la ubicación: ${(err as Error).message}` });
      await this.speak('No pude tomar la ubicación. Probá de nuevo.');
      return;
    }
    const id = this.deps.uuid();
    this.session = new PointSession(
      id,
      this.route.definition,
      this.route.questionnaireVersionId,
      this.route.projectId,
      this.route.routeId,
      fix,
      { interpreter: this.deps.interpreter, now: this.now, locale: this.deps.locale },
    );
    this.dispatch({ type: 'UBICACION_OBTENIDA', pointId: id });
    this.emit({ saveStatus: 'idle', recognized: null });
    await this.speak('Latitud tomada.');
    await this.persistDraft();
    await this.present(this.session.start());
  }

  /** Respuesta del relevador (transcripción del STT o texto escrito en modo desarrollo). */
  async answer(text: string) {
    const cmd = parseCommand(text);
    if (cmd) return this.command(cmd);
    const s = this.session;
    if (!s) return;
    if (this.snap.state === 'ESCUCHANDO') {
      this.dispatch({ type: 'RESPUESTA_RECIBIDA' });
      let prompt: Prompt;
      try {
        prompt = await s.answer(text);
      } catch (err) {
        this.dispatch({ type: 'FALLA', reason: `No se pudo interpretar la respuesta: ${(err as Error).message}` });
        return;
      }
      await this.persistDraft();
      if (prompt.phase === 'confirming') {
        this.dispatch({ type: 'RESPUESTA_PROCESADA', completo: true });
        await this.speak(prompt.say);
      } else {
        this.dispatch({ type: 'RESPUESTA_PROCESADA', completo: false });
        await this.present(prompt);
      }
    } else if (this.snap.state === 'CONFIRMANDO') {
      const prompt = await s.answer(text);
      await this.persistDraft();
      if (prompt.phase === 'done') {
        this.dispatch({ type: 'CONFIRMACION_SI' });
        await this.save(s.resultStatus);
        await this.speak(prompt.say);
      } else if (prompt.phase === 'asking') {
        this.dispatch({ type: 'CONFIRMACION_NO' });
        await this.present(prompt);
      } else {
        await this.speak(prompt.say);
      }
    }
  }

  async repeat() {
    if (!this.session) return;
    await this.speak(this.session.repeat().say);
  }

  async discardPoint() {
    const s = this.session;
    if (!s) return;
    if (!this.dispatch({ type: 'DESCARTAR_PUNTO' })) return;
    // Se envía igual, marcado como descartado: queda trazabilidad y no se pierde nada.
    await this.deps.outbox.enqueue(s.toSyncItem('discarded'));
    await this.deps.drafts.deleteDraft(s.id);
    this.session = null;
    await this.refreshPending();
    await this.speak('Punto descartado.');
  }

  async retry() {
    this.dispatch({ type: 'REINTENTAR' });
    if (this.snap.state === 'PREGUNTANDO') await this.resumeQuestion();
  }

  // ── Sincronización ───────────────────────────────────────────────────────

  setOnline(online: boolean) {
    const wasOffline = !this.view.sync.online;
    this.emit({ sync: { ...this.view.sync, online } });
    if (online && wasOffline) void this.sync();
  }

  async sync() {
    if (this.view.sync.running) return;
    this.emit({ sync: { ...this.view.sync, running: true } });
    try {
      const report = await this.deps.outbox.flush();
      const pending = await this.deps.outbox.pendingCount();
      this.emit({
        sync: {
          ...this.view.sync,
          running: false,
          pending,
          lastError: report.networkError ?? (report.rejected ? `${report.rejected} relevamiento(s) rechazado(s) por el servidor` : null),
          lastSyncAt: report.networkError ? this.view.sync.lastSyncAt : this.now(),
        },
      });
    } catch (err) {
      this.emit({ sync: { ...this.view.sync, running: false, lastError: (err as Error).message } });
    }
  }

  // ── internos ─────────────────────────────────────────────────────────────

  private async command(cmd: VoiceCommand) {
    switch (cmd) {
      case 'tomar_ubicacion':
        return this.takeLocation();
      case 'repetir':
        return this.repeat();
      case 'cancelar_punto':
        return this.discardPoint();
      case 'sincronizar':
        return this.sync();
      case 'finalizar_recorrido':
        return this.endRoute();
    }
  }

  private async present(prompt: Prompt) {
    if (prompt.question) this.dispatch({ type: 'PREGUNTAR', questionKey: prompt.question.key });
    await this.speak(prompt.say);
    // Si el vehículo arrancó mientras hablaba, la máquina ya pausó la entrevista.
    if (this.snap.state === 'PREGUNTANDO') this.dispatch({ type: 'ESCUCHAR' });
  }

  private async resumeQuestion() {
    const s = this.session;
    if (!s) return;
    if (s.phase === 'confirming') {
      // Se vuelve a leer el resumen: la máquina está en PREGUNTANDO, se reenvía como respuesta procesada completa.
      this.dispatch({ type: 'ESCUCHAR' });
      this.dispatch({ type: 'RESPUESTA_RECIBIDA' });
      this.dispatch({ type: 'RESPUESTA_PROCESADA', completo: true });
      await this.speak(s.repeat().say);
      return;
    }
    await this.present({ ...s.repeat(), question: s.currentQuestion });
  }

  private async save(status: 'completed' | 'incomplete') {
    const s = this.session!;
    this.emit({ saveStatus: 'saving' });
    try {
      await this.deps.outbox.enqueue(s.toSyncItem(status));
      await this.deps.drafts.deleteDraft(s.id);
      this.dispatch({ type: 'GUARDADO' });
      this.emit({ saveStatus: 'saved', lastSaved: { id: s.id, status } });
      this.session = null;
      this.dispatch({ type: 'CONTINUAR' });
      await this.refreshPending();
      void this.sync();
    } catch (err) {
      this.emit({ saveStatus: 'error' });
      this.dispatch({ type: 'FALLA', reason: `No se pudo guardar el punto en el teléfono: ${(err as Error).message}` });
    }
  }

  private async persistDraft() {
    if (!this.session) return;
    try {
      await this.deps.drafts.saveDraft(this.session.toSyncItem('incomplete'));
    } catch {
      this.emit({ message: 'No se pudo guardar el borrador del punto en el teléfono.' });
    }
  }

  private async refreshPending() {
    const pending = await this.deps.outbox.pendingCount();
    this.emit({ sync: { ...this.view.sync, pending } });
  }
}
