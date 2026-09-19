function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`env ${name} is required`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) throw new Error(`env ${name} must be an integer`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

import { FALLBACK_LOCALE, isLocale, type Locale, LOCALES } from './i18n.js';

export function loadConfig() {
  return {
    /** API: логин horizon_api (без прав на таблицы, только SET ROLE horizon_user). */
    databaseUrl: str('DATABASE_URL', 'postgres://horizon_api:horizon_api@localhost:5432/horizon'),
    /** Миграции и CLI: владелец схемы. */
    databaseAdminUrl: str('DATABASE_ADMIN_URL', 'postgres://postgres:postgres@localhost:5432/horizon'),
    apiPassword: process.env.HORIZON_API_DB_PASSWORD ?? '',
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    secureCookies: bool('SECURE_COOKIES', process.env.NODE_ENV === 'production'),
    /**
     * Сколько прокси перед API. 1 — только nginx из compose: адрес берётся из последней
     * записи X-Forwarded-For, которую дописал он сам, а подделанные клиентом игнорируются.
     */
    trustProxyHops: int('TRUST_PROXY_HOPS', 1),
    sessionTtlDays: int('SESSION_TTL_DAYS', 30),
    /** Раз в сколько часов меняется токен сессии (кража старого токена гасит все сессии). */
    sessionRotateHours: int('SESSION_ROTATE_HOURS', 24),
    rateLimit: {
      /** Неудачных попыток входа с одного IP в час. */
      perIpPerHour: int('LOGIN_FAILS_PER_IP_HOUR', 20),
      /** Неудачных попыток на один позывной в час со всех IP: дальше задержка 60 с. */
      perUserPerHour: int('LOGIN_FAILS_PER_USER_HOUR', 50),
    },
    inviteValidHours: int('INVITE_VALID_HOURS', 72),
    /** Ключ шифрования секретов TOTP в базе. Меняешь ключ — подключение к приложению теряется у всех. */
    appSecret: appSecret(),
    /** Язык по умолчанию для тех, кто ещё ни разу не выбирал язык в интерфейсе. */
    defaultLocale: defaultLocale(),
  };
}

function appSecret(): string {
  const v = process.env.APP_SECRET ?? (process.env.NODE_ENV === 'test' ? 'test-secret-not-for-production' : '');
  if (v.length < 16) throw new Error('env APP_SECRET is required (32+ hex chars: openssl rand -hex 24)');
  return v;
}

function defaultLocale(): Locale {
  const v = process.env.DEFAULT_LOCALE || FALLBACK_LOCALE;
  if (!isLocale(v)) throw new Error(`env DEFAULT_LOCALE must be one of: ${LOCALES.join(', ')}`);
  return v;
}

export type Config = ReturnType<typeof loadConfig>;
