/**
 * server.js — Local development server for Ojasvi Wellness Booking
 * Run: npm start  →  http://localhost:3000
 */
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { handleSlots, handleBook } = require('./api/chat');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve index.html from project root
app.use(express.static(path.join(__dirname)));

// API routes — delegate to the same logic used by the Vercel function
app.get('/api/slots', async (req, res) => {
  try {
    await handleSlots(req, res);
  } catch (err) {
    console.error('slots error', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/book', async (req, res) => {
  try {
    await handleBook(req, res);
  } catch (err) {
    console.error('book error', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// Catch-all → index.html (SPA-style)
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  Ojasvi Wellness Booking running at http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_EMAIL not set — running in demo mode (no calendar/sheets).\n');
  }
});
