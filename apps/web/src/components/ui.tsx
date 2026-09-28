import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api';

/** Formulario con manejo de envío y errores de la API. */
export function useSubmit(action: () => Promise<unknown>, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details)
        ? ': ' + (err.details as { message: string }[]).map((d) => d.message).slice(0, 3).join('; ')
        : '';
      setError((err as Error).message + details);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      <div className="stack" style={{ gap: 16 }}>{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert" role="alert">{error}</div> : null;
}
