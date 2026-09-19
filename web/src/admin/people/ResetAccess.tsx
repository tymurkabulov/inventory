import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Person } from '../../api';
import { useT } from '../../i18n';
import { ErrorNote } from '../../ui';
import { useRefreshPeople } from '../queries';
import { ActionBox } from './ActionBox';
import { CodeReveal } from './CodeReveal';

/** Сброс доступа: пароль и код из приложения перестают работать, выдаётся новый одноразовый код. */
export function ResetAccess({ person, onDone }: { person: Person; onDone: () => void }) {
  const t = useT();
  const refresh = useRefreshPeople();
  const [code, setCode] = useState<{ code: string; valid_hours: number } | null>(null);

  const reset = useMutation({
    mutationFn: () => api.post<{ code: string; valid_hours: number }>(`/admin/users/${person.id}/reset-access`),
    onSuccess: async (data) => {
      setCode(data);
      await refresh();
    },
  });

  if (code) return <CodeReveal callsign={person.callsign} code={code.code} hours={code.valid_hours} />;

  return (
    <>
      <ActionBox
        title={t('act.reset')}
        submitLabel={t('reset.submit')}
        danger
        busy={reset.isPending}
        onCancel={onDone}
        onSubmit={() => reset.mutate()}
      >
        <p className="text-xs text-muted">{t('reset.text')}</p>
      </ActionBox>
      <ErrorNote error={reset.error} />
    </>
  );
}
