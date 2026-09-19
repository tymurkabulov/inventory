import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Person } from '../../api';
import { todayIso } from '../../format';
import { useT } from '../../i18n';
import { ErrorNote, Field, Input, Select, useToast } from '../../ui';
import { usePositions, useRefreshPeople } from '../queries';
import { ActionBox } from './ActionBox';

export type PlaceMode = 'assign' | 'transfer' | 'unassign';

/** Место человека: назначение, перевод, снятие. Одна форма — одно обращение к серверу. */
export function PlaceForm({
  mode,
  person,
  onDone,
}: {
  mode: PlaceMode;
  person: Person;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const positions = usePositions();
  const refresh = useRefreshPeople();
  const [positionId, setPositionId] = useState('');
  const [date, setDate] = useState(todayIso());

  const save = useMutation({
    mutationFn: () => {
      const base = `/admin/users/${person.id}`;
      if (mode === 'assign') return api.post(`${base}/assign`, { position_id: positionId, date_from: date });
      if (mode === 'transfer') return api.post(`${base}/transfer`, { position_id: positionId, date });
      return api.post(`${base}/unassign`, { date });
    },
    onSuccess: async () => {
      toast(t(`done.${mode}`, { callsign: person.callsign }));
      onDone();
      await refresh();
    },
  });

  // Админ зоны видит в списке только свои места — сервер проверит всё равно.
  const targets = (positions.data ?? []).filter((p) => p.is_active && p.id !== person.position_id);

  if (mode === 'unassign') {
    return (
      <>
        <ActionBox
          title={t('unassign.title', { name: person.position_name ?? '' })}
          submitLabel={t('act.unassign')}
          danger
          busy={save.isPending}
          onCancel={onDone}
          onSubmit={() => save.mutate()}
        >
          <Field label={t('field.unassignDate')}>
            {(id) => <Input id={id} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <p className="text-xs text-muted">{t('unassign.hint')}</p>
        </ActionBox>
        <ErrorNote error={save.error} />
      </>
    );
  }

  return (
    <>
      <ActionBox
        title={mode === 'assign' ? t('assign.title') : t('transfer.title', { name: person.position_name ?? '' })}
        submitLabel={mode === 'assign' ? t('act.assign') : t('act.transfer')}
        busy={save.isPending}
        disabled={!positionId}
        onCancel={onDone}
        onSubmit={() => save.mutate()}
      >
        <Field label={t('field.newPlace')}>
          {(id) => (
            <Select id={id} required value={positionId} onChange={(e) => setPositionId(e.target.value)}>
              <option value="">{t('common.choose')}</option>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={mode === 'assign' ? t('field.dateFrom') : t('field.transferDate')}>
          {(id) => <Input id={id} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        {mode === 'transfer' && <p className="text-xs text-muted">{t('transfer.hint')}</p>}
      </ActionBox>
      <ErrorNote error={save.error} />
    </>
  );
}
