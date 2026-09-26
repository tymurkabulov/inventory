// Регрессии по ревью безопасности: сессии, лимиты входа, степпер, права админа зоны, RLS.
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashInviteCode, sha256 } from '../src/crypto.js';
import { as, freshDb, one, seedPosition, seedUser, socketDb } from './helpers.js';

process.env.NODE_ENV = 'test';

describe('сессии: ротация и повтор старого токена', () => {
  let db: PGlite;
  let uid: string;
  const dev = 'device-aaaaaaaaaaaaaaaaaaaa';
  const touch = (token: string, fresh: string | null = null, device = dev) =>
    db.query<{ user_id: string; rotated: boolean }>('select * from horizon.auth_session_touch($1, $2, $3, 24)', [
      sha256(token),
      device,
      fresh ? sha256(fresh) : null,
    ]);
  const live = async () =>
    (await one<{ n: number }>(db, 'select count(*)::int n from horizon.sessions where user_id = $1 and revoked_at is null', [uid])).n;
  const rotatedAgo = (interval: string) =>
    db.query(`update horizon.sessions set rotated_at = now() - $2::interval where user_id = $1`, [uid, interval]);

  beforeAll(async () => {
    db = await freshDb();
    uid = await seedUser(db, 'Связист');
  });

  async function session(token: string) {
    await db.query('update horizon.sessions set revoked_at = now() where user_id = $1', [uid]);
    await db.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [uid, sha256(token), dev, 'ua', 30]);
    await db.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [uid, sha256(`${token}-laptop`), 'dev-laptop-xxxxxxxxxxxxx', 'ua', 30]);
  }

  it('потерянный ответ с новым токеном не считается кражей: токен выдаётся заново', async () => {
    await session('a1');
    await rotatedAgo('25 hours');
    expect((await touch('a1', 'a2')).rows[0]).toMatchObject({ user_id: uid, rotated: true });
    await rotatedAgo('3 minutes');
    // Телефон не получил a2 и снова шлёт a1.
    expect((await touch('a1', 'a3')).rows[0]).toMatchObject({ user_id: uid, rotated: true });
    expect((await touch('a3')).rows[0]).toMatchObject({ user_id: uid, rotated: false });
    expect(await live()).toBe(2);
  });

  it('старый токен после того, как новым пользовались, гасит все сессии и пишет audit', async () => {
    await session('b1');
    await rotatedAgo('25 hours');
    await touch('b1', 'b2');
    await touch('b2'); // новый дошёл и работает
    await rotatedAgo('3 minutes');
    expect((await touch('b1', 'b3')).rows).toEqual([]);
    expect(await live()).toBe(0);
    const audit = await one<{ n: number }>(
      db,
      `select count(*)::int n from horizon.audit_log where action = 'session_token_reuse' and target_user_id = $1`,
      [uid],
    );
    expect(audit.n).toBeGreaterThan(0);
  });

  it('параллельный запрос со старым токеном в пределах форы проходит', async () => {
    await session('c1');
    await rotatedAgo('25 hours');
    await touch('c1', 'c2');
    await touch('c2');
    expect((await touch('c1', 'c3')).rows[0]).toMatchObject({ user_id: uid, rotated: false });
  });

  it('выход старым токеном закрывает сессию', async () => {
    await session('d1');
    await rotatedAgo('25 hours');
    await touch('d1', 'd2');
    await db.query('select horizon.auth_session_revoke($1)', [sha256('d1')]);
    expect(await live()).toBe(1); // осталась только сессия ноутбука
  });

  it('чужое устройство пишет audit не чаще раза в 10 минут', async () => {
    await session('e1');
    const before = await one<{ n: number }>(db, 'select count(*)::int n from horizon.audit_log');
    for (let i = 0; i < 20; i++) expect((await touch('e1', null, '')).rows).toEqual([]);
    const after = await one<{ n: number }>(db, 'select count(*)::int n from horizon.audit_log');
    expect(after.n - before.n).toBe(1);
  });
});

describe('HTTP: повтор старого токена не даёт 500', () => {
  let env: Awaited<ReturnType<typeof socketDb>>;
  let app: FastifyInstance;
  const dev = 'device-bbbbbbbbbbbbbbbbbbbb';

  beforeAll(async () => {
    env = await socketDb();
    app = await buildApp({ config: { ...loadConfig(), secureCookies: false }, pool: env.pool });
  });
  afterAll(async () => {
    await app.close();
    await env.close();
  });

  it('старый токен после потерянной ротации получает новый cookie, а не 500', async () => {
    const uid = await seedUser(env.db, 'Сигнал');
    await env.db.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [uid, sha256('old'), dev, 'ua', 30]);
    await env.db.query(`update horizon.sessions set rotated_at = now() - interval '25 hours' where user_id = $1`, [uid]);
    const cookie = `hz_session=old; hz_device=${dev}`;
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    await env.db.query(`update horizon.sessions set rotated_at = now() - interval '3 minutes' where user_id = $1`, [uid]);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === 'hz_session' && c.value !== 'old')).toBe(true);
  });
});

describe('лимиты входа', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });

  it('чужие неудачи по логину не держат владельца на его устройстве', async () => {
    const uid = await seedUser(db, 'Владелец', { login: 'owner' });
    await db.query('select horizon.auth_session_create($1, $2, $3, $4, $5)', [uid, sha256('t'), 'owner-device-xxxxxxxxxxx', 'ua', 30]);
    for (let i = 0; i < 50; i++) await db.query('select horizon.auth_note_fail($1, $2)', [`198.51.100.${i % 3}`, 'owner']);
    const gate = (device: string) =>
      one<{ w: number }>(db, 'select horizon.auth_gate($1, $2, 20, 50, $3) w', ['203.0.113.99', 'owner', device]);
    expect((await gate('owner-device-xxxxxxxxxxx')).w).toBe(0);
    expect((await gate('some-other-device-xxxxxx')).w).toBe(60);
    expect((await gate('')).w).toBe(60);
  });
});

