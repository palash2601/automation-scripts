const fs = require('fs');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const SITE_URL = 'https://appointment.indianembassynetherland.com/';
const AUGUST_MONTH_INDEX = 7;                 // 0-indexed (7 = August)
const NAV_TIMEOUT = 30000;                    // real failure timeout, unchanged from before
const PARALLEL_WORKERS = parseInt(process.env.PARALLEL_WORKERS || '3', 10);

// Per-day matrix mode (for GitHub Actions): if TARGET_DAY is set, only that
// day of August is checked instead of the whole month. Pairs with RESULTS_FILE
// (write results to JSON instead of/as well as emailing) and SKIP_EMAIL (skip
// sending an email from this job — used when an aggregator job will send one
// combined email after all matrix jobs finish).
const TARGET_DAY = process.env.TARGET_DAY ? parseInt(process.env.TARGET_DAY, 10) : null;
const RESULTS_FILE = process.env.RESULTS_FILE || null;
const SKIP_EMAIL = process.env.SKIP_EMAIL === 'true';

// ── Notification ──────────────────────────────────────────────────────────────
async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.NOTIFY_EMAIL,
    subject,
    text: body,
  });
  console.log(`📧 Email sent: ${subject}`);
}

// ── Generic concurrency pool ──────────────────────────────────────────────────
// Runs workerFn(item, index) over `items` with at most `concurrency` in flight.
// Pure and Playwright-agnostic so it can be unit tested without a browser.
async function runPool(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));

  async function worker(workerId) {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await workerFn(items[i], i, workerId);
    }
  }

  await Promise.all(
    Array.from({ length: effectiveConcurrency }, (_, i) => worker(i + 1))
  );

  return results;
}

// ── Event-driven wait helper: waits for network to go quiet, capped ──────────
async function waitForNetworkQuiet(page, timeout = 8000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

// ── Navigate to the booking form, handling consent if it appears ─────────────
async function navigateToBookingForm(page) {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await waitForNetworkQuiet(page, 10000);

  const hasCheckbox = await page.locator('input[type="checkbox"]').count();
  if (hasCheckbox > 0) {
    await page.check('input[type="checkbox"]');
    await page.locator('text=PROCEED').or(page.locator('button:has-text("PROCEED")')).click();
    await page.waitForURL('**/book_appointment**', { timeout: NAV_TIMEOUT }).catch(() => {});
  }
  await page.waitForSelector('.hasDatepicker', { state: 'visible', timeout: NAV_TIMEOUT }).catch(() => {});
}

// ── Open calendar and navigate to month containing available dates ─────────────
// targetMonth: 0-indexed month to stop scanning at (e.g. 7 = August). If provided,
// the scan stops as soon as that month's dates have been collected, instead of
// always paging through up to maxMonths.
async function openCalendarAndGetDates(page, targetMonth = null, maxMonths = 4) {
  await page.click('.hasDatepicker');
  await page.waitForSelector('#ui-datepicker-div', { state: 'visible', timeout: NAV_TIMEOUT });

  const allDates = [];

  for (let i = 0; i < maxMonths; i++) {
    const dates = await page.evaluate(() => {
      const table = document.querySelector('#ui-datepicker-div table');
      if (!table) return [];
      return [...table.querySelectorAll('td')]
        .filter(td => !td.className.includes('ui-state-disabled') && td.textContent.trim() !== '')
        .map(td => ({
          date: td.textContent.trim(),
          month: td.getAttribute('data-month'),  // 0-indexed
          year: td.getAttribute('data-year'),
        }));
    });

    allDates.push(...dates);

    if (targetMonth !== null) {
      const monthsSeen = dates.map(d => parseInt(d.month));
      const reachedTarget = monthsSeen.includes(targetMonth);
      const overshotTarget = monthsSeen.length > 0 && monthsSeen.every(m => m > targetMonth);
      if (reachedTarget || overshotTarget) {
        console.log(`  🛑 Stopping calendar scan early — ${reachedTarget ? 'target month reached' : 'target month passed'}`);
        break;
      }
    }

    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector('.ui-datepicker-next');
      return btn && !btn.classList.contains('ui-state-disabled');
    });
    if (!hasNext) break;

    // Capture the month currently shown so we can detect the DOM update, instead
    // of blindly sleeping after clicking "next".
    const prevMonth = dates.length > 0 ? dates[0].month : null;
    await page.click('.ui-datepicker-next');
    await page.waitForFunction((prev) => {
      const cell = document.querySelector('#ui-datepicker-div td[data-month]');
      return cell && cell.getAttribute('data-month') !== prev;
    }, prevMonth, { timeout: 8000 }).catch(() => {});
  }

  return allDates;
}

