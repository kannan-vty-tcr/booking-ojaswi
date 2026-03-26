/**
 * api/chat.js — Ojaswi Wellness Booking
 *
 * Routes:
 *   GET  /api/slots  — available slots for a date + patient list
 *   POST /api/book   — SSE: validate → check → create Calendar events → record in Sheets → send email
 *
 * Payload for POST /api/book:
 *   {
 *     patientBookings: [{ name, age, gender, nationality, date, slot }, ...],
 *     phone: "+91 9876543210",         // first patient's phone, used for all events
 *     email: "guest@example.com"       // first patient's email, for confirmation
 *   }
 *
 * Spreadsheet "Therapist Capacity" (admin edits directly — one row per day):
 *   A: Date (YYYY-MM-DD) | B: Male Therapists | C: Female Therapists | D: Rooms Available
 *   NOTE: Column order is flexible — the code reads headers by name.
 *
 * Spreadsheet "Bookings" (written automatically, one row per patient):
 *   A: Booking ID | B: Patient Name | C: Age | D: Gender | E: Nationality
 *   F: Date | G: Slot | H: Phone | I: Email | J: Calendar Event ID | K: Created At
 */

const { google }    = require('googleapis');
const nodemailer    = require('nodemailer');

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const SLOTS = ['9:00 AM', '11:00 AM', '1:00 PM', '3:00 PM', '5:00 PM'];

const SLOT_TIMES = {
  '9:00 AM':  { start: '09:00', end: '11:00' },
  '11:00 AM': { start: '11:00', end: '13:00' },
  '1:00 PM':  { start: '13:00', end: '15:00' },
  '3:00 PM':  { start: '15:00', end: '17:00' },
  '5:00 PM':  { start: '17:00', end: '19:00' },
};

const CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID    || 'hello@ojaswiwellness.com';
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';

// Calendar events whose titles match this pattern are administrative/internal
// and must be ignored when calculating room/therapist availability.
// Add new words separated by | to extend the list.
const IGNORED_EVENT_TITLE_RE = /\b(follow[\s\-]?up|training|kalari\w*)\b/i;

/* ─────────────────────────────────────────────
   GOOGLE AUTH
───────────────────────────────────────────── */
function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  return new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
}

/* ─────────────────────────────────────────────
   THERAPIST CAPACITY  (day-level, from Sheets)
   Admin submits once per day — all slots use same numbers.
   If admin re-submits for the same date, last row wins.
───────────────────────────────────────────── */
async function getTherapistCapacity(auth, date) {
  const DEFAULT = { male: 1, female: 1, rooms: 1 };
  if (!auth || !SPREADSHEET_ID) return DEFAULT;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Therapist Capacity!A:F',
    });
    const rows = res.data.values || [];
    if (!rows.length) return DEFAULT;

    // Read header row to find correct column positions by name
    // (defensive against Google Form creating columns in a different order)
    const headers = rows[0].map(h => (h || '').toLowerCase().trim());
    const dateCol   = headers.findIndex(h => h.includes('date'));
    const maleCol   = headers.findIndex(h => h.includes('male') && !h.includes('female'));
    const femaleCol = headers.findIndex(h => h.includes('female'));
    const roomsCol  = headers.findIndex(h => h.includes('room'));

    // Fall back to fixed positions (A=0,B=1,C=2,D=3,E=4) if headers are not found
    const dCol = dateCol   >= 0 ? dateCol   : 1;
    const mCol = maleCol   >= 0 ? maleCol   : 2;
    const fCol = femaleCol >= 0 ? femaleCol : 3;
    const rCol = roomsCol  >= 0 ? roomsCol  : 4;

    let capacity = null;
    for (const row of rows.slice(1)) {  // skip header row
      if (row[dCol] === date) {
        capacity = {
          male:   Math.max(0, parseInt(row[mCol]) || 0),
          female: Math.max(0, parseInt(row[fCol]) || 0),
          rooms:  Math.max(0, parseInt(row[rCol]) || 0),
        };
      }
    }
    if (capacity) {
      console.log(`[capacity] date=${date} male=${capacity.male} female=${capacity.female} rooms=${capacity.rooms}`);
    } else {
      console.warn(`[capacity] No entry found for date=${date}, using DEFAULT`);
    }
    return capacity || DEFAULT;
  } catch (err) {
    console.error('getTherapistCapacity error:', err.message);
    return DEFAULT;
  }
}

