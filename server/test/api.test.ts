// Сквозной сценарий через HTTP: вход, посадка, таблица, перевод, revoke.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashInviteCode, totpCode, totpStep } from '../src/crypto.js';
import { one, socketDb } from './helpers.js';

process.env.NODE_ENV = 'test';

let env: Awaited<ReturnType<typeof socketDb>>;
let app: FastifyInstance;
const config = loadConfig();

/** Браузер в миниатюре: хранит cookie, шлёт X-Horizon. */
class Browser {
  cookies = new Map<string, string>();
  constructor(readonly ip = '203.0.113.7') {}

  async req(method: 'GET' | 'POST', url: string, body?: unknown): Promise<LightMyRequestResponse> {
    const res = await app.inject({
      method,
      url,
      payload: body as never,
      headers: {
        'x-horizon': '1',
        // nginx дописывает адрес клиента последним — API верит только этой записи
        'x-forwarded-for': `198.51.100.1, ${this.ip}`,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
    });
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
}

/** Первый вход: одноразовый код → пароль + приложение с одноразовыми кодами. */
async function setupAccess(browser: Browser, login: string, code: string, password: string): Promise<string> {
  const { secret } = await expectOk(browser.post('/api/auth/totp-secret', { login, code }));
  await expectOk(browser.post('/api/auth/setup', { login, code, password, secret, totp: totpCode(secret, totpStep()) }));
  return secret as string;
}

async function expectOk(p: Promise<LightMyRequestResponse>) {
  const res = await p;
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Сбросить лимиты попыток: в тестах несколько сценариев подряд бьют по одному позывному. */
async function unlock(name: string) {
  await env.db.query(
    `update horizon.users set locked_until = null, failed_attempts = 0, totp_last_step = null where login = $1`,
    [name],
  );
  await env.db.query('delete from horizon.auth_attempts');
}

beforeAll(async () => {
  env = await socketDb();
  app = await buildApp({ config, pool: env.pool });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await env?.close();
});

describe('сценарий раздела 13 через API', () => {
  const boss = new Browser();
  const alpha = new Browser();
  let p2: string;
  let p3: string;
  let shop: string;
  let alphaId: string;
  let bossSecret: string;
  let alphaSecret: string;

  it('первый админ входит по коду, ставит пароль и приложение; код сгорает', async () => {
    const { id } = await one<{ id: string }>(
      env.db,
      `insert into horizon.users (login, callsign, invite_code_hash, invite_expires_at)
       values ('grom', 'Гром', $1, now() + interval '1 day') returning id`,
      [hashInviteCode('ABCD-EFGH')],
    );
    await env.db.query(`insert into horizon.admin_scopes (user_id, scope) values ($1, 'full')`, [id]);

    expect((await boss.post('/api/auth/code', { login: 'GROM', code: 'abcd-wrong' })).statusCode).toBe(401);
    await expectOk(boss.post('/api/auth/code', { login: 'grom', code: 'abcdefgh' }));

    const { secret } = await expectOk(boss.post('/api/auth/totp-secret', { login: 'grom', code: 'ABCD-EFGH' }));
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const setup = (body: Record<string, unknown>) => boss.post('/api/auth/setup', { login: 'grom', code: 'ABCD-EFGH', secret, ...body });
    // короткий пароль и чужой код из приложения не проходят
    expect((await setup({ password: 'korotky', totp: totpCode(secret, totpStep()) })).statusCode).toBe(422);
    expect((await setup({ password: 'grim-parol-2026', totp: totpCode(secret, totpStep() + 50) })).statusCode).toBe(401);
    await expectOk(setup({ password: 'grim-parol-2026', totp: totpCode(secret, totpStep()) }));
    bossSecret = secret;

    const me = await expectOk(boss.get('/api/me'));
    expect(me).toMatchObject({ login: 'grom', callsign: 'Гром', admin: { full: true }, assignment: null });

    const again = new Browser();
    expect((await again.post('/api/auth/code', { login: 'grom', code: 'ABCD-EFGH' })).statusCode).toBe(401);
  });

  it('без заголовка X-Horizon POST отклоняется', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'grom', password: 'grim-parol-2026', totp: '000000' } });
    expect(res.statusCode).toBe(403);
  });

