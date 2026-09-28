import { useState, type FormEvent } from 'react';
import { auth } from '../api';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-art">
        <div>
          <h1>RELEVA</h1>
          <p style={{ marginTop: 14 }}>
            Relevamiento territorial asistido por voz. Lo que se observa en la calle, convertido en información
            clara para decidir.
          </p>
        </div>
        <svg className="dots" width="420" height="320" viewBox="0 0 420 320" aria-hidden>
          <path d="M20 300 C 120 220, 160 260, 230 170 S 360 90, 410 20" fill="none" stroke="rgba(245,185,66,.35)" strokeWidth="3" strokeDasharray="2 10" strokeLinecap="round" />
          {[[60, 262, 9], [150, 238, 13], [232, 168, 17], [300, 120, 8], [372, 64, 11]].map(([x, y, r], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={r! + 10} fill="rgba(245,185,66,.12)" />
              <circle cx={x} cy={y} r={r} fill="#f5b942" />
            </g>
          ))}
        </svg>
        <div className="small" style={{ color: 'rgba(232,241,240,.6)' }}>Sin reconocimiento facial ni identificación de personas.</div>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <h1>Ingresar</h1>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="alert" role="alert">{error}</div>}
          <button className="btn btn-primary" disabled={busy} style={{ justifyContent: 'center', padding: '10px 14px' }}>
            {busy ? 'Ingresando…' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  );
}