/* ─────────────────────────────────────────────
   PARSE CALENDAR EVENTS — pure function, exported for testing.
   Accepts pre-filtered array of timed, non-cancelled events.
───────────────────────────────────────────── */
function _parseCalendarEvents(events) {
  let count = events.length;
  let indianMales = 0, indianFemales = 0, nonIndianMales = 0, nonIndianFemales = 0;
  for (const ev of events) {
    const titleMatch = (ev.summary || '').match(/\b(Male|Female)\b/i);
    if (!titleMatch) continue;

    const desc = ev.description || '';
    let isIndia = null;

    if (/\bnon[\s\-]?indian\b/i.test(desc)) {
      isIndia = false;
    } else if (/\b(india|indian)\b/i.test(desc)) {
      isIndia = true;
    } else {
      const natMatch = desc.match(/Nationality:\s*(.+)/i);
      if (natMatch) isIndia = false;
    }

    if (isIndia === null) continue;

    const gender = titleMatch[1].charAt(0).toUpperCase() + titleMatch[1].slice(1).toLowerCase();
    if (isIndia) {
      if (gender === 'Male') indianMales++; else indianFemales++;
    } else {
      if (gender === 'Male') nonIndianMales++; else nonIndianFemales++;
    }
  }
  return { count, indianMales, indianFemales, nonIndianMales, nonIndianFemales };
}

/* ─────────────────────────────────────────────
   CALENDAR BOOKINGS  (single source of truth)
   Fetches all timed events for a slot from Google Calendar.
   Parses gender from title: "Name — Male/Female, Age yrs"
   Parses nationality from description: "Nationality: Country"
   Returns { count, indianMales, indianFemales, nonIndianMales, nonIndianFemales }
   Events that don't match the format are counted in `count`
   but skipped for the therapist breakdown.
───────────────────────────────────────────── */
async function getCalendarBookings(auth, date, slot) {
  const ZERO = { count: 0, indianMales: 0, indianFemales: 0, nonIndianMales: 0, nonIndianFemales: 0 };
  if (!auth) return ZERO;
  const times   = SLOT_TIMES[slot];
  const timeMin = `${date}T${times.start}:00+05:30`;
  const timeMax = `${date}T${times.end}:00+05:30`;
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID, timeMin, timeMax,
      singleEvents: true, orderBy: 'startTime',
    });
    const events = (res.data.items || []).filter(e =>
      e.start &&
      e.start.dateTime &&                         // timed events only — all-day events use start.date
      !e.start.date &&                            // belt-and-suspenders: skip date-only starts
      e.status !== 'cancelled' &&                 // ignore cancelled instances
      !IGNORED_EVENT_TITLE_RE.test(e.summary || '') // ignore admin events (follow-up, training, …)
    );
    return _parseCalendarEvents(events);
  } catch (err) {
    console.error('getCalendarBookings error:', err.message);
    return ZERO;
  }
}

/* ─────────────────────────────────────────────
   CHECK SLOT AVAILABILITY
   Returns { available, availableRooms, maxForGroup }
   where maxForGroup = how many of the given patients
   can actually be accommodated (rooms + therapist constraints).

   Therapist rules:
   - Indian males     → must use male therapist
   - Non-Indian males → must use male therapist
   - Indian females   → must use female therapist
   - Non-Indian females → male or female (flex)

   bookingMode = true  : available only if ALL patients fit
   bookingMode = false : available if at least 1 patient fits
                         (partial capacity triggers split mode on the frontend)
───────────────────────────────────────────── */
/**
 * _calculateAvailability — pure function, no API calls.
 * Accepts pre-fetched capacity and calBookings objects.
 * Exported for unit testing.
 */
