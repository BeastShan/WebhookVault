'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity, Archive, ArrowDownToLine, Braces, Check, CircleCheck, Clock3, Fingerprint, Inbox,
  LayoutDashboard, ListFilter, RadioTower, RotateCcw, Search, ShieldAlert, ShieldCheck, Webhook, X,
} from 'lucide-react';
import type { DashboardData, EventReport } from '../../server/reports';

const labels: Record<string, string> = {
  queued: 'Queued', running: 'Running', retry: 'Scheduled retry', succeeded: 'Succeeded',
  ignored: 'Ignored', dead_letter: 'Dead letter', duplicate: 'Duplicate', conflict: 'Conflict',
  invalid_signature: 'Invalid signature', stale_timestamp: 'Stale timestamp', invalid_payload: 'Invalid payload',
};
const format = (value: string) => labels[value] ?? value.replaceAll('_', ' ');
const time = (value: string) => new Date(value).toISOString().slice(11, 19);
const minute = (value: string) => time(value).slice(0, 5);
type View = 'all' | 'dead' | 'workers';
type Filter = 'all' | 'succeeded' | 'retry' | 'rejected';

async function load<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ? format(body.error) : `HTTP ${response.status}`);
  }
  return response.json();
}

function Badge({ state }: { state: string }) {
  return <span className={`badge badge-${state}`}><i />{format(state)}</span>;
}

function Traffic({ buckets }: { buckets: DashboardData['buckets'] }) {
  const maximum = Math.max(0, ...buckets.map((bucket) => bucket.verified + bucket.rejected));
  const step = Math.max(1, Math.ceil(maximum / 3));
  return <section className="panel traffic" aria-labelledby="traffic-title">
    <div className="panel-head"><div><h2 id="traffic-title">Delivery activity</h2><p>Incoming requests per minute</p></div>
      <span className="period"><Clock3 size={14} /> Last 12 minutes</span></div>
    <div className="plot" role="img" aria-label={buckets.length ?
      buckets.map((b) => `${minute(b.at)} UTC, ${b.verified} verified, ${b.rejected} rejected`).join('; ') : 'Waiting for delivery data'}>
      <div className="gridlines">{[3, 2, 1, 0].map((value) => <div key={value}><span>{value * step}</span></div>)}</div>
      <div className="bars">{buckets.map((bucket) =>
        <div className="bar-slot" key={bucket.at} title={`${minute(bucket.at)} UTC · ${bucket.verified} verified · ${bucket.rejected} rejected`}>
          <div className="bar-stack">
            <i className="bar-rejected" style={{ height: `${bucket.rejected / (3 * step) * 100}%` }} />
            <i className="bar-verified" style={{ height: `${bucket.verified / (3 * step) * 100}%` }} />
          </div>
          <span>{minute(bucket.at)}</span>
        </div>)}</div>
    </div>
    <div className="legend"><span><i /> Verified</span><span><i /> Rejected</span><small>UTC</small></div>
  </section>;
}

function Workers({ workers, full = false }: { workers: DashboardData['workers']; full?: boolean }) {
  const online = workers.filter((worker) => worker.online).length;
  return <section className="panel workers" aria-labelledby="worker-title">
    <div className="panel-head"><div><h2 id="worker-title">Worker health</h2><p>Background processing</p></div><span className="worker-icon"><RadioTower size={18} /></span></div>
    <div className="worker-summary"><span className={online ? 'online' : 'offline'}><i />{online ? 'Online' : 'Offline'}</span><span>{online} active</span></div>
    <div className="worker-list">{workers.length === 0 && <p>No heartbeat recorded.</p>}
      {workers.slice(0, full ? 25 : 3).map((worker) => <div className="worker-row" key={worker.id}>
        <i className={worker.online ? 'healthy-dot' : 'offline-dot'} />
        <div><code>{full ? worker.id : worker.id.slice(0, 8)}</code><small>{worker.online ? 'Heartbeat' : worker.stopped_at ? 'Stopped' : 'Heartbeat expired'}</small></div>
        <time>{time(worker.stopped_at ?? worker.seen_at)}</time>
      </div>)}
    </div>
  </section>;
}

