// Коды ошибок для клиента. Текст ошибки на русском остаётся в `error`,
// клиент переводит по `code` + `params` (web/src/i18n).
//
// Функции БД бросают русский текст; здесь он превращается в код. Тест
// test/errors.test.ts проверяет, что у каждого raise в миграциях есть запись.

export type ErrorParams = Record<string, string | number>;

interface Rule {
  code: string;
  re: RegExp;
  params?: string[];
}

const RULES: Rule[] = [
  { code: 'unauthorized', re: /^не авторизован$/ },
  { code: 'forbidden_admin', re: /^нужны права админа$/ },
  { code: 'forbidden_full', re: /^только полный админ$/ },
  { code: 'forbidden_position', re: /^нет прав на это место$/ },
  { code: 'forbidden_current_position', re: /^нет прав на текущее место человека$/ },
  { code: 'forbidden_both_positions', re: /^нужны права и на текущее, и на новое место$/ },
  { code: 'no_access_position', re: /^нет доступа к этому месту$/ },
  { code: 'position_not_found', re: /^место не найдено$/ },
  { code: 'person_not_found', re: /^человек не найден$/ },
  { code: 'item_not_found', re: /^строка не найдена$/ },
  { code: 'transfer_before_start', re: /^дата перевода раньше даты захода \((.+)\)$/, params: ['date'] },
  { code: 'unassign_before_start', re: /^дата снятия раньше даты захода \((.+)\)$/, params: ['date'] },
  { code: 'invite_invalid', re: /^код недействителен$/ },
  // Подтверждение устройства кодом из бота убрано в 006, но текст остаётся в старых миграциях.
  { code: 'challenge_expired', re: /^код устарел/ },
  // Оповещения и телефон убраны в 012, но raise остаётся в старых миграциях.
  { code: 'admin_needs_phone', re: /^админу нужен телефон бота/ },
  { code: 'position_inactive', re: /^место «(.*)» выключено$/, params: ['name'] },
  { code: 'position_exists', re: /^место «(.*)» уже есть$/, params: ['name'] },
  { code: 'position_has_people', re: /^на месте есть люди/ },
  { code: 'position_fields', re: /^название 1–64 символа/ },
  { code: 'cannot_deactivate_self', re: /^нельзя отключить самого себя$/ },
  { code: 'last_full_admin', re: /^нельзя снять последнего полного админа$/ },
  { code: 'thresholds_required', re: /^нужны три порога/ },
  { code: 'qty_negative', re: /^остаток не может быть отрицательным$/ },
  { code: 'callsign_taken', re: /^позывной «(.*)» уже занят$/, params: ['callsign'] },
  { code: 'login_taken', re: /^логин «(.*)» уже занят$/, params: ['login'] },
  { code: 'invite_fields', re: /^логин: 3–32 символа/ },
  { code: 'invite_fields', re: /^позывной: 2–32 символа/ },
  { code: 'thresholds_invalid', re: /^пороги: мин ≥ 0/ },
  { code: 'item_fields', re: /^проверьте поля:/ },
  { code: 'category_unknown', re: /^категории «(.*)» нет в справочнике$/, params: ['category'] },
  { code: 'too_many_codes', re: /^слишком много запросов кода/ },
  { code: 'item_exists', re: /^строка «(.*)» на этом месте уже есть$/, params: ['name'] },
  { code: 'text_length', re: /^текст 1–500 символов$/ },
  { code: 'already_assigned', re: /^у человека уже есть место/ },
  { code: 'delete_forbidden', re: /^удаление .* запрещено$/ },
  { code: 'already_unassigned', re: /^человек и так без места$/ },
  { code: 'not_assigned', re: /^человек не посажен/ },
  { code: 'person_inactive', re: /^человек отключён$/ },
  { code: 'same_position', re: /^человек уже на этом месте$/ },
  { code: 'locale_invalid', re: /^язык: (код из двух латинских букв|ru, uk или en)$/ },
];

export function codeForDbMessage(message: string): { code: string; params?: ErrorParams } | null {
  for (const rule of RULES) {
    const m = rule.re.exec(message);
    if (!m) continue;
    if (!rule.params) return { code: rule.code };
    const params: ErrorParams = {};
    rule.params.forEach((name, i) => (params[name] = m[i + 1] ?? ''));
    return { code: rule.code, params };
  }
  return null;
}
