import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';

import { Button } from './buttons';

// ---------------------------------------------------------------------------
// Правка остатка: −, значение, +, «Сохранить». Кнопка включается, когда
// число изменили, и не даёт сохранить случайное касание.
// ---------------------------------------------------------------------------
export function QtyStepper({
  value,
  saveLabel,
  onSave,
}: {
  value: number;
  saveLabel: string;
  /** expected — остаток, от которого считали: сервер откажет, если его уже поменяли. */
  onSave: (next: number, expected: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<number>(value);
  const [typing, setTyping] = useState<string | null>(null);
  // Человек начал править число. Ref, а не state: перерисовывать от этого нечего,
  // а эффекту ниже нужно свежее значение, не попадая к себе же в зависимости.
  const touched = useRef(false);
  // Число с сервера, от которого начали править. Пока правка не сохранена,
  // оно не двигается вместе с доской — иначе сервер не заметит чужую правку.
  const base = useRef(value);

  // Пока правку не сохранили, обновление доски (раз в 30 с или с чужого телефона)
  // её не трогает: иначе набранное число исчезает под пальцами.
  useEffect(() => {
    if (touched.current) return;
    base.current = value;
    setDraft(value);
    setTyping(null);
  }, [value]);

  /** Сохранение снимает защиту: дальше строка снова следует за сервером. */
  const commit = (next: number) => {
    touched.current = false;
    onSave(next, base.current);
    base.current = value;
  };

  const dirty = draft !== value;
  const step = (d: number) => {
    touched.current = true;
    setTyping(null);
    setDraft((v) => Math.max(0, Math.round((v + d) * 100) / 100));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center">
        <button
          type="button"
          aria-label={t('qty.minus')}
          onClick={() => step(-1)}
          className="size-touch border border-line bg-surf-2 text-lg text-text hover:bg-surf-3"
        >
          −
        </button>
        <input
          inputMode="decimal"
          enterKeyHint="done"
          aria-label={t('qty.label', { unit: '' })}
          value={typing ?? String(draft)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^\d.,]/g, '');
            touched.current = true;
            setTyping(raw);
            const parsed = Number(raw.replace(',', '.'));
            if (raw !== '' && Number.isFinite(parsed)) setDraft(Math.max(0, parsed));
          }}
          onBlur={() => setTyping(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) commit(draft);
            if (e.key === 'Escape') {
              touched.current = false;
              base.current = value;
              setTyping(null);
              setDraft(value);
            }
          }}
          className="tnum h-touch w-14 border-y border-line bg-bg-0 text-center text-sm font-bold text-text focus:outline-none"
        />
        <button
          type="button"
          aria-label={t('qty.plus')}
          onClick={() => step(1)}
          className="size-touch border border-line bg-surf-2 text-lg text-text hover:bg-surf-3"
        >
          +
        </button>
      </div>
      {/* Число не трогали — значит «перевірив, все на місці»: сохраняем как есть,
          строка перестаёт быть просроченной. */}
      <Button size="sm" variant={dirty ? 'green' : 'plain'} onClick={() => commit(draft)}>
        {dirty ? saveLabel : t('qty.confirm')}
      </Button>
    </div>
  );
}