describe('имущество, места, люди', () => {
  let db: PGlite;
  let boss: string;
  let pA: string;
  let pB: string;
  let zone: string;
  let soldier: string;

  beforeAll(async () => {
    db = await freshDb();
    boss = await seedUser(db, 'Гром', { full: true, login: 'grom' });
    pA = await seedPosition(db, 'Позиция-А');
    pB = await seedPosition(db, 'Позиция-Б');
    zone = await seedUser(db, 'Зона', { zone: [pA] });
    soldier = await seedUser(db, 'Боец');
    await as(db, boss, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [soldier, pA, '2026-09-01']));
  });

  const upsert = (actor: string, f: Record<string, unknown>) =>
    as(db, actor, (tx) =>
      one<{ id: string; qty: number }>(
        tx,
        `select * from horizon.upsert_item($1, $2, $3, null, null, $4, $5, $6, $7, null, null, '', null, $8)`,
        [f.id ?? null, f.position_id ?? null, f.name ?? null, f.qty ?? null, f.min ?? null, f.acc ?? null, f.ideal ?? null, f.expected ?? null],
      ),
    );

  it('степпер со старым снимком получает 409, а не затирает чужую правку', async () => {
    const it0 = await upsert(boss, { position_id: pA, name: 'Батареи', qty: 10, min: 1, acc: 2, ideal: 50 });
    await upsert(soldier, { id: it0.id, qty: 7, expected: 10 });
    await expect(upsert(boss, { id: it0.id, qty: 15, expected: 10 })).rejects.toMatchObject({ code: 'HZ409' });
    expect(Number((await upsert(boss, { id: it0.id, qty: 12, expected: 7 })).qty)).toBe(12);
  });

  it('посадка задним числом внутрь закрытого периода — 422', async () => {
    const u = await seedUser(db, 'История');
    await as(db, boss, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [u, pA, '2026-06-01']));
    await as(db, boss, (tx) => tx.query('select horizon.unassign_user($1, $2)', [u, '2026-08-01']));
    await expect(
      as(db, boss, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [u, pB, '2026-01-01'])),
    ).rejects.toMatchObject({ code: 'HZ422' });
    await as(db, boss, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [u, pB, '2026-08-01']));
  });

  it('админ зоны не сажает полного админа и не видит его логин', async () => {
    await expect(
      as(db, zone, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [boss, pA, '2026-09-20'])),
    ).rejects.toMatchObject({ code: 'HZ403' });
    const people = await as(db, zone, (tx) => one<{ v: Array<{ id: string; login: string | null }> }>(tx, 'select horizon.admin_people() v'));
    expect(people.v.find((p) => p.id === boss)?.login).toBeNull();
    const full = await as(db, boss, (tx) => one<{ v: Array<{ id: string; login: string | null }> }>(tx, 'select horizon.admin_people() v'));
    expect(full.v.find((p) => p.id === boss)?.login).toBe('grom');
  });

  it('RLS: доска по-прежнему видна своим и закрыта чужим', async () => {
    const other = await seedUser(db, 'Чужой');
    await as(db, boss, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [other, pB, '2026-09-01']));
    const count = (uid: string) =>
      as(db, uid, (tx) => one<{ n: number }>(tx, 'select count(*)::int n from horizon.items where position_id = $1', [pA]));
    expect((await count(soldier)).n).toBeGreaterThan(0);
    expect((await count(zone)).n).toBeGreaterThan(0);
    expect((await count(boss)).n).toBeGreaterThan(0);
    expect((await count(other)).n).toBe(0);
  });

  it('проверки прав в RLS считаются раз на запрос, а не на строку', async () => {
    const plan = await as(db, soldier, (tx) =>
      tx.query<{ 'QUERY PLAN': string }>('explain select * from horizon.items where position_id = $1', [pA]),
    );
    const filters = plan.rows.map((r) => r['QUERY PLAN']).filter((l) => l.includes('Filter'));
    expect(filters.join('\n')).not.toMatch(/current_position_id\(\)\)? OR|can_admin_position\(position_id\)/);
    expect(filters.join('\n')).toMatch(/InitPlan/);
  });
});

describe('коды входа и конфигурация', () => {
  it('хеш кода зависит от APP_SECRET', () => {
    expect(hashInviteCode('ABCD-EFGH', 'secret-one-xxxxxxxx')).not.toBe(hashInviteCode('ABCD-EFGH', 'secret-two-xxxxxxxx'));
    expect(hashInviteCode('abcd efgh', 'secret-one-xxxxxxxx')).toBe(hashInviteCode('ABCD-EFGH', 'secret-one-xxxxxxxx'));
  });

  it('профиль tls с одним прыжком прокси не стартует', () => {
    const saved = { ...process.env };
    try {
      process.env.COMPOSE_PROFILES = 'tls';
      process.env.TRUST_PROXY_HOPS = '1';
      expect(() => loadConfig()).toThrow(/TRUST_PROXY_HOPS=2/);
      process.env.TRUST_PROXY_HOPS = '2';
      expect(loadConfig().trustProxyHops).toBe(2);
    } finally {
      process.env = saved;
    }
  });
});