  it('админ заводит места и человека; человек ждёт назначения', async () => {
    p2 = (await expectOk(boss.post('/api/admin/positions', { name: 'Позиция-2' }))).id;
    p3 = (await expectOk(boss.post('/api/admin/positions', { name: 'Позиция-3' }))).id;
    shop = (await expectOk(boss.post('/api/admin/positions', { name: 'Мастерская' }))).id;

    const inv = await expectOk(boss.post('/api/admin/users', { login: 'alfa', callsign: 'Альфа' }));
    expect(inv.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    alphaId = inv.id;

    alphaSecret = await setupAccess(alpha, 'alfa', inv.code, 'zahyst-parol-2026');
    const me = await expectOk(alpha.get('/api/me'));
    expect(me.assignment).toBeNull();
    expect(me.admin).toEqual({ full: false, position_ids: [] });

    // экран ожидания: чужие места не видны
    expect((await alpha.get(`/api/positions/${p2}/board`)).statusCode).toBe(404);
    expect((await alpha.get('/api/admin/overview')).statusCode).toBe(403);
  });

  it('1. A посажен на Позиция-2 и видит только её', async () => {
    await expectOk(boss.post('/api/items', {
      position_id: p2, name: 'Бензин', category: 'Паливо', unit: 'л', qty: 80, min_qty: 20, acceptable_qty: 50, ideal_qty: 100,
    }));
    await expectOk(boss.post('/api/items', {
      position_id: p3, name: 'Вода', unit: 'л', qty: 30, min_qty: 5, acceptable_qty: 20, ideal_qty: 40,
    }));
    await expectOk(boss.post(`/api/admin/users/${alphaId}/assign`, { position_id: p2, date_from: '2026-09-01' }));

    const me = await expectOk(alpha.get('/api/me'));
    expect(me.assignment).toMatchObject({ position_id: p2, name: 'Позиция-2', date_from: '2026-09-01' });
    const board = await expectOk(alpha.get(`/api/positions/${p2}/board`));
    expect(board.people).toEqual([{ id: alphaId, callsign: 'Альфа', date_from: '2026-09-01' }]);
    expect(board.items.map((i: { name: string }) => i.name)).toEqual(['Бензин']);
    expect((await alpha.get(`/api/positions/${p3}/board`)).statusCode).toBe(404);
  });

  it('2. вторая посадка на мастерскую без перевода — ошибка', async () => {
    const res = await boss.post(`/api/admin/users/${alphaId}/assign`, { position_id: shop, date_from: '2026-09-02' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('сначала переведите или снимите');
  });

  it('5. бензин 20/50/100: 18 red, 35 yellow, 80 green; сортировка red→yellow→green→имя', async () => {
    const board = await expectOk(alpha.get(`/api/positions/${p2}/board`));
    const fuel = board.items[0];
    const set = (qty: number) => expectOk(alpha.post('/api/items', { id: fuel.id, qty }));
    expect((await set(18)).status).toBe('red');
    expect((await set(35)).status).toBe('yellow');
    const green = await set(80);
    expect(green).toMatchObject({ status: 'green', full_stock: false, updated_by_callsign: 'Альфа' });
    expect((await set(120)).full_stock).toBe(true);

    await expectOk(alpha.post('/api/items', { position_id: p2, name: 'Аккумулятор', qty: 1, min_qty: 2, acceptable_qty: 3, ideal_qty: 4 }));
    await expectOk(alpha.post('/api/items', { position_id: p2, name: 'Антенна', qty: 5, min_qty: 1, acceptable_qty: 2, ideal_qty: 3 }));
    await expectOk(alpha.post('/api/items', { position_id: p2, name: 'Батарейки', qty: 5, min_qty: 2, acceptable_qty: 10, ideal_qty: 20 }));
    const sorted = await expectOk(alpha.get(`/api/positions/${p2}/board`));
    expect(sorted.items.map((i: { name: string }) => i.name)).toEqual(['Аккумулятор', 'Батарейки', 'Антенна', 'Бензин']);
    expect(sorted.counts).toMatchObject({ red: 1, yellow: 1, green: 2, full: 2 });

    // Хранится только последняя правка: было 80 → стало 120.
    const moves = await expectOk(alpha.get(`/api/items/${fuel.id}/movements`));
    expect(moves.map((m: { qty_before: number; qty_after: number }) => [m.qty_before, m.qty_after])).toEqual([[80, 120]]);
  });

  it('6. пороги 50/20/100 не сохраняются', async () => {
    const res = await alpha.post('/api/items', { position_id: p2, name: 'Масло', qty: 5, min_qty: 50, acceptable_qty: 20, ideal_qty: 100 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('мин < приемлемый');
  });

  it('админ-лента показывает красные', async () => {
    const ov = await expectOk(boss.get('/api/admin/overview'));
    expect(ov.red.map((r: { name: string }) => r.name)).toContain('Аккумулятор');
    const tile = ov.tiles.find((t: { id: string }) => t.id === p2);
    expect(tile).toMatchObject({ people: 1, red: 1 });
    const people = await expectOk(boss.get('/api/admin/people'));
    expect(people.find((p: { id: string }) => p.id === alphaId)).toMatchObject({
      position_name: 'Позиция-2', date_from: '2026-09-01',
    });
  });

  it('3. перевод на Позиция-3 убирает A из шапки Позиция-2 и показывает в Позиция-3', async () => {
    await expectOk(boss.post(`/api/admin/users/${alphaId}/transfer`, { position_id: p3, date: '2026-09-10' }));
    expect((await expectOk(boss.get(`/api/positions/${p2}/board`))).people).toEqual([]);
    expect((await expectOk(boss.get(`/api/positions/${p3}/board`))).people).toEqual([
      { id: alphaId, callsign: 'Альфа', date_from: '2026-09-10' },
    ]);
    const me = await expectOk(alpha.get('/api/me'));
    expect(me.assignment.position_id).toBe(p3);
    expect((await alpha.get(`/api/positions/${p2}/board`)).statusCode).toBe(404);

    const hist = await expectOk(boss.get(`/api/admin/users/${alphaId}/history`));
    expect(hist).toMatchObject([
      { position_name: 'Позиция-3', date_from: '2026-09-10', date_to: null },
      { position_name: 'Позиция-2', date_from: '2026-09-01', date_to: '2026-09-10', assigned_by: 'Гром' },
    ]);
  });

  it('4. снятие возвращает экран ожидания', async () => {
    await expectOk(boss.post(`/api/admin/users/${alphaId}/unassign`, { date: '2026-09-15' }));
    expect((await expectOk(alpha.get('/api/me'))).assignment).toBeNull();
    expect((await alpha.get(`/api/positions/${p3}/board`)).statusCode).toBe(404);
  });

  it('7. revoke выкидывает на вход; вход по паролю и коду возвращает', async () => {
    await expectOk(boss.post(`/api/admin/users/${alphaId}/revoke-sessions`));
    expect((await alpha.get('/api/me')).statusCode).toBe(401);
    const login = (body: Record<string, unknown>) => alpha.post('/api/auth/login', { login: 'alfa', ...body });
    expect((await login({ password: 'ne-tot-parol', totp: totpCode(alphaSecret, totpStep()) })).statusCode).toBe(401);
    // пароль верный, код из чужого приложения
    expect((await login({ password: 'zahyst-parol-2026', totp: totpCode(bossSecret, totpStep()) })).statusCode).toBe(401);
    await unlock('alfa');
    await expectOk(login({ password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) }));
    expect((await alpha.get('/api/me')).statusCode).toBe(200);
  });

  it('один код из приложения не проходит дважды', async () => {
    const x = new Browser();
    const step = totpStep() + 1; // свежий интервал: предыдущий уже использован входом выше
    const code = totpCode(alphaSecret, step);
    await expectOk(x.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: code }));
    expect((await x.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: code })).statusCode).toBe(401);
    await unlock('alfa');
  });

