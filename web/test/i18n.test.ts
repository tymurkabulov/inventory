import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api';
import { errorText, staticT } from '../src/i18n';

describe('errorText', () => {
  const t = staticT();
  const validation = (field: string) => new ApiError(422, `${field}: bad`, 'validation', { field });

  // У этих полей свои тексты — общий «Проверьте поле: password» человеку не поможет.
  it.each(['password', 'totp', 'code', 'callsign'])('поле %s получает свой перевод', (field) => {
    expect(errorText(t, validation(field))).toBe(t(`err.validation.${field}` as never));
  });

  it('остальные поля — общий текст с именем поля', () => {
    expect(errorText(t, validation('comment'))).toBe(t('err.validation', { field: 'comment' }));
  });
});
