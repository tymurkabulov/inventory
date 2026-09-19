import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// Пароль может быть коротким и словарным — поэтому медленный scrypt с солью
// плюс лимиты попыток (horizon.auth_gate).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Один вызов scrypt — это ~100 мс процессора и ~32 МБ памяти, а дёргать вход может кто угодно.
// Больше HASH_LIMIT одновременно не считаем: остальные ждут в очереди.
const HASH_LIMIT = Number(process.env.PASSWORD_HASH_CONCURRENCY ?? 4);
const HASH_QUEUE_MAX = 200;
let running = 0;
const waiting: Array<() => void> = [];

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= HASH_LIMIT) {
    if (waiting.length >= HASH_QUEUE_MAX) throw new Error('сервер занят, повторите позже');
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await withHashSlot(() => scryptAsync(password, salt, 32, SCRYPT));
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await withHashSlot(() =>
    scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { ...SCRYPT, N: Number(n) }),
  );
  return timingSafeEqual(key, expected);
}

/** Очевидные пароли отсеиваем до хеширования: подбор начинают именно с них. */
const WEAK = new Set([
  '12345678', '123456789', '1234567890', '987654321', '11111111', '00000000', '12341234',
  '123123123', 'password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyui',
  'qwerty12', 'qwertyuiop', 'qwerty1234', 'zxcvbnm1', 'asdfghjk', '1qaz2wsx', 'qazwsxedc',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1',
  'admin123', 'administrator', 'welcome1', 'letmein1', 'monkey12', 'dragon123', 'master123',
  'ukraine1', 'ukraina1', 'slavaukraine', 'zsu2022', 'ukraine2022', 'ukraine2023',
  'parol123', 'parolparol', 'abcd1234', 'abc12345', 'test1234', 'horizon1', 'horizon123',
]);

/** Минимум для админа выше: его вход открывает все места и всех людей. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MIN_ADMIN = 12;

export function passwordProblem(password: string, login: string, isAdmin = false): 'short' | 'weak' | null {
  if (password.length < (isAdmin ? PASSWORD_MIN_ADMIN : PASSWORD_MIN)) return 'short';
  const low = password.toLowerCase();
  const name = login.trim().toLowerCase();
  if (WEAK.has(low)) return 'weak';
  if (name.length >= 2 && low.includes(name)) return 'weak';
  if (/^(.)\1+$/.test(password)) return 'weak';
  // «12345678», «abcdefgh» и прочие подряд идущие символы
  if ((/^\d+$/.test(low) || /^[a-z]+$/.test(low)) && isRun(low)) return 'weak';
  return null;
}

/** Символы идут подряд по возрастанию или убыванию. */
function isRun(v: string): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < v.length; i++) {
    const d = v.charCodeAt(i) - v.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

// Код диктуют голосом и вводят с телефона, поэтому в алфавите не осталось ни одной пары,
// которую путают на экране или на слух: 0/O, 1/I/L, 5/S, 8/B, 2/Z, U/V.
const CODE_ALPHABET = '34679ACDEFGHJKMNPQRTWXY';

export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashInviteCode(code: string): string {
  return sha256(`invite:${normalizeInviteCode(code)}`);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238): 6 цифр, шаг 30 секунд, HMAC-SHA1 — так умеют все приложения.
// ---------------------------------------------------------------------------
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
/** Допуск на расхождение часов: ±1 шаг. */
export const TOTP_WINDOW = 1;

export function newTotpSecret(): string {
  const bytes = randomBytes(20); // 160 бит — как советует RFC 4226
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function isTotpSecret(v: string): boolean {
  return /^[A-Z2-7]{32}$/.test(v);
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/=+$/, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, '0');
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/** Номер совпавшего интервала или null. Сравнение без ветвления по времени. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return null;
  const current = totpStep(now);
  let match: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(Buffer.from(digits), expected)) match = step;
  }
  return match;
}

/** Ссылка для QR-кода: otpauth://totp/Horizon:Позывной?secret=…&issuer=Horizon */
export function otpauthUrl(secret: string, login: string): string {
  const label = encodeURIComponent(`Horizon:${login}`);
  const params = new URLSearchParams({ secret, issuer: 'Horizon', algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Секрет TOTP в базе лежит зашифрованным: дамп базы сам по себе не даёт кодов.
// ---------------------------------------------------------------------------
function secretKey(appSecret: string): Buffer {
  return createHash('sha256').update(`totp-key:${appSecret}`).digest();
}

export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(appSecret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${data.toString('base64')}.${cipher.getAuthTag().toString('base64')}`;
}

export function decryptSecret(stored: string, appSecret: string): string | null {
  const [version, ivB64, dataB64, tagB64] = stored.split('.');
  if (version !== 'v1' || !ivB64 || !dataB64 || !tagB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(appSecret), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // не тот APP_SECRET или запись испорчена
  }
}