  it('повторные ошибки тормозят подбор, но не блокируют аккаунт', async () => {
    await unlock('alfa');
    const x = new Browser();
    for (let i = 0; i < 3; i++) await x.post('/api/auth/login', { login: 'alfa', password: 'ne-tot-parol', totp: '000000' });
    // тот же IP и тот же позывной — ждать
    const throttled = await x.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ code: 'too_many_attempts' });

    // аккаунт при этом не заперт: попытки с другого адреса проходят сразу
    const other = new Browser('10.10.10.10');
    await expectOk(other.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) }));
    await unlock('alfa');
  });

  it('20 неудач с одного IP закрывают вход с этого IP', async () => {
    const x = new Browser('10.20.30.40');
    for (let i = 0; i < 20; i++) {
      await x.post('/api/auth/login', { login: `nikto-${i}`, password: 'ne-tot-parol', totp: '000000' });
    }
    const res = await x.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) });
    expect(res.statusCode).toBe(429);
    // с другого адреса вход работает
    const clean = new Browser('10.20.30.41');
    await expectOk(clean.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) }));
    await unlock('alfa');
  });

  it('несуществующий позывной отвечает так же, как неверный пароль', async () => {
    const x = new Browser('10.30.30.30');
    const unknown = await x.post('/api/auth/login', { login: 'kogo-nemae', password: 'luboy-parol-123', totp: '123456' });
    const known = await new Browser('10.30.30.31').post('/api/auth/login', { login: 'alfa', password: 'ne-tot-parol', totp: '123456' });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    await unlock('alfa');
  });

  it('вход с нового устройства — тот же пароль и код', async () => {
    const laptop = new Browser();
    await expectOk(laptop.post('/api/auth/login', { login: 'grom', password: 'grim-parol-2026', totp: totpCode(bossSecret, totpStep()) }));
    expect((await laptop.get('/api/me')).statusCode).toBe(200);
    await expectOk(laptop.post('/api/auth/logout'));
    expect((await laptop.get('/api/me')).statusCode).toBe(401);
  });

  it('секрет приложения хранится зашифрованным', async () => {
    const row = await one<{ totp_secret: string }>(env.db, `select totp_secret from horizon.users where login = 'alfa'`);
    expect(row.totp_secret.startsWith('v1.')).toBe(true);
    expect(row.totp_secret).not.toContain(alphaSecret);
  });

  it('нельзя снять последнего полного админа', async () => {
    const me = await expectOk(boss.get('/api/me'));
    const res = await boss.post(`/api/admin/users/${me.id}/admin`, { full: false, position_ids: [] });
    expect(res.statusCode).toBe(409);
  });

  it('8. правка остатка на новом месте переводит строку в red', async () => {
    await expectOk(boss.post(`/api/admin/users/${alphaId}/assign`, { position_id: p3, date_from: '2026-09-16' }));
    const board = await expectOk(alpha.get(`/api/positions/${p3}/board`));
    const water = board.items[0];
    const saved = await expectOk(alpha.post('/api/items', { id: water.id, qty: 2 }));
    expect(saved.status).toBe('red');
  });

  it('сброс доступа выдаёт новый код и гасит сессии', async () => {
    const { code } = await expectOk(boss.post(`/api/admin/users/${alphaId}/reset-access`));
    expect((await alpha.get('/api/me')).statusCode).toBe(401);
    expect(
      (await alpha.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-2026', totp: totpCode(alphaSecret, totpStep()) })).statusCode,
    ).toBe(401);
    alphaSecret = await setupAccess(alpha, 'alfa', code, 'zahyst-parol-novy');
    expect((await expectOk(alpha.get('/api/me'))).assignment.position_id).toBe(p3);
  });

  it('ошибки несут код и параметры для перевода', async () => {
    const res = await boss.post(`/api/admin/users/${alphaId}/assign`, { position_id: p2, date_from: '2026-09-17' });
    expect(res.json()).toMatchObject({ code: 'already_assigned', error: expect.stringContaining('сначала') });
    const dupLogin = await boss.post('/api/admin/users', { login: 'alfa', callsign: 'Інший' });
    expect(dupLogin.json()).toMatchObject({ code: 'login_taken', params: { login: 'alfa' } });
    const dup = await boss.post('/api/admin/users', { login: 'alfa2', callsign: 'Альфа' });
    expect(dup.json()).toMatchObject({ code: 'callsign_taken', params: { callsign: 'Альфа' } });
    const bad = await alpha.post('/api/auth/login', { login: 'alfa', password: 'zahyst-parol-novy', totp: 'x' });
    expect(bad.json()).toMatchObject({ code: 'validation', params: { field: 'totp' } });
  });

  it('украинский позывной и выбор языка интерфейса', async () => {
    const inv = await expectOk(boss.post('/api/admin/users', { login: 'yizhak', callsign: 'Їжак' }));
    const hedgehog = new Browser();
    await setupAccess(hedgehog, 'yizhak', inv.code, 'kolyuchka-parol-26');
    expect((await expectOk(hedgehog.get('/api/me'))).locale).toBeNull();
    await expectOk(hedgehog.post('/api/me/locale', { locale: 'uk' }));
    expect((await hedgehog.post('/api/me/locale', { locale: 'de' })).statusCode).toBe(422);
    expect((await hedgehog.post('/api/me/locale', { locale: 'ru' })).statusCode).toBe(422);
    expect((await expectOk(hedgehog.get('/api/me'))).locale).toBe('uk');

    await expectOk(boss.post(`/api/admin/users/${inv.id}/assign`, { position_id: shop, date_from: '2026-09-17' }));
    const saved = await expectOk(
      hedgehog.post('/api/items', { position_id: shop, name: 'Мастило', unit: 'л', qty: 1, min_qty: 2, acceptable_qty: 3, ideal_qty: 5 }),
    );
    expect(saved).toMatchObject({ status: 'red', updated_by_callsign: 'Їжак' });
  });

  it('health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});
