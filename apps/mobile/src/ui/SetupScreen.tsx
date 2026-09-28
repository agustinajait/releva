import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { parseQuestionnaire } from '@releva/core';
import { api, ApiError, logout, OfflineError, type MobileUser } from '../services/api';
import { cache } from '../services/storage';
import type { RouteContext } from '../engine/controller';
import { C, s } from './theme';

interface Project { id: string; name: string; clientName: string }
interface Route { id: string; name: string; status: string; zoneName: string | null; surveyorId: string | null }
interface ActiveQ { id: string; name: string; version: number; definition: unknown }

/** Carga de la API y, si no hay señal, del caché local. */
async function load<T>(key: string, path: string): Promise<{ data: T | null; offline: boolean }> {
  try {
    const data = await api<T>(path);
    await cache.set(key, data);
    return { data, offline: false };
  } catch (e) {
    if (e instanceof OfflineError) return { data: await cache.get<T>(key), offline: true };
    throw e;
  }
}

/** Elección de proyecto y recorrido. Deja todo en caché para trabajar sin conexión. */
export function SetupScreen({ user, onStart, onLogout }: { user: MobileUser; onStart: (ctx: RouteContext) => void; onLogout: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [questionnaire, setQuestionnaire] = useState<ActiveQ | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load<Project[]>('projects', '/projects')
      .then((r) => {
        setProjects(r.data ?? []);
        setOffline(r.offline);
        if (r.data?.length === 1) setProject(r.data[0]!);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!project) return;
    setRoutes(null);
    setQuestionnaire(null);
    setError(null);
    Promise.all([
      load<Route[]>(`routes:${project.id}`, `/projects/${project.id}/routes`),
      load<ActiveQ[]>(`questionnaire:${project.id}`, `/projects/${project.id}/questionnaires/active`),
    ])
      .then(([r, q]) => {
        setRoutes((r.data ?? []).filter((x) => x.status !== 'finished'));
        setQuestionnaire(q.data?.[0] ?? null);
        setOffline(r.offline || q.offline);
      })
      .catch((e: Error) => setError(e instanceof ApiError ? e.message : 'No se pudo cargar el proyecto'));
  }, [project]);

  function start(route: Route | null) {
    if (!project || !questionnaire) return;
    const parsed = parseQuestionnaire(questionnaire.definition);
    if (!parsed.ok) {
      setError('El cuestionario publicado no es válido. Avisá al administrador.');
      return;
    }
    if (route) api(`/routes/${route.id}/start`, { method: 'POST' }).catch(() => undefined); // si no hay señal, se registra igual en cada relevamiento
    onStart({
      projectId: project.id,
      projectName: project.name,
      routeId: route?.id ?? null,
      routeName: route?.name ?? 'libre',
      zoneName: route?.zoneName ?? null,
      questionnaireVersionId: questionnaire.id,
      definition: parsed.definition,
    });
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.pad, { paddingTop: 48 }]}>
      <View style={s.row}>
        <Text style={[s.h1, { flex: 1 }]}>Hola, {user.name.split(' ')[0]}</Text>
        <Pressable onPress={async () => { await logout(); onLogout(); }} accessibilityRole="button">
          <Text style={s.muted}>Salir</Text>
        </Pressable>
      </View>
      {offline && <Text style={{ color: C.warn }}>Sin conexión: usando datos guardados en el teléfono.</Text>}
      {error && <Text style={s.error}>{error}</Text>}

      <Text style={s.label}>Proyecto</Text>
      {!projects && <ActivityIndicator color={C.accent} />}
      {projects?.length === 0 && <Text style={s.muted}>No tenés proyectos asignados.</Text>}
      {projects?.map((p) => (
        <Pressable key={p.id} style={[s.card, project?.id === p.id && { borderColor: C.accent }]} onPress={() => setProject(p)}>
          <Text style={s.h2}>{p.name}</Text>
          <Text style={s.muted}>{p.clientName}</Text>
        </Pressable>
      ))}

      {project && (
        <>
          <Text style={[s.label, { marginTop: 12 }]}>Recorrido</Text>
          {!routes && <ActivityIndicator color={C.accent} />}
          {routes && !questionnaire && <Text style={s.error}>El proyecto no tiene un cuestionario publicado.</Text>}
          {routes?.map((r) => (
            <Pressable key={r.id} style={[s.card, !questionnaire && s.btnDisabled]} disabled={!questionnaire} onPress={() => start(r)}>
              <Text style={s.h2}>{r.name}</Text>
              <Text style={s.muted}>{r.zoneName ?? 'Sin zona'} · {r.status === 'in_progress' ? 'en curso' : 'planificado'}</Text>
            </Pressable>
          ))}
          {routes && questionnaire && (
            <Pressable style={s.btn} onPress={() => start(null)}>
              <Text style={s.btnText}>Recorrido libre (sin recorrido asignado)</Text>
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  );
}
