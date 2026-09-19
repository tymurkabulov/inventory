import { useEffect } from 'react';
import { useT } from '../i18n';
import { Button, Empty } from '../ui';

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|ChunkLoadError/i;
const RETRIED = 'hz-chunk-retry';

/** Экран загрузился — значит следующая выкатка снова вправе перезагрузить страницу сама. */
export function clearReloadGuard() {
  try {
    sessionStorage.removeItem(RETRIED);
  } catch {
    /* приватный режим */
  }
}

/**
 * Экран не смог загрузиться. Чаще всего это выкатили новую версию: кусок кода
 * со старым именем уже не отдаётся. Один раз перезагружаемся сами, дальше —
 * руками, чтобы не зациклиться на плохой связи.
 */
export function LoadFailed({ error }: { error: unknown }) {
  const t = useT();
  const message = error instanceof Error ? error.message : String(error ?? '');
  const isChunk = CHUNK_ERROR.test(message);

  useEffect(() => {
    if (!isChunk) return;
    try {
      if (sessionStorage.getItem(RETRIED)) return;
      sessionStorage.setItem(RETRIED, '1');
    } catch {
      return; // приватный режим — тогда только кнопкой
    }
    location.reload();
  }, [isChunk]);

  return (
    <div className="p-3">
      <Empty title={t('load.failedTitle')}>{isChunk ? t('load.failedNewVersion') : t('load.failedText')}</Empty>
      <Button variant="blue" className="mt-3" onClick={() => location.reload()}>
        {t('common.reload')}
      </Button>
    </div>
  );
}
