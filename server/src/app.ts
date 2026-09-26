import { timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { newToken, sha256 } from './crypto.js';
import { AppError, asApi, type Pool, toAppError } from './db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes, cookieNames, cookieOptions } from './routes/auth.js';
import { boardRoutes } from './routes/board.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

export interface AppDeps {
  config: Config;
  pool: Pool;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Доверяем только своему nginx (по умолчанию один прыжок): иначе клиент подделает
    // X-Forwarded-For и обойдёт лимиты попыток.
    trustProxy: (_addr: string, hop: number) => hop < deps.config.trustProxyHops,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  app.decorateRequest('userId', null);

  /**
   * Наблюдение за одним VPS без Prometheus: копим отметки времени за час и
   * отдаём в /api/health признак degraded. Внешний пингер ругается по нему,
   * и больше ничего ставить на сервер не нужно.
   */
  const HOUR = 3600_000;
  const THROTTLED_LIMIT = 10;
  const recent = { errors: [] as number[], throttled: [] as number[] };
  const note = (marks: number[]) => {
    if (marks.length < 1000) marks.push(Date.now()); // выше порога считать уже незачем
  };
  const lastHour = (marks: number[]) => {
    const from = Date.now() - HOUR;
    while (marks.length > 0 && marks[0]! < from) marks.shift();
    return marks.length;
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      const field = first ? first.path.join('.') : '';
      return reply
        .status(422)
        .send({ error: first ? `${field}: ${first.message}` : 'неверные данные', code: 'validation', params: { field } });
    }
    const appErr = toAppError(err);
    if (appErr) {
      if (appErr.status === 429) note(recent.throttled);
      return reply.status(appErr.status).send({ error: appErr.message, code: appErr.code, params: appErr.params });
    }
    // Ошибки самого Fastify (битый JSON, не тот content-type): статус наружу,
    // текст — только в лог, в нём бывают подробности разбора запроса.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      req.log.warn({ err }, 'bad request');
      return reply.status(status).send({ error: 'неверный запрос', code: 'bad_request' });
    }
    req.log.error(err);
    note(recent.errors);
    return reply.status(500).send({ error: 'внутренняя ошибка', code: 'internal' });
  });

  // CSRF: браузер не пошлёт кастомный заголовок кросс-доменно без CORS, а CORS мы не включаем.
  app.addHook('onRequest', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-horizon'] !== '1') {
      throw new AppError(403, 'нет заголовка X-Horizon', 'csrf');
    }
  });

  const { session: SESSION_COOKIE, device: DEVICE_COOKIE } = cookieNames(deps.config.secureCookies);

  /**
   * Частота запросов на человека. Считаем по нему, а не по адресу: за общим
   * прокси адрес один на всех, а пул соединений маленький, и один клиент в цикле
   * выбирает его целиком. Счётчик живёт в этом экземпляре приложения — процесс
   * один, а лишняя таблица в базе стоила бы записи на каждый запрос.
   */
  const seen = new Map<string, { until: number; hits: number }>();
  const tooFast = (userId: string): boolean => {
    const now = Date.now();
    const slot = seen.get(userId);
    if (!slot || slot.until <= now) {
      seen.set(userId, { until: now + 60_000, hits: 1 });
      return false;
    }
    slot.hits++;
    return slot.hits > deps.config.ratePerUserPerMinute;
  };

  // Сессия действует только с того устройства, где её открыли, и раз в сутки меняет токен.
  // Всплывший старый токен — признак кражи: БД гасит все сессии человека.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/') || path === '/api/health') return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new AppError(401, 'войдите', 'login_required');
    const fresh = newToken();
    const { rows } = await asApi(deps.pool, (c) =>
      c.query<{ user_id: string | null; rotated: boolean }>(
        'select * from horizon.auth_session_touch($1, $2, $3, $4)',
        [sha256(token), req.cookies[DEVICE_COOKIE] ?? '', sha256(fresh), deps.config.sessionRotateHours],
      ),
    );
    const session = rows[0];
    if (!session?.user_id) throw new AppError(401, 'сессия закрыта — войдите заново', 'session_closed');
    if (session.rotated) {
      reply.setCookie(SESSION_COOKIE, fresh, {
        ...cookieOptions(deps.config.secureCookies),
        maxAge: deps.config.sessionTtlDays * 24 * 3600,
      });
    }
    if (tooFast(session.user_id)) {
      throw new AppError(429, 'слишком много запросов, подождите минуту', 'too_many_requests');
    }
    req.userId = session.user_id;
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // Открыт наружу: наружу и уходит только «жив» и «есть ли беда за последний час».
  // По этим двум словам внешний пингер поймёт всё, что ему положено, а версию
  // схемы и счётчики видит только тот, у кого есть OPS_TOKEN.
  app.get('/api/health', async (req) => {
    await deps.pool.query('select 1');
    const errors = lastHour(recent.errors);
    const throttled = lastHour(recent.throttled);
    const body: Record<string, unknown> = { ok: true, degraded: errors > 0 || throttled > THROTTLED_LIMIT };

    if (deps.config.opsToken && sameSecret(req.headers['x-horizon-ops'], deps.config.opsToken)) {
      const { rows } = await deps.pool.query<{ last: string | null; n: number }>(
        'select max(name) as last, count(*)::int as n from public.horizon_migrations',
      );
      Object.assign(body, { migrations: rows[0]?.n ?? 0, schema: rows[0]?.last ?? null, errors, throttled });
    }
    return body;
  });

  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(boardRoutes(deps), { prefix: '/api' });
  await app.register(adminRoutes(deps), { prefix: '/api/admin' });

  // Раз в час выметаем протухшие сессии и счётчики попыток. Раньше это делал
  // отдельный воркер — вместе с очередью бота он больше не нужен.
  const cleanup = setInterval(() => {
    deps.pool.query('select horizon.cleanup()').catch((err) => app.log.error({ err }, 'cleanup failed'));
    const now = Date.now();
    for (const [id, slot] of seen) if (slot.until <= now) seen.delete(id);
  }, 3600_000);
  cleanup.unref();
  app.addHook('onClose', async () => clearInterval(cleanup));

  return app;
}

/** Сравнение пропуска без утечки по времени: сравниваем хеши одинаковой длины. */
function sameSecret(sent: string | string[] | undefined, expected: string): boolean {
  if (typeof sent !== 'string') return false;
  return timingSafeEqual(Buffer.from(sha256(sent), 'hex'), Buffer.from(sha256(expected), 'hex'));
}

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw new AppError(401, 'войдите', 'login_required');
  return req.userId;
}

export type Reply = FastifyReply;
