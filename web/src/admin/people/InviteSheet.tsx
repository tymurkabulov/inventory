import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { useT } from '../../i18n';
import { Button, ErrorNote, Field, Input, Sheet } from '../../ui';
import { CodeReveal } from './CodeReveal';

/** Новый человек: логин и позывной — и одноразовый код в ответ. */
export function InviteSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const t = useT();
  const [login, setLogin] = useState('');
  const [callsign, setCallsign] = useState('');

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ id: string; code: string; valid_hours: number }>('/admin/users', { login, callsign }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'people'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={invite.data ? t('invite.codeTitle') : t('invite.title')}
      footer={
        invite.data ? (
          <>
            <Button
              variant="blue"
              block
              onClick={() => {
                onCreated(invite.data.id);
                onClose();
              }}
            >
              {t('invite.assign')}
            </Button>
            <Button variant="gray" block onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="green" icon="check" block type="submit" form="invite-form" busy={invite.isPending}>
              {t('invite.create')}
            </Button>
            <Button variant="gray" block onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </>
        )
      }
    >
      {invite.data ? (
        <CodeReveal callsign={callsign} code={invite.data.code} hours={invite.data.valid_hours} />
      ) : (
        <form id="invite-form" onSubmit={submit} className="flex flex-col gap-3">
          <Field label={t('login.login')} hint={t('invite.loginHint')}>
            {(id) => (
              <Input
                id={id}
                required
                minLength={3}
                maxLength={32}
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                value={login}
                onChange={(e) => setLogin(e.target.value.toLowerCase())}
              />
            )}
          </Field>
          <Field label={t('login.callsign')} hint={t('invite.callsignHint')}>
            {(id) => (
              <Input
                id={id}
                required
                minLength={2}
                maxLength={32}
                value={callsign}
                onChange={(e) => setCallsign(e.target.value)}
              />
            )}
          </Field>
          <ErrorNote error={invite.error} />
        </form>
      )}
    </Sheet>
  );
}
