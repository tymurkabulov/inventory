import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { type ReactNode, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { hasSavedLang, isLang, type Lang, useI18n } from './i18n';
import { PageTitleProvider, useLocalState, useMe } from './hooks';
import {
  ConfirmSheet,
  cx,
  Icon,
  type IconName,
  IconButton,
  LanguageSelect,
  Loading,
  TopBar,
} from './ui';

interface Tab {
  label: string;
  to: string;
  icon: IconName;
}

/** Каркас приложения: разделы, заголовок экрана и выход. Содержимое даёт маршрут. */
export function Shell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { t, lang, setLang } = useI18n();
  const me = useMe().data as Me;
  const [theme, setTheme] = useLocalState('hz-theme', 'dark');
  const [page, setPage] = useState<{ title: ReactNode; meta?: ReactNode }>({ title: 'Horizon' });
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const isAdmin = me.admin.full || me.admin.position_ids.length > 0;
  const own = me.assignment;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const saveLocale = useCallback(
    async (locale: Lang) => {
      try {
        await api.post('/me/locale', { locale });
        qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, locale } : m));
      } catch {
        /* язык интерфейса уже сменился; боту — при следующей попытке */
      }
    },
    [qc],
  );

  // Язык из профиля важнее языка устройства: на нём же пишет бот.
  useEffect(() => {
    if (isLang(me.locale)) setLang(me.locale, false);
    else if (hasSavedLang()) void saveLocale(lang);
  }, [me.id, me.locale]);

  // qc.clear() уничтожает и сам запрос профиля — экран остаётся висеть со старыми
  // данными. Поэтому профиль обнуляем явно, а остальные запросы выбрасываем.
  const logout = async () => {
    setLeaving(true);
    await api.post('/auth/logout').catch(() => {});
    qc.setQueryData(['me'], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  };

  // Рядовой видит только своё место — разделов для него нет.
  const tabs: Tab[] = isAdmin
    ? [
        ...(own ? [{ label: t('nav.own'), to: '/me', icon: 'board' as const }] : []),
        { label: t('nav.overview'), to: '/admin', icon: 'board' },
        { label: t('nav.people'), to: '/admin/people', icon: 'people' },
        ...(me.admin.full ? [{ label: t('nav.positions'), to: '/admin/positions', icon: 'pin' as const }] : []),
      ]
    : [];

  const controls = (
    <div className="flex shrink-0 items-center gap-1.5">
      <LanguageSelect onChange={saveLocale} />
      <IconButton
        icon={theme === 'dark' ? 'sun' : 'moon'}
        label={t('nav.theme')}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="size-9"
      />
      <IconButton
        icon="logout"
        label={t('nav.logout')}
        onClick={() => setConfirmLogout(true)}
        className="size-9 border-red text-red-ink hover:bg-red hover:text-white"
      />
    </div>
  );

  return (
    <div className="flex h-dvh">
      {/* Ноутбук: разделы слева и не уезжают при прокрутке. */}
      {tabs.length > 0 && (
        <aside className="hidden w-sidebar shrink-0 flex-col gap-0.5 border-r border-line bg-bg-0 p-3 lg:flex">
          <div className="px-2 pt-2 pb-4 text-xs font-bold tracking-[0.12em] text-muted">HORIZON</div>
          {tabs.map((tab) => (
            <button
              key={tab.to}
              type="button"
              aria-current={path === tab.to ? 'page' : undefined}
              onClick={() => navigate({ to: tab.to })}
              className={cx(
                'flex min-h-touch w-full items-center gap-2 px-2 text-left text-sm',
                path === tab.to ? 'bg-surf-2 font-semibold text-text' : 'text-text hover:bg-surf',
              )}
            >
              <Icon name={tab.icon} className="size-4 text-muted" />
              {tab.label}
            </button>
          ))}
          {/* Кто сейчас в системе: на позиции одним телефоном пользуются по очереди,
              и это должно читаться с расстояния вытянутой руки. */}
          <div className="mt-auto border-t border-line pt-3 text-center" title={me.callsign}>
            <div className="truncate text-base font-bold">{me.callsign}</div>
          </div>
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar title={page.title} meta={page.meta} onBack={path.startsWith('/pos/') ? () => history.back() : undefined}>
          {controls}
        </TopBar>

        {/* Телефон: разделы строкой под заголовком. */}
        {tabs.length > 0 && (
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surf px-3 py-1.5 lg:hidden">
            {tabs.map((tab) => (
              <button
                key={tab.to}
                type="button"
                aria-current={path === tab.to ? 'page' : undefined}
                onClick={() => navigate({ to: tab.to })}
                className={cx(
                  'min-h-9 shrink-0 border px-2.5 text-xs font-semibold whitespace-nowrap',
                  path === tab.to ? 'border-accent bg-surf-2 text-text' : 'border-line bg-surf-2 text-muted',
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <PageTitleProvider onChange={setPage}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </PageTitleProvider>
      </div>

      <ConfirmSheet
        open={confirmLogout}
        title={t('logout.title')}
        confirmLabel={t('nav.logout')}
        busy={leaving}
        onCancel={() => setConfirmLogout(false)}
        onConfirm={logout}
      >
        {t('logout.text')}
      </ConfirmSheet>
    </div>
  );
}
