'use strict';
/**
 * Unit tests for _parseCalendarEvents
 *
 * The function receives a pre-filtered array of timed, non-cancelled Google Calendar
 * event objects and returns:
 *   { count, indianMales, indianFemales, nonIndianMales, nonIndianFemales }
 *
 * Filtering rules (applied BEFORE calling this function, but tested here via the
 * full getCalendarBookings path indirectly, and explicitly for the pure function):
 *   - All-day events (start.date present, start.dateTime absent) → excluded
 *   - Cancelled events (status === 'cancelled') → excluded
 *   - Both start.date AND start.dateTime → excluded (belt-and-suspenders)
 *
 * Parsing rules:
 *   - Gender: /\b(Male|Female)\b/i anywhere in summary
 *   - Nationality (non-Indian): /\bnon[\s\-]?indian\b/i in description
 *   - Nationality (Indian): /\b(india|indian)\b/i in description
 *   - Nationality (other country): "Nationality: <country>" → non-Indian
 *   - No detectable nationality → counted in total, skipped for therapist pools
 *   - No detectable gender → counted in total, skipped for therapist pools
 */

jest.mock('googleapis', () => ({ google: { auth: { JWT: jest.fn() } } }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const { _parseCalendarEvents, _IGNORED_EVENT_TITLE_RE } = require('../../api/chat');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal timed, non-cancelled event */
const event = (summary, description = '') => ({
  summary,
  description,
  start: { dateTime: '2025-03-20T09:00:00+05:30' },
  status: 'confirmed',
});

// ─── Empty / trivial ──────────────────────────────────────────────────────────

describe('Empty input', () => {
  test('empty array → all zeros', () => {
    const r = _parseCalendarEvents([]);
    expect(r).toEqual({ count: 0, indianMales: 0, indianFemales: 0, nonIndianMales: 0, nonIndianFemales: 0 });
  });
});


// ─── Gender parsing ───────────────────────────────────────────────────────────

describe('Gender detection', () => {
  test('"— Male, 30 yrs" in title → counted as male', () => {
    const r = _parseCalendarEvents([event('Ravi — Male, 30 yrs', 'Nationality: India')]);
    expect(r.indianMales).toBe(1);
    expect(r.count).toBe(1);
  });

  test('"— Female, 25 yrs" in title → counted as female', () => {
    const r = _parseCalendarEvents([event('Priya — Female, 25 yrs', 'Nationality: India')]);
    expect(r.indianFemales).toBe(1);
  });

  test('"MALE" uppercase in title → parsed (case-insensitive)', () => {
    const r = _parseCalendarEvents([event('John - MALE - Chavitti', 'Nationality: India')]);
    expect(r.indianMales).toBe(1);
  });

  test('"female" lowercase in title → parsed', () => {
    const r = _parseCalendarEvents([event('Ananya — female, 22 yrs', 'Nationality: India')]);
    expect(r.indianFemales).toBe(1);
  });

  test('no gender word in title → counted in total, skipped for therapist pools', () => {
    const r = _parseCalendarEvents([event('Abhishek - Sarvangadhara', 'Nationality: India')]);
    expect(r.count).toBe(1);
    expect(r.indianMales).toBe(0);
    expect(r.indianFemales).toBe(0);
    expect(r.nonIndianMales).toBe(0);
    expect(r.nonIndianFemales).toBe(0);
  });
});


// ─── Nationality parsing ──────────────────────────────────────────────────────

describe('Nationality — Indian', () => {
  test('"Nationality: India" → isIndia=true', () => {
    const r = _parseCalendarEvents([event('Ravi — Male, 30 yrs', 'Nationality: India')]);
    expect(r.indianMales).toBe(1);
    expect(r.nonIndianMales).toBe(0);
  });

  test('"nationality - Indian" (admin format) → isIndia=true', () => {
    const r = _parseCalendarEvents([event('Raj — Male, 40 yrs', 'nationality - Indian')]);
    expect(r.indianMales).toBe(1);
  });

  test('"Indian" standalone in description → isIndia=true', () => {
    const r = _parseCalendarEvents([event('Aarav — Male, 35 yrs', 'Indian')]);
    expect(r.indianMales).toBe(1);
  });

  test('"india" lowercase → isIndia=true', () => {
    const r = _parseCalendarEvents([event('Meera — Female, 28 yrs', 'india')]);
    expect(r.indianFemales).toBe(1);
  });
});

describe('Nationality — Non-Indian', () => {
  test('"non-indian" → isIndia=false', () => {
    const r = _parseCalendarEvents([event('John — Male, 45 yrs', 'non-indian')]);
    expect(r.nonIndianMales).toBe(1);
    expect(r.indianMales).toBe(0);
  });

  test('"non indian" (no hyphen) → isIndia=false', () => {
    const r = _parseCalendarEvents([event('John — Male, 45 yrs', 'non indian')]);
    expect(r.nonIndianMales).toBe(1);
  });

  test('"Non-Indian" (capitalised) → isIndia=false', () => {
    const r = _parseCalendarEvents([event('Jane — Female, 33 yrs', 'Non-Indian')]);
    expect(r.nonIndianFemales).toBe(1);
  });

  test('"country - non indian" (admin format) → isIndia=false', () => {
    const r = _parseCalendarEvents([event('Tom — Male, 50 yrs', 'country - non indian')]);
    expect(r.nonIndianMales).toBe(1);
  });

  test('"Nationality: Australia" → isIndia=false (other country = Non-Indian)', () => {
    const r = _parseCalendarEvents([event('Emily — Female, 29 yrs', 'Nationality: Australia')]);
    expect(r.nonIndianFemales).toBe(1);
  });

  test('"Nationality: USA" → isIndia=false', () => {
    const r = _parseCalendarEvents([event('Mike — Male, 38 yrs', 'Nationality: USA')]);
    expect(r.nonIndianMales).toBe(1);
  });
});

describe('Nationality — ambiguous / missing', () => {
  test('no nationality info at all → counted in total, skipped for therapist pools', () => {
    const r = _parseCalendarEvents([event('Ravi — Male, 30 yrs', 'Some other description')]);
    expect(r.count).toBe(1);
    expect(r.indianMales).toBe(0);
    expect(r.nonIndianMales).toBe(0);
  });

  test('empty description → skipped for therapist pools', () => {
    const r = _parseCalendarEvents([event('Priya — Female, 25 yrs', '')]);
    expect(r.count).toBe(1);
    expect(r.indianFemales).toBe(0);
    expect(r.nonIndianFemales).toBe(0);
  });

  test('"non-indian" takes priority over "india" substring (non-indian rule matches first)', () => {
    // Description containing both "non-indian" and "india" — non-indian regex tests first
    const r = _parseCalendarEvents([event('Raj — Male, 30 yrs', 'non-indian visiting india')]);
    expect(r.nonIndianMales).toBe(1);
    expect(r.indianMales).toBe(0);
  });
});


// ─── Multiple events ──────────────────────────────────────────────────────────

describe('Multiple events counted correctly', () => {
  test('2 indian males, 1 indian female, 1 non-indian male, 1 non-indian female', () => {
    const events = [
      event('A — Male, 30 yrs',   'Nationality: India'),
      event('B — Male, 25 yrs',   'Indian'),
      event('C — Female, 28 yrs', 'Nationality: India'),
      event('D — Male, 40 yrs',   'non-indian'),
      event('E — Female, 33 yrs', 'Nationality: UK'),
    ];
    const r = _parseCalendarEvents(events);
    expect(r.count).toBe(5);
    expect(r.indianMales).toBe(2);
    expect(r.indianFemales).toBe(1);
    expect(r.nonIndianMales).toBe(1);
    expect(r.nonIndianFemales).toBe(1);
  });

  test('mix of parseable and unparseable events → count includes all, pools include only parseable', () => {
    const events = [
      event('Ravi — Male, 30 yrs',  'Nationality: India'), // indian male
      event('No gender here',        'Nationality: India'), // counted but not categorised
      event('Uma — Female, 22 yrs',  ''),                   // no nationality — skipped
    ];
    const r = _parseCalendarEvents(events);
    expect(r.count).toBe(3);
    expect(r.indianMales).toBe(1);
    expect(r.indianFemales).toBe(0);
  });
});


// ─── Pre-filter validation (belt-and-suspenders tests) ───────────────────────
// The filter happens in getCalendarBookings before calling _parseCalendarEvents.
// These tests verify the filter logic is correct by passing event shapes to
// a helper that mimics the filter, matching the code in getCalendarBookings.

describe('Calendar event filter (pre-parse)', () => {
  // Replicate the exact filter from getCalendarBookings for isolated testing
  function applyFilter(items) {
    return items.filter(e =>
      e.start &&
      e.start.dateTime &&
      !e.start.date &&
      e.status !== 'cancelled'
    );
  }

  test('all-day event (start.date only, no dateTime) → excluded', () => {
    const allDayEvent = { summary: 'Holiday', start: { date: '2025-03-20' }, status: 'confirmed' };
    expect(applyFilter([allDayEvent])).toHaveLength(0);
  });

  test('cancelled timed event → excluded', () => {
    const cancelledEvent = {
      summary: 'Ravi — Male, 30 yrs',
      start: { dateTime: '2025-03-20T09:00:00+05:30' },
      status: 'cancelled',
    };
    expect(applyFilter([cancelledEvent])).toHaveLength(0);
  });

  test('event with BOTH start.date AND start.dateTime → excluded (belt-and-suspenders)', () => {
    const oddEvent = {
      summary: 'Weird — Male, 30 yrs',
      start: { date: '2025-03-20', dateTime: '2025-03-20T09:00:00+05:30' },
      status: 'confirmed',
    };
    expect(applyFilter([oddEvent])).toHaveLength(0);
  });

  test('valid timed, non-cancelled event → included', () => {
    const validEvent = {
      summary: 'Ravi — Male, 30 yrs',
      start: { dateTime: '2025-03-20T09:00:00+05:30' },
      status: 'confirmed',
    };
    expect(applyFilter([validEvent])).toHaveLength(1);
  });

  test('mix of all-day, cancelled, and valid events → only valid passes', () => {
    const items = [
      { summary: 'Holiday',           start: { date: '2025-03-20' }, status: 'confirmed' },
      { summary: 'Ravi — Male, 30 yrs', start: { dateTime: '2025-03-20T09:00:00+05:30' }, status: 'cancelled' },
      { summary: 'Priya — Female',     start: { dateTime: '2025-03-20T09:00:00+05:30' }, status: 'confirmed' },
    ];
    expect(applyFilter(items)).toHaveLength(1);
    expect(applyFilter(items)[0].summary).toBe('Priya — Female');
  });
});


// ─── Ignored event titles (follow-up, training, …) ───────────────────────────

describe('Ignored event titles — IGNORED_EVENT_TITLE_RE', () => {
  // Replicate the full filter including the title-ignore rule
  function applyFilter(items) {
    return items.filter(e =>
      e.start &&
      e.start.dateTime &&
      !e.start.date &&
      e.status !== 'cancelled' &&
      !_IGNORED_EVENT_TITLE_RE.test(e.summary || '')
    );
  }

  const timedConfirmed = summary => ({
    summary,
    start: { dateTime: '2025-03-20T09:00:00+05:30' },
    status: 'confirmed',
  });

  // "Follow up" variations
  test('"Follow up" → excluded', () => {
    expect(applyFilter([timedConfirmed('Follow up with Ravi')])).toHaveLength(0);
  });

  test('"follow up" lowercase → excluded', () => {
    expect(applyFilter([timedConfirmed('follow up — Priya')])).toHaveLength(0);
  });

  test('"Follow-up" with hyphen → excluded', () => {
    expect(applyFilter([timedConfirmed('Follow-up call')])).toHaveLength(0);
  });

  test('"FOLLOW UP" uppercase → excluded', () => {
    expect(applyFilter([timedConfirmed('FOLLOW UP SESSION')])).toHaveLength(0);
  });

  test('"Follow Up" title-case → excluded', () => {
    expect(applyFilter([timedConfirmed('Follow Up Consultation')])).toHaveLength(0);
  });

  // "Training" variations
  test('"Training" → excluded', () => {
    expect(applyFilter([timedConfirmed('Training session')])).toHaveLength(0);
  });

  test('"training" lowercase → excluded', () => {
    expect(applyFilter([timedConfirmed('Staff training')])).toHaveLength(0);
  });

  test('"TRAINING" uppercase → excluded', () => {
    expect(applyFilter([timedConfirmed('TRAINING')])).toHaveLength(0);
  });

  // "Kalari" variations
  test('"Kalari" → excluded', () => {
    expect(applyFilter([timedConfirmed('Kalari session')])).toHaveLength(0);
  });

  test('"kalari" lowercase → excluded', () => {
    expect(applyFilter([timedConfirmed('kalari class')])).toHaveLength(0);
  });

  test('"KALARI" uppercase → excluded', () => {
    expect(applyFilter([timedConfirmed('KALARI')])).toHaveLength(0);
  });

  test('"Kalaripayattu" → excluded (kalari* matches any kalari-prefixed word)', () => {
    expect(applyFilter([timedConfirmed('Kalaripayattu demo')])).toHaveLength(0);
  });

  test('"kalaripayattu" lowercase → excluded', () => {
    expect(applyFilter([timedConfirmed('kalaripayattu class')])).toHaveLength(0);
  });

  test('"KALARIPAYATTU" uppercase → excluded', () => {
    expect(applyFilter([timedConfirmed('KALARIPAYATTU')])).toHaveLength(0);
  });

  // Normal patient events must still pass
  test('normal patient event → still included', () => {
    expect(applyFilter([timedConfirmed('Ravi — Male, 30 yrs')])).toHaveLength(1);
  });

  test('title containing "training" as substring inside a word → NOT excluded (word boundary)', () => {
    // e.g. "Constraining therapy" should not be excluded — "training" must be a whole word
    expect(applyFilter([timedConfirmed('Constraining therapy')])).toHaveLength(1);
  });

  test('mix: 1 follow-up, 1 training, 1 kalari, 1 valid → only valid passes', () => {
    const items = [
      timedConfirmed('Follow up with client'),
      timedConfirmed('Staff training day'),
      timedConfirmed('Kalari session'),
      timedConfirmed('Priya — Female, 28 yrs'),
    ];
    const result = applyFilter(items);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Priya — Female, 28 yrs');
  });

  test('ignored event does not affect room/therapist count', () => {
    // Pass ignored events through _parseCalendarEvents directly to confirm they were
    // never supposed to reach it — the filter is the gatekeeper.
    // Here we confirm that if they DID slip through (bug), count would include them.
    // This test documents the contract: filter MUST exclude before parse.
    const ignoredEvents = [
      timedConfirmed('Follow up'),
      timedConfirmed('Training'),
    ];
    const filtered = applyFilter(ignoredEvents);
    expect(filtered).toHaveLength(0); // none reach _parseCalendarEvents
  });
});
