import { useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { setUnauthorizedHandler } from './api';
import { useT } from './i18n';
import { useMe } from './hooks';
import { createAppRouter } from './router';
import { Login } from './screens/Login';
import { Button, ErrorNote, Loading } from './ui';

/** Вход в приложение: пока профиля нет, маршрутов тоже нет. */
export function App() {
  const qc = useQueryClient();
  const t = useT();
  const me = useMe();
  // Роутер создаётся один раз: useState это гарантирует, useMemo — нет.
  const [router] = useState(() => createAppRouter(qc));

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    });
  }, [qc]);

  if (me.isPending) return <Loading />;
  if (me.error) {
    return (
      <main className="mx-auto max-w-md p-4">
        <ErrorNote error={me.error} />
        <Button className="mt-3" onClick={() => me.refetch()}>
          {t('common.retry')}
        </Button>
      </main>
    );
  }
  if (!me.data) return <Login />;
  return <RouterProvider router={router} />;
}
