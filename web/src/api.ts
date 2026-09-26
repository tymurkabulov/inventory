export type Status = 'red' | 'yellow' | 'green';
export type Condition = 'ok' | 'repair' | 'broken';

export interface Me {
  id: string;
  login: string;
  callsign: string;
  locale: string | null;
  admin: { full: boolean; position_ids: string[] };
  assignment: { position_id: string; name: string; date_from: string } | null;
}

export interface Item {
  id: string;
  position_id: string;
  name: string;
  category: string;
  unit: string;
  qty: number;
  min_qty: number;
  acceptable_qty: number;
  ideal_qty: number;
  condition: Condition;
  comment: string;
  stock_rank: 0 | 1 | 2;
  status: Status;
  full_stock: boolean;
  stale: boolean;
  updated_at: string;
  updated_by_callsign: string | null;
}

export interface Board {
  position: { id: string; name: string; is_active: boolean; stale_after_hours: number };
  people: Array<{ id: string; callsign: string; date_from: string }>;
  items: Item[];
  counts: { red: number; yellow: number; green: number; stale: number; full: number };
}

export interface Movement {
  id: number;
  qty_before: number | null;
  qty_after: number;
  delta: number;
  reason: string;
  created_at: string;
  created_by_callsign: string | null;
}

export interface Tile {
  id: string;
  name: string;
  is_active: boolean;
  stale_after_hours: number;
  people: number;
  red: number;
  yellow: number;
  green: number;
  last_update: string | null;
  stale: boolean;
}

export interface Overview {
  tiles: Tile[];
  red: Array<{
    id: string;
    name: string;
    unit: string;
    qty: number;
    min_qty: number;
    updated_at: string;
    position_id: string;
    position_name: string;
  }>;
}

export interface Person {
  id: string;
  /** Админу зоны — только у тех, кого он завёл сам. */
  login: string | null;
  callsign: string;
  is_active: boolean;
  /** Пароль заведён: PIN-а нет с миграции 006, сервер отдаёт has_password. */
  has_password: boolean;
  invite_pending: boolean;
  is_full_admin: boolean;
  admin_position_ids: string[];
  position_id: string | null;
  position_name: string | null;
  date_from: string | null;
  sessions: number;
  last_seen_at: string | null;
}

export interface PositionRow {
  id: string;
  name: string;
  is_active: boolean;
  stale_after_hours: number;
}

export interface HistoryRow {
  id: string;
  position_id: string;
  position_name: string;
  date_from: string;
  date_to: string | null;
  assigned_by: string | null;
  closed_by: string | null;
}

/** Ошибка API. Текст для человека — errorText() из i18n по code/params. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public params?: Record<string, string | number>,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/**
 * Запрос обязан закончиться. На мобильной связи бывает, что соединение есть, а
 * пакеты не ходят: fetch тогда не отклонится никогда, и экран остаётся со
 * спиннером без единой кнопки.
 */
const TIMEOUT_MS = 15_000;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // AbortSignal.timeout и AbortSignal.any есть не на всех телефонах, с которых
  // это открывают, поэтому таймаут и отмену сводим руками в один контроллер.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  const cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel, { once: true });

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      signal: ctrl.signal,
      headers: {
        'x-horizon': '1',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Запрос сняли снаружи (ушли с экрана) — это не сбой связи, пробрасываем как есть.
    if (signal?.aborted) throw err;
    if (timedOut) throw new ApiError(0, 'timeout', 'timeout');
    throw new ApiError(0, 'network error', 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    const e = data as { error?: string; code?: string; params?: Record<string, string | number> };
    throw new ApiError(res.status, e.error ?? `HTTP ${res.status}`, e.code, e.params);
  }
  return data as T;
}

export const api = {
  /** signal приходит от react-query: уход с экрана снимает запрос. */
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T = { ok: true }>(path: string, body: unknown = {}) => request<T>('POST', path, body),
};

/** Та же формула, что horizon.status() в БД — для оптимистичного UI. */
export function statusOf(qty: number, min: number, acceptable: number): Status {
  if (qty < min) return 'red';
  if (qty < acceptable) return 'yellow';
  return 'green';
}

export const RANK: Record<Status, 0 | 1 | 2> = { red: 0, yellow: 1, green: 2 };

export function sortItems(items: Item[]): Item[] {
  return [...items].sort(
    (a, b) => a.stock_rank - b.stock_rank || a.name.localeCompare(b.name, 'uk', { sensitivity: 'base' }),
  );
}
