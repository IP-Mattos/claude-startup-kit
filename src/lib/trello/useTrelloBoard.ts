// The board "brain": owns config + board state, optimistic CRUD with
// rollback, and live reconciliation. The view layer is dumb — it renders this
// state and calls these actions.
//
// Reconciliation strategy: the subscriber emits opaque change events whose
// payload shape differs from the Task DTO, so we DO NOT apply them in place.
// Any event touching the active project schedules a debounced refetch of the
// board. Optimistic local edits give instant feedback; the refetch is the
// source of truth that converges everyone.

import { useCallback, useEffect, useRef, useState } from "react";
import { IS_TAURI } from "../env";
import {
  subscribeTrelloEvents,
  toTrelloError,
  trelloClearConfig,
  trelloCompleteTask,
  trelloConfigure,
  trelloCreateTask,
  trelloDeleteTask,
  trelloListColumns,
  trelloListMembers,
  trelloListProjects,
  trelloListTasks,
  trelloLoadPersisted,
  trelloMe,
  trelloMoveTask,
  trelloPatchTask,
  trelloStartSubscriber,
  trelloStopSubscriber,
} from "./client";
import type {
  Column,
  CreateTaskPayload,
  Member,
  PatchTaskPayload,
  Profile,
  Project,
  Task,
} from "./types";

const LS_ACTIVE_PROJECT = "csk-trello-project";
const REFETCH_DEBOUNCE_MS = 600;
const MAX_TASK_PAGES = 20; // safety cap so a runaway cursor can't loop forever

export type BootState = "loading" | "unconfigured" | "ready";
export type LiveStatus = "off" | "connecting" | "live" | "error";

