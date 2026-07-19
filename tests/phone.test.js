const { normalizeIraqiPhone } = require('../src/utils/phone');

const CANONICAL = '9647701234567';

describe('normalizeIraqiPhone', () => {
  test('normalizes the three accepted input formats onto one canonical value', () => {
    expect(normalizeIraqiPhone('07701234567')).toBe(CANONICAL); // domestic
    expect(normalizeIraqiPhone('+9647701234567')).toBe(CANONICAL); // international, +
    expect(normalizeIraqiPhone('009647701234567')).toBe(CANONICAL); // international, 00
  });

  test('accepts every operator prefix in service', () => {
    expect(normalizeIraqiPhone('07501234567')).toBe('9647501234567'); // 75x Korek
    expect(normalizeIraqiPhone('07601234567')).toBe('9647601234567'); // 760 Alkafeel
    expect(normalizeIraqiPhone('07701234567')).toBe('9647701234567'); // 77x Asiacell
    expect(normalizeIraqiPhone('07801234567')).toBe('9647801234567'); // 78x Zain
    expect(normalizeIraqiPhone('07901234567')).toBe('9647901234567'); // 79x Zain — rejected before
  });

  test('strips whitespace, dashes and parentheses', () => {
    expect(normalizeIraqiPhone('0770 123 4567')).toBe(CANONICAL);
    expect(normalizeIraqiPhone('0770-123-4567')).toBe(CANONICAL);
    expect(normalizeIraqiPhone('  0770 - 123 - 4567  ')).toBe(CANONICAL);
    expect(normalizeIraqiPhone('+964 (770) 123-4567')).toBe(CANONICAL);
  });

  test('accepts the bare local form without a leading zero', () => {
    expect(normalizeIraqiPhone('7701234567')).toBe(CANONICAL);
  });

  // Regression guard: a normalizer that tests the leading '0' before '00964' turns
  // 009647701234567 into 96409647701234567, and the number stops resolving entirely.
  test('does not mistake the 00964 prefix for a leading zero', () => {
    expect(normalizeIraqiPhone('009647701234567')).toBe(CANONICAL);
  });

  // The stored phone is fed back through this function on every send, so it must be a fixed point.
  test('is idempotent on the canonical form', () => {
    expect(normalizeIraqiPhone(CANONICAL)).toBe(CANONICAL);
    expect(normalizeIraqiPhone(normalizeIraqiPhone('07701234567'))).toBe(CANONICAL);
  });

  test('returns null for invalid input', () => {
    expect(normalizeIraqiPhone('+15550100100')).toBeNull(); // not Iraqi
    expect(normalizeIraqiPhone('07401234567')).toBeNull(); // 74x is not an operator prefix
    expect(normalizeIraqiPhone('06701234567')).toBeNull(); // does not start with 7
    expect(normalizeIraqiPhone('077012345')).toBeNull(); // too short
    expect(normalizeIraqiPhone('077012345678')).toBeNull(); // too long
    expect(normalizeIraqiPhone('')).toBeNull();
    expect(normalizeIraqiPhone('abc')).toBeNull();
  });

  test('returns null instead of throwing on a missing or non-string value', () => {
    expect(normalizeIraqiPhone(undefined)).toBeNull();
    expect(normalizeIraqiPhone(null)).toBeNull();
    expect(normalizeIraqiPhone({})).toBeNull();
    expect(normalizeIraqiPhone([])).toBeNull();
    expect(normalizeIraqiPhone(7701234567)).toBe(CANONICAL); // JSON numeric body
  });
});

// The bug this change closes: the OTP limiter keyed on the raw string, so one account got a
// fresh bucket for every spelling of its number.
describe('OTP rate-limit key', () => {
  const keyOf = (phone) => normalizeIraqiPhone(phone) ?? String(phone);

  test('every spelling of one number collapses to a single bucket', () => {
    const spellings = [
      '07701234567',
      '+9647701234567',
      '009647701234567',
      '7701234567',
      '0770 123 4567',
      '0770-123-4567',
      '+964 (770) 123-4567',
      CANONICAL,
    ];
    expect(new Set(spellings.map(keyOf)).size).toBe(1);
    expect(keyOf('07701234567')).toBe(CANONICAL);
  });

  test('distinct accounts still get distinct buckets', () => {
    expect(keyOf('07701234567')).not.toBe(keyOf('07701234568'));
  });

  test('a non-Iraqi number falls back to its raw string rather than a null key', () => {
    expect(keyOf('+15550100100')).toBe('+15550100100');
  });
});
