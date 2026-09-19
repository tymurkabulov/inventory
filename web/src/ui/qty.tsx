import { useEffect, useState } from 'react';

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
  onSave: (next: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<number>(value);
  const [typing, setTyping] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setTyping(null);
  }, [value]);

  const dirty = draft !== value;
  const step = (d: number) => {
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
            setTyping(raw);
            const parsed = Number(raw.replace(',', '.'));
            if (raw !== '' && Number.isFinite(parsed)) setDraft(Math.max(0, parsed));
          }}
          onBlur={() => setTyping(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) onSave(draft);
            if (e.key === 'Escape') {
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
      <Button size="sm" variant={dirty ? 'green' : 'plain'} onClick={() => onSave(draft)}>
        {dirty ? saveLabel : t('qty.confirm')}
      </Button>
    </div>
  );
}
