import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, lazy, Suspense, useState } from 'react';
import { api } from '../api';
import { useLocalState } from '../hooks';
import { useT } from '../i18n';
import { Button, cx, ErrorNote, Field, Input, Label, LanguageSelect, Loading, OtpInput, useToast } from '../ui';

// Генератор QR весит прилично, а нужен один раз — на втором шаге первого входа.
const Qr = lazy(() => import('./Qr').then((m) => ({ default: m.Qr })));

// Первый вход — мастер: код → приложение → пароль → подтверждение.
// На каждом шаге одно действие: так его проходят с телефона в перчатках.
type SetupStep = 1 | 2 | 3 | 4;
type Screen = { kind: 'login' } | { kind: 'setup'; step: SetupStep };

export function Login() {
  const qc = useQueryClient();
  const t = useT();
  const toast = useToast();
  const [login, setLogin] = useLocalState('hz-login', '');
  const [screen, setScreen] = useState<Screen>(login ? { kind: 'login' } : { kind: 'setup', step: 1 });
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [otpauth, setOtpauth] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const done = () => qc.invalidateQueries({ queryKey: ['me'] });

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    setError(null);
    setPassword('');
    setPassword2('');
    setTotp('');
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const name = login.trim();

    if (screen.kind === 'login') {
      return run(async () => {
        await api.post('/auth/login', { login: name, password, totp });
        await done();
      });
    }

    // Шаг 1: код проверяем сразу и получаем секрет для приложения.
    if (screen.step === 1) {
      return run(async () => {
        await api.post('/auth/code', { login: name, code });
        const res = await api.post<{ secret: string; otpauth: string }>('/auth/totp-secret', { login: name, code });
        setSecret(res.secret);
        setOtpauth(res.otpauth);
        setScreen({ kind: 'setup', step: 2 });
      });
    }
    if (screen.step === 2) {
      setScreen({ kind: 'setup', step: 3 });
      return;
    }
    if (screen.step === 3) {
      if (password !== password2) return setError(new Error(t('login.passwordMismatch')));
      setError(null);
      setScreen({ kind: 'setup', step: 4 });
      return;
    }
    return run(async () => {
      await api.post('/auth/setup', { login: name, code, password, secret, totp });
      await done();
    });
  }

  const step = screen.kind === 'setup' ? screen.step : null;
  const title =
    screen.kind === 'login'
      ? t('login.title.login')
      : step === 1
        ? t('login.title.code')
        : step === 2
          ? t('login.qrTitle')
          : step === 3
            ? t('login.password')
            : t('login.totp');

  const submitLabel = screen.kind === 'login' ? t('login.enter') : step === 4 ? t('login.saveAndEnter') : t('login.next');

  const loginField = (
    <Field label={t('login.login')} hint={t('login.loginHint')}>
      {(id) => (
        <Input
          id={id}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={3}
          maxLength={32}
          autoFocus={!login}
          value={login}
          onChange={(e) => setLogin(e.target.value.toLowerCase())}
        />
      )}
    </Field>
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-100 flex-col justify-center px-4 py-7">
      {/* Карточка: на ноутбуке форма не висит посреди пустого экрана. */}
      <div className="border border-line bg-surf p-5">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold tracking-[0.14em] text-muted uppercase">HORIZON</div>
            <h1 className="my-2 text-2xl font-semibold">{title}</h1>
          </div>
          <LanguageSelect />
        </div>

        <p className="text-xs text-muted">{screen.kind === 'login' ? t('login.tagline') : t('login.codeIntro')}</p>

        {screen.kind === 'setup' && (
          <div className="my-3 flex gap-1">
            {[1, 2, 3, 4].map((n) => (
              <i key={n} aria-hidden className={cx('h-[3px] flex-1', n <= (step ?? 1) ? 'bg-accent' : 'bg-surf-3')} />
            ))}
          </div>
        )}

        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          {screen.kind === 'login' && (
            <>
              {loginField}
              <Field label={t('login.password')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={8}
                    maxLength={100}
                    autoFocus={!!login}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <div>
                <Label>{t('login.totp')}</Label>
                <OtpInput value={totp} onChange={setTotp} />
                <p className="mt-1.5 text-xs text-muted">{t('login.totpHint')}</p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              {loginField}
              <Field label={t('login.code')} hint={t('login.codeHint')}>
                {(id) => (
                  <Input
                    id={id}
                    required
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    placeholder="XXXX-XXXX"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    className="text-center font-mono text-lg tracking-[0.08em]"
                  />
                )}
              </Field>
            </>
          )}

          {step === 2 && (
            <Suspense fallback={<Loading />}>
              <Qr
                otpauth={otpauth}
                secret={secret}
                onCopy={(ok) => toast(ok ? t('login.qrCopied') : t('common.copyFailed'), ok ? 'success' : 'warn')}
              />
            </Suspense>
          )}

          {step === 3 && (
            <>
              <Field label={t('login.password')} hint={t('login.passwordHint')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={100}
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('login.repeatPassword')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={100}
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-xs text-muted">{t('login.confirmIntro')}</p>
              <div>
                <Label>{t('login.totp')}</Label>
                <OtpInput value={totp} onChange={setTotp} autoFocus />
              </div>
            </>
          )}

          <ErrorNote error={error} />

          <Button variant="blue" block type="submit" busy={busy}>
            {submitLabel}
          </Button>

          <Button
            variant="gray"
            block
            onClick={() => {
              reset();
              if (screen.kind === 'login') setScreen({ kind: 'setup', step: 1 });
              else if (screen.step === 1) setScreen({ kind: 'login' });
              else setScreen({ kind: 'setup', step: (screen.step - 1) as SetupStep });
            }}
          >
            {screen.kind === 'login' ? t('login.haveCode') : screen.step === 1 ? t('login.havePassword') : t('nav.back')}
          </Button>
        </form>
      </div>
    </main>
  );
}
