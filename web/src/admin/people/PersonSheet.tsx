import { useState } from 'react';
import type { Me, Person } from '../../api';
import { fmtAgo, useI18n } from '../../i18n';
import { useNow } from '../../hooks';
import { Box, Button, Sheet, Tag } from '../../ui';
import { PersonHistory } from './PersonHistory';
import { PlaceForm, type PlaceMode } from './PlaceForm';
import { ResetAccess } from './ResetAccess';
import { RightsForm } from './RightsForm';
import { SessionActions } from './SessionActions';

type Action = null | PlaceMode | 'rights' | 'reset';

/** Карточка человека: сводка, меню действий и история. Само действие живёт в своей форме. */
export function PersonSheet({ me, person, onClose }: { me: Me; person: Person; onClose: () => void }) {
  const { t, lang } = useI18n();
  const now = useNow();
  const [action, setAction] = useState<Action>(null);

  const isSelf = person.id === me.id;
  const canManagePlace =
    person.is_active && (me.admin.full || !person.position_id || me.admin.position_ids.includes(person.position_id));

  return (
    <Sheet open title={person.callsign} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <Box label={t('person.current')}>
          <span className="text-sm">{person.position_name ?? '—'}</span>
        </Box>
        <Box label={t('person.login')}>
          <span className="font-mono text-sm">{person.login}</span>
        </Box>
        <Box label={t('people.colSeen')}>
          <span className="text-sm">{person.last_seen_at ? fmtAgo(lang, person.last_seen_at, now) : t('people.neverSeen')}</span>
        </Box>
      </div>

      <div className="flex flex-wrap gap-1">
        {person.is_full_admin && <Tag>{t('tag.full')}</Tag>}
        {!person.is_full_admin && person.admin_position_ids.length > 0 && <Tag>{t('tag.zone')}</Tag>}
        {!person.is_active && <Tag>{t('tag.inactive')}</Tag>}
        {person.invite_pending && <Tag>{t('tag.invite')}</Tag>}
        <Tag>{t('person.sessions', { count: person.sessions })}</Tag>
      </div>

      {action === null && (canManagePlace || me.admin.full) && (
        <div className="flex flex-col gap-2">
          {canManagePlace &&
            (!person.position_id ? (
              <Button variant="blue" block onClick={() => setAction('assign')}>
                {t('act.assign')}
              </Button>
            ) : (
              <>
                <Button variant="blue" block onClick={() => setAction('transfer')}>
                  {t('act.transfer')}
                </Button>
                <Button variant="gray" block onClick={() => setAction('unassign')}>
                  {t('act.unassign')}
                </Button>
              </>
            ))}
          {me.admin.full && person.is_active && (
            <>
              <Button variant="gray" block onClick={() => setAction('rights')}>
                {t('act.rights')}
              </Button>
              <Button variant="gray" block onClick={() => setAction('reset')}>
                {t('act.reset')}
              </Button>
            </>
          )}
          {me.admin.full && <SessionActions person={person} isSelf={isSelf} />}
        </div>
      )}

      {(action === 'assign' || action === 'transfer' || action === 'unassign') && (
        <PlaceForm mode={action} person={person} onDone={() => setAction(null)} />
      )}
      {action === 'rights' && <RightsForm person={person} onDone={() => setAction(null)} />}
      {action === 'reset' && <ResetAccess person={person} onDone={() => setAction(null)} />}

      <PersonHistory personId={person.id} />
    </Sheet>
  );
}
