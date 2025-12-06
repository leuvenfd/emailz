const express = require('express');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Constants --------------------------------------------------------------

const EXCLUDED_DOMAINS = new Set([
  'sentry.wixpress.com',
  'sentry-next.wixpress.com'
]);

// Can override via Railway env var FIREBASE_DB_URL
const FIREBASE_DB_URL =
  process.env.FIREBASE_DB_URL ||
  'https://trackingclients-default-rtdb.firebaseio.com/emails.json';

const EMAILS_FILE = path.join(__dirname, 'emails.txt');

// --- Helpers ----------------------------------------------------------------

function loadEmailsFromFile(filename = EMAILS_FILE) {
  if (!fs.existsSync(filename)) return new Set();
  const content = fs.readFileSync(filename, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return new Set(lines);
}

function appendEmailsToFile(emails, filename = EMAILS_FILE) {
  if (!emails.length) return;
  const data = emails.map(e => e + '\n').join('');
  fs.appendFileSync(filename, data, 'utf-8');
}

async function saveEmailToFirebase(email) {
  const data = { email };
  try {
    const res = await fetch(FIREBASE_DB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`Failed to save ${email} to Firebase: ${text}`);
      return false;
    }
    console.log(`Saved to Firebase: ${email}`);
    return true;
  } catch (err) {
    console.log(`Error saving to Firebase: ${err}`);
    return false;
  }
}

function cleanUrl(url) {
  url = url.replace(/\\/g, '').trim();
  if (!url) return null;
  try {
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    new URL(url); // validate
    return url;
  } catch {
    return null;
  }
}

async function extractEmailsFromUrl(url) {
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const cleaned = cleanUrl(url);
  if (!cleaned) {
    console.log(`Invalid URL skipped: ${url}`);
    return [];
  }

  try {
    console.log(`Fetching webpage: ${cleaned}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s

    const res = await fetch(cleaned, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/91.0.4472.124 Safari/537.36'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`Error fetching ${cleaned}: status ${res.status}`);
      return [];
    }

    const sourceCode = await res.text();
    console.log(`Successfully fetched ${sourceCode.length} characters of source code`);

    const matches = sourceCode.match(emailPattern) || [];
    const unique = Array.from(new Set(matches));
    console.log(`Found ${unique.length} unique email addresses from ${cleaned}`);
    return unique;
  } catch (err) {
    console.log(`Error fetching ${cleaned}: ${err}`);
    return [];
  }
}

function isProbablySystemEmail(email) {
  const [local, domain] = email.split('@');

  if (EXCLUDED_DOMAINS.has(domain)) return true;

  // long hex (16+ chars)
  if (/^[0-9a-f]{16,}$/i.test(local)) return true;
  // all digits, 8+ chars
  if (/^\d{8,}$/.test(local)) return true;

  return false;
}

function isValidEmail(email) {
  const lower = email.toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.bmp', '.tiff', '.ico'];
  if (imageExts.some(ext => lower.endsWith(ext))) return false;

  const validPattern = /^(?!\.)[a-zA-Z0-9._%+-]+@(?!-)(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

  if (!validPattern.test(email)) return false;
  if (email.includes('..')) return false;
  if (isProbablySystemEmail(email)) return false;

  return true;
}

async function filterValidEmailsAndSave(emailList) {
  const emailsAlreadySaved = loadEmailsFromFile();
  const newEmailsToFile = [];
  const validEmails = [];

  for (const email of new Set(emailList)) {
    if (isValidEmail(email)) {
      validEmails.push(email);
      if (!emailsAlreadySaved.has(email)) {
        const ok = await saveEmailToFirebase(email);
        if (ok) newEmailsToFile.push(email);
      } else {
        console.log(`Skipped saving ${email} to Firebase: already in file`);
      }
    }
  }

  if (newEmailsToFile.length) {
    appendEmailsToFile(newEmailsToFile);
  }

  return validEmails.sort();
}

async function extractEmailsFromUrls(urls) {
  console.log(`Processing ${urls.length} URLs...`);
  console.log('='.repeat(60));

  let allEmails = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);
    const emails = await extractEmailsFromUrl(url);
    allEmails = allEmails.concat(emails);

    if (emails.length) {
      console.log(`  → Found emails: ${emails.join(', ')}`);
    } else {
      console.log(`  → No emails found`);
    }
  }

  const uniqueAllEmails = Array.from(new Set(allEmails)).sort();

  console.log('\n' + '='.repeat(60));
  console.log(`SUMMARY: Found ${uniqueAllEmails.length} unique email addresses across all URLs`);
  console.log('='.repeat(60));

  const validEmails = await filterValidEmailsAndSave(uniqueAllEmails);
  return { allEmails: uniqueAllEmails, validEmails };
}

// --- Express setup ----------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API endpoint used by the frontend
app.post('/api/extract-emails', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'No URLs provided.' });
    }

    const { allEmails, validEmails } = await extractEmailsFromUrls(urls);
    res.json({ allEmails, validEmails });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Start server -----------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
