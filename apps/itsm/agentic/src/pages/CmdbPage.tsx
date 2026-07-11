import { useCallback, useEffect, useState } from "react";
import { ActionReplayLayer, weftAction, type WeftActionEvent } from "@percena/weft/action-bridge";
import { api, type CI, type ItsMEvent } from "../api";
import { Btn, ErrorBanner, Modal, Pill, Spinner, fmtDateTime } from "../components";

/**
 * Translates an ITSM business event into a weft action descriptor pointing at
 * the always-visible CI card. Only `actor === "agent"` events are replayed;
 * the X-Weft-Actor override stamps agent-driven tool calls with
 * `actor = "agent"`. Non-ci events return null so they don't trigger a
 * spurious replay+refresh on this tab.
 */
function toCiActionEvent(event: ItsMEvent): WeftActionEvent | null {
  if (event.actor !== "agent") return null;
  if (event.action !== "ci.updated") return null;
  const ci = event.data.ci as { id?: string } | undefined;
  if (!ci?.id) return null;
  return {
    actor: "agent",
    action: event.action,
    target: `ci-card:${ci.id}`,
    label: `Update ${ci.id}`,
  };
}

export default function CmdbPage() {
  const [cis, setCis] = useState<CI[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CI | null>(null);
  const [dependents, setDependents] = useState<CI[] | null>(null);
  const [depBusy, setDepBusy] = useState(false);
  const [depError, setDepError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.cis
      .list()
      .then(setCis)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const [eventSource, setEventSource] = useState<EventSource | null>(null);

  // One shared EventSource feeds both the manual non-agent refresh and the
  // ActionReplayLayer (agent ci.updated events are replayed, then onReplayed
  // refreshes). CMDB only reacts to ci.* events — incident/change mutations
  // elsewhere don't change the CI list.
  useEffect(() => {
    const source = new EventSource("/api/events");
    setEventSource(source);
    source.addEventListener("itsm.event", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as ItsMEvent;
        if (event.action === "ci.updated" && event.actor !== "agent") load();
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => {
      source.close();
      setEventSource(null);
    };
  }, [load]);

  const open = (c: CI) => {
    setSelected(c);
    setDependents(null);
    setDepError(null);
  };

  const showDependents = async () => {
    if (!selected) return;
    setDepBusy(true);
    setDepError(null);
    setDependents(null);
    try {
      const ds = await api.cis.dependents(selected.id);
      setDependents(ds);
    } catch (e) {
      setDepError(e instanceof Error ? e.message : String(e));
    } finally {
      setDepBusy(false);
    }
  };

  if (error) return <ErrorBanner message={error} />;
  if (!cis) return <Spinner label="Loading CMDB…" />;

  return (
    <div className="max-w-4xl">
      {eventSource && (
        <ActionReplayLayer<ItsMEvent>
          source={eventSource}
          eventName="itsm.event"
          map={toCiActionEvent}
          cursor="ghost"
          onReplayed={() => load()}
        />
      )}
      <h2 className="mb-3 text-sm font-semibold text-slate-700">Configuration Items ({cis.length})</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cis.map((c) => (
          <button type="button"
            key={c.id}
            onClick={() => open(c)}
            className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 hover:shadow-sm"
            {...weftAction("ci-card", c.id)}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-800">{c.name}</span>
              <Pill>{c.status}</Pill>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {c.id} · {c.type} · owner {c.owner}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              depends_on: {c.depends_on.length} · runs_on: {c.runs_on.length}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <Modal title={`${selected.name} · ${selected.id}`} onClose={() => setSelected(null)} wide>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Detail label="Name" value={selected.name} />
            <Detail label="ID" value={selected.id} />
            <Detail label="Type" value={selected.type} />
            <Detail label="Status" value={selected.status} />
            <Detail label="Owner" value={selected.owner} />
            <Detail label="Created" value={fmtDateTime(selected.created_at)} />
          </dl>

          <section className="mt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Depends on
            </h4>
            {selected.depends_on.length ? (
              <ul className="text-sm text-slate-600">
                {selected.depends_on.map((d) => (
                  <li key={d} className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{d}</span>
                    <button type="button"
                      className="text-blue-600 hover:underline"
                      onClick={() => {
                        const c = cis.find((x) => x.id === d);
                        if (c) open(c);
                      }}
                    >
                      {cis.find((x) => x.id === d)?.name ?? "(missing)"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">none</p>
            )}
          </section>

          <section className="mt-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Runs on
            </h4>
            {selected.runs_on.length ? (
              <ul className="text-sm text-slate-600">
                {selected.runs_on.map((d) => (
                  <li key={d} className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">{d}</span>
                    <button type="button"
                      className="text-blue-600 hover:underline"
                      onClick={() => {
                        const c = cis.find((x) => x.id === d);
                        if (c) open(c);
                      }}
                    >
                      {cis.find((x) => x.id === d)?.name ?? "(missing)"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">none</p>
            )}
          </section>

          <section className="mt-4 border-t border-slate-100 pt-3">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Reachable dependents
              </h4>
              <Btn onClick={showDependents} disabled={depBusy}>
                {depBusy ? "Traversing…" : dependents ? "Refresh" : "Show dependents"}
              </Btn>
            </div>
            <p className="mb-2 text-xs text-slate-400">
              Multi-hop traversal of depends_on + runs_on (excludes the root CI).
            </p>
            {depError && <ErrorBanner message={depError} />}
            {dependents && (
              dependents.length ? (
                <ul className="space-y-1">
                  {dependents.map((d) => (
                    <li key={d.id}>
                      <button type="button"
                        onClick={() => open(d)}
                        className="flex w-full items-center justify-between rounded border border-slate-200 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="font-medium text-slate-700">{d.name}</span>
                        <span className="text-xs text-slate-400">
                          {d.id} · {d.type}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">No downstream CIs reachable.</p>
              )
            )}
          </section>
        </Modal>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value}</dd>
    </div>
  );
}
