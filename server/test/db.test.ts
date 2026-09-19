// Приёмка раздела 13 на уровне БД: политика мест, цвет, RLS, движение остатка.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, freshDb, one, seedPosition, seedUser } from './helpers.js';

let db: PGlite;
let boss: string; // полный админ
let p2: string;
let p3: string;
let shop: string;

beforeAll(async () => {
  db = await freshDb();
  boss = await seedUser(db, 'Гром', { full: true });
  p2 = await seedPosition(db, 'Позиция-2');
  p3 = await seedPosition(db, 'Позиция-3');
  shop = await seedPosition(db, 'Мастерская');
});

const assign = (uid: string, actor: string, pos: string, date = '2026-09-01') =>
  as(db, actor, (tx) => tx.query('select horizon.assign_to_position($1, $2, $3)', [uid, pos, date]));
const transfer = (uid: string, actor: string, pos: string, date = '2026-09-10') =>
  as(db, actor, (tx) => tx.query('select horizon.transfer_user($1, $2, $3)', [uid, pos, date]));
const unassign = (uid: string, actor: string, date = '2026-09-15') =>
  as(db, actor, (tx) => tx.query('select horizon.unassign_user($1, $2)', [uid, date]));
const openCount = async (uid: string) =>
  Number((await one<{ n: number }>(db, 'select count(*)::int n from horizon.assignments where user_id = $1 and date_to is null', [uid])).n);