function _calculateAvailability(capacity, calBookings, patients, bookingMode = false) {
  const calCount = calBookings.count;
  const booked   = calBookings;

  const availableRooms = Math.max(0, capacity.rooms - calCount);

  const availMale   = Math.max(0, capacity.male   - booked.indianMales  - booked.nonIndianMales);
  const availFemale = Math.max(0, capacity.female - booked.indianFemales);

  const newIndianM    = patients.filter(p => p.nationality === 'India' && p.gender === 'Male').length;
  const newIndianF    = patients.filter(p => p.nationality === 'India' && p.gender === 'Female').length;
  const newNonIndianM = patients.filter(p => p.nationality !== 'India' && p.gender === 'Male').length;
  const newNonIndianF = patients.filter(p => p.nationality !== 'India' && p.gender === 'Female').length;

  const canMales     = Math.min(newIndianM + newNonIndianM, availMale);
  const canIndF      = Math.min(newIndianF, availFemale);
  const remainMale   = Math.max(0, availMale   - canMales);
  const remainFemale = Math.max(0, availFemale - canIndF);
  const canNonIndF   = Math.min(newNonIndianF, remainMale + remainFemale);
  const therapistMax = canMales + canIndF + canNonIndF;

  const maxForGroup = Math.min(availableRooms, therapistMax);

  if (bookingMode) {
    if (maxForGroup < patients.length) {
      return { available: false, reason: 'No availability for this slot', availableRooms, maxForGroup };
    }
  } else {
    if (maxForGroup === 0) {
      return { available: false, reason: 'No availability for this slot', availableRooms: 0, maxForGroup: 0 };
    }
  }

  return { available: true, availableRooms, maxForGroup };
}

async function checkSlotAvailability(auth, date, slot, patients, bookingMode = false) {
  const [capacity, calBookings] = await Promise.all([
    getTherapistCapacity(auth, date),
    getCalendarBookings(auth, date, slot),
  ]);

  console.log(
    `[slots] ${date} ${slot} | ` +
    `cap(M=${capacity.male} F=${capacity.female} R=${capacity.rooms}) | ` +
    `cal(count=${calBookings.count} iM=${calBookings.indianMales} iF=${calBookings.indianFemales} niM=${calBookings.nonIndianMales} niF=${calBookings.nonIndianFemales}) | ` +
    `need=${patients.length}`
  );

  return _calculateAvailability(capacity, calBookings, patients, bookingMode);
}

/* ─────────────────────────────────────────────
   CREATE CALENDAR EVENT  (one per patient)
   Title:       "Patient Name — Gender, Age yrs"
   Description: Nationality + Phone + booking note
───────────────────────────────────────────── */
async function createCalendarEvent(auth, patient, phone, date, slot) {
  if (!auth) return null;
  const times = SLOT_TIMES[slot];
  const event = {
    summary: `${patient.name} — ${patient.gender}, ${patient.age} yrs`,
    description: [
      `Nationality: ${patient.nationality}`,
      `Contact: ${phone}`,
      ...(patient.notes ? [`\nSpecial Considerations: ${patient.notes}`] : []),
      '',
      'Booked via Ojaswi Wellness website.',
    ].join('\n'),
    start: { dateTime: `${date}T${times.start}:00+05:30`, timeZone: 'Asia/Kolkata' },
    end:   { dateTime: `${date}T${times.end}:00+05:30`,   timeZone: 'Asia/Kolkata' },
    colorId: patient.nationality === 'India' ? '2' : '7', // Sage=Indian, Peacock=international
    reminders: {
      useDefault: false,
      overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 60 }],
    },
  };
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
    return res.data.id;
  } catch (err) {
    console.error('createCalendarEvent error:', err.message);
    return null;
  }
}

/* ─────────────────────────────────────────────
   RECORD BOOKING IN SHEETS  (one row per patient)
───────────────────────────────────────────── */
async function recordBooking(auth, bookingId, patient, phone, email, date, slot, eventId) {
  if (!auth || !SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Bookings!A:L',
      valueInputOption: 'RAW',
      resource: {
        values: [[
          bookingId,
          patient.name,
          patient.age,
          patient.gender,
          patient.nationality,
          date,
          slot,
          phone,
          email || '',
          eventId || '',
          new Date().toISOString(),
          patient.notes || '',
        ]],
      },
    });
  } catch (err) {
    console.error('recordBooking error:', err.message);
  }
}

