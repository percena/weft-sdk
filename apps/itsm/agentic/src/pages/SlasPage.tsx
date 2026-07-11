import { useEffect, useState } from "react";
import { api, type SLA } from "../api";
import { ErrorBanner, Spinner } from "../components";

export default function SlasPage() {
  const [slas, setSlas] = useState<SLA[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.slas
      .list()
      .then((s) => alive && setSlas(s))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!slas) return <Spinner label="Loading SLAs…" />;

  return (
    <div className="max-w-3xl">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">SLA Matrix</h2>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Priority</th>
              <th className="px-4 py-2">Response target</th>
              <th className="px-4 py-2">Resolution target</th>
              <th className="px-4 py-2">On breach</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {slas.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-slate-800">{s.priority}</td>
                <td className="px-4 py-2 text-slate-600">{fmtMins(s.response_mins)}</td>
                <td className="px-4 py-2 text-slate-600">{fmtMins(s.resolution_mins)}</td>
                <td className="px-4 py-2 text-slate-600">{s.breach_action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Response = acknowledge target from creation; resolution = fix target. Breach auto-escalates.
      </p>
    </div>
  );
}

function fmtMins(m: number): string {
  if (m < 60) return `${m} min`;
  if (m < 1440) {
    const h = m / 60;
    return Number.isInteger(h) ? `${h} hr` : `${h.toFixed(1)} hr`;
  }
  const d = m / 1440;
  return Number.isInteger(d) ? `${d} days` : `${d.toFixed(1)} days`;
}
