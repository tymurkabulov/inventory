import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useCanGoBack, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useEffectEvent, useState } from 'react';
import { api, type Me } from './api';
import { hasSavedLang, isLang, type Lang, useI18n } from './i18n';
import { useLocalState, useMe } from './hooks';
import {
  ConfirmSheet,
  Icon,
  type IconName,
  IconButton,
  LanguageSelect,
  PageTitleSlot,
  TopBar,
} from './ui';

interface Tab {
  label: string;
  // Маршрут, а не строка: опечатку в разделе поймает TypeScript.
  to: '/me' | '/admin' | '/admin/people' | '/admin/positions';
  icon: IconName;
}

/** Каркас приложения: разделы, заголовок экрана и выход. Содержимое даёт маршрут. */
export function Shell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { t, lang, setLang } = useI18n();
  const me = useMe().data as Me;
  const [theme, setTheme] = useLocalState('hz-theme', 'dark');
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const isAdmin = me.admin.full || me.admin.position_ids.length > 0;
  const own = me.assignment;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const saveLocale = async (locale: Lang) => {
    try {
      await api.post('/me/locale', { locale });
      qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, locale } : m));
    } catch {
      /* язык интерфейса уже сменился на экране; в профиль — при следующей попытке */
    }
  };

  // Язык из профиля важнее языка устройства. Срабатывает на приход профиля, а не
  // на смену языка: переключатель в шапке сам зовёт saveLocale, и реакция на lang
  // означала бы повторную отправку на каждое переключение. Поэтому lang читается
  // из события эффекта, а не из его зависимостей.
  const syncLocale = useEffectEvent((locale: string | null) => {
    if (isLang(locale)) setLang(locale, false);
    else if (hasSavedLang()) void saveLocale(lang);
  });
  useEffect(() => syncLocale(me.locale), [me.id, me.locale]);

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
        ...(own ? [{ label: t('nav.own'), to: '/me', icon: 'board' } satisfies Tab] : []),
        { label: t('nav.overview'), to: '/admin', icon: 'board' },
        { label: t('nav.people'), to: '/admin/people', icon: 'people' },
        ...(me.admin.full ? [{ label: t('nav.positions'), to: '/admin/positions', icon: 'pin' } satisfies Tab] : []),
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
            <Link
              key={tab.to}
              to={tab.to}
              // exact: «Панель» (/admin) не должна гореть на /admin/people.
              activeOptions={{ exact: true }}
              className="flex min-h-touch w-full items-center gap-2 px-2 text-left text-sm text-text"
              activeProps={{ className: 'bg-surf-2 font-semibold' }}
              inactiveProps={{ className: 'hover:bg-surf' }}
            >
              <Icon name={tab.icon} className="size-4 text-muted" />
              {tab.label}
            </Link>
          ))}
          {/* Кто сейчас в системе: на позиции одним телефоном пользуются по очереди,
              и это должно читаться с расстояния вытянутой руки. */}
          <div className="mt-auto border-t border-line pt-3 text-center" title={me.callsign}>
            <div className="truncate text-base font-bold">{me.callsign}</div>
          </div>
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar
          titleRef={setTitleSlot}
          // Доску могли открыть прямой ссылкой — тогда «назад» ведёт на панель, а не с сайта.
          onBack={
            path.startsWith('/pos/')
              ? () => (canGoBack ? router.history.back() : navigate({ to: '/admin' }))
              : undefined
          }
        >
          {controls}
        </TopBar>

        {/* Телефон: разделы строкой под заголовком. */}
        {tabs.length > 0 && (
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surf px-3 py-1.5 lg:hidden">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                activeOptions={{ exact: true }}
                className="flex min-h-9 shrink-0 items-center border bg-surf-2 px-2.5 text-xs font-semibold whitespace-nowrap"
                activeProps={{ className: 'border-accent text-text' }}
                inactiveProps={{ className: 'border-line text-muted' }}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        )}

        <PageTitleSlot value={titleSlot}>
          <Outlet />
        </PageTitleSlot>
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