const upsert = (actor: string, fields: Record<string, unknown>) =>
  as(db, actor, (tx) =>
    one<{ id: string; qty: string; stock_rank: number }>(
      tx,
      `select * from horizon.upsert_item($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        fields.id ?? null, fields.position_id ?? null, fields.name ?? null, fields.category ?? null,
        fields.unit ?? null, fields.qty ?? null, fields.min ?? null, fields.acc ?? null, fields.ideal ?? null,
        null, null, '',
      ],
    ),
  );

describe('status() — раздел 5', () => {
  it('бензин 20/50/100: 18 red, 35 yellow, 80 green, 120 green+full', async () => {
    const r = await one<Record<string, unknown>>(
      db,
      `select horizon.status(18, 20, 50, 100) a, horizon.status(35, 20, 50, 100) b,
              horizon.status(80, 20, 50, 100) c, horizon.status(120, 20, 50, 100) d,
              horizon.is_full_stock(120, 100) full_120, horizon.is_full_stock(80, 100) full_80,
              horizon.status(20, 20, 50, 100) edge_min, horizon.status(50, 20, 50, 100) edge_acc`,
    );
    expect(r).toEqual({
      a: 'red', b: 'yellow', c: 'green', d: 'green',
      full_120: true, full_80: false, edge_min: 'yellow', edge_acc: 'green',
    });
  });

  it('пороги 50/20/100 не сохраняются', async () => {
    const actor = await seedUser(db, 'Пороги');
    await assign(actor, boss, shop);
    await expect(upsert(actor, { position_id: shop, name: 'Масло', qty: 5, min: 50, acc: 20, ideal: 100 }))
      .rejects.toMatchObject({ code: 'HZ422' });
    // и в обход функции — CHECK в таблице
    await expect(
      db.query(`insert into horizon.items (position_id, name, min_qty, acceptable_qty, ideal_qty) values ($1, 'x', 50, 20, 100)`, [shop]),
    ).rejects.toMatchObject({ code: '23514' });
    await unassign(actor, boss, '2026-09-02');
  });
});

describe('один человек — одно место (разделы 2, 4.3)', () => {
  let a: string;

  beforeAll(async () => {
    a = await seedUser(db, 'Альфа');
  });

  it('A посажен на Позиция-2 и видит только её', async () => {
    await upsert(boss, { position_id: p2, name: 'Бензин', unit: 'л', qty: 80, min: 20, acc: 50, ideal: 100 });
    await upsert(boss, { position_id: p3, name: 'Вода', unit: 'л', qty: 10, min: 5, acc: 20, ideal: 40 });
    await assign(a, boss, p2);

    const items = await as(db, a, (tx) => tx.query<{ name: string }>('select name from horizon.items'));
    expect(items.rows.map((r) => r.name)).toEqual(['Бензин']);
    const positions = await as(db, a, (tx) => tx.query<{ name: string }>('select name from horizon.positions'));
    expect(positions.rows.map((r) => r.name)).toEqual(['Позиция-2']);
    const me = await as(db, a, (tx) => one<{ me: any }>(tx, 'select horizon.me() me'));
    expect(me.me.assignment).toMatchObject({ position_id: p2, name: 'Позиция-2', date_from: '2026-09-01' });
  });

  it('вторая посадка на мастерскую без перевода — ошибка', async () => {
    await expect(assign(a, boss, shop)).rejects.toMatchObject({
      code: 'HZ409',
      message: expect.stringContaining('сначала переведите или снимите'),
    });
    expect(await openCount(a)).toBe(1);
  });

  it('вторая открытая assignment падает на индексе БД даже в обход UI', async () => {
    await expect(
      db.query(`insert into horizon.assignments (user_id, position_id, date_from) values ($1, $2, '2026-09-05')`, [a, shop]),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await openCount(a)).toBe(1);
  });

  it('horizon_user не может писать assignments напрямую', async () => {
    await expect(
      as(db, a, (tx) => tx.query(`update horizon.assignments set date_to = '2026-09-02' where user_id = $1`, [a])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('перевод на Позиция-3 убирает A из шапки Позиция-2 и показывает в Позиция-3', async () => {
    await transfer(a, boss, p3);
    const header = (pos: string) =>
      as(db, boss, (tx) =>
        tx.query<{ callsign: string; date_from: string }>(
          `select u.callsign, a.date_from from horizon.assignments a join horizon.users u on u.id = a.user_id
            where a.position_id = $1 and a.date_to is null`,
          [pos],
        ),
      );
    expect((await header(p2)).rows).toEqual([]);
    expect((await header(p3)).rows).toEqual([{ callsign: 'Альфа', date_from: expect.anything() }]);
    expect(await openCount(a)).toBe(1);

    const items = await as(db, a, (tx) => tx.query<{ name: string }>('select name from horizon.items'));
    expect(items.rows.map((r) => r.name)).toEqual(['Вода']);

    const hist = await one<{ n: number }>(db, 'select count(*)::int n from horizon.assignments where user_id = $1', [a]);
    expect(hist.n).toBe(2); // история сохранена
  });

  it('перевод на то же место и перевод задним числом отклоняются', async () => {
    await expect(transfer(a, boss, p3)).rejects.toMatchObject({ code: 'HZ409' });
    await expect(transfer(a, boss, p2, '2026-09-09')).rejects.toMatchObject({ code: 'HZ422' });
    expect(await openCount(a)).toBe(1);
  });

  it('снятие возвращает экран ожидания и пустую таблицу', async () => {
    await unassign(a, boss);
    expect(await openCount(a)).toBe(0);
    const me = await as(db, a, (tx) => one<{ me: any }>(tx, 'select horizon.me() me'));
    expect(me.me.assignment).toBeNull();
    const items = await as(db, a, (tx) => tx.query('select * from horizon.items'));
    expect(items.rows).toEqual([]);
    await expect(transfer(a, boss, p2, '2026-09-16')).rejects.toMatchObject({ code: 'HZ409' });
  });

  it('историю мест нельзя удалить', async () => {
    await expect(db.query('delete from horizon.assignments where user_id = $1', [a])).rejects.toThrow(/запрещено/);
  });
});

describe('права (разделы 3, 8)', () => {
  it('админ зоны не посадит человека на чужую зону и не уведёт из чужой', async () => {
    const zoneAdmin = await seedUser(db, 'Зона', { zone: [p2] });
    const b = await seedUser(db, 'Браво');
    await expect(assign(b, zoneAdmin, p3)).rejects.toMatchObject({ code: 'HZ403' });
    await assign(b, zoneAdmin, p2);
    await expect(transfer(b, zoneAdmin, p3)).rejects.toMatchObject({ code: 'HZ403' });

    const c = await seedUser(db, 'Чарли');
    await assign(c, boss, p3);
    await expect(transfer(c, zoneAdmin, p2)).rejects.toMatchObject({ code: 'HZ403' });
    await expect(unassign(c, zoneAdmin)).rejects.toMatchObject({ code: 'HZ403' });

    const zoneItems = await as(db, zoneAdmin, (tx) => tx.query<{ position_id: string }>('select position_id from horizon.items'));
    expect(new Set(zoneItems.rows.map((r) => r.position_id))).toEqual(new Set([p2]));
  });

  it('рядовой не может сажать и приглашать', async () => {
    const d = await seedUser(db, 'Дельта');
    const e = await seedUser(db, 'Эхо');
    await expect(assign(e, d, p2)).rejects.toMatchObject({ code: 'HZ403' });
    await expect(
      as(db, d, (tx) => tx.query(`select horizon.invite_user('novyy', 'Новый', 'h', 72)`)),
    ).rejects.toMatchObject({ code: 'HZ403' });
  });

  it('нельзя снять последнего полного админа', async () => {
    await expect(
      as(db, boss, (tx) => tx.query('select horizon.grant_admin($1, false, $2::uuid[])', [boss, []])),
    ).rejects.toMatchObject({ code: 'HZ409' });
    const second = await seedUser(db, 'Второй');
    await as(db, boss, (tx) => tx.query('select horizon.grant_admin($1, true, $2::uuid[])', [second, []]));
    await as(db, second, (tx) => tx.query('select horizon.grant_admin($1, false, $2::uuid[])', [boss, [p2]]));
    await expect(
      as(db, second, (tx) => tx.query('select horizon.set_user_active($1, false)', [second])),
    ).rejects.toMatchObject({ code: 'HZ409' });
    await as(db, second, (tx) => tx.query('select horizon.grant_admin($1, true, $2::uuid[])', [boss, []]));
  });

  it('пользователь не видит хеши и не зовёт функции входа', async () => {
    const f = await seedUser(db, 'Фокстрот');
    await expect(as(db, f, (tx) => tx.query('select password_hash from horizon.users'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(db, f, (tx) => tx.query('select * from horizon.audit_log'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(db, f, (tx) => tx.query('select horizon.auth_lookup($1)', ['Гром']))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('остаток и movement (раздел 4.2)', () => {
  let g: string;
  let item: string;

  beforeAll(async () => {
    g = await seedUser(db, 'Гольф');
    const pos = await seedPosition(db, 'Позиция-7');
    await assign(g, boss, pos);
    item = (await upsert(g, { position_id: pos, name: 'Бензин', unit: 'л', qty: 80, min: 20, acc: 50, ideal: 100 })).id;
  });

  it('хранится только последняя смена qty, без смены — не трогаем', async () => {
    await upsert(g, { id: item, qty: 35 });
    await upsert(g, { id: item, qty: 35 });
    const m = await db.query<{ qty_before: string; qty_after: string }>(
      'select qty_before, qty_after from horizon.stock_movements where item_id = $1 order by id', [item]);
    expect(m.rows.map((r) => [r.qty_before === null ? null : Number(r.qty_before), Number(r.qty_after)])).toEqual([
      [80, 35],
    ]);
  });

  it('остаток ниже минимума делает строку красной', async () => {
    const saved = await upsert(g, { id: item, qty: 18 });
    expect(saved.stock_rank).toBe(0); // 0 — красный, см. horizon.status()
  });
});

