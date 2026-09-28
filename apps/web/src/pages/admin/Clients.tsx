import { useState } from 'react';
import { api } from '../../api';
import { ErrorBox, Field, Page, useSubmit } from '../../components/ui';
import { fmtDateTime, useApi } from '../../hooks';

interface Client { id: string; name: string; slug: string; active: boolean; createdAt: string }
interface Org { id: string; name: string; clientId: string; clientName: string }

export function ClientsPage() {
  const clients = useApi<Client[]>('/clients');
  const orgs = useApi<Org[]>('/organizations');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const create = useSubmit(
    () => api('/clients', { method: 'POST', body: { name, slug } }),
    () => { setName(''); setSlug(''); clients.reload(); },
  );
  const [orgName, setOrgName] = useState('');
  const [orgClient, setOrgClient] = useState('');
  const createOrg = useSubmit(
    () => api('/organizations', { method: 'POST', body: { name: orgName, clientId: orgClient } }),
    () => { setOrgName(''); orgs.reload(); },
  );
  const toggle = async (c: Client) => {
    await api(`/clients/${c.id}`, { method: 'PATCH', body: { active: !c.active } });
    clients.reload();
  };

  return (
    <Page title="Clientes y organismos" subtitle="Cada cliente es un espacio aislado: sus datos no son visibles para otros clientes.">
      <div className="card card-pad">
        <form className="form-row" onSubmit={create.submit}>
          <Field label="Nombre del cliente"><input className="input" value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} required /></Field>
          <Field label="Identificador"><input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} required /></Field>
          <button className="btn btn-primary" disabled={create.busy}>Crear cliente</button>
        </form>
        <div style={{ marginTop: 10 }}><ErrorBox error={create.error} /></div>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Cliente</th><th>Identificador</th><th>Estado</th><th>Alta</th><th /></tr></thead>
          <tbody>
            {(clients.data ?? []).map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td className="mono">{c.slug}</td>
                <td>{c.active ? <span className="badge ok">Activo</span> : <span className="badge">Inactivo</span>}</td>
                <td className="muted">{fmtDateTime(c.createdAt)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={() => void toggle(c)}>{c.active ? 'Desactivar' : 'Activar'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 8 }}>Organismos</h2>
      <div className="card card-pad">
        <form className="form-row" onSubmit={createOrg.submit}>
          <Field label="Cliente">
            <select className="input" value={orgClient} onChange={(e) => setOrgClient(e.target.value)} required>
              <option value="">Elegir…</option>
              {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Nombre del organismo"><input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} required /></Field>
          <button className="btn btn-primary" disabled={createOrg.busy}>Agregar organismo</button>
        </form>
        <div style={{ marginTop: 10 }}><ErrorBox error={createOrg.error} /></div>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Organismo</th><th>Cliente</th></tr></thead>
          <tbody>
            {(orgs.data ?? []).map((o) => <tr key={o.id}><td>{o.name}</td><td className="muted">{o.clientName}</td></tr>)}
            {orgs.data?.length === 0 && <tr><td colSpan={2} className="empty">Sin organismos</td></tr>}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
