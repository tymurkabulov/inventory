import { api } from '../api';
import { useT } from '../i18n';
import { Button, Empty } from '../ui';

/**
 * Экран не смог загрузиться. Устаревший после выкатки кусок кода сюда не
 * доходит — его перезагрузкой лечит обработчик vite:preloadError в main.tsx.
 * Здесь остаются связь, сервер и сломанная сессия.
 */
export function LoadFailed() {
  const t = useT();
  return (
    <div className="p-3">
      <Empty title={t('load.failedTitle')}>{t('load.failedText')}</Empty>
      <div className="mt-3 flex gap-2">
        <Button variant="blue" onClick={() => location.reload()}>
          {t('common.reload')}
        </Button>
        {/* Если сломана сама сессия, «Обновить» возвращает на этот же экран.
            Выход стирает cookie на сервере — дальше обычный вход. */}
        <Button variant="plain" onClick={() => api.post('/auth/logout').finally(() => location.assign('/'))}>
          {t('nav.logout')}
        </Button>
      </div>
    </div>
  );
}
