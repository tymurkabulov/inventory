import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { I18nProvider } from './i18n';
import { ToastProvider } from './ui';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        if (err instanceof ApiError) {
          if (err.status >= 400 && err.status < 500) return false;
          // Нет связи или сервер молчит. Каждая попытка — это ещё 15 с таймаута,
          // а человек всё это время смотрит на пустой экран: пробуем один раз.
          if (err.status === 0) return count < 1;
        }
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});

// После выкатки куски кода со старыми именами сервер уже не отдаёт. Vite сообщает
// об этом событием: перезагружаемся за новой версией. Не чаще раза в 10 секунд —
// если кусок не грузится из-за связи, ошибка дойдёт до экрана с кнопками, а не
// зациклит перезагрузку. Без sessionStorage (приватный режим) не рискуем вовсе.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('hz-reloaded-at') ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('hz-reloaded-at', String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <App />
          </ToastProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
