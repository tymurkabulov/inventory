import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId, useRef } from 'react';

import { useT } from '../i18n';

import { cx } from './cx';

import { Icon } from './icons';

const FIELD = 'min-h-touch w-full border border-line bg-bg-0 px-3 text-sm text-text placeholder:text-faint focus:outline-none';

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold text-muted">
      {children}
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {error ? (
        <p className="mt-1.5 text-xs text-red-ink">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(FIELD, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(FIELD, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(FIELD, 'min-h-20 resize-y py-2.5', className)} />;
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-touch cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span className="grid size-5 shrink-0 place-items-center border border-line bg-bg-0 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
        <Icon name="check" className="size-3.5 text-accent-ink opacity-0 peer-checked:opacity-100" />
      </span>
      {label}
    </label>
  );
}

/** Код из приложения: шесть клеток, вводится одной рукой. */
export function OtpInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const t = useT();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');

  const setAt = (i: number, digit: string) => {
    const next = value.padEnd(6, ' ').split('');
    next[i] = digit || ' ';
    onChange(next.join('').replace(/\s/g, '').slice(0, 6));
  };

  return (
    <div className="flex gap-1.5" role="group" aria-label={t('login.totp')}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          autoFocus={autoFocus && i === 0}
          aria-label={`${t('login.totp')} ${i + 1}`}
          value={d.trim()}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            if (raw.length > 1) {
              onChange(raw.slice(0, 6));
              boxes.current[Math.min(raw.length, 5)]?.focus();
              return;
            }
            setAt(i, raw);
            if (raw) boxes.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !e.currentTarget.value) boxes.current[i - 1]?.focus();
          }}
          className="tnum size-12 border border-line bg-bg-0 text-center text-xl font-bold text-text focus:outline-none"
        />
      ))}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={cx('flex min-h-touch min-w-0 flex-1 items-center gap-2 border border-line bg-bg-0 px-3', className)}>
      <Icon name="search" className="size-4 text-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full border-none bg-transparent text-sm text-text outline-none placeholder:text-faint"
      />
    </label>
  );
}
