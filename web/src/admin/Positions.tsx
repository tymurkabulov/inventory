import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, type PositionRow } from '../api';
import { useT } from '../i18n';
import {
  BottomBar,
  Button,
  Checkbox,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  PageTitle,
  Sheet,
  Tag,
} from '../ui';
import { usePositions } from './queries';

export function Positions() {
  const t = useT();
  const positions = usePositions();
  const [editing, setEditing] = useState<PositionRow | 'new' | null>(null);


  return (
    <>
      <PageTitle
        title={t('nav.positions')}
        meta={positions.data ? t('pos.count', { count: positions.data.length }) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-3">
          <div className="hidden self-start lg:block">
            <Button variant="blue" icon="plus" onClick={() => setEditing('new')}>
              {t('pos.add')}
            </Button>
          </div>

          {positions.isPending ? (
            <Loading />
          ) : positions.error ? (
            <ErrorNote error={positions.error} />
          ) : positions.data.length === 0 ? (
            <Empty title={t('ov.noLocations')}>{t('pos.emptyHint')}</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {positions.data.map((p) => (
                <div key={p.id} className="flex min-h-16 flex-wrap items-center gap-2 border border-line bg-surf p-2.5">
                  <Link to="/pos/$positionId" params={{ positionId: p.id }} className="min-w-0 flex-1 text-left">
                    <b className="flex items-center gap-2">
                      <span className="truncate">{p.name}</span>
                      {!p.is_active && <Tag>{t('board.disabled').replace(/^[\s·]+/, '')}</Tag>}
                    </b>
                    <span className="block truncate text-xs text-muted">
                      {t('pos.staleAfter', { hours: p.stale_after_hours })}
                    </span>
                  </Link>
                  <Button size="sm" variant="plain" onClick={() => setEditing(p)}>
                    {t('pos.edit')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <BottomBar>
        <Button variant="blue" icon="plus" block onClick={() => setEditing('new')}>
          {t('pos.add')}
        </Button>
      </BottomBar>

      {editing && <PositionSheet position={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PositionSheet({ position, onClose }: { position: PositionRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const t = useT();
  const [name, setName] = useState(position?.name ?? '');
  const [stale, setStale] = useState(String(position?.stale_after_hours ?? 24));
  const [active, setActive] = useState(position?.is_active ?? true);

  const save = useMutation({
    mutationFn: () =>
      api.post('/admin/positions', { id: position?.id, name, stale_after_hours: Number(stale), is_active: active }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin'] });
      await qc.invalidateQueries({ queryKey: ['board'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={position ? t('pos.edit') : t('pos.new')}
      footer={
        <>
          <Button variant="green" icon="check" block type="submit" form="pos-form" busy={save.isPending}>
            {t('common.save')}
          </Button>
          <Button variant="gray" block onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      <form id="pos-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('pos.name')} hint={t('pos.nameHint')}>
          {(id) => <Input id={id} required maxLength={64} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t('pos.staleHours')} hint={t('pos.staleHint')}>
          {(id) => (
            <Input id={id} type="number" min={1} max={720} required value={stale} onChange={(e) => setStale(e.target.value)} />
          )}
        </Field>
        {position && <Checkbox label={t('pos.active')} checked={active} onChange={setActive} />}
        <ErrorNote error={save.error} />
      </form>
    </Sheet>
  );
}
