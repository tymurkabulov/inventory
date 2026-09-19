import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeForDbMessage } from '../src/errors.js';
import { migrationsDir } from '../src/migrate.js';

describe('коды ошибок', () => {
  // Каждый raise в миграциях должен превращаться в код, иначе клиент покажет русский текст.
  const messages = readdirSync(migrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .flatMap((f) => [...readFileSync(`${migrationsDir()}/${f}`, 'utf8').matchAll(/raise exception '([^']*)'/g)])
    .map((m) => m[1]!.replaceAll('%', 'X'));

  it.each([...new Set(messages)])('%s', (message) => {
    expect(codeForDbMessage(message)?.code).toBeTruthy();
  });

  it('параметры достаются из текста', () => {
    expect(codeForDbMessage('позывной «Гром» уже занят')).toEqual({ code: 'callsign_taken', params: { callsign: 'Гром' } });
    expect(codeForDbMessage('дата перевода раньше даты захода (01.09.2026)')).toEqual({
      code: 'transfer_before_start',
      params: { date: '01.09.2026' },
    });
    expect(codeForDbMessage('что-то новое')).toBeNull();
  });
});
