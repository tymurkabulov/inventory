import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Person } from '../../api';
import { useT } from '../../i18n';
import { Button, ConfirmSheet, ErrorNote, useToast } from '../../ui';
import { useRefreshPeople } from '../queries';

type Kind = 'revoke' | 'activate' | 'deactivate';

/** Сессии и учётная запись: выкинуть из системы, выключить и включить обратно. */
export function SessionActions({ person, isSelf }: { person: Person; isSelf: boolean }) {
  const t = useT();
  const toast = useToast();
  const refresh = useRefreshPeople();
  const [confirmOff, setConfirmOff] = useState(false);

  const run = useMutation({
    mutationFn: (kind: Kind) => {
      const base = `/admin/users/${person.id}`;
      if (kind === 'revoke') return api.post(`${base}/revoke-sessions`);
      return api.post(`${base}/active`, { active: kind === 'activate' });
    },
    onSuccess: async (_data, kind) => {
      toast(t(`done.${kind}`, { callsign: person.callsign }));
      setConfirmOff(false);
      await refresh();
    },
  });

  if (!person.is_active) {
    return (
      <>
        <Button variant="green" icon="check" block busy={run.isPending} onClick={() => run.mutate('activate')}>
          {t('act.activate')}
        </Button>
        <ErrorNote error={run.error} />
      </>
    );
  }

  return (
    <>
      <Button
        variant="red"
        block
        busy={run.isPending && run.variables === 'revoke'}
        onClick={() => run.mutate('revoke')}
      >
        {t('act.revoke')}
      </Button>
      {/* Себя выключить нельзя: иначе админ запрёт сам себя. */}
      {!isSelf && (
        <Button variant="red" block onClick={() => setConfirmOff(true)}>
          {t('act.deactivate')}
        </Button>
      )}
      <ErrorNote error={run.error} />

      <ConfirmSheet
        open={confirmOff}
        title={t('act.deactivate')}
        confirmLabel={t('act.confirmDeactivate')}
        busy={run.isPending}
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => run.mutate('deactivate')}
      >
        {t('person.confirmDeactivate', { callsign: person.callsign })}
      </ConfirmSheet>
    </>
  );
}
