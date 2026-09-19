import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, type Me, type Person } from '../../api';
import { fmtDate } from '../../format';
import { fmtAgo, useI18n } from '../../i18n';
import { useNow, usePageTitle } from '../../hooks';
import {
  BottomBar,
  Button,
  Checkbox,
  Empty,
  ErrorNote,
  Icon,
  Loading,
  SearchInput,
  StickyTools,
  Tag,
} from '../../ui';
import { InviteSheet } from './InviteSheet';
import { PersonSheet } from './PersonSheet';

/** Список людей: поиск, фильтр «без места» и вход в карточку человека. */
export function People({ me }: { me: Me }) {
  const { t, lang } = useI18n();
  const now = useNow();
  const people = useQuery({ queryKey: ['admin', 'people'], queryFn: () => api.get<Person[]>('/admin/people') });
  const [selected, setSelected] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyWaiting, setOnlyWaiting] = useState(false);

  usePageTitle(t('nav.people'), people.data ? t('people.count', { count: people.data.length }) : undefined);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people.data ?? []).filter(
      (p) =>
        (!q ||
          p.callsign.toLowerCase().includes(q) ||
          p.login.includes(q) ||
          (p.position_name ?? '').toLowerCase().includes(q)) &&
        (!onlyWaiting || (p.is_active && !p.position_id)),
    );
  }, [people.data, query, onlyWaiting]);

  const person = people.data?.find((p) => p.id === selected) ?? null;
  const waiting = (people.data ?? []).filter((p) => p.is_active && !p.position_id).length;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <StickyTools>
          <div className="flex flex-wrap gap-2">
            <SearchInput value={query} onChange={setQuery} placeholder={t('people.search')} className="min-w-35" />
            <div className="hidden lg:block">
              <Button variant="blue" icon="plus" onClick={() => setInviting(true)}>
                {t('people.add')}
              </Button>
            </div>
          </div>
          <div className="mt-1">
            <Checkbox label={t('people.waiting', { count: waiting })} checked={onlyWaiting} onChange={setOnlyWaiting} />
          </div>
        </StickyTools>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {people.isPending ? (
            <Loading />
          ) : people.error ? (
            <ErrorNote error={people.error} />
          ) : list.length === 0 ? (
            <Empty title={t('people.none')} />
          ) : (
            <div className="flex flex-col gap-1.5">
              {list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(p.id)}
                  className="flex min-h-16 w-full items-center gap-2.5 border border-line bg-surf p-2.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <b className={p.is_active ? '' : 'text-muted line-through'}>{p.callsign}</b>
                    <span className="block truncate text-xs text-muted">
                      <span className="font-mono">{p.login}</span> ·{' '}
                      {p.position_id
                        ? `${p.position_name} · ${t('common.since', { date: fmtDate(p.date_from) })}`
                        : t('people.noPlace')}
                      {' · '}
                      {p.last_seen_at ? t('people.seen', { ago: fmtAgo(lang, p.last_seen_at, now) }) : t('people.neverSeen')}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {p.is_full_admin && <Tag>{t('tag.full')}</Tag>}
                      {!p.is_full_admin && p.admin_position_ids.length > 0 && <Tag>{t('tag.zone')}</Tag>}
                      {!p.is_active && <Tag>{t('tag.inactive')}</Tag>}
                      {p.invite_pending && <Tag>{t('tag.invite')}</Tag>}
                    </span>
                  </span>
                  <Icon name="chevron" className="size-4 shrink-0 text-muted" />
                </button>
              ))}
            </div>
          )}
        </div>

        <BottomBar>
          <Button variant="blue" icon="plus" block onClick={() => setInviting(true)}>
            {t('people.add')}
          </Button>
        </BottomBar>
      </div>

      {inviting && <InviteSheet onClose={() => setInviting(false)} onCreated={(id) => setSelected(id)} />}
      {person && <PersonSheet me={me} person={person} onClose={() => setSelected(null)} />}
    </>
  );
}
