import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Person } from '../../api';
import { useT } from '../../i18n';
import { Checkbox, ErrorNote, useToast } from '../../ui';
import { usePositions, useRefreshPeople } from '../queries';
import { ActionBox } from './ActionBox';

/** Права: полный админ или список своих позиций. */
export function RightsForm({ person, onDone }: { person: Person; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const positions = usePositions();
  const refresh = useRefreshPeople();
  const [full, setFull] = useState(person.is_full_admin);
  const [zones, setZones] = useState<string[]>(person.admin_position_ids);

  const save = useMutation({
    mutationFn: () => api.post(`/admin/users/${person.id}/admin`, { full, position_ids: full ? [] : zones }),
    onSuccess: async () => {
      toast(t('done.rights', { callsign: person.callsign }));
      onDone();
      await refresh();
    },
  });

  return (
    <>
      <ActionBox
        title={t('act.rights')}
        submitLabel={t('common.save')}
        busy={save.isPending}
        onCancel={onDone}
        onSubmit={() => save.mutate()}
      >
        <Checkbox label={t('rights.full')} checked={full} onChange={setFull} />
        {!full && (
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-xs font-semibold text-muted">{t('rights.zone')}</legend>
            {(positions.data ?? []).map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                checked={zones.includes(p.id)}
                onChange={(on) => setZones((z) => (on ? [...z, p.id] : z.filter((x) => x !== p.id)))}
              />
            ))}
            <p className="text-xs text-muted">{t('rights.none')}</p>
          </fieldset>
        )}
      </ActionBox>
      <ErrorNote error={save.error} />
    </>
  );
}
