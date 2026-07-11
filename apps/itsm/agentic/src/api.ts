import { useEffect, useRef } from "react";

// ─── enums ──────────────────────────────────────────────────────────────────
export type Role = "requester" | "agent" | "manager";
export type Priority = "P1" | "P2" | "P3" | "P4";
export type IncidentStatus =
  | "new" | "in_progress" | "pending_user" | "resolved" | "closed" | "escalated";
export type IncidentCategory =
  | "hardware" | "software" | "network" | "security" | "performance";
export type ChangeStatus =
  | "draft" | "submitted" | "cab_approved" | "scheduled"
  | "implementing" | "implemented" | "closed" | "rejected" | "rolled_back";
export type ChangeType = "normal" | "emergency";
export type ChangeRisk = "low" | "medium" | "high";
export type CiType = "server" | "service" | "application" | "database" | "network" | "storage";
export type CiStatus = "in_service" | "maintenance" | "retired";

// ─── record shapes ──────────────────────────────────────────────────────────
export interface User {
  id: string;
  username: string;
  role: Role;
  on_call_for: string[];
}
export interface SLA {
  id: string;
  priority: Priority;
  response_mins: number;
  resolution_mins: number;
  breach_action: string;
}
export interface CI {
  id: string;
  name: string;
  type: CiType;
  owner: string;
  status: CiStatus;
  depends_on: string[];
  runs_on: string[];
  created_at: string;
}
export interface Comment {
  id: string;
  author: string;
  body: string;
  at: string;
}
export interface HistoryEntry {
  action: string;
  from_status: string | null;
  to_status: string;
  at: string;
  actor: string;
}
export interface Incident {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: IncidentStatus;
  category: IncidentCategory;
  assignee: string | null;
  requester: string;
  affected_ci: string | null;
  linked_cis: string[];
  linked_changes: string[];
  comments: Comment[];
  resolution_note: string | null;
  sla_id: string | null;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
  allowed_actions: string[];
}
export interface Change {
  id: string;
  title: string;
  description: string;
  type: ChangeType;
  risk: ChangeRisk;
  status: ChangeStatus;
  requester: string;
  implementer: string | null;
  affected_cis: string[];
  linked_incidents: string[];
  change_window: string | null;
  rollback_plan: string | null;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
  allowed_actions: string[];
}
export interface ItsMEvent {
  id: string;
  ts: string;
  actor: string;
  action: string;
  data: Record<string, unknown>;
}

// ─── request body types ─────────────────────────────────────────────────────
export interface CreateIncidentBody {
  title: string;
  description?: string;
  priority: Priority;
  category: IncidentCategory;
  affected_ci?: string | null;
}
export interface CreateChangeBody {
  title: string;
  description?: string;
  type?: ChangeType;
  risk?: ChangeRisk;
  affected_cis?: string[];
  rollback_plan?: string | null;
}

// ─── error ──────────────────────────────────────────────────────────────────
export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.extra = extra;
  }
}

// ─── core fetch helper ──────────────────────────────────────────────────────
interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    signal: opts.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const obj = (data ?? {}) as Record<string, unknown>;
    const message = typeof obj.error === "string" ? obj.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, obj);
  }
  return (data ?? null) as T;
}

function withQuery(base: string, params?: Record<string, string | undefined>): string {
  if (!params) return base;
  const sp = new URLSearchParams();
  let has = false;
  for (const [k, v] of Object.entries(params)) {
    if (v) {
      sp.set(k, v);
      has = true;
    }
  }
  return has ? `${base}?${sp.toString()}` : base;
}

// transition action (assign/resolve/…) → URL segment (request_info→request-info)
function actionSegment(action: string): string {
  return action.replace(/_/g, "-");
}

// ─── api object ─────────────────────────────────────────────────────────────
export const api = {
  auth: {
    me: () => request<User>("/api/auth/me"),
    login: (username: string) =>
      request<{ id: string; username: string; role: Role }>("/api/auth/login", {
        method: "POST",
        body: { username },
      }),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  },
  incidents: {
    list: (params?: { status?: string; assignee?: string }) =>
      request<Incident[]>(withQuery("/api/incidents", params)),
    get: (id: string) => request<Incident>(`/api/incidents/${id}`),
    create: (body: CreateIncidentBody) =>
      request<Incident>("/api/incidents", { method: "POST", body }),
    /** Transition action (assign/escalate/resolve/close/reopen/request_info/provide_info). */
    action: (id: string, action: string, body: Record<string, unknown> = {}) =>
      request<Incident>(`/api/incidents/${id}/${actionSegment(action)}`, {
        method: "POST",
        body,
      }),
    comment: (id: string, body: string) =>
      request<Incident>(`/api/incidents/${id}/comments`, { method: "POST", body: { body } }),
    priority: (id: string, priority: Priority) =>
      request<Incident>(`/api/incidents/${id}/priority`, { method: "POST", body: { priority } }),
    linkCi: (id: string, ci_id: string) =>
      request<Incident>(`/api/incidents/${id}/link/ci`, { method: "POST", body: { ci_id } }),
    linkChange: (id: string, change_id: string) =>
      request<Incident>(`/api/incidents/${id}/link/change`, { method: "POST", body: { change_id } }),
  },
  changes: {
    list: (params?: { status?: string }) =>
      request<Change[]>(withQuery("/api/changes", params)),
    get: (id: string) => request<Change>(`/api/changes/${id}`),
    create: (body: CreateChangeBody) =>
      request<Change>("/api/changes", { method: "POST", body }),
    /** Transition action (submit/approve/reject/schedule/implement/complete/rollback/close). */
    action: (id: string, action: string, body: Record<string, unknown> = {}) =>
      request<Change>(`/api/changes/${id}/${actionSegment(action)}`, {
        method: "POST",
        body,
      }),
    linkCi: (id: string, ci_id: string) =>
      request<Change>(`/api/changes/${id}/link/ci`, { method: "POST", body: { ci_id } }),
    linkIncident: (id: string, incident_id: string) =>
      request<Change>(`/api/changes/${id}/link/incident`, {
        method: "POST",
        body: { incident_id },
      }),
  },
  cis: {
    list: () => request<CI[]>("/api/cis"),
    get: (id: string) => request<CI>(`/api/cis/${id}`),
    dependents: (id: string) => request<CI[]>(`/api/cis/${id}/dependents`),
  },
  slas: {
    list: () => request<SLA[]>("/api/slas"),
  },
  users: {
    list: () => request<User[]>("/api/users"),
  },
  state: {
    get: () =>
      request<{ users: number; cis: number; slas: SLA[]; incidents: Incident[]; changes: Change[] }>(
        "/api/state",
      ),
  },
};

// ─── SSE hook ───────────────────────────────────────────────────────────────
export function useEventSource(onEvent: (e: ItsMEvent) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const es = new EventSource("/api/events");
    const handler = (ev: MessageEvent) => {
      try {
        ref.current(JSON.parse(ev.data) as ItsMEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener("itsm.event", handler as EventListener);
    return () => {
      es.removeEventListener("itsm.event", handler as EventListener);
      es.close();
    };
  }, []);
}
