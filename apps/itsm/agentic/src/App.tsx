import { useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { Btn, Spinner } from "./components";
import { ChatPane } from "./ChatPane";
import { bootstrapChatSession, type ChatSessionBootstrap } from "./chat-bootstrap";
import LoginPage from "./pages/LoginPage";
import IncidentsPage from "./pages/IncidentsPage";
import ChangesPage from "./pages/ChangesPage";
import CmdbPage from "./pages/CmdbPage";
import SlasPage from "./pages/SlasPage";

type Tab = "incidents" | "changes" | "cmdb" | "slas";

const TABS: { id: Tab; label: string }[] = [
  { id: "incidents", label: "Incidents" },
  { id: "changes", label: "Changes" },
  { id: "cmdb", label: "CMDB" },
  { id: "slas", label: "SLAs" },
];

const MAX_RETRIES = 5;
const RETRY_DELAYS = [2000, 3000, 5000, 8000, 12000];

function MainLayout() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("incidents");
  const [boot, setBoot] = useState<ChatSessionBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const attemptBootstrap = useCallback(
    (auto = false) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      if (auto) setRetrying(true);
      else setError(null);

      if (!user) return;
      bootstrapChatSession(user.username, ac.signal)
        .then((created) => {
          retriesRef.current = 0;
          setRetrying(false);
          setError(null);
          setBoot(created);
        })
        .catch((err: Error) => {
          if (ac.signal.aborted) return;
          setRetrying(false);
          setError(err.message);
          if (retriesRef.current < MAX_RETRIES) {
            const delay = RETRY_DELAYS[Math.min(retriesRef.current, RETRY_DELAYS.length - 1)];
            retriesRef.current++;
            timerRef.current = setTimeout(() => attemptBootstrap(true), delay);
          }
        });
    },
    [user],
  );

  useEffect(() => {
    attemptBootstrap();
    return () => {
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [attemptBootstrap]);

  // Auto-switch to the tab of an agent-driven event so the user SEES the
  // automated-live-cursor replay + the live update. The per-page ActionReplayLayer is
  // scoped (a change event on the Incidents tab is ignored); without this, a
  // change operation driven while the user is on the Incidents tab is invisible
  // until an incident event fires (e.g. the rollback auto-incident at the end).
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("itsm.event", (e) => {
      try {
        const evt = JSON.parse((e as MessageEvent).data);
        if (evt.actor !== "agent") return;
        const action = String(evt.action || "");
        if (action.startsWith("incident.")) setTab("incidents");
        else if (action.startsWith("change.")) setTab("changes");
        else if (action.startsWith("ci.")) setTab("cmdb");
      } catch { /* ignore malformed */ }
    });
    return () => es.close();
  }, []);

  const manualRetry = () => {
    retriesRef.current = 0;
    clearTimeout(timerRef.current);
    setRetrying(false);
    attemptBootstrap();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-800">ITSM Console</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            agentic
          </span>
        </div>
        <div className="flex items-center gap-3">
          {boot && (
            <span className="hidden text-xs text-slate-400 sm:inline">
              Session <span className="font-mono">{boot.session_id.slice(0, 8)}</span>
            </span>
          )}
          {user && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600">
                <span className="font-medium text-slate-800">{user.username}</span>
                <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {user.role}
                </span>
              </span>
              <Btn onClick={logout}>Logout</Btn>
            </div>
          )}
        </div>
      </header>

      <nav className="flex gap-1 border-b border-slate-200 bg-white px-3">
        {TABS.map((t) => (
          <button type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === t.id
                ? "border-slate-800 text-slate-800"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex min-h-0 flex-1">
        <aside className="flex w-[440px] shrink-0 flex-col border-r border-slate-200 bg-white">
          {error && (
            <div className="m-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Failed to create chat session: {error}
              <div className="mt-1.5 flex items-center gap-2 text-xs">
                {retrying ? (
                  <span className="opacity-70">
                    Retrying… ({retriesRef.current}/{MAX_RETRIES})
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={manualRetry}
                    className="rounded border border-red-300 bg-white px-2 py-0.5 text-red-600 hover:bg-red-50"
                  >
                    Reconnect
                  </button>
                )}
              </div>
            </div>
          )}
          {!boot && !error && (
            <div className="flex flex-1 items-center justify-center">
              <Spinner label="Connecting to chat…" />
            </div>
          )}
          {boot && <ChatPane boot={boot} />}
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto scroll-thin p-4">
          {tab === "incidents" && <IncidentsPage />}
          {tab === "changes" && <ChangesPage />}
          {tab === "cmdb" && <CmdbPage />}
          {tab === "slas" && <SlasPage />}
        </section>
      </main>
    </div>
  );
}

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (!user) return <LoginPage />;

  return <MainLayout key={user.username} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
