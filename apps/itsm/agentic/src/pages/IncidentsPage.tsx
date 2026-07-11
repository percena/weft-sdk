import { useCallback, useEffect, useRef, useState } from "react";
import { ActionReplayLayer, weftAction, type WeftActionEvent } from "@percena/weft/action-bridge";
import {
  api,
  type CI,
  type Incident,
  type IncidentCategory,
  type IncidentStatus,
  type ItsMEvent,
  type Priority,
} from "../api";
import { useAuth } from "../auth";
import {
  Btn,
  ErrorBanner,
  Field,
  Modal,
  Pill,
  PriorityBadge,
  Spinner,
  StatusBadge,
  fmtDateTime,
  inputCls,
} from "../components";

const STATUSES: IncidentStatus[] = [
  "new", "in_progress", "pending_user", "resolved", "closed", "escalated",
];
const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];
const CATEGORIES: IncidentCategory[] = [
  "hardware", "software", "network", "security", "performance",
];

const ACTION_LABEL: Record<string, string> = {
  assign: "Assign",
  escalate: "Escalate",
  resolve: "Resolve",
  close: "Close",
  reopen: "Reopen",
  request_info: "Request info",
  provide_info: "Provide info",
};

function humanizeAction(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Translates an ITSM business event into a weft action descriptor pointing at
 * the always-visible incident row (the detail modal may not be open). Only
 * `actor === "agent"` events are replayed; the X-Weft-Actor override stamps
 * agent-driven tool calls with `actor = "agent"`. Non-incident events return
 * null so they don't trigger a spurious replay+refresh on this tab.
 */
function toIncidentActionEvent(event: ItsMEvent): WeftActionEvent | null {
  if (event.actor !== "agent") return null;
  if (!event.action.startsWith("incident.")) return null;
  const incident = event.data.incident as { id?: string } | undefined;
  if (!incident?.id) return null;
  const d = event.data;
  let describe: string;
  switch (event.action) {
    case "incident.created":
      describe = "Create";
      break;
    case "incident.assigned":
      describe = "Assign";
      break;
    case "incident.transitioned":
      describe = humanizeAction(String(d.action ?? "transition"));
      break;
    case "incident.commented":
      describe = "Comment";
      break;
    case "incident.priority_updated":
      describe = "Update priority";
      break;
    case "incident.linked":
      describe = `Link ${String(d.kind ?? "ci").toUpperCase()} →`;
      break;
    default:
      describe = event.action;
  }
  return {
    actor: "agent",
    action: event.action,
    target: `incident-row:${incident.id}`,
    label: `${describe} ${incident.id}`,
  };
}

export default function IncidentsPage() {
  const { user } = useAuth();
  const [list, setList] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [cis, setCis] = useState<CI[]>([]);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    api.incidents
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

  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const selectedRef = useRef<Incident | null>(null);
  selectedRef.current = selected;

  const refresh = useCallback(() => {
    load();
    const sel = selectedRef.current;
    if (sel) {
      api.incidents.get(sel.id).then(setSelected).catch(() => {});
    }
  }, [load]);

  // One shared EventSource feeds both the manual non-agent refresh and the
  // ActionReplayLayer (agent events are replayed, then onReplayed refreshes).
  useEffect(() => {
    const source = new EventSource("/api/events");
    setEventSource(source);
    source.addEventListener("itsm.event", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as ItsMEvent;
        if (event.actor !== "agent") refresh();
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => {
      source.close();
      setEventSource(null);
    };
  }, [refresh]);

  const canCreate = user?.role === "requester" || user?.role === "agent";

  if (error) return <ErrorBanner message={error} />;
  if (!list) return <Spinner label="Loading incidents…" />;

  return (
    <div>
      {eventSource && (
        <ActionReplayLayer<ItsMEvent>
          source={eventSource}
          eventName="itsm.event"
          map={toIncidentActionEvent}
          cursor="ghost"
          onReplayed={() => refresh()}
        />
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Incidents ({list.length})</h2>
        <div className="flex items-center gap-2">
          <select
            className={`${inputCls} w-auto`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {canCreate && (
            <Btn variant="primary" onClick={() => setShowNew(true)}>+ New incident</Btn>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No incidents.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Assignee</th>
                <th className="px-3 py-2">Affected CI</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setSelected(i)}
                  className="cursor-pointer hover:bg-slate-50"
                  {...weftAction("incident-row", i.id)}
                >
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{i.id}</td>
                  <td className="px-3 py-2 text-slate-800">{i.title}</td>
                  <td className="px-3 py-2"><PriorityBadge priority={i.priority} /></td>
                  <td className="px-3 py-2"><StatusBadge status={i.status} kind="incident" /></td>
                  <td className="px-3 py-2 text-slate-600">{i.assignee ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{i.affected_ci ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{fmtDateTime(i.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <IncidentDetail
          incident={selected}
          cis={cis}
          onClose={() => setSelected(null)}
          onUpdate={(inc) => { setSelected(inc); load(); }}
        />
      )}

      {showNew && (
        <NewIncidentForm
          cis={cis}
          onClose={() => setShowNew(false)}
          onCreated={(inc) => { setShowNew(false); setSelected(inc); load(); }}
        />
      )}
    </div>
  );
}

// ─── detail + actions ───────────────────────────────────────────────────────
function IncidentDetail({
  incident,
  cis,
  onClose,
  onUpdate,
}: {
  incident: Incident;
  cis: CI[];
  onClose: () => void;
  onUpdate: (inc: Incident) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");
  const [resolution, setResolution] = useState("");
  const [comment, setComment] = useState("");
  const [priority, setPriority] = useState<Priority>(incident.priority);
  const [linkCi, setLinkCi] = useState("");
  const [linkChange, setLinkChange] = useState("");

  const run = async (fn: () => Promise<Incident>) => {
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

  const has = (a: string) => incident.allowed_actions.includes(a);
  const ciName = (id: string) => cis.find((c) => c.id === id)?.name ?? id;

  return (
    <Modal title={`${incident.id} · ${incident.title}`} onClose={onClose} wide>
      <ErrorBanner message={err} />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={incident.status} kind="incident" />
        <PriorityBadge priority={incident.priority} />
        <Pill>cat: {incident.category}</Pill>
        <Pill>sla: {incident.sla_id ?? "—"}</Pill>
        <Pill>requester: {incident.requester}</Pill>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Row label="Assignee" value={incident.assignee ?? "—"} />
        <Row label="Affected CI" value={incident.affected_ci ? ciName(incident.affected_ci) : "—"} />
        <Row label="Created" value={fmtDateTime(incident.created_at)} />
        <Row label="Updated" value={fmtDateTime(incident.updated_at)} />
      </dl>

      {incident.description && (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {incident.description}
        </p>
      )}
      {incident.resolution_note && (
        <p className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          <span className="font-medium">Resolution:</span> {incident.resolution_note}
        </p>
      )}

      {/* transition actions */}
      <section className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Actions
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          {has("assign") && (
            <div className="flex items-center gap-1">
              <input
                className={`${inputCls} w-40`}
                placeholder="assignee (blank = CI owner)"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
              <Btn
                variant="primary"
                disabled={busy}
                onClick={() => run(() => api.incidents.action(incident.id, "assign", assignee ? { assignee } : {}))}
              >
                Assign
              </Btn>
            </div>
          )}
          {has("resolve") && (
            <div className="flex items-center gap-1">
              <input
                className={`${inputCls} w-48`}
                placeholder="resolution note (optional)"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />
              <Btn
                disabled={busy}
                onClick={() => run(() => api.incidents.action(incident.id, "resolve", resolution ? { resolution_note: resolution } : {}))}
              >
                Resolve
              </Btn>
            </div>
          )}
          {["escalate", "close", "reopen", "request_info", "provide_info"]
            .filter((a) => has(a))
            .map((a) => (
              <Btn key={a} disabled={busy} onClick={() => run(() => api.incidents.action(incident.id, a))}>
                {ACTION_LABEL[a] ?? a}
              </Btn>
            ))}
        </div>
      </section>

      {/* open mutations */}
      <section className="mt-4 border-t border-slate-100 pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Work
        </h4>
        <div className="grid gap-3 sm:grid-cols-2">
          {has("update_priority") && (
            <Field label="Update priority">
              <div className="flex items-center gap-1">
                <select
                  className={inputCls}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                >
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <Btn disabled={busy} onClick={() => run(() => api.incidents.priority(incident.id, priority))}>
                  Set
                </Btn>
              </div>
            </Field>
          )}
          {has("add_comment") && (
            <Field label="Add comment">
              <div className="flex items-center gap-1">
                <input
                  className={inputCls}
                  placeholder="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Btn disabled={busy || !comment} onClick={() => run(() => api.incidents.comment(incident.id, comment).then((inc) => { setComment(""); return inc; }))}>
                  Post
                </Btn>
              </div>
            </Field>
          )}
          {has("link_ci") && (
            <Field label="Link CI">
              <div className="flex items-center gap-1">
                <select className={inputCls} value={linkCi} onChange={(e) => setLinkCi(e.target.value)}>
                  <option value="">Select CI…</option>
                  {cis.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
                </select>
                <Btn disabled={busy || !linkCi} onClick={() => run(() => api.incidents.linkCi(incident.id, linkCi).then((inc) => { setLinkCi(""); return inc; }))}>
                  Link
                </Btn>
              </div>
            </Field>
          )}
          {has("link_change") && (
            <Field label="Link change">
              <div className="flex items-center gap-1">
                <input
                  className={`${inputCls} w-32`}
                  placeholder="CHG-x"
                  value={linkChange}
                  onChange={(e) => setLinkChange(e.target.value)}
                />
                <Btn disabled={busy || !linkChange} onClick={() => run(() => api.incidents.linkChange(incident.id, linkChange).then((inc) => { setLinkChange(""); return inc; }))}>
                  Link
                </Btn>
              </div>
            </Field>
          )}
        </div>
      </section>

      {/* linked */}
      {(incident.linked_cis.length > 0 || incident.linked_changes.length > 0) && (
        <section className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Linked</h4>
          <div className="flex flex-wrap gap-1.5">
            {incident.linked_cis.map((id) => <Pill key={id}>ci: {ciName(id)}</Pill>)}
            {incident.linked_changes.map((id) => <Pill key={id}>change: {id}</Pill>)}
          </div>
        </section>
      )}

      {/* comments */}
      <section className="mt-4 border-t border-slate-100 pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Comments ({incident.comments.length})
        </h4>
        {incident.comments.length === 0 ? (
          <p className="text-sm text-slate-400">none</p>
        ) : (
          <ul className="space-y-1.5">
            {incident.comments.map((c) => (
              <li key={c.id} className="rounded-md bg-slate-50 px-3 py-1.5 text-sm">
                <div className="text-xs text-slate-400">{c.author} · {fmtDateTime(c.at)}</div>
                <div className="text-slate-700">{c.body}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* history */}
      <section className="mt-4 border-t border-slate-100 pt-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          History
        </h4>
        <ol className="space-y-1 text-sm">
          {incident.history.map((h, idx) => (
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

// ─── new incident form ──────────────────────────────────────────────────────
function NewIncidentForm({
  cis,
  onClose,
  onCreated,
}: {
  cis: CI[];
  onClose: () => void;
  onCreated: (inc: Incident) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("P3");
  const [category, setCategory] = useState<IncidentCategory>("software");
  const [affectedCi, setAffectedCi] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const inc = await api.incidents.create({
        title,
        description: description || undefined,
        priority,
        category,
        affected_ci: affectedCi || null,
      });
      onCreated(inc);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New incident" onClose={onClose}>
      <ErrorBanner message={err} />
      <div className="space-y-3">
        <Field label="Title">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" />
        </Field>
        <Field label="Description (optional)">
          <textarea className={inputCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as IncidentCategory)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Affected CI (optional)">
          <select className={inputCls} value={affectedCi} onChange={(e) => setAffectedCi(e.target.value)}>
            <option value="">None</option>
            {cis.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
          </select>
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
