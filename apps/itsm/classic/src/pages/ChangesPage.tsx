import { useCallback, useEffect, useState } from "react";
import {
  api,
  useEventSource,
  type Change,
  type ChangeRisk,
  type ChangeStatus,
  type ChangeType,
  type CI,
} from "../api";
import { useAuth } from "../auth";
import {
  Btn,
  ErrorBanner,
  Field,
  Modal,
  Pill,
  Spinner,
  StatusBadge,
  fmtDateTime,
  inputCls,
} from "../components";

const STATUSES: ChangeStatus[] = [
  "draft", "submitted", "cab_approved", "scheduled",
  "implementing", "implemented", "closed", "rejected", "rolled_back",
];
const RISKS: ChangeRisk[] = ["low", "medium", "high"];
const TYPES: ChangeType[] = ["normal", "emergency"];

const ACTION_LABEL: Record<string, string> = {
  submit: "Submit",
  approve: "Approve",
  reject: "Reject",
  schedule: "Schedule",
  implement: "Implement",
  complete: "Complete",
  rollback: "Rollback",
  close: "Close",
};

export default function ChangesPage() {
  const { user } = useAuth();
  const [list, setList] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [cis, setCis] = useState<CI[]>([]);
  const [selected, setSelected] = useState<Change | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    api.changes
      .list(filter ? { status: filter } : undefined)
      .then(setList)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.cis.list().then(setCis).catch(() => {});
  }, []);

  useEventSource(() => {
    load();
    if (selected) {
      api.changes.get(selected.id).then(setSelected).catch(() => {});
    }
  });

  const isManager = user?.role === "manager";

  if (error) return <ErrorBanner message={error} />;
  if (!list) return <Spinner label="Loading changes…" />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Changes ({list.length})</h2>
        <div className="flex items-center gap-2">
          <select
            className={`${inputCls} w-auto`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Btn variant="primary" onClick={() => setShowNew(true)}>+ New change</Btn>
        </div>
      </div>

      <p className="mb-2 text-xs text-slate-400">
        Note: <span className="font-medium">approve</span> / <span className="font-medium">reject</span> require the manager role (bob). Other roles will get a 403.
      </p>

      {list.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No changes.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Risk</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">CIs</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.id}</td>
                  <td className="px-3 py-2 text-slate-800">{c.title}</td>
                  <td className="px-3 py-2 text-slate-600">{c.type}</td>
                  <td className="px-3 py-2 text-slate-600">{c.risk}</td>
                  <td className="px-3 py-2"><StatusBadge status={c.status} kind="change" /></td>
                  <td className="px-3 py-2 text-slate-600">{c.affected_cis.length}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{fmtDateTime(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ChangeDetail
          change={selected}
          cis={cis}
          isManager={isManager}
          onClose={() => setSelected(null)}
          onUpdate={(c) => { setSelected(c); load(); }}
        />
      )}

      {showNew && (
        <NewChangeForm
          cis={cis}
          onClose={() => setShowNew(false)}
          onCreated={(c) => { setShowNew(false); setSelected(c); load(); }}
        />
      )}
    </div>
  );
}

