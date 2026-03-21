'use strict';
/**
 * Unit tests for isSlotPast and getISTNow (frontend logic, ported to Node for testing)
 *
 * isSlotPast(isoDate, slotName):
 *   Returns true when:
 *     - isoDate matches today's IST date  AND
 *     - The current IST hour >= the slot's start hour
 *   Returns false for any future date, or any past date, or an unrecognised slot name.
 *
 * getISTNow():
 *   Returns a Date object adjusted to IST (UTC+5:30).
 */

// ─── Port frontend functions to Node ─────────────────────────────────────────
// These are copied verbatim from index.html so they can be tested in Node.

const SLOT_START_HOURS = {
  '9:00 AM':  9,
  '11:00 AM': 11,
  '1:00 PM':  13,
  '3:00 PM':  15,
  '5:00 PM':  17,
};

function getISTNow() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSlotPast(isoDate, slotName) {
  const istNow = getISTNow();
  if (isoDate !== formatDate(istNow)) return false;
  const startHour = SLOT_START_HOURS[slotName];
  if (startHour === undefined) return false;
  return istNow.getHours() >= startHour;
}


// ─── getISTNow ────────────────────────────────────────────────────────────────

describe('getISTNow', () => {
  test('returns a Date object', () => {
    expect(getISTNow()).toBeInstanceOf(Date);
  });

  test('IST offset is UTC+5:30 (offset difference ≤ 30 minutes from manual calculation)', () => {
    const utcNow = new Date();
    const istNow = getISTNow();
    // Expected IST time = UTC + 330 minutes
    const expectedMs = utcNow.getTime() + (utcNow.getTimezoneOffset() + 330) * 60000;
    expect(Math.abs(istNow.getTime() - expectedMs)).toBeLessThan(1000); // within 1s
  });
});


// ─── isSlotPast — future date ─────────────────────────────────────────────────

describe('isSlotPast — future date', () => {
  function futureDateISO() {
    const ist = getISTNow();
    ist.setDate(ist.getDate() + 1);
    return formatDate(ist);
  }

  test('tomorrow + any slot → false', () => {
    const tomorrow = futureDateISO();
    expect(isSlotPast(tomorrow, '9:00 AM')).toBe(false);
    expect(isSlotPast(tomorrow, '5:00 PM')).toBe(false);
  });

  test('far future date → false', () => {
    expect(isSlotPast('2099-12-31', '9:00 AM')).toBe(false);
  });
});


// ─── isSlotPast — past date ───────────────────────────────────────────────────

describe('isSlotPast — past date', () => {
  function yesterdayISO() {
    const ist = getISTNow();
    ist.setDate(ist.getDate() - 1);
    return formatDate(ist);
  }

  test('yesterday + any slot → false (different date, not today)', () => {
    const yesterday = yesterdayISO();
    expect(isSlotPast(yesterday, '9:00 AM')).toBe(false);
    expect(isSlotPast(yesterday, '5:00 PM')).toBe(false);
  });
});


// ─── isSlotPast — today, hour-based ──────────────────────────────────────────

describe('isSlotPast — today, controlled hour', () => {
  // We mock getISTNow by overriding the internal function via a controlled wrapper.
  // Since our ported functions are local (not module-level), we use a factory approach.

  function makeIsSlotPast(fakeHour) {
    function fakeGetISTNow() {
      const now = new Date();
      const real = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
      real.setHours(fakeHour, 0, 0, 0);
      return real;
    }
    return function isSlotPastMocked(isoDate, slotName) {
      const istNow = fakeGetISTNow();
      if (isoDate !== formatDate(istNow)) return false;
      const startHour = SLOT_START_HOURS[slotName];
      if (startHour === undefined) return false;
      return istNow.getHours() >= startHour;
    };
  }

  function todayISO() { return formatDate(getISTNow()); }

  test('current hour < slot start → false (slot not yet passed)', () => {
    // fake IST hour = 8 (before 9:00 AM slot)
    const fn = makeIsSlotPast(8);
    expect(fn(todayISO(), '9:00 AM')).toBe(false);
  });

  test('current hour === slot start → true (slot just started = treat as passed)', () => {
    // fake IST hour = 9 (exactly at 9:00 AM slot)
    const fn = makeIsSlotPast(9);
    expect(fn(todayISO(), '9:00 AM')).toBe(true);
  });

  test('current hour > slot start → true', () => {
    // fake IST hour = 14 (after 1:00 PM = 13:00)
    const fn = makeIsSlotPast(14);
    expect(fn(todayISO(), '1:00 PM')).toBe(true);
  });

  test('hour 17 → 5:00 PM slot (startHour=17) is passed', () => {
    const fn = makeIsSlotPast(17);
    expect(fn(todayISO(), '5:00 PM')).toBe(true);
  });

  test('hour 16 → 5:00 PM slot not yet passed', () => {
    const fn = makeIsSlotPast(16);
    expect(fn(todayISO(), '5:00 PM')).toBe(false);
  });

  test('hour 10 → 9:00 AM passed, 11:00 AM not yet passed', () => {
    const fn = makeIsSlotPast(10);
    expect(fn(todayISO(), '9:00 AM')).toBe(true);
    expect(fn(todayISO(), '11:00 AM')).toBe(false);
  });

  test('hour 23 → all slots passed', () => {
    const fn = makeIsSlotPast(23);
    const today = todayISO();
    Object.keys(SLOT_START_HOURS).forEach(slot => {
      expect(fn(today, slot)).toBe(true);
    });
  });

  test('hour 0 (midnight) → no slots passed yet', () => {
    const fn = makeIsSlotPast(0);
    const today = todayISO();
    Object.keys(SLOT_START_HOURS).forEach(slot => {
      expect(fn(today, slot)).toBe(false);
    });
  });
});


// ─── isSlotPast — unknown slot name ──────────────────────────────────────────

describe('isSlotPast — unknown slot name', () => {
  test('unknown slot name → false (undefined startHour)', () => {
    expect(isSlotPast(formatDate(getISTNow()), '7:00 AM')).toBe(false);
    expect(isSlotPast(formatDate(getISTNow()), 'Morning')).toBe(false);
    expect(isSlotPast(formatDate(getISTNow()), '')).toBe(false);
  });
});
