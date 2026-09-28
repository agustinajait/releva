import { useState } from 'react';
import { fmtDateTime, useApi } from '../hooks';

interface Fact {
  fieldKey: string;
  value: unknown;
  status: 'mentioned' | 'extracted' | 'confirmed' | 'unknown';
  source: string;
  questionKey: string | null;
  rawAnswer: string | null;
}
interface Survey {
  id: string;
  status: string;
  capturedAt: string;
  accuracyM: number | null;
  routeName: string | null;
  surveyorName: string | null;
  questionnaireVersionId: string;
  facts: Fact[];
  transcript: { speaker: 'releva' | 'surveyor'; text: string; at: string }[] | null;
}
interface PointData {
  id: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  zoneName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  surveys: Survey[];
  fieldLabels: Record<string, Record<string, { label: string; category?: string; options?: Record<string, string> }>>;
}

const STATUS: Record<Fact['status'], { label: string; cls: string }> = {
  confirmed: { label: 'Confirmado', cls: 'ok' },
  mentioned: { label: 'Mencionado', cls: 'info' },
  extracted: { label: 'Estructurado', cls: 'warn' },
  unknown: { label: 'Desconocido', cls: '' },
};

function formatValue(v: unknown, options?: Record<string, string>): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return v.map((x) => options?.[x] ?? x).join(', ');
  if (typeof v === 'string') return options?.[v] ?? v;
  return String(v);
}

/** Ficha de punto: resultado entendible sin leer la conversación; la transcripción queda como respaldo. */
export function PointDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading } = useApi<PointData>(`/points/${id}`, { transcript: 'true' });
  const [idx, setIdx] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);

  if (error) return <div className="detail-section"><div className="alert">{error}</div></div>;
  if (!data || loading) return <div className="detail-section muted">Cargando…</div>;

  const survey = data.surveys[Math.min(idx, data.surveys.length - 1)];
  const labels = survey ? data.fieldLabels[survey.questionnaireVersionId] ?? {} : {};

  return (
    <>
      <div className="detail-head">
        <div className="row">
          <h2>Punto · {data.zoneName ?? 'Sin zona'}</h2>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {data.lat.toFixed(5)}, {data.lng.toFixed(5)}
          {data.accuracyM != null && ` · ±${Math.round(data.accuracyM)} m`}
        </div>
        <div className="small muted">
          {data.surveys.length} relevamiento{data.surveys.length === 1 ? '' : 's'} · primero {fmtDateTime(data.firstSeenAt)} · último {fmtDateTime(data.lastSeenAt)}
        </div>
      </div>

      {survey && (
        <div className="detail-section">
          <div className="row">
            <h3>Información relevada</h3>
            <span className="spacer" />
            <span className="small muted">{fmtDateTime(survey.capturedAt)}</span>
          </div>
          <div className="facts">
            {survey.facts.map((f) => {
              const meta = labels[f.fieldKey];
              return (
                <div key={f.fieldKey} style={{ display: 'contents' }}>
                  <span>{meta?.label ?? f.fieldKey}</span>
                  <span className="fact-val">{f.status === 'unknown' ? <span className="muted">No se sabe</span> : formatValue(f.value, meta?.options)}</span>
                  <span className="fact-status">
                    <span className={`badge ${STATUS[f.status].cls}`}>{STATUS[f.status].label}</span>
                    {f.rawAnswer && <span className="small muted" title={f.rawAnswer}> “{f.rawAnswer.length > 60 ? f.rawAnswer.slice(0, 60) + '…' : f.rawAnswer}”</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>
            {survey.surveyorName ?? 'Relevador'} {survey.routeName && `· ${survey.routeName}`} {survey.status !== 'completed' && <span className="badge warn">Incompleto</span>}
          </div>
          {survey.transcript && survey.transcript.length > 0 && (
            <>
              <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setShowTranscript((s) => !s)}>
                {showTranscript ? 'Ocultar conversación' : 'Ver conversación original'}
              </button>
              {showTranscript && (
                <div className="transcript">
                  {survey.transcript.map((t, i) => (
                    <div key={i} className={`bubble ${t.speaker}`}>
                      <strong className="small">{t.speaker === 'releva' ? 'RELEVA' : 'Relevador'}: </strong>
                      {t.text}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {data.surveys.length > 1 && (
        <div className="detail-section">
          <h3>Historial</h3>
          <div className="timeline" style={{ marginTop: 10 }}>
            {data.surveys.map((s, i) => (
              <button
                key={s.id}
                className={`timeline-item ${i === idx ? 'current' : ''}`}
                style={{ background: 'none', border: 0, borderLeft: undefined, textAlign: 'left', cursor: 'pointer', padding: '2px 0 2px 12px' }}
                onClick={() => { setIdx(i); setShowTranscript(false); }}
              >
                <div style={{ fontWeight: 600 }}>{fmtDateTime(s.capturedAt)}</div>
                <div className="small muted">
                  {formatValue(s.facts.find((f) => f.fieldKey === 'personas')?.value ?? null)} personas · {s.facts.length} datos
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
