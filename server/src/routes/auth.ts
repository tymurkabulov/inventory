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
  locked_until: Date | null;
  is_admin: boolean;
}

// Один и тот же текст на любую неудачу: по ответу нельзя понять, есть ли такой логин.
const BAD_LOGIN = 'неверный логин, пароль или код';
// Чтобы по времени ответа нельзя было понять, существует ли логин.
const DUMMY_HASH = await hashPassword('a-password-that-is-never-used');
const DUMMY_SECRET = newTotpSecret();

async function lookup(c: Client, name: string): Promise<AuthRow | null> {
  const { rows } = await c.query<AuthRow>('select * from horizon.auth_lookup($1)', [name]);
  return rows[0] ?? null;
}

function usable(user: AuthRow | null): user is AuthRow {
  if (!user || !user.is_active) return false;
  return !(user.locked_until && user.locked_until > new Date());
}

function inviteMatches(user: AuthRow, rawCode: string): boolean {
  return (
    user.invite_code_hash !== null &&
    user.invite_code_hash === hashInviteCode(rawCode) &&
    user.invite_expires_at !== null &&
    user.invite_expires_at > new Date()
  );
}

export const authRoutes =
  ({ config, pool }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { session: SESSION_COOKIE, device: DEVICE_COOKIE } = cookieNames(config.secureCookies);
    const cookieBase = {
      path: '/',
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: config.secureCookies,
    };

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

    /**
     * Лимит попыток: пара «IP + логин» получает растущую задержку, IP целиком —
     * не больше 20 неудач в час. Блокировки аккаунта нет: ею можно было пользоваться
     * против своих же людей.
     */
    async function gate(c: Client, ip: string, name: string) {
      const { rows } = await c.query<{ wait: number }>('select horizon.auth_gate($1, $2, $3, $4) as wait', [
        ip,
        name,
        config.rateLimit.perIpPerHour,
        config.rateLimit.perUserPerHour,
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
    app.post('/code', async (req) => {
      const body = z.object({ login, code }).parse(req.body);
      const ok = await asApi(pool, async (c) => {
        await gate(c, req.ip, body.login);
        const user = await lookup(c, body.login);
        if (usable(user) && inviteMatches(user, body.code)) {
          await noteSuccess(c, req.ip, body.login);
          return true;
        }
        if (user) await c.query('select horizon.auth_fail($1)', [user.id]);
        await noteFail(c, req.ip, body.login);
        return false;
      });
      if (!ok) throw new AppError(401, BAD_LOGIN, 'bad_login');
      return { ok: true };
    });

    // Секрет для приложения. Он ещё ничей: пока человек не подтвердит его кодом
    // в /setup, в базу ничего не пишется.
    app.post('/totp-secret', async (req) => {
      const body = z.object({ login, code }).parse(req.body);
      const ok = await asApi(pool, async (c) => {
        await gate(c, req.ip, body.login);
        const user = await lookup(c, body.login);
        if (usable(user) && inviteMatches(user, body.code)) return true;
        await noteFail(c, req.ip, body.login);
        return false;
      });
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

      const result = await asApi(pool, async (c) => {
        await gate(c, req.ip, body.login);
        const user = await lookup(c, body.login);
        if (!usable(user) || !inviteMatches(user, body.code)) {
          if (user) await c.query('select horizon.auth_fail($1)', [user.id]);
          await noteFail(c, req.ip, body.login);
          return { kind: 'fail' as const };
        }

        // Правила к паролю проверяем после кода: так подсказки видит только свой.
        const weak = passwordProblem(body.password, body.login, user.is_admin);
        if (weak === 'short') {
          const min = user.is_admin ? PASSWORD_MIN_ADMIN : PASSWORD_MIN;
          throw new AppError(422, `пароль: минимум ${min} символов`, 'password_short', { min });
        }
        if (weak === 'weak') throw new AppError(422, 'пароль слишком простой', 'password_weak');
        if (verifyTotp(body.secret, body.totp) === null) {
          await noteFail(c, req.ip, body.login);
          throw new AppError(401, 'неверный код из приложения', 'bad_totp');
        }

        await c.query('select horizon.auth_complete_invite($1, $2, $3, $4, $5, $6, $7, $8)', [
          user.id,
          hashInviteCode(body.code),
          await hashPassword(body.password),
          encryptSecret(body.secret, config.appSecret),
          sha256(token),
          device,
          req.headers['user-agent'] ?? '',
          config.sessionTtlDays,
        ]);
        await noteSuccess(c, req.ip, body.login);
        return { kind: 'ok' as const };
      });

      if (result.kind === 'fail') throw new AppError(401, BAD_LOGIN, 'bad_login');
      setSession(reply, token);
      return { ok: true };
    });

    // Обычный вход: позывной, пароль и код из приложения — одним шагом.
    app.post('/login', async (req, reply) => {
      const body = z.object({ login, password, totp }).parse(req.body);
      const device = deviceId(req, reply);
      const token = newToken();

      const result = await asApi(pool, async (c) => {
        await gate(c, req.ip, body.login);
        const user = await lookup(c, body.login);

        // Несуществующий и ненастроенный логин проходят тот же путь по времени,
        // что и настоящий: иначе по ответу собирают список логинов.
        if (!usable(user) || !user.password_hash || !user.totp_secret) {
          await verifyPassword(body.password, DUMMY_HASH);
          verifyTotp(DUMMY_SECRET, body.totp);
          await noteFail(c, req.ip, body.login);
          return { kind: 'fail' as const };
        }

        const passwordOk = await verifyPassword(body.password, user.password_hash);
        const secret = decryptSecret(user.totp_secret, config.appSecret);
        if (!secret) throw new AppError(500, 'секрет приложения не читается', 'internal');
        const step = passwordOk ? verifyTotp(secret, body.totp) : null;

        // Тот же код второй раз не пройдёт — даже если его подсмотрели.
        const consumed =
          step === null
            ? false
            : ((await c.query<{ ok: boolean }>('select horizon.auth_totp_consume($1, $2) as ok', [user.id, step]))
                .rows[0]?.ok ?? false);

        if (!passwordOk || !consumed) {
          await c.query('select horizon.auth_fail($1)', [user.id]);
          await noteFail(c, req.ip, body.login);
          return { kind: 'fail' as const };
        }

        await c.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [
          user.id,
          sha256(token),
          device,
          req.headers['user-agent'] ?? '',
          config.sessionTtlDays,
        ]);
        await noteSuccess(c, req.ip, body.login);
        return { kind: 'session' as const };
      });

      if (result.kind === 'fail') throw new AppError(401, BAD_LOGIN, 'bad_login');
      setSession(reply, token);
      return { ok: true };
    });

    app.post('/logout', async (req, reply) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (raw) {
        await asApi(pool, (c) => c.query('select horizon.auth_session_revoke($1)', [sha256(raw)]));
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });
  };
