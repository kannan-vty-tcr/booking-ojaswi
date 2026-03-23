'use strict';
/**
 * Unit tests for _calculateAvailability
 *
 * Business rules under test:
 *   - Indian Male     → must use male therapist
 *   - Non-Indian Male → must use male therapist
 *   - Indian Female   → must use female therapist (ONLY)
 *   - Non-Indian Female → can use either male or female therapist (flex)
 *   - maxForGroup = min(availableRooms, therapistMax)
 *   - bookingMode=true  → available only when ALL patients fit
 *   - bookingMode=false → available when at least 1 patient fits
 */

// Mock googleapis so requiring chat.js doesn't fail in test environment
jest.mock('googleapis', () => ({ google: { auth: { JWT: jest.fn() } } }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const { _calculateAvailability } = require('../../api/chat');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a capacity object */
const cap = (male, female, rooms) => ({ male, female, rooms });

/** Build a calBookings object with zero counts */
const cal = ({ count = 0, indianMales = 0, indianFemales = 0, nonIndianMales = 0, nonIndianFemales = 0 } = {}) =>
  ({ count, indianMales, indianFemales, nonIndianMales, nonIndianFemales });

const EMPTY_CAL = cal();

// Patient factory helpers
const indM   = () => ({ nationality: 'India',     gender: 'Male'   });
const indF   = () => ({ nationality: 'India',     gender: 'Female' });
const nonIndM = () => ({ nationality: 'Australia', gender: 'Male'   });
const nonIndF = () => ({ nationality: 'Australia', gender: 'Female' });


// ─── Basic single-patient cases ───────────────────────────────────────────────

describe('Single Indian Male', () => {
  test('sufficient capacity → available, maxForGroup=1', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indM()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('0 male therapists → not available', () => {
    const result = _calculateAvailability(cap(0, 2, 4), EMPTY_CAL, [indM()]);
    expect(result.available).toBe(false);
    expect(result.maxForGroup).toBe(0);
  });

  test('0 rooms → not available', () => {
    const result = _calculateAvailability(cap(2, 2, 0), EMPTY_CAL, [indM()]);
    expect(result.available).toBe(false);
    expect(result.maxForGroup).toBe(0);
  });
});

describe('Single Indian Female', () => {
  test('sufficient capacity → available, maxForGroup=1', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('0 female therapists → not available (cannot use male)', () => {
    const result = _calculateAvailability(cap(2, 0, 4), EMPTY_CAL, [indF()]);
    expect(result.available).toBe(false);
    expect(result.maxForGroup).toBe(0);
  });
});

describe('Single Non-Indian Male', () => {
  test('sufficient capacity → available', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [nonIndM()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('0 male therapists → not available', () => {
    const result = _calculateAvailability(cap(0, 2, 4), EMPTY_CAL, [nonIndM()]);
    expect(result.available).toBe(false);
  });
});

describe('Single Non-Indian Female (flex therapist)', () => {
  test('only male therapist available → uses male, available', () => {
    const result = _calculateAvailability(cap(1, 0, 4), EMPTY_CAL, [nonIndF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('only female therapist available → uses female, available', () => {
    const result = _calculateAvailability(cap(0, 1, 4), EMPTY_CAL, [nonIndF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('no therapists at all → not available', () => {
    const result = _calculateAvailability(cap(0, 0, 4), EMPTY_CAL, [nonIndF()]);
    expect(result.available).toBe(false);
  });
});


// ─── Multi-patient therapist pool tests ───────────────────────────────────────

describe('Multiple patients — therapist pool', () => {
  test('2 Indian males, 2 male therapists → maxForGroup=2', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indM(), indM()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(2);
  });

  test('3 Indian males, 2 male therapists → maxForGroup=2 (therapist limit)', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indM(), indM(), indM()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('2 Indian females, 2 female therapists → maxForGroup=2', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indF(), indF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(2);
  });

  test('3 Indian females, 2 female therapists → maxForGroup=2', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [indF(), indF(), indF()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('1 Indian male + 1 Indian female: separate pools, both fit', () => {
    // male takes male pool, female takes female pool — independent
    const result = _calculateAvailability(cap(1, 1, 4), EMPTY_CAL, [indM(), indF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(2);
  });

  test('2 Indian males + 1 Indian female, cap(2M,1F,4R) → all 3 fit', () => {
    const result = _calculateAvailability(cap(2, 1, 4), EMPTY_CAL, [indM(), indM(), indF()]);
    expect(result.maxForGroup).toBe(3);
  });

  test('1 Indian male exhausts male pool; non-Indian female cannot spill onto female if female taken', () => {
    // cap: 1M, 1F; patients: 1 Indian male + 1 Indian female + 1 non-Indian female
    // Indian male → uses 1M (remain: 0M, 1F)
    // Indian female → uses 1F (remain: 0M, 0F)
    // non-Indian female → 0 remain → cannot book
    const result = _calculateAvailability(cap(1, 1, 4), EMPTY_CAL, [indM(), indF(), nonIndF()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('non-Indian female uses remaining male slot after males are allocated', () => {
    // cap: 2M, 1F; patients: 1 Indian male + 1 non-Indian female
    // Indian male → uses 1M (remain: 1M, 1F)
    // non-Indian female → uses 1M (remain: 0M, 1F)  OR 1F
    const result = _calculateAvailability(cap(2, 1, 4), EMPTY_CAL, [indM(), nonIndF()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('2 non-Indian females, 1M+1F available → both fit (use 1 each)', () => {
    const result = _calculateAvailability(cap(1, 1, 4), EMPTY_CAL, [nonIndF(), nonIndF()]);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(2);
  });

  test('3 non-Indian females, 1M+1F available → only 2 fit', () => {
    const result = _calculateAvailability(cap(1, 1, 4), EMPTY_CAL, [nonIndF(), nonIndF(), nonIndF()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('4 non-Indian females, 2M+2F available → all 4 fit', () => {
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, [nonIndF(), nonIndF(), nonIndF(), nonIndF()]);
    expect(result.maxForGroup).toBe(4);
  });
});


// ─── Room constraint ──────────────────────────────────────────────────────────

describe('Room constraint', () => {
  test('2 patients, 1 room, enough therapists → maxForGroup=1', () => {
    const result = _calculateAvailability(cap(2, 2, 1), EMPTY_CAL, [indM(), indF()]);
    expect(result.maxForGroup).toBe(1);
  });

  test('3 patients, 2 rooms, enough therapists → maxForGroup=2', () => {
    const result = _calculateAvailability(cap(3, 3, 2), EMPTY_CAL, [indM(), indF(), nonIndF()]);
    expect(result.maxForGroup).toBe(2);
  });

  test('rooms=0 → maxForGroup=0 regardless of therapist count', () => {
    const result = _calculateAvailability(cap(5, 5, 0), EMPTY_CAL, [indM()]);
    expect(result.maxForGroup).toBe(0);
    expect(result.available).toBe(false);
  });
});


// ─── Existing calendar bookings reduce available capacity ─────────────────────

describe('Calendar bookings reduce capacity', () => {
  test('1 Indian male already booked → male pool reduced by 1', () => {
    // cap: 1M, existing: 1 indian male booked → availMale=0
    const result = _calculateAvailability(
      cap(1, 2, 4),
      cal({ count: 1, indianMales: 1 }),
      [indM()]
    );
    expect(result.available).toBe(false);
  });

  test('1 Indian female already booked → female pool reduced by 1', () => {
    const result = _calculateAvailability(
      cap(2, 1, 4),
      cal({ count: 1, indianFemales: 1 }),
      [indF()]
    );
    expect(result.available).toBe(false);
  });

  test('1 non-Indian male already booked → reduces male pool', () => {
    const result = _calculateAvailability(
      cap(1, 2, 4),
      cal({ count: 1, nonIndianMales: 1 }),
      [indM()]
    );
    expect(result.available).toBe(false);
  });

  test('mixed existing bookings — correct reduction', () => {
    // cap: 3M, 3F, 10R; existing: 1 indian male, 1 indian female, 1 non-indian male (3 total)
    // availMale = 3 - 1(iM) - 1(niM) = 1; availFemale = 3 - 1(iF) = 2
    // availableRooms = 10 - 3 = 7 (rooms not the constraint)
    // new patients: 1 indian male → uses 1M; 1 indian female → uses 1F
    // therapistMax = 2; maxForGroup = min(7, 2) = 2
    const result = _calculateAvailability(
      cap(3, 3, 10),
      cal({ count: 3, indianMales: 1, indianFemales: 1, nonIndianMales: 1 }),
      [indM(), indF()]
    );
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(2);
  });

  test('room fully booked by calendar → not available', () => {
    // 4 rooms, 4 existing bookings
    const result = _calculateAvailability(
      cap(5, 5, 4),
      cal({ count: 4 }),
      [indM()]
    );
    expect(result.available).toBe(false);
    expect(result.availableRooms).toBe(0);
  });

  test('partial room availability reduces maxForGroup', () => {
    // 3 rooms, 2 existing → 1 room left; 3 new patients, enough therapists → maxForGroup=1
    const result = _calculateAvailability(
      cap(5, 5, 3),
      cal({ count: 2 }),
      [indM(), indF(), nonIndF()]
    );
    expect(result.maxForGroup).toBe(1);
  });
});


// ─── bookingMode strict vs. display ──────────────────────────────────────────

describe('bookingMode', () => {
  test('bookingMode=true, 2 patients need, maxForGroup=2 → available', () => {
    const result = _calculateAvailability(cap(2, 2, 2), EMPTY_CAL, [indM(), indF()], true);
    expect(result.available).toBe(true);
  });

  test('bookingMode=true, 2 patients need, maxForGroup=1 → NOT available', () => {
    const result = _calculateAvailability(cap(1, 2, 1), EMPTY_CAL, [indM(), indF()], true);
    expect(result.available).toBe(false);
    expect(result.maxForGroup).toBe(1);
  });

  test('bookingMode=false (display), 2 patients, maxForGroup=1 → still shows as available (partial)', () => {
    const result = _calculateAvailability(cap(1, 2, 1), EMPTY_CAL, [indM(), indF()], false);
    expect(result.available).toBe(true);
    expect(result.maxForGroup).toBe(1);
  });

  test('bookingMode=false, maxForGroup=0 → not available', () => {
    const result = _calculateAvailability(cap(0, 0, 0), EMPTY_CAL, [indM()], false);
    expect(result.available).toBe(false);
  });
});


// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('empty patient array → maxForGroup equals min(rooms, therapists)', () => {
    // No new patients → nothing blocks; therapistMax = 0 since no patients to assign
    const result = _calculateAvailability(cap(2, 2, 4), EMPTY_CAL, []);
    expect(result.maxForGroup).toBe(0);
  });

  test('all capacity zeros → available=false', () => {
    const result = _calculateAvailability(cap(0, 0, 0), EMPTY_CAL, [indM()]);
    expect(result.available).toBe(false);
    expect(result.maxForGroup).toBe(0);
  });

  test('calBookings.count > capacity.rooms → availableRooms clamped to 0', () => {
    // 2 rooms, 3 existing bookings (shouldn't happen, but must not go negative)
    const result = _calculateAvailability(
      cap(5, 5, 2),
      cal({ count: 3 }),
      [indM()]
    );
    expect(result.availableRooms).toBe(0);
    expect(result.available).toBe(false);
  });

  test('large group all fits within capacity', () => {
    // 5 patients: 2 Indian males, 2 Indian females, 1 non-Indian female
    // cap: 3M, 3F, 5R
    // 2 indian males → use 2M (remain: 1M, 3F)
    // 2 indian females → use 2F (remain: 1M, 1F)
    // 1 non-Indian female → uses 1 of (1M+1F) = 1
    // therapistMax = 2+2+1 = 5; maxForGroup = min(5,5) = 5
    const pts = [indM(), indM(), indF(), indF(), nonIndF()];
    const result = _calculateAvailability(cap(3, 3, 5), EMPTY_CAL, pts);
    expect(result.maxForGroup).toBe(5);
    expect(result.available).toBe(true);
  });

  test('returns availableRooms in result', () => {
    const result = _calculateAvailability(cap(2, 2, 3), cal({ count: 1 }), [indM()]);
    expect(result.availableRooms).toBe(2);
  });

  test('reason string returned when not available', () => {
    const result = _calculateAvailability(cap(0, 0, 0), EMPTY_CAL, [indM()]);
    expect(result.reason).toBeTruthy();
  });
});
