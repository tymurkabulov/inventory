import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { copyText } from '../ui';

/**
 * QR рисуем в браузере: ссылка с секретом наружу не уходит.
 * Грузится отдельным куском — нужен один раз, на первом входе.
 */
export function Qr({ otpauth, secret, onCopy }: { otpauth: string; secret: string; onCopy: (ok: boolean) => void }) {
  const t = useT();
  const [png, setPng] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(otpauth, { margin: 1, width: 360, color: { dark: '#111111', light: '#ffffff' } })
      .then((url) => alive && setPng(url))
      .catch(() => alive && setPng(null));
    return () => {
      alive = false;
    };
  }, [otpauth]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">{t('login.qrHint')}</p>
      {png ? (
        <img src={png} alt="" className="mx-auto size-42 bg-white p-2" />
      ) : (
        <div className="mx-auto size-42 animate-pulse bg-surf-3" />
      )}
      <button
        type="button"
        onClick={() => void copyText(secret).then(onCopy)}
        className="border border-dashed border-line bg-bg-0 p-2.5 text-center font-mono text-sm tracking-[0.06em] break-all"
      >
        {t('login.qrManual')} {secret}
      </button>
    </div>
  );
}
