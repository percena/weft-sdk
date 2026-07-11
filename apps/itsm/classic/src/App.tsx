import { useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { Btn, Spinner } from "./components";
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

function Shell() {
  const { user, loading, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("incidents");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (!user) return <LoginPage />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-800">ITSM Console</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            classic
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">{user.username}</span>
            <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {user.role}
            </span>
          </span>
          <Btn onClick={logout}>Logout</Btn>
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

      <main className="flex-1 overflow-y-auto scroll-thin p-4">
        {tab === "incidents" && <IncidentsPage />}
        {tab === "changes" && <ChangesPage />}
        {tab === "cmdb" && <CmdbPage />}
        {tab === "slas" && <SlasPage />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
