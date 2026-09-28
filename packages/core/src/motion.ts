import { distanceMeters, type LocationFix } from './geo.js';

/**
 * Detecta si el vehículo está en movimiento a partir de lecturas GPS.
 * Usa histéresis para no oscilar con el ruido del GPS (un auto parado
 * "se mueve" varios metros entre lecturas).
 */
export interface MotionConfig {
  /** Velocidad a partir de la cual se considera movimiento (m/s). 2.8 m/s ≈ 10 km/h. */
  movingSpeed: number;
  /** Velocidad por debajo de la cual se considera detenido (m/s). */
  stoppedSpeed: number;
  /** Lecturas seguidas por encima de movingSpeed para declarar movimiento. */
  movingSamples: number;
  /** Segundos seguidos por debajo de stoppedSpeed para declarar detención. */
  stoppedSeconds: number;
  /** Lecturas con precisión peor que esto (m) se ignoran. */
  maxAccuracy: number;
}

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  movingSpeed: 2.8,
  stoppedSpeed: 0.8,
  movingSamples: 2,
  stoppedSeconds: 4,
  maxAccuracy: 50,
};

export type MotionState = 'unknown' | 'moving' | 'stopped';

export class MotionDetector {
  private state: MotionState = 'unknown';
  private last: LocationFix | null = null;
  private fastCount = 0;
  private slowSince: number | null = null;

  constructor(private readonly cfg: MotionConfig = DEFAULT_MOTION_CONFIG) {}

  get current(): MotionState {
    return this.state;
  }

  /** Procesa una lectura. Devuelve el nuevo estado si cambió, o null. */
  push(fix: LocationFix): MotionState | null {
    if (fix.accuracy > this.cfg.maxAccuracy) return null;
    const t = Date.parse(fix.capturedAt);
    const speed = this.speedOf(fix, t);
    this.last = fix;
    if (speed === null) return null;

    const before = this.state;
    if (speed >= this.cfg.movingSpeed) {
      this.fastCount += 1;
      this.slowSince = null;
      if (this.fastCount >= this.cfg.movingSamples) this.state = 'moving';
    } else if (speed <= this.cfg.stoppedSpeed) {
      this.fastCount = 0;
      this.slowSince ??= t;
      if (t - this.slowSince >= this.cfg.stoppedSeconds * 1000) this.state = 'stopped';
    } else {
      // Zona intermedia: no cambia el estado, reinicia contadores.
      this.fastCount = 0;
      this.slowSince = null;
    }
    return this.state !== before ? this.state : null;
  }

  private speedOf(fix: LocationFix, t: number): number | null {
    if (typeof fix.speed === 'number' && fix.speed >= 0) return fix.speed;
    if (!this.last) return null;
    const dt = (t - Date.parse(this.last.capturedAt)) / 1000;
    if (!(dt > 0)) return null;
    return distanceMeters(this.last, fix) / dt;
  }
}
