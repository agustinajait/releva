import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import type { LocationFix, TextToSpeech } from '@releva/core';
import type { LocationProvider } from '../engine/controller';

// ── Ubicación ──────────────────────────────────────────────────────────────

const toFix = (l: Location.LocationObject): LocationFix => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  accuracy: l.coords.accuracy ?? 9999,
  altitude: l.coords.altitude,
  speed: l.coords.speed,
  capturedAt: new Date(l.timestamp).toISOString(),
});

export async function ensureLocationPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

/**
 * Captura la mejor posición disponible: pide lecturas de alta precisión y se
 * queda con la más precisa hasta alcanzar la deseada o agotar el tiempo.
 */
export const expoLocation: LocationProvider = {
  async captureFix({ timeoutMs, desiredAccuracyM }) {
    let best: LocationFix | null = null;
    let settle: ((f: LocationFix | Error) => void) | null = null;
    const result = new Promise<LocationFix | Error>((r) => (settle = r));
    const subscription = Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 500, distanceInterval: 0 },
      (l) => {
        const fix = toFix(l);
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (fix.accuracy <= desiredAccuracyM) settle?.(fix);
      },
    );
    subscription.catch((e: Error) => settle?.(e));
    const timer = setTimeout(() => settle?.(best ?? new Error('sin señal GPS')), timeoutMs);
    const out = await result;
    clearTimeout(timer);
    // Se cierra la suscripción siempre, aunque la lectura haya llegado antes de registrarla.
    subscription.then((sub) => sub.remove()).catch(() => undefined);
    if (out instanceof Error) throw out;
    return out;
  },
};

/** Lecturas continuas durante el recorrido (detección de movimiento). */
export async function watchLocation(onFix: (f: LocationFix) => void): Promise<() => void> {
  const sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, (l) => onFix(toFix(l)));
  return () => sub.remove();
}

// ── Voz: salida (TTS del dispositivo) ──────────────────────────────────────

export const deviceTts: TextToSpeech = {
  id: 'expo-speech',
  speak(text, { locale }) {
    return new Promise<void>((resolve) => {
      Speech.speak(text, { language: locale, onDone: () => resolve(), onStopped: () => resolve(), onError: () => resolve() });
    });
  },
  async stop() {
    await Speech.stop();
  },
};

// ── Voz: entrada (STT) ─────────────────────────────────────────────────────
//
// En esta etapa la respuesta se ingresa por teclado desde la pantalla de recorrido
// (modo desarrollo) y llega a AppController.answer(texto). El reconocimiento de voz
// real se conecta en la próxima etapa implementando `SpeechToText` de @releva/core,
// sin cambiar el controlador ni la sesión.
