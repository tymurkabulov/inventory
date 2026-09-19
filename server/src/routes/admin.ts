import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AppDeps, requireUser } from '../app.js';
import { hashInviteCode, newInviteCode } from '../crypto.js';
import { asUser } from '../db.js';

const idParam = z.object({ id: z.uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате ГГГГ-ММ-ДД');

export const adminRoutes =
  ({ config, pool }: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const call = async (req: FastifyRequest, sql: string, params: unknown[] = []) => {
      const uid = requireUser(req);
      const { rows } = await asUser(pool, uid, (c) => c.query(sql, params));
      return rows;
    };

    app.get('/overview', async (req) => (await call(req, 'select horizon.admin_overview() as v'))[0]!.v);

    app.get('/people', async (req) => (await call(req, 'select horizon.admin_people() as v'))[0]!.v);

    // RLS: полный админ видит все места, админ зоны — только свои.
    app.get('/positions', async (req) =>
      call(
        req,
        `select id, name, is_active, stale_after_hours
           from horizon.positions
          where horizon.can_admin_position(id)
          order by is_active desc, lower(name)`,
      ),
    );

    app.post('/positions', async (req) => {
      const b = z
        .object({
          id: z.uuid().nullish(),
          name: z.string().trim().min(1).max(64).nullish(),
          stale_after_hours: z.coerce.number().int().min(1).max(720).nullish(),
          is_active: z.boolean().nullish(),
        })
        .parse(req.body);
      const rows = await call(req, 'select horizon.upsert_position($1, $2, $3, $4) as id', [
        b.id ?? null,
        b.name ?? null,
        b.stale_after_hours ?? null,
        b.is_active ?? null,
      ]);
      return { id: rows[0]!.id };
    });

    // invite_user: код показывается один раз, в БД только хеш.
    app.post('/users', async (req) => {
      const b = z
        .object({
          login: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[0-9a-z._-]{3,32}$/, 'логин: 3–32 символа латиницей, цифры и . _ -'),
          callsign: z.string().trim().min(2).max(32),
        })
        .parse(req.body);
      const code = newInviteCode();
      const rows = await call(req, 'select horizon.invite_user($1, $2, $3, $4) as id', [
        b.login,
        b.callsign,
        hashInviteCode(code),
        config.inviteValidHours,
      ]);
      return { id: rows[0]!.id, code, valid_hours: config.inviteValidHours };
    });

    app.post('/users/:id/assign', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ position_id: z.uuid(), date_from: isoDate }).parse(req.body);
      const rows = await call(req, 'select horizon.assign_to_position($1, $2, $3) as id', [id, b.position_id, b.date_from]);
      return { assignment_id: rows[0]!.id };
    });

    app.post('/users/:id/transfer', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ position_id: z.uuid(), date: isoDate }).parse(req.body);
      const rows = await call(req, 'select horizon.transfer_user($1, $2, $3) as id', [id, b.position_id, b.date]);
      return { assignment_id: rows[0]!.id };
    });

    app.post('/users/:id/unassign', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ date: isoDate }).parse(req.body);
      await call(req, 'select horizon.unassign_user($1, $2)', [id, b.date]);
      return { ok: true };
    });

    app.post('/users/:id/admin', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ full: z.boolean(), position_ids: z.array(z.uuid()).max(200).default([]) }).parse(req.body);
      await call(req, 'select horizon.grant_admin($1, $2, $3::uuid[])', [id, b.full, b.position_ids]);
      return { ok: true };
    });

    app.post('/users/:id/revoke-sessions', async (req) => {
      const { id } = idParam.parse(req.params);
      const rows = await call(req, 'select horizon.revoke_sessions($1) as n', [id]);
      return { revoked: rows[0]!.n };
    });

    app.post('/users/:id/reset-access', async (req) => {
      const { id } = idParam.parse(req.params);
      const code = newInviteCode();
      await call(req, 'select horizon.reset_access($1, $2, $3)', [id, hashInviteCode(code), config.inviteValidHours]);
      return { code, valid_hours: config.inviteValidHours };
    });

    app.post('/users/:id/active', async (req) => {
      const { id } = idParam.parse(req.params);
      const b = z.object({ active: z.boolean() }).parse(req.body);
      await call(req, 'select horizon.set_user_active($1, $2)', [id, b.active]);
      return { ok: true };
    });

    app.get('/users/:id/history', async (req) => {
      const { id } = idParam.parse(req.params);
      return (await call(req, 'select horizon.user_history($1) as v', [id]))[0]!.v;
    });
  };
