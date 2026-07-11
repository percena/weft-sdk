import { useState } from "react";
import { useAuth } from "../auth";
import { Btn, ErrorBanner, inputCls } from "../components";

const USERS = [
  { username: "alice", role: "agent" },
  { username: "bob", role: "manager" },
  { username: "carol", role: "requester" },
  { username: "dave", role: "agent" },
] as const;

export default function LoginPage() {
  const { login } = useAuth();
  const [selected, setSelected] = useState<string>("alice");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await login(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-800">ITSM Console</h1>
        <p className="mb-4 text-sm text-slate-500">Sign in as one of the seeded demo users.</p>
        <ErrorBanner message={error} />
        <div className="mb-4 grid grid-cols-2 gap-2">
          {USERS.map((u) => (
            <button type="button"
              key={u.username}
              onClick={() => setSelected(u.username)}
              className={`rounded-md border px-3 py-2 text-left transition ${
                selected === u.username
                  ? "border-slate-800 bg-slate-800 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <div className="text-sm font-medium">{u.username}</div>
              <div
                className={`text-xs ${selected === u.username ? "text-slate-300" : "text-slate-400"}`}
              >
                {u.role}
              </div>
            </button>
          ))}
        </div>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Username</span>
          <input
            className={inputCls}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            placeholder="username"
          />
        </label>
        <Btn variant="primary" onClick={submit} disabled={busy || !selected}>
          {busy ? "Signing in…" : "Sign in"}
        </Btn>
        <p className="mt-3 text-xs text-slate-400">Any password accepted (demo).</p>
      </div>
    </div>
  );
}