// ── Set date via jQuery datepicker API and trigger page events ─────────────────
async function selectDate(page, date, month, year) {
  const dd = date.padStart(2, '0');
  const mm = String(parseInt(month) + 1).padStart(2, '0');
  const formatted = `${dd}-${mm}-${year}`;

  const result = await page.evaluate((formatted) => {
    const input = document.querySelector('.hasDatepicker');
    if (!input) return 'no input';

    if (window.$ && $(input).datepicker) {
      const parts = formatted.split('-');
      const d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      $(input).datepicker('setDate', d);
      $(input).trigger('change');
      return 'set via jquery';
    }

    input.value = formatted;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set via native events';
  }, formatted);

  // Wait for the AJAX call that refreshes the slot list to finish, instead of
  // blindly sleeping a fixed amount of time.
  await waitForNetworkQuiet(page, 8000);
  return { formatted, result };
}

// ── List all available (not fully booked) time slots for the selected date ───
async function getAvailableSlots(page) {
  await page.waitForSelector('.check', { timeout: NAV_TIMEOUT }).catch(() => {});
  return page.evaluate(() => {
    return [...document.querySelectorAll('.check')]
      .map((el, i) => ({ i, text: el.textContent.trim() }))
      .filter(s => s.text.includes('Available'));
  });
}

// ── Click a specific time slot by its index among .check elements ────────────
async function selectSlotByIndex(page, index) {
  await page.evaluate((idx) => {
    const el = document.querySelectorAll('.check')[idx];
    if (el) el.click();
  }, index);
  await waitForNetworkQuiet(page, 8000);
}