function genIdem(): string {
  // Fresh idempotency key per request. Duplicate user actions (e.g. a
  // double-click on complete) are prevented by the in-flight guard below, not
  // by reusing this key — so each distinct request gets its own.
  try {
    return crypto.randomUUID();
  } catch {
    return `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// Follow the cursor so the board shows every task, not just the first page.
async function fetchAllTasks(projectId: string): Promise<Task[]> {
  const all: Task[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_TASK_PAGES; i++) {
    const page = await trelloListTasks({
      project_id: projectId,
      limit: 100,
      cursor,
    });
    all.push(...page.data);
    if (!page.pagination.has_more || !page.pagination.next_cursor) break;
    cursor = page.pagination.next_cursor;
  }
  return all;
}

export interface UseTrelloBoard {
  available: boolean;
  boot: BootState;
  profile: Profile | null;
  projects: Project[];
  activeProjectId: string | null;
  columns: Column[];
  tasks: Task[];
  members: Member[];
  projectsLoading: boolean;
  boardLoading: boolean;
  live: LiveStatus;
  lagged: boolean;
  error: string | null;
  notice: string | null;
  busyTaskIds: ReadonlySet<string>;
  // actions
  configure: (apiKey: string, baseUrl?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  selectProject: (id: string) => void;
  refreshBoard: () => void;
  refreshProjects: () => void;
  dismissNotice: () => void;
  createTask: (columnId: string, title: string, extra?: Partial<CreateTaskPayload>) => Promise<void>;
  patchTask: (taskId: string, payload: PatchTaskPayload) => Promise<void>;
  moveTask: (taskId: string, toColumnId: string, position: number) => Promise<void>;
  completeTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
}

export function useTrelloBoard(): UseTrelloBoard {
  const [boot, setBoot] = useState<BootState>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LS_ACTIVE_PROJECT) || null;
    } catch {
      return null;
    }
  });
  const [columns, setColumns] = useState<Column[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [boardLoading, setBoardLoading] = useState(false);
  const [live, setLive] = useState<LiveStatus>("off");
  const [lagged, setLagged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Ref mirror so the (set-once) event handlers always see the current project
  // and don't refetch a board the user already navigated away from.
  const activeRef = useRef<string | null>(activeProjectId);
  useEffect(() => {
    activeRef.current = activeProjectId;
  }, [activeProjectId]);

  const refetchTimer = useRef<number | null>(null);
  const boardReqId = useRef(0); // guards against out-of-order board loads
  const subReqId = useRef(0); // guards against out-of-order subscriber starts
  const authFailedEpoch = useRef(-1); // sub epoch whose first poll hit auth error

  // Per-task in-flight guard so a double-click (e.g. on complete) can't fire a
  // second mutation against the real board. The ref is the race-free source of
  // truth; the state set mirrors it so the UI can disable in-flight controls.
  const inFlight = useRef<Set<string>>(new Set());
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(new Set());
  const setBusy = useCallback((id: string, busy: boolean) => {
    if (busy) inFlight.current.add(id);
    else inFlight.current.delete(id);
    setBusyTaskIds(new Set(inFlight.current));
  }, []);

  const persistActive = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(LS_ACTIVE_PROJECT, id);
      else localStorage.removeItem(LS_ACTIVE_PROJECT);
    } catch {
      /* storage locked — non-fatal */
    }
  }, []);

  const loadBoard = useCallback(async (projectId: string) => {
    const reqId = ++boardReqId.current;
    setBoardLoading(true);
    setError(null);
    try {
      const [cols, allTasks] = await Promise.all([
        trelloListColumns(projectId),
        fetchAllTasks(projectId),
      ]);
      // Drop the result if another load started after us.
      if (reqId !== boardReqId.current) return;
      setColumns([...cols].sort((a, b) => a.position - b.position));
      setTasks(allTasks);
      setLagged(false);
    } catch (e) {
      if (reqId !== boardReqId.current) return;
      setError(toTrelloError(e).message);
    } finally {
      if (reqId === boardReqId.current) setBoardLoading(false);
    }
  }, []);

  // Load the project's people roster when the active project changes. Members
  // change rarely, so this stays out of the high-frequency board refetch.
  // Non-critical: on failure we just render without faces.
  useEffect(() => {
    // Clear first so the roster + assignee faces never show the PREVIOUS
    // project's people during the fetch window of a project switch (they show
    // empty/"?" until the new project's members land — never the wrong team).
    setMembers([]);
    if (!IS_TAURI || boot !== "ready" || !activeProjectId) return;
    let cancelled = false;
    trelloListMembers(activeProjectId)
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch(() => {
        /* already cleared above — non-critical, just render without faces */
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, boot]);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      const id = activeRef.current;
      if (id) void loadBoard(id);
    }, REFETCH_DEBOUNCE_MS);
  }, [loadBoard]);

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const page = await trelloListProjects({ limit: 100 });
      setProjects(page.data);
      // Default-select the first project if none chosen or the chosen one
      // vanished.
      setActiveProjectId((cur) => {
        if (cur && page.data.some((p) => p.id === cur)) return cur;
        const next = page.data[0]?.id ?? null;
        persistActive(next);
        return next;
      });
    } catch (e) {
      setError(toTrelloError(e).message);
    } finally {
      setProjectsLoading(false);
    }
  }, [persistActive]);

  // ----- boot: re-hydrate persisted config -----
  useEffect(() => {
    if (!IS_TAURI) {
      setBoot("unconfigured");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const has = await trelloLoadPersisted();
        if (cancelled) return;
        if (!has) {
          setBoot("unconfigured");
          return;
        }
        const me = await trelloMe();
        if (cancelled) return;
        setProfile(me);
        setBoot("ready");
        void refreshProjects();
      } catch (e) {
        if (cancelled) return;
        // A persisted-but-invalid key lands here — surface and let the user
        // re-enter credentials.
        setError(toTrelloError(e).message);
        setBoot("unconfigured");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  // ----- wire live events once (handlers read refs, so deps are stable) -----
  useEffect(() => {
    if (!IS_TAURI || boot !== "ready") return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      const u = await subscribeTrelloEvents({
        onChanges: (page) => {
          const id = activeRef.current;
          if (!id) return;
          // Only react to events for the CURRENTLY watched project — a stale
          // event from a just-switched-away project must not move live/refetch.
          if (page.data.some((ev) => ev.project_id === id)) {
            setLive("live"); // a current-project event ⇒ polling is healthy
            scheduleRefetch();
          }
        },
        onLag: () => {
          setLagged(true);
          scheduleRefetch();
        },
        // onStarted is intentionally NOT handled: the epoch-guarded start
        // promise (board effect) is the authoritative source for the "live"
        // transition. Reacting to the one-shot subscriber-started event here
        // would let a stale (pre-switch) start flip the pill to a false "live".
        onAuthError: (msg) => {
          // Auth failure STOPS the poll loop and means the key is bad for every
          // project (same credential), so "error" is truthful and sticky. Latch
          // the current epoch so a start promise resolving in the same tick
          // can't overwrite this with a false "live".
          authFailedEpoch.current = subReqId.current;
          setLive("error");
          setError(msg);
        },
        onChangesError: () => {
          // Transient non-auth poll error: the backoff loop keeps retrying, so
          // the subscriber is NOT dead. Leave the pill as-is instead of flashing
          // "error" (which could get stuck on a board with no further activity).
        },
        onStorageError: () => {
          /* non-fatal: cursor persistence hiccup */
        },
      });
      if (disposed) u();
      else unlisten = u;
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [boot, scheduleRefetch]);

  // ----- load board + (re)start subscriber when the active project changes ---
  // We intentionally do NOT stop the subscriber in this effect's cleanup:
  // trello_start_subscriber already stops the prior one internally, so a
  // project switch is one ordered call. An un-awaited cleanup stop here would
  // race the next start and could silently kill the fresh subscriber (leaving
  // the UI stuck on "live" while no polling runs). Teardown is the unmount-only
  // effect below.
  useEffect(() => {
    if (!IS_TAURI || boot !== "ready" || !activeProjectId) return;
    void loadBoard(activeProjectId);
    setLive("connecting");
    // A resolved start means the poll loop is running, so flip to "live" here
    // rather than relying on the one-shot trello://subscriber-started event —
    // that event is emitted before our async listener is guaranteed registered,
    // so on a quiet board it can be missed and leave us stuck on "connecting".
    // Epoch-guard the callbacks (like boardReqId) so a stale project's start
    // resolving after a rapid switch can't overwrite the current project's
    // live/error state.
    const reqId = ++subReqId.current;
    trelloStartSubscriber([activeProjectId])
      .then(() => {
        // Only flip to "live" if this is still the current start AND this epoch
        // hasn't already hit an auth error (a key rejected on the first poll can
        // emit auth-error in the same tick the start promise resolves — without
        // this latch the .then would clobber a truthful "error" back to "live").
        if (reqId === subReqId.current && authFailedEpoch.current !== reqId) {
          setLive("live");
        }
      })
      .catch((e) => {
        if (reqId !== subReqId.current) return;
        setLive("error");
        setError(toTrelloError(e).message);
      });
  }, [activeProjectId, boot, loadBoard]);

  // ----- unmount-only teardown: stop polling + cancel any pending refetch -----
  useEffect(() => {
    return () => {
      if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
      void trelloStopSubscriber().catch(() => {});
    };
  }, []);

  // ----- actions -----

  const configure = useCallback(
    async (apiKey: string, baseUrl?: string) => {
      setError(null);
      const me = await trelloConfigure(apiKey, baseUrl?.trim() || undefined);
      setProfile(me);
      setBoot("ready");
      await refreshProjects();
    },
    [refreshProjects],
  );

  const disconnect = useCallback(async () => {
    try {
      await trelloStopSubscriber();
    } catch {
      /* ignore */
    }
    await trelloClearConfig();
    setProfile(null);
    setProjects([]);
    setColumns([]);
    setTasks([]);
    setActiveProjectId(null);
    persistActive(null);
    setLive("off");
    setError(null);
    setBoot("unconfigured");
  }, [persistActive]);

  const selectProject = useCallback(
    (id: string) => {
      setActiveProjectId(id);
      persistActive(id);
    },
    [persistActive],
  );

  const refreshBoard = useCallback(() => {
    if (activeProjectId) void loadBoard(activeProjectId);
  }, [activeProjectId, loadBoard]);

  const createTask = useCallback(
    async (columnId: string, title: string, extra?: Partial<CreateTaskPayload>) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const projectId = activeRef.current;
      if (!projectId) return;
      // Optimistic temp card at the bottom of the column.
      const tempId = `temp-${genIdem()}`;
      const maxPos = tasks
        .filter((t) => t.column_id === columnId)
        .reduce((m, t) => Math.max(m, t.position), 0);
      const optimistic: Task = {
        id: tempId,
        column_id: columnId,
        project_id: projectId,
        title: trimmed,
        details: extra?.details ?? null,
        flow: extra?.flow ?? null,
        task_date: extra?.task_date ?? null,
        progress: extra?.progress ?? 0,
        position: maxPos + 1,
        created_by: profile?.id ?? "",
        assignee_ids: extra?.assignee_ids ?? [],
        supervisor_ids: extra?.supervisor_ids ?? [],
        comment_count: 0,
        completed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setTasks((prev) => [...prev, optimistic]);
      try {
        const payload: CreateTaskPayload = {
          column_id: columnId,
          title: trimmed,
          ...extra,
        };
        const created = await trelloCreateTask(payload, genIdem());
        // Reconcile resiliently: a debounced refetch (our own or a teammate's
        // change event) may have landed between the optimistic insert and now,
        // wiping the temp card and/or already inserting the real task. Drop the
        // temp AND any existing copy of the real id, then re-add the server
        // task — so the creation is never lost and never duplicated. Render
        // order is by position, so appending is fine.
        setTasks((prev) => [
          ...prev.filter((t) => t.id !== tempId && t.id !== created.id),
          created,
        ]);
      } catch (e) {
        setTasks((prev) => prev.filter((t) => t.id !== tempId));
        setError(toTrelloError(e).message);
      }
    },
    [tasks, profile],
  );

  const patchTask = useCallback(
    async (taskId: string, payload: PatchTaskPayload) => {
      if (inFlight.current.has(taskId)) return;
      setBusy(taskId, true);
      let snapshot: Task | undefined;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          snapshot = t;
          // Optimistic merge — only the fields we actually sent. column_id is
          // included so moving via the editor dropdown jumps the card to the
          // new column immediately (parity with the drag path).
          return {
            ...t,
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.details !== undefined
              ? { details: payload.details as string | null }
              : {}),
            ...(payload.flow !== undefined ? { flow: payload.flow as string | null } : {}),
            ...(payload.task_date !== undefined
              ? { task_date: payload.task_date as string | null }
              : {}),
            ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
            ...(payload.column_id !== undefined ? { column_id: payload.column_id } : {}),
          };
        }),
      );
      try {
        const updated = await trelloPatchTask(taskId, payload, genIdem());
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
      } catch (e) {
        if (snapshot) {
          const snap = snapshot;
          setTasks((prev) => prev.map((t) => (t.id === taskId ? snap : t)));
        }
        setError(toTrelloError(e).message);
      } finally {
        setBusy(taskId, false);
      }
    },
    [setBusy],
  );

  const moveTask = useCallback(
    async (taskId: string, toColumnId: string, position: number) => {
      if (inFlight.current.has(taskId)) return;
      setBusy(taskId, true);
      let snapshot: Task | undefined;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          snapshot = t;
          return { ...t, column_id: toColumnId, position };
        }),
      );
      try {
        const updated = await trelloMoveTask(
          taskId,
          { column_id: toColumnId, position },
          genIdem(),
        );
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
      } catch (e) {
        if (snapshot) {
          const snap = snapshot;
          setTasks((prev) => prev.map((t) => (t.id === taskId ? snap : t)));
        }
        setError(toTrelloError(e).message);
      } finally {
        setBusy(taskId, false);
      }
    },
    [setBusy],
  );

  const completeTask = useCallback(
    async (taskId: string) => {
      if (inFlight.current.has(taskId)) return; // drop the double-click
      setBusy(taskId, true);
      try {
        const outcome = await trelloCompleteTask(taskId, undefined, genIdem());
        setTasks((prev) => prev.map((t) => (t.id === taskId ? outcome.task : t)));
        if (outcome.requires_supervisor_approval) {
          setNotice("requires_supervisor_approval");
        }
      } catch (e) {
        setError(toTrelloError(e).message);
      } finally {
        setBusy(taskId, false);
      }
    },
    [setBusy],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      if (inFlight.current.has(taskId)) return;
      setBusy(taskId, true);
      let snapshot: Task[] | undefined;
      setTasks((prev) => {
        snapshot = prev;
        return prev.filter((t) => t.id !== taskId);
      });
      try {
        await trelloDeleteTask(taskId, genIdem());
      } catch (e) {
        if (snapshot) setTasks(snapshot);
        setError(toTrelloError(e).message);
      } finally {
        setBusy(taskId, false);
      }
    },
    [setBusy],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    available: IS_TAURI,
    boot,
    profile,
    projects,
    activeProjectId,
    columns,
    tasks,
    members,
    projectsLoading,
    boardLoading,
    live,
    lagged,
    error,
    notice,
    busyTaskIds,
    configure,
    disconnect,
    selectProject,
    refreshBoard,
    refreshProjects,
    dismissNotice,
    createTask,
    patchTask,
    moveTask,
    completeTask,
    deleteTask,
  };
}
