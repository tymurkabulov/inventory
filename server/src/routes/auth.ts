import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  decryptSecret,
  encryptSecret,
  hashInviteCode,
  hashPassword,
  isTotpSecret,
  newToken,
  newTotpSecret,
  otpauthUrl,
  PASSWORD_MIN,
  PASSWORD_MIN_ADMIN,
  passwordProblem,
  sha256,
  verifyPassword,
  verifyTotp,
} from '../crypto.js';
import { AppError, asApi, type Client } from '../db.js';

/**
 * На HTTPS имена с префиксом `__Host-`: браузер не даст поставить такую cookie
 * с другого поддомена и без Secure. На http (локальная проверка) префикс запрещён.
 */
export const cookieNames = (secure: boolean) => ({
  session: secure ? '__Host-hz_session' : 'hz_session',
  device: secure ? '__Host-hz_device' : 'hz_device',
});

/**
 * Атрибуты cookie. Одни и те же на установку и на удаление: браузер отбросит
 * `Set-Cookie` с именем `__Host-`, если в нём нет Secure и Path=/, — и cookie
 * при выходе останется на месте.
 */
export const cookieOptions = (secure: boolean) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure,
});

const login = z.string().trim().min(3).max(32);
const password = z.string().min(PASSWORD_MIN).max(100);
const code = z.string().trim().min(4).max(16);
const totp = z.string().trim().regex(/^\d{6}$/, 'код — 6 цифр');

interface AuthRow {
  id: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
  invite_code_hash: string | null;
  invite_expires_at: Date | null;
  is_active: boolean;
  is_admin: boolean;
}

// Один и тот же текст на любую неудачу: по ответу нельзя понять, есть ли такой логин.
const BAD_LOGIN = 'неверный логин, пароль или код';
// Чтобы по времени ответа нельзя было понять, существует ли логин.
const DUMMY_HASH = await hashPassword('a-password-that-is-never-used');
const DUMMY_SECRET = newTotpSecret();

/**
 * Попыток входа одновременно с одного адреса. Лимиты в базе считают только
 * завершённые попытки: пачка параллельных запросов проходила проверку разом,
 * пока ни одна неудача ещё не записана.
 */
const PARALLEL_PER_IP = 3;

async function lookup(c: Client, name: string): Promise<AuthRow | null> {
  const { rows } = await c.query<AuthRow>('select * from horizon.auth_lookup($1)', [name]);
  return rows[0] ?? null;
}

function usable(user: AuthRow | null): user is AuthRow {
  return !!user && user.is_active;
}

