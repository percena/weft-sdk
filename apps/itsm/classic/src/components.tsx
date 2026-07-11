import type { ReactNode } from "react";
import type { ChangeStatus, IncidentStatus, Priority } from "./api";

// ─── color maps ─────────────────────────────────────────────────────────────
const INCIDENT_STATUS: Record<IncidentStatus, string> = {
  new: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  pending_user: "bg-violet-100 text-violet-700",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-slate-200 text-slate-600",
  escalated: "bg-red-100 text-red-700",
};

const CHANGE_STATUS: Record<ChangeStatus, string> = {
  draft: "bg-slate-200 text-slate-600",
  submitted: "bg-blue-100 text-blue-700",
  cab_approved: "bg-violet-100 text-violet-700",
  scheduled: "bg-indigo-100 text-indigo-700",
  implementing: "bg-amber-100 text-amber-700",
  implemented: "bg-green-100 text-green-700",
  closed: "bg-slate-200 text-slate-600",
  rejected: "bg-red-100 text-red-700",
  rolled_back: "bg-orange-100 text-orange-700",
};

const PRIORITY: Record<Priority, string> = {
  P1: "bg-red-600 text-white",
  P2: "bg-orange-500 text-white",
  P3: "bg-amber-400 text-amber-900",
  P4: "bg-slate-300 text-slate-700",
};

const badge = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

export function StatusBadge({
  status,
  kind,
}: {
  status: IncidentStatus | ChangeStatus;
  kind: "incident" | "change";
}) {
  const map = kind === "incident" ? INCIDENT_STATUS : CHANGE_STATUS;
  const cls = map[status as keyof typeof map] ?? "bg-slate-100 text-slate-600";
  return <span className={`${badge} ${cls}`}>{status}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`${badge} ${PRIORITY[priority]}`}>{priority}</span>;
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className={`${badge} bg-slate-100 text-slate-600`}>{children}</span>
  );
}

// ─── layout bits ────────────────────────────────────────────────────────────
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-slate-500">
      <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" role="img" aria-label="Loading">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-400";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-lg border border-slate-200 bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <button type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto scroll-thin p-4">{children}</div>
      </div>
    </div>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  variant = "default",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "danger";
  type?: "button" | "submit";
  title?: string;
}) {
  const base =
    "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-slate-800 text-white hover:bg-slate-700"
      : variant === "danger"
        ? "border border-red-300 bg-white text-red-700 hover:bg-red-50"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function fmtDateTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