// ── Read service category options ─────────────────────────────────────────────
async function getServiceOptions(page) {
  await page.waitForSelector('select option', { timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForNetworkQuiet(page, 5000);
  return page.evaluate(() => {
    const sel = document.querySelector('select');
    if (!sel) return [];
    return [...sel.options].map((o, i) => ({ i, text: o.text, disabled: o.disabled }));
  });
}

// ── Check OCI (option 3) and Surrender (option 4) availability for one date ──
// Checks EVERY available time slot on the date, not just the first — a slot
// further down the list can have OCI/Surrender open even if the first is full.
async function checkDate(page, { date, month, year }, workerId) {
  const label = `${date.padStart(2, '0')}-${String(parseInt(month) + 1).padStart(2, '0')}-${year}`;
  console.log(`\n🔍 [w${workerId}] Checking ${label}...`);

  const { formatted } = await selectDate(page, date, month, year);
  console.log(`  📆 [w${workerId}] Date set: ${formatted}`);

  const slots = await getAvailableSlots(page);
  if (slots.length === 0) {
    console.log(`  ⏰  [w${workerId}] No available time slots on ${label}`);
    return {
      date: label, slots: [],
      oci: 'no time slots', surrender: 'no time slots',
      oci_available: false, surrender_available: false,
    };
  }
  console.log(`  ⏰  [w${workerId}] ${slots.length} available slot(s) on ${label}: ${slots.map(s => s.text).join(', ')}`);

  const slotResults = [];

  for (const slot of slots) {
    await selectSlotByIndex(page, slot.i);

    const options = await getServiceOptions(page);
    const opt3 = options.find(o => o.i === 3);
    const opt4 = options.find(o => o.i === 4);
    const opt3Available = !!(opt3 && !opt3.disabled);
    const opt4Available = !!(opt4 && !opt4.disabled);

    if (opt3Available) {
      console.log(`  🎉 [w${workerId}] OCI AVAILABLE on ${label} @ ${slot.text}! ${opt3.text}`);
    } else {
      console.log(`  ❌ [w${workerId}] OCI not available on ${label} @ ${slot.text} (${opt3 ? opt3.text : 'option missing'})`);
    }

    if (opt4Available) {
      console.log(`  🎉 [w${workerId}] Surrender AVAILABLE on ${label} @ ${slot.text}! ${opt4.text}`);
    } else {
      console.log(`  ❌ [w${workerId}] Surrender not available on ${label} @ ${slot.text} (${opt4 ? opt4.text : 'option missing'})`);
    }

    slotResults.push({
      slot: slot.text,
      oci_available: opt3Available,
      surrender_available: opt4Available,
      oci_service: opt3 ? opt3.text : null,
      surrender_service: opt4 ? opt4.text : null,
    });
  }

  const ociSlots = slotResults.filter(s => s.oci_available).map(s => s.slot);
  const surrenderSlots = slotResults.filter(s => s.surrender_available).map(s => s.slot);

  return {
    date: label,
    slots: slotResults,
    oci: ociSlots.length > 0 ? `Available @ ${ociSlots.join(', ')}` : 'Not available',
    surrender: surrenderSlots.length > 0 ? `Available @ ${surrenderSlots.join(', ')}` : 'Not available',
    oci_available: ociSlots.length > 0,
    surrender_available: surrenderSlots.length > 0,
  };
}

// ── Check all dates in parallel across multiple browser contexts ─────────────
async function checkDatesInParallel(browser, storageState, dates, concurrency) {
  return runPool(dates, concurrency, async (dateEntry, index, workerId) => {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    try {
      await navigateToBookingForm(page);
      return await checkDate(page, dateEntry, workerId);
    } catch (err) {
      const label = `${dateEntry.date}-${dateEntry.month}-${dateEntry.year}`;
      console.error(`  ⚠️  [w${workerId}] Failed checking ${label}: ${err.message}`);
      return {
        date: label, slots: [],
        oci: 'error', surrender: 'error',
        oci_available: false, surrender_available: false,
      };
    } finally {
      await context.close();
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🕐 Check started at ${new Date().toISOString()}`);
  console.log(`⚙️  Parallel workers: ${PARALLEL_WORKERS}`);

  const browser = await chromium.launch({ headless: true });

  try {
    // Step 1: One initial context handles consent + calendar scan, then hands
    // off its session (storageState) to the parallel workers so they can skip
    // the consent screen.
    const loginContext = await browser.newContext();
    const loginPage = await loginContext.newPage();
    await navigateToBookingForm(loginPage);
    console.log('✅ On booking form:', loginPage.url());

    const allAvailableDates = await openCalendarAndGetDates(loginPage, AUGUST_MONTH_INDEX);
    const storageState = await loginContext.storageState();
    await loginContext.close();

    if (allAvailableDates.length === 0) {
      console.log('❌ No available dates found while scanning up to August');
      await browser.close();
      return;
    }

    console.log(`📅 Available dates (scanned through August): ${allAvailableDates.map(d => `${d.date}/${parseInt(d.month) + 1}/${d.year}`).join(', ')}`);

    const augustDates = allAvailableDates.filter(d => parseInt(d.month) === AUGUST_MONTH_INDEX);
    if (augustDates.length === 0) {
      console.log('❌ No available dates in August');
      await browser.close();
      return;
    }
    console.log(`📅 Available dates (August, whole month): ${augustDates.map(d => `${d.date}/${parseInt(d.month) + 1}/${d.year}`).join(', ')}`);

    let availableDates = augustDates;
    if (TARGET_DAY !== null) {
      availableDates = augustDates.filter(d => parseInt(d.date) === TARGET_DAY);
      console.log(`🎯 Matrix mode: restricting to August ${TARGET_DAY} only`);
      if (availableDates.length === 0) {
        console.log(`❌ August ${TARGET_DAY} is not open for booking (not in the calendar's available dates)`);
        if (RESULTS_FILE) {
          fs.writeFileSync(RESULTS_FILE, JSON.stringify({
            overview: [], ociAvailable: [], surrenderAvailable: [],
            targetDay: TARGET_DAY, checkedAt: new Date().toISOString(),
          }, null, 2));
          console.log(`💾 Wrote empty result to ${RESULTS_FILE}`);
        }
        await browser.close();
        return;
      }
    }

    // Step 2: Check OCI (option 3) and Surrender (option 4) in parallel
    const overview = await checkDatesInParallel(browser, storageState, availableDates, PARALLEL_WORKERS);

    const ociAvailable = [];
    const surrenderAvailable = [];
    overview.forEach(r => {
      (r.slots || []).forEach(s => {
        if (s.oci_available) ociAvailable.push({ date: r.date, slot: s.slot, service: s.oci_service });
        if (s.surrender_available) surrenderAvailable.push({ date: r.date, slot: s.slot, service: s.surrender_service });
      });
    });

    // Step 3: Write results to disk for aggregation (matrix mode), and/or send email
    if (RESULTS_FILE) {
      fs.writeFileSync(RESULTS_FILE, JSON.stringify({
        overview, ociAvailable, surrenderAvailable,
        targetDay: TARGET_DAY, checkedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`💾 Wrote results to ${RESULTS_FILE}`);
    }

    const anyAvailable = ociAvailable.length > 0 || surrenderAvailable.length > 0;

    const overviewLines = overview.map(r => {
      const slotSummary = (r.slots && r.slots.length > 0)
        ? r.slots.map(s => s.slot).join(', ')
        : 'none';
      return `  • ${r.date} | slots checked: ${slotSummary} | OCI: ${r.oci} | Surrender: ${r.surrender}`;
    }).join('\n');

    const subject = anyAvailable
      ? `🎉 OCI/Surrender Appointment Available – Indian Embassy Netherlands`
      : `⛔ No OCI/Surrender Slots Available – Indian Embassy Netherlands`;

    const bodyParts = [
      anyAvailable
        ? 'An OCI or Surrender appointment slot is now available!\n'
        : 'Checked all available appointment dates — no OCI or Surrender slots open yet.\n',
    ];

    if (ociAvailable.length > 0) {
      bodyParts.push('OCI available on:');
      bodyParts.push(ociAvailable.map(r => `  • ${r.date} | ${r.slot} | ${r.service}`).join('\n'));
      bodyParts.push('');
    }

    if (surrenderAvailable.length > 0) {
      bodyParts.push('Surrender available on:');
      bodyParts.push(surrenderAvailable.map(r => `  • ${r.date} | ${r.slot} | ${r.service}`).join('\n'));
      bodyParts.push('');
    }

    bodyParts.push('Full overview (all dates checked):');
    bodyParts.push(overviewLines || '  (none checked)');
    bodyParts.push('');
    bodyParts.push(`Book now: ${SITE_URL}`);
    bodyParts.push(`Checked at: ${new Date().toISOString()}`);

    const body = bodyParts.join('\n');

    console.log('\n' + body);

    if (SKIP_EMAIL) {
      console.log('⏭️  SKIP_EMAIL set — not sending from this job (matrix mode; an aggregator job will send one combined email)');
    } else if (process.env.GMAIL_USER) {
      await sendEmail(subject, body);
    } else {
      console.log('⚠️  GMAIL_USER not set — skipping email');
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (process.env.NOTIFY_ON_ERROR === 'true' && process.env.GMAIL_USER) {
      await sendEmail('⚠️ OCI/Surrender Checker Error', `${err.message}\n\n${err.stack}`).catch(() => {});
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Export for testing/reuse; only auto-run when executed directly.
module.exports = { runPool, sendEmail };

if (require.main === module) {
  main();
}
