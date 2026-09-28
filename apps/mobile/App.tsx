import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { DirectAnswerInterpreter, Outbox } from '@releva/core';
import { AppController, type RouteContext } from './src/engine/controller';
import { restoreSession, syncTransport, type MobileUser } from './src/services/api';
import { SqliteDraftStore, SqliteOutboxStore } from './src/services/storage';
import { deviceTts, ensureLocationPermission, expoLocation, watchLocation } from './src/services/device';
import { LoginScreen } from './src/ui/LoginScreen';
import { SetupScreen } from './src/ui/SetupScreen';
import { RouteScreen } from './src/ui/RouteScreen';
import { C } from './src/ui/theme';

/**
 * Composición de la app: acá se eligen las implementaciones concretas.
 * Cambiar de proveedor de voz o de IA es cambiar una línea en este archivo.
 */
function createController() {
  const drafts = new SqliteDraftStore();
  const outbox = new Outbox(new SqliteOutboxStore(), syncTransport);
  const controller = new AppController({
    location: expoLocation,
    tts: deviceTts,
    interpreter: new DirectAnswerInterpreter(), // Próxima etapa: intérprete con IA (mismo contrato).
    outbox,
    drafts,
    uuid: () => Crypto.randomUUID(),
  });
  return { controller, drafts, outbox };
}

function RouteRunner({ controller, ctx, onExit }: { controller: AppController; ctx: RouteContext; onExit: () => void }) {
  useKeepAwake(); // la pantalla no se apaga durante el recorrido
  useEffect(() => {
    let stop: (() => void) | null = null;
    let alive = true;
    void (async () => {
      await controller.startRoute(ctx);
      if (!(await ensureLocationPermission())) return;
      const s = await watchLocation((f) => controller.onLocation(f));
      if (alive) stop = s;
      else s();
    })();
    return () => {
      alive = false;
      stop?.();
    };
  }, [controller, ctx]);
  return <RouteScreen controller={controller} onExit={onExit} />;
}

export default function App() {
  const [{ controller, drafts, outbox }] = useState(createController);
  const [user, setUser] = useState<MobileUser | null | undefined>(undefined);
  const [ctx, setCtx] = useState<RouteContext | null>(null);

  useEffect(() => {
    restoreSession().then(setUser).catch(() => setUser(null));
  }, []);

  // Conectividad: sincroniza al recuperar la señal y cada minuto.
  useEffect(() => {
    const off = NetInfo.addEventListener((st) => controller.setOnline(Boolean(st.isConnected && st.isInternetReachable !== false)));
    const t = setInterval(() => void controller.sync(), 60_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [controller]);

  // Puntos que quedaron a medias (la app se cerró): se envían como incompletos, nunca se pierden.
  const recover = useMemo(
    () => async () => {
      const pending = await drafts.listDrafts();
      for (const d of pending) {
        await outbox.enqueue({ ...d, status: 'incomplete' });
        await drafts.deleteDraft(d.clientUuid);
      }
    },
    [drafts, outbox],
  );
  useEffect(() => {
    if (user) void recover().then(() => controller.sync());
  }, [user, recover, controller]);

  let screen;
  if (user === undefined) screen = <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={C.accent} /></View>;
  else if (!user) screen = <LoginScreen onLogin={setUser} />;
  else if (!ctx) screen = <SetupScreen user={user} onStart={setCtx} onLogout={() => setUser(null)} />;
  else screen = <RouteRunner controller={controller} ctx={ctx} onExit={() => setCtx(null)} />;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      {screen}
    </View>
  );
}