export const authRoutes =
  ({ config, pool }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { session: SESSION_COOKIE, device: DEVICE_COOKIE } = cookieNames(config.secureCookies);
    const cookieBase = cookieOptions(config.secureCookies);

    /** Хеш, с которым совпал код входа, — его и сверяет база при сгорании кода. */
    function inviteHash(user: AuthRow, rawCode: string): string | null {
      if (!user.invite_code_hash || !user.invite_expires_at || user.invite_expires_at <= new Date()) return null;
      const h = hashInviteCode(rawCode, config.appSecret);
      return h === user.invite_code_hash ? h : null;
    }

    function deviceId(req: FastifyRequest, reply: FastifyReply): string {
      const existing = req.cookies[DEVICE_COOKIE];
      if (existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing)) return existing;
      const fresh = newToken();
      reply.setCookie(DEVICE_COOKIE, fresh, { ...cookieBase, maxAge: 400 * 24 * 3600 });
      return fresh;
    }

    function setSession(reply: FastifyReply, token: string) {
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: config.sessionTtlDays * 24 * 3600 });
    }

    const inflight = new Map<string, number>();
    async function oneAtATime<T>(ip: string, fn: () => Promise<T>): Promise<T> {
      const n = inflight.get(ip) ?? 0;
      if (n >= PARALLEL_PER_IP) {
        throw new AppError(429, 'слишком много попыток, подождите 1 с', 'too_many_attempts', { seconds: 1 });
      }
      inflight.set(ip, n + 1);
      try {
        return await fn();
      } finally {
        const left = (inflight.get(ip) ?? 1) - 1;
        if (left > 0) inflight.set(ip, left);
        else inflight.delete(ip);
      }
    }

    /**
     * Лимит попыток: пара «IP + логин» получает растущую задержку, IP целиком —
     * не больше 20 неудач в час. Блокировки аккаунта нет: общий лимит на логин
     * не действует на устройство, с которого человек уже входил.
     */
    async function gate(c: Client, ip: string, name: string, device: string) {
      const { rows } = await c.query<{ wait: number }>('select horizon.auth_gate($1, $2, $3, $4, $5) as wait', [
        ip,
        name,
        config.rateLimit.perIpPerHour,
        config.rateLimit.perUserPerHour,
        device,
      ]);
      const wait = Number(rows[0]?.wait ?? 0);
      if (wait > 0) {
        throw new AppError(429, `слишком много попыток, подождите ${wait} с`, 'too_many_attempts', { seconds: wait });
      }
    }

    const noteFail = (c: Client, ip: string, name: string) =>
      c.query('select horizon.auth_note_fail($1, $2)', [ip, name]);
    const noteSuccess = (c: Client, ip: string, name: string) =>
      c.query('select horizon.auth_note_success($1, $2)', [ip, name]);

    // Проверка кода до экрана пароля: ошибка видна сразу, а не после настройки приложения.
    // Ошибка должна закоммитить попытку — поэтому 401 кидаем вне транзакции.
    app.post('/code', async (req, reply) => {
      const body = z.object({ login, code }).parse(req.body);
      const device = deviceId(req, reply);
      const ok = await oneAtATime(req.ip, () =>
        asApi(pool, async (c) => {
          await gate(c, req.ip, body.login, device);
          const user = await lookup(c, body.login);
          if (usable(user) && inviteHash(user, body.code)) {
            await noteSuccess(c, req.ip, body.login);
            return true;
          }
          await noteFail(c, req.ip, body.login);
          return false;
        }),
      );
      if (!ok) throw new AppError(401, BAD_LOGIN, 'bad_login');
      return { ok: true };
    });

    // Секрет для приложения. Он ещё ничей: пока человек не подтвердит его кодом
    // в /setup, в базу ничего не пишется.
    app.post('/totp-secret', async (req, reply) => {
      const body = z.object({ login, code }).parse(req.body);
      const device = deviceId(req, reply);
      const ok = await oneAtATime(req.ip, () =>
        asApi(pool, async (c) => {
          await gate(c, req.ip, body.login, device);
          const user = await lookup(c, body.login);
          if (usable(user) && inviteHash(user, body.code)) return true;
          await noteFail(c, req.ip, body.login);
          return false;
        }),
      );
      if (!ok) throw new AppError(401, BAD_LOGIN, 'bad_login');
      const secret = newTotpSecret();
      return { secret, otpauth: otpauthUrl(secret, body.login.trim()) };
    });

    // Первый вход и вход после сброса: код сгорает, пароль и приложение привязываются.
    app.post('/setup', async (req, reply) => {
      const body = z
        .object({ login, code, password, secret: z.string().refine(isTotpSecret, 'секрет повреждён'), totp })
        .parse(req.body);

      const device = deviceId(req, reply);
      const token = newToken();

      await oneAtATime(req.ip, async () => {
        // 1. Лимиты и код — короткая транзакция. Неудача коммитится вместе с ней.
        const found = await asApi(pool, async (c) => {
          await gate(c, req.ip, body.login, device);
          const user = await lookup(c, body.login);
          const matched = usable(user) ? inviteHash(user, body.code) : null;
          if (!user || !matched) {
            await noteFail(c, req.ip, body.login);
            return null;
          }
          return { user, matched };
        });
        if (!found) throw new AppError(401, BAD_LOGIN, 'bad_login');
        const { user, matched } = found;

        // Правила к паролю проверяем после кода: так подсказки видит только свой.
        const weak = passwordProblem(body.password, body.login, user.is_admin);
        if (weak === 'short') {
          const min = user.is_admin ? PASSWORD_MIN_ADMIN : PASSWORD_MIN;
          throw new AppError(422, `пароль: минимум ${min} символов`, 'password_short', { min });
        }
        if (weak === 'weak') throw new AppError(422, 'пароль слишком простой', 'password_weak');
        // Неверный код из приложения — это попытка, и запись о ней должна дожить до коммита.
        if (verifyTotp(body.secret, body.totp) === null) {
          await asApi(pool, (c) => noteFail(c, req.ip, body.login));
          throw new AppError(401, 'неверный код из приложения', 'bad_totp');
        }

        // 2. scrypt — без соединения с базой: пул не должен ждать процессор.
        const passwordHash = await hashPassword(body.password);

        // 3. Код сгорает атомарно: база ещё раз сверяет хеш и срок.
        await asApi(pool, async (c) => {
          await c.query('select horizon.auth_complete_invite($1, $2, $3, $4, $5, $6, $7, $8)', [
            user.id,
            matched,
            passwordHash,
            encryptSecret(body.secret, config.appSecret),
            sha256(token),
            device,
            req.headers['user-agent'] ?? '',
            config.sessionTtlDays,
          ]);
          await noteSuccess(c, req.ip, body.login);
        });
      });

      setSession(reply, token);
      return { ok: true };
    });

    // Обычный вход: логин, пароль и код из приложения — одним шагом.
    app.post('/login', async (req, reply) => {
      const body = z.object({ login, password, totp }).parse(req.body);
      const device = deviceId(req, reply);
      const token = newToken();

      const ok = await oneAtATime(req.ip, async () => {
        // 1. Лимиты и поиск — короткая транзакция.
        const user = await asApi(pool, async (c) => {
          await gate(c, req.ip, body.login, device);
          return lookup(c, body.login);
        });

        // 2. Пароль и код — без соединения с базой: scrypt занимает ~100 мс
        //    процессора, и держать на это время соединение из пула нельзя.
        //    Несуществующий и ненастроенный логин проходят тот же путь по времени,
        //    что и настоящий: иначе по ответу собирают список логинов.
        const real = usable(user) && !!user.password_hash && !!user.totp_secret;
        let step: number | null = null;
        if (!real) {
          await verifyPassword(body.password, DUMMY_HASH);
          verifyTotp(DUMMY_SECRET, body.totp);
        } else {
          const passwordOk = await verifyPassword(body.password, user.password_hash);
          const secret = decryptSecret(user.totp_secret!, config.appSecret);
          if (!secret) throw new AppError(500, 'секрет приложения не читается', 'internal');
          step = passwordOk ? verifyTotp(secret, body.totp) : null;
        }

        // 3. Итог — вторая короткая транзакция.
        return asApi(pool, async (c) => {
          if (real && step !== null) {
            // Тот же код второй раз не пройдёт — даже если его подсмотрели.
            const { rows } = await c.query<{ ok: boolean }>('select horizon.auth_totp_consume($1, $2) as ok', [
              user!.id,
              step,
            ]);
            if (rows[0]?.ok) {
              await c.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [
                user!.id,
                sha256(token),
                device,
                req.headers['user-agent'] ?? '',
                config.sessionTtlDays,
              ]);
              await noteSuccess(c, req.ip, body.login);
              return true;
            }
          }
          await noteFail(c, req.ip, body.login);
          return false;
        });
      });

      if (!ok) throw new AppError(401, BAD_LOGIN, 'bad_login');
      setSession(reply, token);
      return { ok: true };
    });

    app.post('/logout', async (req, reply) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (raw) {
        await asApi(pool, (c) => c.query('select horizon.auth_session_revoke($1)', [sha256(raw)]));
      }
      reply.clearCookie(SESSION_COOKIE, cookieBase);
      return { ok: true };
    });
  };