/* ─────────────────────────────────────────────
   ENSURE SHEETS EXIST WITH CORRECT HEADERS
───────────────────────────────────────────── */
async function ensureSheets(auth) {
  if (!auth || !SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const meta   = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const names  = meta.data.sheets.map(s => s.properties.title);
    const adds   = [];

    if (!names.includes('Therapist Capacity')) {
      adds.push({ addSheet: { properties: { title: 'Therapist Capacity' } } });
    }
    if (!names.includes('Bookings')) {
      adds.push({ addSheet: { properties: { title: 'Bookings' } } });
    }
    if (adds.length) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: adds } });
    }

    // Ensure Therapist Capacity header row (only if sheet was just created or is empty)
    const capRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Therapist Capacity!A1' });
    if (!(capRes.data.values || []).length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Therapist Capacity!A1:D1',
        valueInputOption: 'RAW',
        resource: { values: [['Date (YYYY-MM-DD)', 'Male Therapists', 'Female Therapists', 'Rooms Available']] },
      });
    }

    // Ensure Bookings header row
    const bkRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Bookings!A1' });
    if (!(bkRes.data.values || []).length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Bookings!A1:L1',
        valueInputOption: 'RAW',
        resource: {
          values: [['Booking ID','Patient Name','Age','Gender','Nationality',
                    'Date','Slot','Phone','Email','Calendar Event ID','Created At','Special Considerations']],
        },
      });
    }
  } catch (err) {
    console.error('ensureSheets error:', err.message);
  }
}