function Detail({ report, close, refresh }: { report: EventReport; close: () => void; refresh: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const [reason, setReason] = useState('');
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const eligible = report.event && report.jobs[0]?.state === 'dead_letter' && !report.replays.length;
  const hasFailure = report.attempts.some((attempt) => ['retryable', 'lease_expired'].includes(attempt.outcome));
  const root = `/api/deliveries/${report.delivery.id}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!report.event || !approved) return;
    setPending(true);
    setMessage('');
    try {
      await load(`/api/events/${report.event.id}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ approved, reason }),
      });
      setToken('');
      setReason('');
      setApproved(false);
      setMessage('Replay queued. The original execution is preserved.');
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  return <dialog className="drawer" ref={dialog} onCancel={close} aria-labelledby="detail-title">
    <div className="drawer-content">
      <div className="drawer-header"><div><p className="mono">DELIVERY DETAILS</p><h2 id="detail-title">{report.delivery.provider_id ?? 'Rejected request'}</h2></div>
        <button className="icon-button" aria-label="Close details" onClick={close}><X size={20} /></button></div>
      <div className="detail-meta"><Badge state={report.jobs.at(-1)?.state ?? report.delivery.disposition} />
        <span>{report.delivery.signature === 'verified' ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />} {report.delivery.signature}</span></div>
      <dl className="metadata"><dt>Delivery ID</dt><dd>{report.delivery.id}</dd>
        {report.event && <><dt>Event ID</dt><dd>{report.event.id}</dd><dt>Sequence</dt><dd>{report.event.sequence}</dd></>}
        <dt>Source</dt><dd>{report.delivery.source}</dd><dt>Payload SHA-256</dt><dd>{report.delivery.payload_hash}</dd>
        <dt>Received</dt><dd>{new Date(report.delivery.received_at).toISOString()}</dd>
        {report.delivery.signed_at && <><dt>Signed at</dt><dd>{new Date(report.delivery.signed_at).toISOString()}</dd></>}</dl>
      <div className="detail-actions"><a className="button" href={`${root}/export`} download><ArrowDownToLine size={16} /> Incident report</a>
        {hasFailure && <button className="button" onClick={async () => {
          try {
            const task = await load<object>(`${root}/investigation`);
            const url = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `webhookvault-task-${report.delivery.id}.json`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (error) { setMessage((error as Error).message); }
        }}><Braces size={16} /> Investigation task</button>}
      </div>
      {message && <p role="status" className="notice">{message}</p>}
      <section className="detail-section"><h3>Delivery attempts</h3>
        {report.jobs.length === 0 && <p>This request did not enter the processing queue.</p>}
        {report.jobs.map((job) => <div className="execution" key={job.id}>
          <div><strong>{job.replay_id ? 'Replay execution' : 'Original execution'}</strong><Badge state={job.state} /></div>
          <p>{job.attempt_count} / {job.max_attempts} attempts{job.state === 'retry' ? ` · next at ${time(job.available_at)} UTC` : ''}</p>
          {report.attempts.filter((attempt) => attempt.job_id === job.id).map((attempt) =>
            <div className="attempt" key={attempt.number}><span>#{attempt.number}</span>
              <div><strong>{format(attempt.outcome)}{attempt.http_status ? ` · HTTP ${attempt.http_status}` : ''}</strong>
                <small>{attempt.detail ?? 'Awaiting acknowledgement'}</small>
                {attempt.next_at && <small>Retry scheduled for {time(attempt.next_at)} UTC</small>}
              </div><time>{time(attempt.started_at)}</time></div>)}
        </div>)}
      </section>
      {eligible && <section className="detail-section"><h3>Authorize replay</h3><p>One replay is allowed for this dead-letter event. The same event ID and ordering rules apply.</p>
        <form className="replay-form" onSubmit={submit}>
          <label>Operator token<input type="password" autoComplete="off" required value={token} onChange={(event) => setToken(event.target.value)} /></label>
          <label>Audit reason<input required minLength={8} maxLength={160} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <label className="checkbox"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /> I approve this replay</label>
          <button className="button primary" disabled={!approved || pending}><RotateCcw size={15} /> Queue replay</button>
        </form></section>}
      <section className="detail-section"><h3>Event timeline <small>UTC</small></h3>
        <ol className="timeline">{report.timeline.map((item, i) =>
          <li key={`${item.reference}-${i}`}><span>{format(item.action)}</span><time>{time(item.at)}</time></li>)}</ol>
      </section>
    </div>
  </dialog>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState('');
  const [report, setReport] = useState<EventReport>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const refresh = useCallback(async () => {
    try { setData(await load<DashboardData>('/api/dashboard')); setError(''); }
    catch (failure) { setError((failure as Error).message); }
  }, []);
  const refreshReport = useCallback(async () => {
    if (selected) {
      const next = await load<EventReport>(`/api/deliveries/${selected}/report`);
      setReport((current) => current?.delivery.id === next.delivery.id ? next : current);
    }
  }, [selected]);
  useEffect(() => {
    void refresh();
    const handle = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => clearInterval(handle);
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    const handle = setInterval(() => void refreshReport().catch(() => {}), 3000);
    return () => clearInterval(handle);
  }, [selected, refreshReport]);
  async function open(id: string) {
    try {
      const next = await load<EventReport>(`/api/deliveries/${id}/report`);
      setReport(next);
      setSelected(id);
    } catch (failure) { setError((failure as Error).message); }
  }
  const navigate = (next: View) => { setView(next); setFilter('all'); setSearch(''); };
  const totals = data?.totals;
  const metrics = [
    { label: 'Total deliveries', value: totals?.received, sub: `${totals?.duplicates ?? 0} duplicates`, Icon: Inbox, tone: 'violet' },
    { label: 'Verified signatures', value: totals?.verified, sub: 'Authenticated requests', Icon: ShieldCheck, tone: 'green' },
    { label: 'Active jobs', value: totals && totals.queued + totals.running + totals.retries, sub: `${totals?.retries ?? 0} scheduled retries`, Icon: Clock3, tone: 'gold' },
    { label: 'Dead-letter events', value: totals?.dead, sub: 'Latest execution exhausted', Icon: Archive, tone: 'red' },
  ];
  const rows = ((view === 'dead' ? data?.deadRows : data?.rows) ?? []).filter((row) => {
    if (filter === 'rejected' && row.signature !== 'rejected') return false;
    if ((filter === 'succeeded' || filter === 'retry') && row.state !== filter) return false;
    const query = search.trim().toLowerCase();
    return !query || [row.provider_id, row.id, row.event_id, row.source].some((value) => value?.toLowerCase().includes(query));
  });
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div><Webhook size={23} /></div><span>Webhook<span>Vault</span><small>Delivery console</small></span></div>
      <nav aria-label="Console"><p>WORKSPACE</p>
        <button className={view === 'all' ? 'selected' : ''} aria-current={view === 'all' ? 'page' : undefined} onClick={() => navigate('all')}><LayoutDashboard size={17} /> Overview</button>
        <button className={view === 'dead' ? 'selected' : ''} aria-current={view === 'dead' ? 'page' : undefined} onClick={() => navigate('dead')}><Archive size={17} /> Dead letter {Boolean(totals?.dead) && <small>{totals?.dead}</small>}</button>
        <button className={view === 'workers' ? 'selected' : ''} aria-current={view === 'workers' ? 'page' : undefined} onClick={() => navigate('workers')}><Activity size={17} /> Workers</button>
      </nav>
      <div className="environment"><Fingerprint size={18} /><span>Local laboratory<small>Synthetic traffic only</small></span></div>
    </aside>
    <main>
      <header className="topbar"><div><span>Workspace</span><b>/</b>{view === 'all' ? 'Overview' : view === 'dead' ? 'Dead letter' : 'Workers'}</div>
        <div><span className={data && !error ? 'online' : 'offline'}><i />{error ? 'API unavailable' : data ? 'API connected' : 'Connecting'}</span>
          <button aria-label="Refresh dashboard" className="icon-button" onClick={() => void refresh()}><RotateCcw size={15} /></button></div></header>
      <div className="content">
        <div className="intro"><div><h1>{view === 'all' ? 'Delivery overview' : view === 'dead' ? 'Dead-letter queue' : 'Background workers'}</h1>
          <p>{view === 'all' ? 'Monitor webhook traffic, processing state, and delivery failures.' : view === 'dead' ?
            'Inspect exhausted deliveries and authorize a bounded replay.' : 'Inspect worker heartbeats and recent interruptions.'}</p></div>
          <span className="source"><span /> synthetic</span></div>
        {error && <p className="notice" role="alert">Unable to load console data. {error}</p>}
        {view === 'all' && <><div className="metrics">{metrics.map(({ label, value, sub, Icon, tone }) =>
          <section className="panel metric" key={label}><div><h2>{label}</h2><span className={`metric-icon ${tone}`}><Icon size={18} /></span></div>
            <strong>{value ?? '—'}</strong><p>{value === undefined ? 'Waiting for data' : sub}</p></section>)}</div>
          <div className="monitor"><Traffic buckets={data?.buckets ?? []} /><Workers workers={data?.workers ?? []} /></div></>}
        {view === 'workers' ? <Workers workers={data?.workers ?? []} full /> :
          <section className="panel deliveries" aria-labelledby="deliveries-title">
            <div className="panel-head"><div><h2 id="deliveries-title">{view === 'dead' ? 'Eligible and exhausted deliveries' : 'Recent deliveries'}</h2>
              <p>{view === 'dead' ? 'Latest 150 dead-letter events' : 'Latest 150 incoming requests'}</p></div>
              <label className="search"><Search size={16} /><input aria-label="Search deliveries" placeholder="Search events…" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
            {view === 'all' && <div className="filters" aria-label="Delivery filters"><ListFilter size={15} />
              {([['all', 'All deliveries'], ['succeeded', 'Succeeded'], ['retry', 'Retrying'], ['rejected', 'Rejected']] as const).map(([key, name]) =>
                <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{name}</button>)}</div>}
            <div className="table-scroll"><table><thead><tr><th>Provider event</th><th>Signature</th><th>State</th><th>Attempts</th><th>Received <small>UTC</small></th></tr></thead>
              <tbody>{rows.map((row) => <tr key={row.id}>
                <td><button className="event-link" onClick={() => void open(row.id)}>{row.provider_id ?? 'Rejected request'}</button><small>{row.source} · {row.id.slice(0, 8)}{row.replay_id ? ' · replay' : ''}</small></td>
                <td><span className={`signature ${row.signature}`}>{row.signature === 'verified' ? <CircleCheck size={14} /> : <ShieldAlert size={14} />}{row.signature}</span></td>
                <td><Badge state={row.disposition === 'accepted' ? row.state ?? 'queued' : row.disposition} />
                  {row.state === 'retry' && row.available_at && <small>Next {time(row.available_at)} UTC</small>}</td>
                <td className="mono">{row.attempt_count ?? '—'}</td><td className="mono">{time(row.received_at)}</td>
              </tr>)}</tbody></table>
              {rows.length === 0 && <p className="empty">{data ? 'No deliveries match this view.' : 'Loading deliveries…'}</p>}</div>
            <div className="table-footer"><span>{rows.length} {rows.length === 1 ? 'delivery' : 'deliveries'} shown</span><span><Check size={13} /> Refreshes every 3 seconds</span></div>
          </section>}
      </div>
    </main>
    {report && selected && <Detail key={selected} report={report} close={() => { setSelected(undefined); setReport(undefined); }}
      refresh={async () => { await Promise.all([refresh(), refreshReport()]); }} />}
  </div>;
}
