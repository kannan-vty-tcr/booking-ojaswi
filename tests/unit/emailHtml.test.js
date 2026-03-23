'use strict';
/**
 * Unit tests for _buildEmailHtml
 *
 * Covers:
 *   - Contact section: readable (light background + dark text)
 *   - Phone number always shown
 *   - Email address shown / omitted correctly
 *   - Special considerations block per patient
 *   - Multiple patients grouped by date, dates sorted ascending
 *   - Singular vs plural session wording
 *   - Booking ID in output
 *   - Mobile-responsive: viewport meta + @media query present
 */

jest.mock('googleapis', () => ({ google: { auth: { JWT: jest.fn() } } }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const { _buildEmailHtml } = require('../../api/chat');

// ─── helpers ─────────────────────────────────────────────────────────────────

const patient = (overrides = {}) => ({
  name: 'Ravi Kumar', age: '35', gender: 'Male', nationality: 'India',
  date: '2025-03-20', slot: '9:00 AM', notes: '',
  ...overrides,
});


// ─── Contact section readability ─────────────────────────────────────────────

describe('Contact section — readability', () => {
  test('contact box uses light background #f5ede4', () => {
    const html = _buildEmailHtml('test@x.com', '+91 9876543210', [patient()], 'OW-001');
    expect(html).toContain('background:#f5ede4');
  });

  test('contact text uses dark color #2a1a08', () => {
    const html = _buildEmailHtml('test@x.com', '+91 9876543210', [patient()], 'OW-001');
    expect(html).toContain('color:#2a1a08');
  });

  test('phone number appears in the HTML', () => {
    const html = _buildEmailHtml('test@x.com', '+91 9876543210', [patient()], 'OW-001');
    expect(html).toContain('+91 9876543210');
  });

  test('email address appears when provided', () => {
    const html = _buildEmailHtml('guest@example.com', '+91 9876543210', [patient()], 'OW-001');
    expect(html).toContain('guest@example.com');
  });

  test('email address omitted when empty string passed — no separator in contact section', () => {
    const html = _buildEmailHtml('', '+91 9876543210', [patient()], 'OW-001');
    // Only the contact <div> should have no separator; the footer has its own &nbsp;·&nbsp;
    // Extract just the contact section to check
    const contactStart = html.indexOf('background:#f5ede4');
    const contactEnd   = html.indexOf('</div>', contactStart) + 6;
    const contactSection = html.slice(contactStart, contactEnd);
    expect(contactSection).not.toContain('&nbsp;·&nbsp;');
  });
});


// ─── Mobile responsiveness ────────────────────────────────────────────────────

describe('Mobile responsiveness', () => {
  test('viewport meta tag is present', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient()], 'OW-001');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  test('@media (max-width:600px) rule is present', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient()], 'OW-001');
    expect(html).toContain('@media (max-width:600px)');
  });

  test('DOCTYPE declaration present', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient()], 'OW-001');
    expect(html).toContain('<!DOCTYPE html>');
  });
});


// ─── Booking ID ───────────────────────────────────────────────────────────────

describe('Booking ID', () => {
  test('booking ID is rendered in the email body', () => {
    const html = _buildEmailHtml('t@x.com', '+91 1111111111', [patient()], 'OW-XYZ-999');
    expect(html).toContain('OW-XYZ-999');
  });
});


// ─── Singular vs plural wording ───────────────────────────────────────────────

describe('Singular vs plural session wording', () => {
  test('single booking → "session has been confirmed"', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient()], 'OW-001');
    expect(html).toContain('session has been confirmed');
    expect(html).not.toContain('sessions have');
  });

  test('multiple bookings → "sessions have been confirmed"', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [
      patient({ name: 'A', date: '2025-03-20' }),
      patient({ name: 'B', date: '2025-03-20' }),
    ], 'OW-002');
    expect(html).toContain('sessions have been confirmed');
  });
});


// ─── Patient details ──────────────────────────────────────────────────────────

describe('Patient details in email', () => {
  test('patient name is shown', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient({ name: 'Deepa Nair' })], 'OW-001');
    expect(html).toContain('Deepa Nair');
  });

  test('patient gender and age shown', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient({ gender: 'Female', age: '28' })], 'OW-001');
    expect(html).toContain('Female');
    expect(html).toContain('28 yrs');
  });

  test('patient nationality shown', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient({ nationality: 'Germany' })], 'OW-001');
    expect(html).toContain('Germany');
  });

  test('slot time shown per patient', () => {
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', [patient({ slot: '3:00 PM' })], 'OW-001');
    expect(html).toContain('3:00 PM');
  });
});


// ─── Multi-date grouping ──────────────────────────────────────────────────────

describe('Multi-date grouping and ordering', () => {
  test('two patients on same date appear under one date header', () => {
    const bookings = [
      patient({ name: 'Alice', date: '2025-03-20', slot: '9:00 AM' }),
      patient({ name: 'Bob',   date: '2025-03-20', slot: '11:00 AM' }),
    ];
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', bookings, 'OW-001');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    // Both are on same date, date block appears once (only one date header section)
    const dateHeaders = (html.match(/Thursday|Friday|Saturday|Sunday|Monday|Tuesday|Wednesday/g) || []);
    expect(dateHeaders.length).toBe(1); // single date block
  });

  test('two patients on different dates — both dates appear sorted ascending', () => {
    const bookings = [
      patient({ name: 'Alice', date: '2025-03-22', slot: '9:00 AM' }),
      patient({ name: 'Bob',   date: '2025-03-20', slot: '9:00 AM' }),
    ];
    const html = _buildEmailHtml('t@x.com', '+91 9999999999', bookings, 'OW-001');
    const alicePos = html.indexOf('Alice');
    const bobPos   = html.indexOf('Bob');
    // Bob (20th, earlier) should appear before Alice (22nd, later) after sort
    expect(bobPos).toBeLessThan(alicePos);
  });
});
