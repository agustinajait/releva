import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { STATE_LABELS } from '@releva/core';
import type { AppController, ControllerView } from '../engine/controller';
import { C, s } from './theme';

const STATE_COLOR: Partial<Record<ControllerView['snapshot']['state'], string>> = {
  VEHICULO_EN_MOVIMIENTO: C.info,
  VEHICULO_DETENIDO: C.ok,
  ESCUCHANDO: C.accent,
  PREGUNTANDO: C.accent,
  CONFIRMANDO: C.accent,
  PUNTO_COMPLETADO: C.ok,
  ERROR: C.danger,
};

function Btn({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      style={[s.btn, primary && s.btnPrimary, disabled && s.btnDisabled, { flex: 1 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={primary ? s.btnPrimaryText : s.btnText}>{label}</Text>
    </Pressable>
  );
}

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * Pantalla del recorrido. Acompaña la conversación: el relevador no completa
 * formularios. Muestra estado, ubicación, punto, pregunta, respuesta reconocida,
 * progreso, guardado, sincronización y errores.
 */
export function RouteScreen({ controller, onExit }: { controller: AppController; onExit: () => void }) {
  const [v, setV] = useState<ControllerView>(controller.state);
  const [text, setText] = useState('');
  useEffect(() => controller.subscribe(setV), [controller]);

  const st = v.snapshot.state;
  const interviewing = ['PREGUNTANDO', 'ESCUCHANDO', 'PROCESANDO_RESPUESTA', 'CONFIRMANDO', 'PUNTO_ACTIVO'].includes(st);
  const canListen = st === 'ESCUCHANDO' || st === 'CONFIRMANDO';
  const canCapture = st === 'VEHICULO_DETENIDO';
  const pausedPoint = st === 'VEHICULO_EN_MOVIMIENTO' && !!v.snapshot.pointId;

  const send = () => {
    if (!text.trim()) return;
    void controller.answer(text);
    setText('');
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.pad, { paddingTop: 44, paddingBottom: 32 }]} keyboardShouldPersistTaps="handled">
      {/* Encabezado: proyecto, zona, recorrido */}
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>{v.route?.projectName}</Text>
          <Text style={s.h2}>{v.route?.routeName}{v.route?.zoneName ? ` · ${v.route.zoneName}` : ''}</Text>
        </View>
        <Pressable onPress={async () => { await controller.endRoute(); onExit(); }} disabled={interviewing || pausedPoint}>
          <Text style={[s.muted, (interviewing || pausedPoint) && { opacity: 0.4 }]}>Finalizar</Text>
        </Pressable>
      </View>

      {/* Estado de RELEVA */}
      <View style={[s.card, { borderColor: STATE_COLOR[st] ?? C.line, borderWidth: 2 }]}>
        <Text style={s.label}>Estado</Text>
        <Text style={{ color: STATE_COLOR[st] ?? C.text, fontSize: 24, fontWeight: '800' }}>{STATE_LABELS[st]}</Text>
        {pausedPoint && <Text style={{ color: C.warn }}>Punto en pausa. Detenete para continuar la entrevista.</Text>}
        {v.message && <Text style={{ color: C.warn }}>{v.message}</Text>}
        {v.snapshot.error && <Text style={s.error}>{v.snapshot.error}</Text>}
      </View>

      {/* Pregunta actual y respuesta reconocida */}
      {(interviewing || v.lastSpoken) && (
        <View style={s.card}>
          <Text style={s.label}>RELEVA dice</Text>
          <Text style={{ color: C.text, fontSize: 22, fontWeight: '700' }}>{v.lastSpoken ?? v.question}</Text>
          {v.recognized && (
            <>
              <Text style={[s.label, { marginTop: 8 }]}>Respuesta reconocida</Text>
              <Text style={s.text}>“{v.recognized}”</Text>
            </>
          )}
          {interviewing && (
            <View style={{ marginTop: 8, gap: 4 }}>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: C.panel2, overflow: 'hidden' }}>
                <View style={{ height: 8, width: `${Math.round(v.progress * 100)}%`, backgroundColor: C.accent }} />
              </View>
              <Text style={s.muted}>{v.knownCount} datos registrados · {Math.round(v.progress * 100)}% de lo obligatorio</Text>
            </View>
          )}
        </View>
      )}

      {/* Entrada de respuesta (modo desarrollo: el STT real se conecta en la próxima etapa) */}
      {canListen && (
        <View style={[s.card, { gap: 10 }]}>
          <Text style={s.label}>Respuesta (modo desarrollo)</Text>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
            placeholder="Escribí lo que diría el relevador"
            placeholderTextColor={C.text3}
            returnKeyType="send"
            accessibilityLabel="Respuesta"
          />
          <View style={s.row}>
            <Btn label="Enviar" primary onPress={send} />
            <Btn label="Repetir" onPress={() => void controller.repeat()} />
          </View>
        </View>
      )}

      {/* Acción principal */}
      {!interviewing && st !== 'ERROR' && (
        <Pressable
          style={[s.btn, s.btnPrimary, { paddingVertical: 28 }, !canCapture && s.btnDisabled]}
          onPress={() => void controller.takeLocation()}
          disabled={!canCapture}
          accessibilityRole="button"
          accessibilityLabel="Tomar ubicación"
        >
          <Text style={[s.btnPrimaryText, { fontSize: 22 }]}>Tomar ubicación</Text>
          <Text style={{ color: C.accentInk, marginTop: 4 }}>
            {canCapture ? '“RELEVA, tomá latitud”' : 'Disponible con el vehículo detenido'}
          </Text>
        </Pressable>
      )}
      {st === 'ERROR' && (
        <View style={s.row}>
          <Btn label="Reintentar" primary onPress={() => void controller.retry()} />
        </View>
      )}
      {(interviewing || st === 'ERROR' || pausedPoint) && (
        <Btn label="Descartar punto" onPress={() => void controller.discardPoint()} />
      )}

      {/* Ubicación y punto */}
      <View style={s.card}>
        <Text style={s.label}>Ubicación</Text>
        {v.lastFix ? (
          <Text style={s.text}>
            {v.lastFix.lat.toFixed(5)}, {v.lastFix.lng.toFixed(5)} · ±{Math.round(v.lastFix.accuracy)} m
            {typeof v.lastFix.speed === 'number' ? ` · ${Math.round(v.lastFix.speed * 3.6)} km/h` : ''}
          </Text>
        ) : (
          <Text style={s.muted}>Esperando GPS…</Text>
        )}
        {v.pointFix && (
          <Text style={s.muted}>
            Punto actual: {v.pointFix.lat.toFixed(5)}, {v.pointFix.lng.toFixed(5)} (±{Math.round(v.pointFix.accuracy)} m) · {fmtTime(v.pointFix.capturedAt)}
          </Text>
        )}
      </View>

      {/* Guardado y sincronización */}
      <View style={s.card}>
        <Text style={s.label}>Guardado y sincronización</Text>
        <Text style={s.text}>
          {v.saveStatus === 'saved' && v.lastSaved ? `Último punto guardado ${v.lastSaved.status === 'incomplete' ? '(incompleto)' : ''}` : v.saveStatus === 'error' ? 'Error al guardar' : 'Sin puntos nuevos'}
        </Text>
        <Text style={{ color: v.sync.online ? C.ok : C.warn }}>
          {v.sync.online ? 'Con conexión' : 'Sin conexión — se guarda en el teléfono'}
          {` · ${v.sync.pending} pendiente(s)`}
          {v.sync.running ? ' · sincronizando…' : ''}
        </Text>
        {v.sync.lastSyncAt && <Text style={s.muted}>Última sincronización: {fmtTime(v.sync.lastSyncAt)}</Text>}
        {v.sync.lastError && v.sync.online && <Text style={s.error}>{v.sync.lastError}</Text>}
        <Btn label="Sincronizar ahora" onPress={() => void controller.sync()} disabled={v.sync.running} />
      </View>

      {/* Simulación para pruebas en emulador */}
      {__DEV__ && (
        <View style={s.card}>
          <Text style={s.label}>Pruebas (solo desarrollo)</Text>
          <View style={s.row}>
            <Btn label="Simular detenido" onPress={() => controller.simulateMotion('stopped')} />
            <Btn label="Simular en movimiento" onPress={() => controller.simulateMotion('moving')} />
          </View>
          <Btn label="Usar GPS real" onPress={() => controller.simulateMotion(null)} />
        </View>
      )}
    </ScrollView>
  );
}
