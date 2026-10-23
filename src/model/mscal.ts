// Calendar (MSCAL.OCX, the Access calendar): the date logic of the run session and the window. It reuses MonthView's helpers (dateControls.ts).
import { dateFrom, dateParts } from '../lang/values';
import { MAX_DATE, MIN_DATE, addMonths, daysInMonth, dayOf } from './dateControls';

export type CalUnit = 'Day' | 'Week' | 'Month' | 'Year';

/** The date `delta` units from `serial`: months and years keep the day of the month as far as the target month goes (31 January + 1 month = 28/29 February). */
export function stepDate(serial: number, unit: CalUnit, delta: number): number {
  const day = dayOf(serial);
  if (unit === 'Day') return day + delta;
  if (unit === 'Week') return day + 7 * delta;
  const p = dateParts(serial);
  const t = addMonths(p.y, p.m, unit === 'Year' ? 12 * delta : delta);
  return dateFrom(t.y, t.m, Math.min(p.d, daysInMonth(t.y, t.m))).serial;
}

/** Day, Month or Year of `serial` replaced by `n`; null when it does not fit (Day 31 in a 30-day month, Month 13, Year 0). */
export function setDatePart(serial: number, part: 'Day' | 'Month' | 'Year', n: number): number | null {
  const p = dateParts(serial);
  const y = part === 'Year' ? n : p.y, m = part === 'Month' ? n : p.m, d = part === 'Day' ? n : p.d;
  if (!Number.isInteger(n) || m < 1 || m > 12 || y < 100 || y > 9999 || d < 1 || d > daysInMonth(y, m)) return null;
  const s = dateFrom(y, m, d).serial;
  return s < MIN_DATE || s > MAX_DATE ? null : s;
}

export const inRange = (serial: number): boolean => serial >= MIN_DATE && serial <= MAX_DATE;

/** A name cut to the Day/MonthLength: 1 the first letter, 2 the short name, 3 the long one (the caller passes both). */
export function cutName(length: number, short: string, long: string): string {
  if (length <= 1) return (short || long).charAt(0).toUpperCase();
  return length === 2 ? short : long;
}

