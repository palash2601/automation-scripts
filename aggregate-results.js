// Reads all results-*.json files written by matrix-mode oci-checker.js runs
// (one per day of August) and sends a single combined OCI/Surrender email.
//
// Usage: node aggregate-results.js <results-directory>

const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./oci-checker.js');

const SITE_URL = 'https://appointment.indianembassynetherland.com/';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node aggregate-results.js <results-directory>');
    process.exit(1);
  }

  if (!fs.existsSync(dir)) {
    console.error(`❌ Results directory not found: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  console.log(`📂 Found ${files.length} result file(s) in ${dir}: ${files.join(', ')}`);

  const allOverview = [];
  const allOci = [];
  const allSurrender = [];
  const missingDays = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`  ⚠️  Could not parse ${file}: ${err.message}`);
      continue;
    }

    if (Array.isArray(data.missingRequestedDays)) {
      missingDays.push(...data.missingRequestedDays);
    }

    allOverview.push(...(data.overview || []));
    allOci.push(...(data.ociAvailable || []));
    allSurrender.push(...(data.surrenderAvailable || []));
  }

  // Sort overview by date for a readable report (dates are "DD-MM-YYYY")
  allOverview.sort((a, b) => {
    const [da, ma, ya] = a.date.split('-').map(Number);
    const [db, mb, yb] = b.date.split('-').map(Number);
    return (ya - yb) || (ma - mb) || (da - db);
  });

  const anyAvailable = allOci.length > 0 || allSurrender.length > 0;

  const overviewLines = allOverview.map(r => {
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
      : 'Checked all available August appointment dates — no OCI or Surrender slots open yet.\n',
  ];

  if (allOci.length > 0) {
    bodyParts.push('OCI available on:');
    bodyParts.push(allOci.map(r => `  • ${r.date} | ${r.slot} | ${r.service}`).join('\n'));
    bodyParts.push('');
  }

  if (allSurrender.length > 0) {
    bodyParts.push('Surrender available on:');
    bodyParts.push(allSurrender.map(r => `  • ${r.date} | ${r.slot} | ${r.service}`).join('\n'));
    bodyParts.push('');
  }

  bodyParts.push('Full overview (all dates checked across matrix jobs):');
  bodyParts.push(overviewLines || '  (none checked)');

  if (missingDays.length > 0) {
    bodyParts.push('');
    bodyParts.push(`Note: these August days were not open for booking: ${missingDays.sort((a, b) => a - b).join(', ')}`);
  }

  bodyParts.push('');
  bodyParts.push(`Book now: ${SITE_URL}`);
  bodyParts.push(`Aggregated at: ${new Date().toISOString()}`);

  const body = bodyParts.join('\n');

  console.log('\n' + body);

  if (process.env.GMAIL_USER) {
    await sendEmail(subject, body);
  } else {
    console.log('⚠️  GMAIL_USER not set — skipping email');
  }
}

main().catch(err => {
  console.error('❌ Aggregation error:', err.message);
  process.exit(1);
});