// ─── detail + actions ───────────────────────────────────────────────────────
function ChangeDetail({
  change,
  cis,
  isManager,
  onClose,
  onUpdate,
}: {
  change: Change;
  cis: CI[];
  isManager: boolean;
  onClose: () => void;
  onUpdate: (c: Change) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [window, setWindow] = useState("");
  const [linkCi, setLinkCi] = useState("");
  const [linkIncident, setLinkIncident] = useState("");

  const run = async (fn: () => Promise<Change>) => {
    setErr(null);
    setBusy(true);
    try {
      const updated = await fn();
      onUpdate(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const has = (a: string) => change.allowed_actions.includes(a);
  const ciName = (id: string) => cis.find((c) => c.id === id)?.name ?? id;

  const managerOnly = (a: string) => a === "approve" || a === "reject";

  return (
    <Modal title={`${change.id} · ${change.title}`} onClose={onClose} wide>
      <ErrorBanner message={err} />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={change.status} kind="change" />
        <Pill>type: {change.type}</Pill>
        <Pill>risk: {change.risk}</Pill>
        <Pill>requester: {change.requester}</Pill>
        {change.implementer && <Pill>implementer: {change.implementer}</Pill>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Row label="Created" value={fmtDateTime(change.created_at)} />
        <Row label="Updated" value={fmtDateTime(change.updated_at)} />
        <Row label="Change window" value={change.change_window ?? "—"} />
      </dl>

      {change.description && (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {change.description}
        </p>
      )}
      {change.rollback_plan && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <span className="font-medium">Rollback plan:</span> {change.rollback_plan}
        </p>
      )}

      {/* transition actions */}
      <section className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</h4>
        <div className="flex flex-wrap items-center gap-2">
          {has("schedule") && (
            <div className="flex items-center gap-1">
              <input
                className={`${inputCls} w-56`}
                placeholder="change window (e.g. 2026-07-01 02:00–04:00 UTC)"
                value={window}
                onChange={(e) => setWindow(e.target.value)}
              />
              <Btn
                disabled={busy || !window}
                onClick={() => run(() => api.changes.action(change.id, "schedule", { change_window: window }).then((c) => { setWindow(""); return c; }))}
              >
                Schedule
              </Btn>
            </div>
          )}
          {["submit", "approve", "reject", "implement", "complete", "rollback", "close"]
            .filter((a) => has(a))
            .map((a) => {
              const mo = managerOnly(a);
              return (
                <Btn
                  key={a}
                  variant={a === "rollback" ? "danger" : "default"}
                  disabled={busy}
                  onClick={() => run(() => api.changes.action(change.id, a))}
                  title={mo && !isManager ? "manager role required" : undefined}
                >
                  {ACTION_LABEL[a] ?? a}
                  {mo && !isManager && <span className="ml-1 text-[10px] opacity-70">(403)</span>}
                </Btn>
              );
            })}
        </div>
        {!isManager && (has("approve") || has("reject")) && (
          <p className="mt-1.5 text-xs text-amber-600">
            You are not a manager — approve/reject will return 403 from the backend.
          </p>
        )}
      </section>

      {/* link */}
      {(has("link_ci") || has("link_incident")) && (
        <section className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Link</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {has("link_ci") && (
              <Field label="Link CI">
                <div className="flex items-center gap-1">
                  <select className={inputCls} value={linkCi} onChange={(e) => setLinkCi(e.target.value)}>
                    <option value="">Select CI…</option>
                    {cis.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
                  </select>
                  <Btn disabled={busy || !linkCi} onClick={() => run(() => api.changes.linkCi(change.id, linkCi).then((c) => { setLinkCi(""); return c; }))}>
                    Link
                  </Btn>
                </div>
              </Field>
            )}
            {has("link_incident") && (
              <Field label="Link incident">
                <div className="flex items-center gap-1">
                  <input
                    className={`${inputCls} w-32`}
                    placeholder="INC-x"
                    value={linkIncident}
                    onChange={(e) => setLinkIncident(e.target.value)}
                  />
                  <Btn disabled={busy || !linkIncident} onClick={() => run(() => api.changes.linkIncident(change.id, linkIncident).then((c) => { setLinkIncident(""); return c; }))}>
                    Link
                  </Btn>
                </div>
              </Field>
            )}
          </div>
        </section>
      )}

      {/* linked */}
      {(change.affected_cis.length > 0 || change.linked_incidents.length > 0) && (
        <section className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Linked</h4>
          <div className="flex flex-wrap gap-1.5">
            {change.affected_cis.map((id) => <Pill key={id}>ci: {ciName(id)}</Pill>)}
            {change.linked_incidents.map((id) => <Pill key={id}>incident: {id}</Pill>)}
          </div>
        </section>
      )}

      {/* history */}
      <section className="mt-4 border-t border-slate-100 pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History</h4>
        <ol className="space-y-1 text-sm">
          {change.history.map((h, idx) => (
            <li key={idx} className="flex gap-2 text-slate-600">
              <span className="font-mono text-xs text-slate-400">{fmtDateTime(h.at)}</span>
              <span>
                <span className="font-medium">{h.action}</span>
                {h.from_status && <> · {h.from_status} → {h.to_status}</>}
                {!h.from_status && h.to_status && <> → {h.to_status}</>}
                {" "}by {h.actor}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value}</dd>
    </div>
  );
}

// ─── new change form ────────────────────────────────────────────────────────
function NewChangeForm({
  cis,
  onClose,
  onCreated,
}: {
  cis: CI[];
  onClose: () => void;
  onCreated: (c: Change) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ChangeType>("normal");
  const [risk, setRisk] = useState<ChangeRisk>("medium");
  const [affectedCis, setAffectedCis] = useState<string[]>([]);
  const [rollbackPlan, setRollbackPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleCi = (id: string) =>
    setAffectedCis((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const c = await api.changes.create({
        title,
        description: description || undefined,
        type,
        risk,
        affected_cis: affectedCis,
        rollback_plan: rollbackPlan || null,
      });
      onCreated(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New change" onClose={onClose}>
      <ErrorBanner message={err} />
      <div className="space-y-3">
        <Field label="Title">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" />
        </Field>
        <Field label="Description (optional)">
          <textarea className={inputCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as ChangeType)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Risk">
            <select className={inputCls} value={risk} onChange={(e) => setRisk(e.target.value as ChangeRisk)}>
              {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Affected CIs">
          <div className="max-h-32 overflow-y-auto scroll-thin rounded-md border border-slate-200 p-2">
            {cis.map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={affectedCis.includes(c.id)}
                  onChange={() => toggleCi(c.id)}
                />
                <span className="font-mono text-xs text-slate-400">{c.id}</span>
                {c.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Rollback plan (optional)">
          <textarea className={inputCls} rows={2} value={rollbackPlan} onChange={(e) => setRollbackPlan(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={busy || !title} onClick={submit}>
            {busy ? "Creating…" : "Create"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
