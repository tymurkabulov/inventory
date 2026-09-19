import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    // Экран ожидания сам переключится на таблицу после посадки.
    refetchInterval: (q) => (q.state.data && !q.state.data.assignment ? 10_000 : 30_000),
  });
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useLocalState(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    (v: string) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* приватный режим — не критично */
      }
    },
  ];
}

// ---------------------------------------------------------------------------
// Заголовок в шапке принадлежит экрану: на телефоне это главная подпись,
// по которой человек понимает, где он.
// ---------------------------------------------------------------------------
interface PageTitle {
  title: ReactNode;
  meta?: ReactNode;
}

const PageTitleCtx = createContext<(v: PageTitle) => void>(() => {});

export function PageTitleProvider({ children, onChange }: { children: ReactNode; onChange: (v: PageTitle) => void }) {
  return <PageTitleCtx.Provider value={onChange}>{children}</PageTitleCtx.Provider>;
}

export function usePageTitle(title: ReactNode, meta?: ReactNode) {
  const set = useContext(PageTitleCtx);
  useEffect(() => {
    set({ title, meta });
  }, [set, title, meta]);
}
