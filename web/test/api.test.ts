import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '../src/api';

/** fetch, который не отвечает никогда, но честно реагирует на abort. */
const hangingFetch = () =>
  vi.stubGlobal(
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );

const failure = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);

describe('запрос к API', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('зависший запрос отваливается по таймауту, а не висит вечно', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const pending = failure(api.get('/me'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toMatchObject({ code: 'timeout' });
  });

  it('отмена снаружи не выдаётся за сбой связи', async () => {
    hangingFetch();
    const ctrl = new AbortController();

    const pending = failure(api.get('/me', ctrl.signal));
    ctrl.abort();

    const err = await pending;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(String(err)).toMatch(/abort/i);
  });

  it('обрыв связи даёт код network', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await failure(api.get('/me'))).toMatchObject({ status: 0, code: 'network' });
  });

  it('ошибка сервера доносит код до интерфейса', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'строку уже изменили', code: 'item_changed' }), { status: 409 })),
    );
    expect(await failure(api.get('/me'))).toMatchObject({ status: 409, code: 'item_changed' });
  });
});
