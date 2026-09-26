import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type AppDeps, requireUser } from '../app.js';
import { AppError, asUser } from '../db.js';
import { LOCALES } from '../i18n.js';
import { cookieNames, cookieOptions } from './auth.js';

// Без coerce: «""» и « » превращались в 0 и молча делали строку красной.
const qty = z.number().finite().min(0).max(1e9);

const itemBody = z.object({
  id: z.uuid().nullish(),
  position_id: z.uuid().nullish(),
  name: z.string().trim().min(1).max(80).nullish(),
  category: z.string().trim().max(40).nullish(),
  unit: z.string().trim().min(1).max(12).nullish(),
  qty: qty.nullish(),
  min_qty: qty.nullish(),
  acceptable_qty: qty.nullish(),
  ideal_qty: qty.nullish(),
  condition: z.enum(['ok', 'repair', 'broken']).nullish(),
  comment: z.string().max(280).nullish(),
  reason: z.string().max(120).nullish(),
  /** updated_at, который карточка видела при открытии: защита от затирания чужой правки. */
  expected_updated_at: z.iso.datetime().nullish(),
  /** Остаток, от которого считал степпер: защита от потери параллельной правки. */
  expected_qty: qty.nullish(),
});

// Цвет не хранится: считаем в запросе через те же функции, что и в БД.
export const ITEM_COLUMNS = `
  i.id, i.position_id, i.name, i.category, i.unit, i.qty,
  i.min_qty, i.acceptable_qty, i.ideal_qty, i.condition, i.comment,
  i.stock_rank, i.updated_at,
  horizon.status(i.qty, i.min_qty, i.acceptable_qty, i.ideal_qty) as status,
  horizon.is_full_stock(i.qty, i.ideal_qty) as full_stock,
  i.updated_at < now() - make_interval(hours => p.stale_after_hours) as stale,
  ub.callsign as updated_by_callsign`;

export const boardRoutes =
  ({ config, pool }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { session: SESSION_COOKIE } = cookieNames(config.secureCookies);
    const cookieBase = cookieOptions(config.secureCookies);

    app.get('/me', async (req) => {
      const uid = requireUser(req);
      const { rows } = await asUser(pool, uid, (c) => c.query('select horizon.me() as me'));
      const me = rows[0]?.me;
      if (!me) throw new AppError(401, 'войдите', 'login_required');
      return me;
    });

    // Язык интерфейса — он же язык сообщений бота этому человеку.
    app.post('/me/locale', async (req) => {
      const uid = requireUser(req);
      const { locale } = z.object({ locale: z.enum(LOCALES) }).parse(req.body);
      await asUser(pool, uid, (c) => c.query('select horizon.set_my_locale($1)', [locale]));
      return { ok: true };
    });

    app.post('/me/revoke-sessions', async (req, reply) => {
      const uid = requireUser(req);
      await asUser(pool, uid, (c) => c.query('select horizon.revoke_sessions($1)', [uid]));
      reply.clearCookie(SESSION_COOKIE, cookieBase);
      return { ok: true };
    });

    // Справочник категорий — один на роту, правится в базе.
    app.get('/categories', async (req) => {
      const uid = requireUser(req);
      const { rows } = await asUser(pool, uid, (c) =>
        c.query<{ name: string }>('select name from horizon.item_categories order by sort, name'),
      );
      return rows.map((r) => r.name);
    });

    // Шапка места + таблица. Всё под RLS: чужое место даст 404.
    app.get('/positions/:id/board', async (req) => {
      const uid = requireUser(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      return asUser(pool, uid, async (c) => {
        const pos = await c.query(
          'select id, name, is_active, stale_after_hours from horizon.positions where id = $1',
          [id],
        );
        if (!pos.rows[0]) throw new AppError(404, 'место не найдено', 'position_not_found');

        const people = await c.query(
          `select u.id, u.callsign, a.date_from
             from horizon.assignments a join horizon.users u on u.id = a.user_id
            where a.position_id = $1 and a.date_to is null
            order by a.date_from, lower(u.callsign)`,
          [id],
        );

        const items = await c.query(
          `select ${ITEM_COLUMNS}
             from horizon.items i
             join horizon.positions p on p.id = i.position_id
             left join horizon.users ub on ub.id = i.updated_by
            where i.position_id = $1
            order by i.stock_rank, lower(i.name)`,
          [id],
        );

        const counts = { red: 0, yellow: 0, green: 0, stale: 0, full: 0 };
        for (const it of items.rows as Array<{ status: 'red' | 'yellow' | 'green'; stale: boolean; full_stock: boolean }>) {
          counts[it.status]++;
          if (it.stale) counts.stale++;
          if (it.full_stock) counts.full++;
        }

        return { position: pos.rows[0], people: people.rows, items: items.rows, counts };
      });
    });

    app.post('/items', async (req) => {
      const uid = requireUser(req);
      const b = itemBody.parse(req.body);
      if (!b.id && !b.name) throw new AppError(422, 'нужно название', 'name_required');
      return asUser(pool, uid, async (c) => {
        const saved = await c.query<{ id: string }>(
          `select id from horizon.upsert_item($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            b.id ?? null,
            b.position_id ?? null,
            b.name ?? null,
            b.category ?? null,
            b.unit ?? null,
            b.qty ?? null,
            b.min_qty ?? null,
            b.acceptable_qty ?? null,
            b.ideal_qty ?? null,
            b.condition ?? null,
            b.comment ?? null,
            b.reason ?? '',
            b.expected_updated_at ?? null,
            b.expected_qty ?? null,
          ],
        );
        const { rows } = await c.query(
          `select ${ITEM_COLUMNS}
             from horizon.items i
             join horizon.positions p on p.id = i.position_id
             left join horizon.users ub on ub.id = i.updated_by
            where i.id = $1`,
          [saved.rows[0]!.id],
        );
        return rows[0];
      });
    });

    app.post('/items/:id/delete', async (req) => {
      const uid = requireUser(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await asUser(pool, uid, (c) => c.query('select horizon.delete_item($1)', [id]));
      return { ok: true };
    });

    app.get('/items/:id/movements', async (req) => {
      const uid = requireUser(req);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { rows } = await asUser(pool, uid, (c) =>
        c.query(
          `select m.id, m.qty_before, m.qty_after, m.delta, m.reason, m.created_at, u.callsign as created_by_callsign
             from horizon.stock_movements m
             left join horizon.users u on u.id = m.created_by
            where m.item_id = $1
            limit 1`,
          [id],
        ),
      );
      return rows;
    });
  };