/* ─────────────────────────────────────────────
   BUILD EMAIL HTML — pure function, exported for testing.
───────────────────────────────────────────── */
function _buildEmailHtml(email, phone, patientBookings, bookingId) {
  const byDate = {};
  for (const pb of patientBookings) {
    if (!byDate[pb.date]) byDate[pb.date] = [];
    byDate[pb.date].push(pb);
  }

  const dateBlocks = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, patients]) => {
      const [year, month, day] = date.split('-');
      const dateLabel = new Date(+year, +month - 1, +day)
        .toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

      const patientCards = patients.map(p => {
        const notesHtml = p.notes
          ? `<div style="margin-top:8px;padding:8px 10px;background:#251a10;border-left:3px solid #d96b30;border-radius:0 6px 6px 0;font-size:0.8rem;color:#c8a882;line-height:1.5;">
               <span style="font-weight:600;color:#a08060;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.05em;">Special Considerations</span><br>
               ${p.notes}
             </div>`
          : '';
        return `
        <div style="background:#1a120a;border-radius:8px;padding:12px 14px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px;">
            <div>
              <div style="font-weight:600;color:#e8d9c8;font-size:0.9rem;">${p.name}</div>
              <div style="color:#a08060;font-size:0.8rem;margin-top:2px;">${p.gender}, ${p.age} yrs &nbsp;·&nbsp; ${p.nationality}</div>
            </div>
            <div style="background:#2a1e14;border-radius:6px;padding:4px 10px;font-size:0.8rem;color:#d96b30;font-weight:600;white-space:nowrap;">${p.slot}</div>
          </div>
          ${notesHtml}
        </div>`;
      }).join('');

      return `
      <div style="margin-bottom:20px;">
        <div style="font-size:0.78rem;font-weight:700;color:#d96b30;letter-spacing:0.07em;text-transform:uppercase;margin-bottom:8px;">${dateLabel}</div>
        ${patientCards}
      </div>`;
    }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin:0; padding:0; background:#1a120a; font-family:'Helvetica Neue',Arial,sans-serif; color:#e8d9c8; }
    .wrapper { max-width:560px; margin:32px auto; background:#221710; border-radius:14px; overflow:hidden; }
    .header { background:linear-gradient(135deg,#d96b30,#b8521f); padding:28px 32px; }
    .body { padding:28px 32px; }
    .footer { padding:18px 32px; border-top:1px solid #2a2118; font-size:0.75rem; color:#7a5e44; text-align:center; }
    @media (max-width:600px) {
      .wrapper { margin:0; border-radius:0; }
      .header { padding:20px 18px; }
      .body { padding:20px 18px; }
      .footer { padding:14px 18px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div style="font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:0.02em;">Ojaswi Wellness</div>
      <div style="font-size:0.85rem;color:rgba(255,255,255,0.75);margin-top:4px;">Booking Confirmation</div>
    </div>
    <div class="body">
      <p style="font-size:1rem;color:#e8d9c8;margin:0 0 6px;">Your session${patientBookings.length > 1 ? 's have' : ' has'} been confirmed.</p>
      <p style="font-size:0.85rem;color:#a08060;margin:0 0 24px;">Booking ID: <strong style="color:#d96b30;">${bookingId}</strong></p>
      ${dateBlocks}
      <div style="margin-top:8px;padding:14px 16px;background:#f5ede4;border-radius:10px;border:1px solid #e0d0c0;font-size:0.85rem;">
        <div style="color:#7a5e44;margin-bottom:4px;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Contact</div>
        <div style="word-break:break-all;color:#2a1a08;font-weight:500;">${phone}${email ? ` &nbsp;·&nbsp; ${email}` : ''}</div>
      </div>
      <p style="margin-top:22px;font-size:0.8rem;color:#7a5e44;line-height:1.6;">
        Each session includes your chosen treatment (60 or 90 mins), any add-ons selected (up to 30 mins), and time to shower and freshen up — please allow up to 2 hours in total.<br>
        Kindly arrive 5 minutes early. Our team will contact you on the number above if any changes are needed.
      </p>
    </div>
    <div class="footer">
      Ojaswi Wellness &nbsp;·&nbsp; <a href="https://ojaswiwellness.com" style="color:#d96b30;text-decoration:none;">ojaswiwellness.com</a>
    </div>
  </div>
</body>
</html>`;
}

/* ─────────────────────────────────────────────
   SEND CONFIRMATION EMAIL  (via Gmail SMTP)
   Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD
───────────────────────────────────────────── */
async function sendConfirmationEmail(email, phone, patientBookings, bookingId) {
  const gmailUser = process.env.GMAIL_USER;
  // Strip spaces — Gmail shows App Passwords in 4-char groups but SMTP needs no spaces
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  const adminEmail = 'ojaswi.wellness@gmail.com';

  if (!gmailUser || !gmailPass) {
    console.warn('[email] Skipping — GMAIL_USER or GMAIL_APP_PASSWORD missing.');
    return;
  }

  // Build recipient list: always CC admin; customer only if email provided
  const toList   = email ? email : adminEmail;
  const ccList   = email && email !== adminEmail ? adminEmail : undefined;

  try {
    const html = _buildEmailHtml(email || adminEmail, phone, patientBookings, bookingId);
    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   465,
      secure: true,           // SSL (port 465) — more reliable than STARTTLS
      auth:   { user: gmailUser, pass: gmailPass },
    });

    await transporter.sendMail({
      from:    `"Ojaswi Wellness" <${gmailUser}>`,
      to:      toList,
      ...(ccList ? { cc: ccList } : {}),
      subject: `Booking Confirmed — ${bookingId}`,
      html,
    });
    console.log(`[email] ✅ Confirmation sent to ${toList}${ccList ? ` (CC: ${ccList})` : ''}`);
  } catch (err) {
    console.error('[email] ❌ Failed to send confirmation email.');
    console.error('[email]    To:', toList);
    console.error('[email]    Error:', err.message);
    if (err.responseCode) console.error('[email]    SMTP code:', err.responseCode, err.response);
    // Non-fatal — booking is already recorded
  }
}

/* ─────────────────────────────────────────────
   SSE HELPER
───────────────────────────────────────────── */
function sseWrite(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

/* ─────────────────────────────────────────────
   HANDLER: GET /api/slots
───────────────────────────────────────────── */
async function handleSlots(req, res) {
  const date   = req.query.date;
  const ptsRaw = req.query.patients || '[]';
  if (!date) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });

  let patients;
  try { patients = JSON.parse(ptsRaw); } catch { patients = []; }

  const auth   = getAuth();
  const result = [];

  for (const slot of SLOTS) {
    const pts   = patients.length ? patients : [{ gender: 'Male', nationality: '' }];
    const avail = await checkSlotAvailability(auth, date, slot, pts);
    result.push({
      slot,
      available:      avail.available,
      availableRooms: avail.availableRooms ?? 0,
      maxForGroup:    avail.maxForGroup    ?? 0,
      reason:         avail.reason || null,
    });
  }

  res.setHeader('Content-Type', 'application/json');
  res.json({ date, slots: result });
}

/* ─────────────────────────────────────────────
   HANDLER: POST /api/book  (SSE stream)
   Payload: { patientBookings: [{...patient, date, slot}], phone }
───────────────────────────────────────────── */
async function handleBook(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const { patientBookings, phone, email } = req.body || {};

  // ── Step 1: Validate ───────────────────────
  sseWrite(res, 'progress', { step: 'validate' });
  await delay(300);

  if (!patientBookings?.length || !phone || !email) {
    sseWrite(res, 'complete', { success: false, message: 'Invalid booking data.' });
    return res.end();
  }
  for (const pb of patientBookings) {
    if (!pb.name || !pb.age || !pb.gender || !pb.nationality || !pb.date || !pb.slot) {
      sseWrite(res, 'complete', { success: false, message: 'Incomplete patient information.' });
      return res.end();
    }
  }

  // ── Step 2: Availability — group by (date, slot) ──
  sseWrite(res, 'progress', { step: 'slots' });
  await delay(400);

  const auth = getAuth();
  await ensureSheets(auth);

  // Group patients sharing the same date+slot
  const groups = {};
  for (const pb of patientBookings) {
    const key = `${pb.date}|${pb.slot}`;
    if (!groups[key]) groups[key] = { date: pb.date, slot: pb.slot, patients: [] };
    groups[key].patients.push({ gender: pb.gender, nationality: pb.nationality });
  }

  for (const g of Object.values(groups)) {
    let avail;
    try {
      avail = await checkSlotAvailability(auth, g.date, g.slot, g.patients, true);
    } catch (err) {
      console.error('checkSlotAvailability threw:', err.message);
      sseWrite(res, 'complete', { success: false, message: 'Could not verify availability. Please try again.' });
      return res.end();
    }
    if (!avail.available) {
      sseWrite(res, 'complete', {
        success: false,
        message: `The ${g.slot} slot on ${g.date} is no longer available. Please go back and choose another slot.`,
      });
      return res.end();
    }
  }

  // ── Step 3: Create Calendar Events (one per patient) ──
  sseWrite(res, 'progress', { step: 'calendar' });
  await delay(500);

  const bookingId = 'OW-' + Date.now().toString(36).toUpperCase();

  // ── Step 4: Confirm immediately, then write to Calendar/Sheets/Email in background ──
  // Google API write calls can take 30–120 s on cold connections (googleapis retry logic).
  // Render keeps the process alive after res.end(), so background work completes fine.
  sseWrite(res, 'progress', { step: 'confirm' });
  await delay(400);
  sseWrite(res, 'complete', { success: true, bookingId });
  res.end();

  // Background: create calendar events, record in sheets, send email
  // Errors are logged but cannot affect the user response (already sent).
  (async () => {
    for (const pb of patientBookings) {
      try {
        const eventId = await createCalendarEvent(auth, pb, phone, pb.date, pb.slot);
        await recordBooking(auth, bookingId, pb, phone, email, pb.date, pb.slot, eventId);
      } catch (err) {
        console.error('[booking] Background write failed for', pb.name, ':', err.message);
      }
    }
    await sendConfirmationEmail(email, phone, patientBookings, bookingId);
  })();
}

/* ─────────────────────────────────────────────
   VERCEL ENTRY POINT
───────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url  = req.url || '';
  const path = url.split('?')[0];

  if (path.endsWith('/slots') && req.method === 'GET')  return handleSlots(req, res);
  if (path.endsWith('/book')  && req.method === 'POST') return handleBook(req, res);

  res.status(404).json({ error: 'Not found' });
};

module.exports.handleSlots = handleSlots;
module.exports.handleBook  = handleBook;

// Pure-function exports — used by unit tests only
module.exports._calculateAvailability  = _calculateAvailability;
module.exports._parseCalendarEvents    = _parseCalendarEvents;
module.exports._buildEmailHtml         = _buildEmailHtml;
module.exports._IGNORED_EVENT_TITLE_RE = IGNORED_EVENT_TITLE_RE;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
