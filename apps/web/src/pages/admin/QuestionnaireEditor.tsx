import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseQuestionnaire, type Condition, type QuestionnaireDefinition } from '@releva/core';
import { api } from '../../api';
import { ErrorBox, Page, useSubmit } from '../../components/ui';
import { fmtDateTime, useApi } from '../../hooks';

interface Version {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  questionnaireId: string;
  projectId: string;
  name: string;
  publishedAt: string | null;
  definition: unknown;
}

function describe(c: Condition): string {
  if ('all' in c) return c.all.map(describe).join(' y ');
  if ('any' in c) return c.any.map(describe).join(' o ');
  if ('not' in c) return `no (${describe(c.not)})`;
  const ops: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'en', contains: 'incluye', known: 'se conoce', unknown: 'no se conoce', truthy: 'es sí' };
  return 'value' in c ? `${c.field} ${ops[c.op]} ${JSON.stringify(c.value)}` : `${c.field} ${ops[c.op]}`;
}

/** Vista legible del cuestionario: lo que el administrador configuró, sin leer JSON. */
function Preview({ def }: { def: QuestionnaireDefinition }) {
  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  return (
    <div className="stack">
      <h3>Preguntas</h3>
      {def.questions.map((q) => (
        <div key={q.key} className="q-item">
          <div className="row">
            <span className="t">“{q.text}”</span>
            {q.key === def.openingQuestion && <span className="badge info">Apertura</span>}
            {q.askAlways && <span className="badge">Siempre</span>}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            Completa: {q.fields.map((k) => byKey.get(k)?.label ?? k).join(', ')}
          </div>
          {q.visibleIf && <div className="small" style={{ marginTop: 2 }}>Solo si: <span className="mono">{describe(q.visibleIf)}</span></div>}
          {q.followUps.length > 0 && <div className="small" style={{ marginTop: 2 }}>Seguimiento: {q.followUps.join(', ')}</div>}
        </div>
      ))}
      <h3 style={{ marginTop: 8 }}>Campos</h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Campo</th><th>Tipo</th><th>Regla</th></tr></thead>
          <tbody>
            {def.fields.map((f) => (
              <tr key={f.key}>
                <td><strong>{f.label}</strong><div className="mono muted">{f.key}</div></td>
                <td>{f.type}{f.options && <div className="small muted">{f.options.map((o) => o.label).join(' · ')}</div>}</td>
                <td className="small">
                  {f.required && <span className="badge warn">Obligatorio</span>}{' '}
                  {f.requiredIf && <span>Obligatorio si <span className="mono">{describe(f.requiredIf)}</span></span>}
                  {f.visibleIf && <div>Aplica si <span className="mono">{describe(f.visibleIf)}</span></div>}
                  {f.indicator && <div><span className="badge info">Indicador: {f.indicator.aggregate}</span></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QuestionnaireEditorPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const version = useApi<Version>(`/questionnaire-versions/${id}`);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (version.data) {
      // PostgreSQL (jsonb) no conserva el orden de las claves: se muestra en el orden del esquema.
      const p = parseQuestionnaire(version.data.definition);
      setText(JSON.stringify(p.ok ? p.definition : version.data.definition, null, 2));
      setDirty(false);
    }
  }, [version.data]);

  // Validación en vivo con el mismo motor que usan la app y el servidor.
  const parsed = useMemo(() => {
    try {
      return { json: true as const, result: parseQuestionnaire(JSON.parse(text)) };
    } catch (e) {
      return { json: false as const, error: (e as Error).message };
    }
  }, [text]);

  const editable = version.data?.status === 'draft';
  const save = useSubmit(async () => {
    await api(`/questionnaire-versions/${id}`, { method: 'PUT', body: { definition: JSON.parse(text) } });
    setDirty(false);
    setSaved(`Borrador guardado ${fmtDateTime(new Date().toISOString())}`);
  });
  const publish = useSubmit(async () => {
    if (dirty) await api(`/questionnaire-versions/${id}`, { method: 'PUT', body: { definition: JSON.parse(text) } });
    await api(`/questionnaire-versions/${id}/publish`, { method: 'POST' });
    version.reload();
  });
  const newVersion = useSubmit(async () => {
    const v = await api<{ id: string }>(`/questionnaires/${version.data!.questionnaireId}/versions`, { method: 'POST' });
    nav(`/admin/cuestionarios/${v.id}`);
  });

  if (version.error) return <Page title="Cuestionario"><div className="alert">{version.error}</div></Page>;
  if (!version.data) return <Page title="Cuestionario"><div className="muted">Cargando…</div></Page>;
  const v = version.data;
  const valid = parsed.json && parsed.result.ok;

  return (
    <Page
      title={`${v.name} · versión ${v.version}`}
      subtitle={
        <>
          {v.status === 'draft' ? 'Borrador editable' : v.status === 'published' ? `Publicada ${fmtDateTime(v.publishedAt)} — inmutable` : 'Retirada'}
          {' · '}<Link to={`/admin/proyectos/${v.projectId}`}>volver al proyecto</Link>
        </>
      }
      actions={
        editable ? (
          <>
            {saved && !dirty && <span className="muted small">{saved}</span>}
            <button className="btn" disabled={!dirty || !parsed.json || save.busy} onClick={() => void save.submit()}>Guardar borrador</button>
            <button className="btn btn-primary" disabled={!valid || publish.busy} onClick={() => void publish.submit()}>Publicar</button>
          </>
        ) : (
          <button className="btn btn-primary" disabled={newVersion.busy} onClick={() => void newVersion.submit()}>Crear nueva versión</button>
        )
      }
    >
      <ErrorBox error={save.error ?? publish.error ?? newVersion.error} />
      <div className="editor">
        <div className="card">
          <div className="card-head">
            <h2>Definición</h2>
            {parsed.json ? (
              parsed.result.ok ? <span className="badge ok">Válido</span> : <span className="badge danger">{parsed.result.issues.length} problema(s)</span>
            ) : <span className="badge danger">JSON inválido</span>}
          </div>
          <div className="card-pad stack">
            {!parsed.json && <div className="issue">{parsed.error}</div>}
            {parsed.json && !parsed.result.ok && (
              <div className="issues">
                {parsed.result.issues.slice(0, 12).map((i, k) => (
                  <div key={k} className="issue"><span className="mono">{i.path.join('.') || '(raíz)'}</span> — {i.message}</div>
                ))}
              </div>
            )}
            <textarea
              className="input code"
              spellCheck={false}
              value={text}
              readOnly={!editable}
              onChange={(e) => { setText(e.target.value); setDirty(true); setSaved(null); }}
              aria-label="Definición del cuestionario (JSON)"
            />
            <div className="small muted">
              El administrador define qué información se necesita; RELEVA decide en el momento qué preguntar según lo que el relevador ya dijo.
              El editor visual llega en una próxima etapa.
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Vista previa</h2></div>
          <div className="card-pad">
            {parsed.json && parsed.result.ok ? <Preview def={parsed.result.definition} /> : <div className="muted">Corregí los problemas para ver la vista previa.</div>}
          </div>
        </div>
      </div>
    </Page>
  );
}
