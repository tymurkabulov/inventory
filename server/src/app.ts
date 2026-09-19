import cookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { newToken, sha256 } from './crypto.js';
import { AppError, asApi, type Pool, toAppError } from './db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes, cookieNames } from './routes/auth.js';
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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      const field = first ? first.path.join('.') : '';
      return reply
        .status(422)
        .send({ error: first ? `${field}: ${first.message}` : 'неверные данные', code: 'validation', params: { field } });
    }
    const appErr = toAppError(err);
    if (appErr) return reply.status(appErr.status).send({ error: appErr.message, code: appErr.code, params: appErr.params });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: 'bad_request' });
    req.log.error(err);
    return reply.status(500).send({ error: 'внутренняя ошибка', code: 'internal' });
  });

  // CSRF: браузер не пошлёт кастомный заголовок кросс-доменно без CORS, а CORS мы не включаем.
  app.addHook('onRequest', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-horizon'] !== '1') {
      throw new AppError(403, 'нет заголовка X-Horizon', 'csrf');
    }
  });

  const { session: SESSION_COOKIE, device: DEVICE_COOKIE } = cookieNames(deps.config.secureCookies);

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
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: deps.config.secureCookies,
        maxAge: deps.config.sessionTtlDays * 24 * 3600,
      });
    }
    req.userId = session.user_id;
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/health', async () => {
    await deps.pool.query('select 1');
    return { ok: true };
  });

  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(boardRoutes(deps), { prefix: '/api' });
  await app.register(adminRoutes(deps), { prefix: '/api/admin' });

  // Раз в час выметаем протухшие сессии и счётчики попыток. Раньше это делал
  // отдельный воркер — вместе с очередью бота он больше не нужен.
  const cleanup = setInterval(() => {
    deps.pool.query('select horizon.worker_cleanup()').catch((err) => app.log.error({ err }, 'cleanup failed'));
  }, 3600_000);
  cleanup.unref();
  app.addHook('onClose', async () => clearInterval(cleanup));

  return app;
}

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw new AppError(401, 'войдите', 'login_required');
  return req.userId;
}

export type Reply = FastifyReply;
