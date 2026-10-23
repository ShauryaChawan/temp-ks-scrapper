const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('node:fs');
const path = require('node:path');

puppeteer.use(StealthPlugin());

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const SWIGGY_RES_ID = getArg('res-id', '10979');
const OUTLET_RIDS = (getArg('outlet-rids', '') || '')
  .split(',')
  .map(rid => rid.trim())
  .filter(Boolean);

const PAGE_URL = `https://partner.swiggy.com/food/business-metrics/ads-performance/restaurant/${SWIGGY_RES_ID}`;
const REPORT_ID = '34874332-c1f5-4380-84dc-9d3517a87c79';
const ACTION_DELAY_MS = 1000;
const INITIAL_WAIT_MS = 30000;
const EXTENDED_WAIT_MS = 120000;
const INITIAL_POLL_INTERVAL_MS = 2000;
const EXTENDED_POLL_INTERVAL_MS = 5000;
const TIMEZONE = 'Asia/Kolkata';
const REQUIRED_METRICS = [
  'Ad Spends', 'Impressions', 'Menu Visits', 'Orders',
  'NU Orders', 'Sales', 'AOV', 'CPC', 'ROAS',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatTimestampWithTimezone(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  const instantAtSecond = Math.floor(date.getTime() / 1000) * 1000;
  const zonedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMinutes = Math.round((zonedAsUtc - instantAtSecond) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetRemainder}`;
}

function getYesterday() {
  // Use the Asia/Kolkata date, independent of the host machine's configured timezone.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const dateParts = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const date = new Date(Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day) - 1));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  return {
    day, month, year,
    display: [String(day).padStart(2, '0'), String(month + 1).padStart(2, '0'), year].join('/'),
    iso: [year, String(month + 1).padStart(2, '0'), String(day).padStart(2, '0')].join('-'),
  };
}

async function clickAndWait(page, selector) {
  await page.locator(selector).click();
  await sleep(ACTION_DELAY_MS);
}

async function selectDate(page, placeholder, target) {
  await clickAndWait(page, `input[placeholder="${placeholder}"]`);

  for (let attempt = 0; attempt < 24; attempt++) {
    const calendar = await page.evaluate(() => ({
      caption: document.querySelector('.DayPicker-Caption')?.innerText?.trim() || null,
      hasNext: !!document.querySelector('.DayPicker-NavButton--next'),
      hasPrevious: !!document.querySelector('.DayPicker-NavButton--prev'),
      visible: !!document.querySelector('.DayPicker'),
    }));

    if (!calendar.visible || !calendar.caption) {
      throw new Error(`Calendar not detected for "${placeholder}".`);
    }

    const match = calendar.caption.match(/([A-Za-z]+)\\s+(\\d{4})/);
    if (!match) throw new Error(`Cannot parse calendar caption: "${calendar.caption}"`);

    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const visibleMonth = monthNames.indexOf(match[1].toLowerCase());
    const visibleYear = Number(match[2]);
    if (visibleMonth < 0) throw new Error(`Unknown calendar month: ${match[1]}`);

    const visibleIndex = visibleYear * 12 + visibleMonth;
    const targetIndex = target.year * 12 + target.month;
    if (visibleIndex === targetIndex) break;
    if (attempt === 23) throw new Error('Could not navigate to the target calendar month.');

    const direction = visibleIndex < targetIndex
      ? '.DayPicker-NavButton--next'
      : '.DayPicker-NavButton--prev';
    const exists = direction.endsWith('--next') ? calendar.hasNext : calendar.hasPrevious;
    if (!exists) throw new Error(`Calendar navigation button not found: ${direction}`);
    await clickAndWait(page, direction);
  }

  const selected = await page.evaluate(dayNumber => {
    const cells = [...document.querySelectorAll('.DayPicker-Day')];
    const cell = cells.find(el =>
      !el.classList.contains('DayPicker-Day--outside')
      && !el.classList.contains('DayPicker-Day--disabled')
      && el.getAttribute('aria-disabled') !== 'true'
      && el.innerText.trim() === String(dayNumber)
    );
    if (!cell) return false;
    cell.click();
    return true;
  }, target.day);

  if (!selected) throw new Error(`Could not select day ${target.day} for ${placeholder}.`);
  await sleep(ACTION_DELAY_MS);

  const actualValue = await page.$eval(`input[placeholder="${placeholder}"]`, input => input.value);
  const normalizedActual = actualValue.includes('-')
    ? actualValue.split('-').reverse().join('/')
    : actualValue;
  if (normalizedActual !== target.display) {
    throw new Error(`${placeholder} date mismatch. Expected ${target.display}, received ${actualValue}`);
  }
}

function parseMetricValue(metric, rawValue) {
  const cleaned = String(rawValue).replace(/[₹,\\s]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new Error(`Could not parse metric "${metric}" value "${rawValue}"`);

  const keys = {
    'Ad Spends': 'ad_spends',
    'Impressions': 'impressions',
    'Menu Visits': 'menu_visits',
    'Orders': 'orders',
    'NU Orders': 'nu_orders',
    'Sales': 'sales',
    'AOV': 'aov',
    'CPC': 'cpc',
    'ROAS': 'roas',
  };
  if (!keys[metric]) throw new Error(`Unexpected metric label: ${metric}`);
  return { key: keys[metric], value };
}

async function ensureDashboardReady(page) {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const expectedPath = /\\/food\\/business-metrics\\/ads-performance\\/restaurant\\/\\d+/.test(location.href);
    const filterPresent = [...document.querySelectorAll('button')]
      .some(button => button.innerText.includes('Outlet name & RID'));
    return expectedPath && filterPresent;
  }, { timeout: 30000 });
}

async function openOutletFilter(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(button => button.innerText.includes('Outlet name & RID'))
  );
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find(el => el.innerText.includes('Outlet name & RID'));
    if (!button) throw new Error('Outlet filter button not found');
    button.click();
  });
  await sleep(ACTION_DELAY_MS);
  await page.waitForSelector('input[placeholder="Search outlet by name or RID"]');
}

async function selectOutlet(page, rid) {
  await openOutletFilter(page);

  const checkedIds = await page.evaluate(() => {
    const search = document.querySelector('input[placeholder="Search outlet by name or RID"]');
    let node = search;
    let sidebar = null;
    while (node && node !== document.body) {
      const hasCheckboxes = node.querySelector('input[type="checkbox"]');
      const hasConfirm = [...node.querySelectorAll('button')]
        .some(button => button.innerText.trim().toLowerCase() === 'confirm');
      if (hasCheckboxes && hasConfirm) { sidebar = node; break; }
      node = node.parentElement;
    }
    if (!sidebar) throw new Error('Could not identify outlet sidebar containing Confirm.');
    return [...sidebar.querySelectorAll('input[type="checkbox"]:checked')]
      .map(checkbox => checkbox.id).filter(Boolean);
  });

  for (const id of checkedIds) {
    const unchecked = await page.evaluate(outletId => {
      const checkbox = document.getElementById(outletId);
      if (!checkbox || checkbox.type !== 'checkbox') return false;
      if (checkbox.checked) checkbox.click();
      return !checkbox.checked;
    }, id);
    if (!unchecked) throw new Error(`Could not deselect outlet checkbox ${id}`);
  }

  await page.locator('input[placeholder="Search outlet by name or RID"]').fill(rid);
  await sleep(ACTION_DELAY_MS);

  await page.waitForFunction(targetRid => {
    const checkbox = document.getElementById(targetRid);
    return checkbox && checkbox.type === 'checkbox';
  }, { timeout: 20000 }, rid);

  const selected = await page.evaluate(targetRid => {
    const checkbox = document.getElementById(targetRid);
    if (!checkbox || checkbox.type !== 'checkbox') return false;
    if (!checkbox.checked) checkbox.click();
    return checkbox.checked;
  }, rid);
  if (!selected) throw new Error(`Could not select outlet RID ${rid}`);

  await sleep(ACTION_DELAY_MS);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find(el => el.innerText.trim().toLowerCase() === 'confirm');
    if (!button) throw new Error('Confirm button not found');
    button.click();
  });
  await sleep(ACTION_DELAY_MS);
}

async function extractMetrics(page) {
  const waitStartedAt = Date.now();
  let lastStatus = { attachedFrameFound: false, loaded: false };
  let extendedWaitEnabled = false;
  let nextPollIntervalMs = INITIAL_POLL_INTERVAL_MS;

  while (Date.now() - waitStartedAt < EXTENDED_WAIT_MS) {
    const elapsedMs = Date.now() - waitStartedAt;
    if (!extendedWaitEnabled && elapsedMs >= INITIAL_WAIT_MS) {
      extendedWaitEnabled = true;
      nextPollIntervalMs = EXTENDED_POLL_INTERVAL_MS;
      console.log('30 seconds elapsed; extending polling to 2 minutes total.');
    }

    const frame = page.frames().find(candidate =>
      candidate.url().includes('app.powerbi.com/reportEmbed')
      && candidate.url().includes(REPORT_ID)
    );

    if (frame) {
      try {
        const result = await frame.evaluate(() => {
          const extracted = [];
          const cards = [...document.querySelectorAll('.card[aria-label]')];
          for (const card of cards) {
            for (const item of [...card.querySelectorAll('.cardItemContainer')]) {
              const labelElement = item.querySelector('.details');
              const valueElement = item.querySelector('.caption');
              const label = labelElement?.getAttribute('title') || labelElement?.innerText?.trim();
              const value = valueElement?.getAttribute('title') || valueElement?.innerText?.trim();
              if (label && value) extracted.push({ metric: label, value });
            }
          }
          return { metrics: extracted };
        });

        const foundLabels = new Set(result.metrics.map(item => item.metric));
        const loaded = REQUIRED_METRICS.every(label => foundLabels.has(label));
        lastStatus = { attachedFrameFound: true, loaded };
        console.log(`[${Math.round((Date.now() - waitStartedAt) / 1000)}s] Power BI check: ${JSON.stringify(lastStatus)}`);

        if (loaded) {
          const metrics = {};
          for (const item of result.metrics) {
            const parsed = parseMetricValue(item.metric, item.value);
            metrics[parsed.key] = parsed.value;
          }
          return metrics;
        }
      } catch (error) {
        lastStatus = { attachedFrameFound: true, loaded: false };
        console.log(`[${Math.round((Date.now() - waitStartedAt) / 1000)}s] Power BI check: ${JSON.stringify(lastStatus)}`);
      }
    } else {
      lastStatus = { attachedFrameFound: false, loaded: false };
      console.log(`[${Math.round((Date.now() - waitStartedAt) / 1000)}s] Power BI check: ${JSON.stringify(lastStatus)}`);
    }

    const currentElapsedMs = Date.now() - waitStartedAt;
    const delay = extendedWaitEnabled
      ? nextPollIntervalMs
      : Math.min(nextPollIntervalMs, Math.max(1, INITIAL_WAIT_MS - currentElapsedMs));
    await sleep(delay);
  }

  throw new Error(`Power BI metrics unavailable within 2 minutes. Last status: ${JSON.stringify(lastStatus)}`);
}

async function getReportDates(page, fallbackDate) {
  const dates = await page.evaluate(() => [...document.querySelectorAll(
    'input[placeholder="From"], input[placeholder="To"]'
  )].map(input => ({ field: input.placeholder, value: input.value })));

  const toIsoDate = value => {
    if (!value) return null;
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return value;
    const match = value.match(/^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  };

  return {
    fromDate: toIsoDate(dates.find(date => date.field === 'From')?.value) || fallbackDate,
    toDate: toIsoDate(dates.find(date => date.field === 'To')?.value) || fallbackDate,
  };
}

async function main() {
  if (!/^\\d+$/.test(String(SWIGGY_RES_ID))) {
    console.error('Invalid --res-id. Expected a numeric Swiggy restaurant ID.');
    process.exitCode = 2;
    return;
  }
  if (!OUTLET_RIDS.length) {
    console.error('Pass at least one RID using --outlet-rids=RID1,RID2,...');
    process.exitCode = 2;
    return;
  }
  if (OUTLET_RIDS.some(rid => !/^\\d+$/.test(rid))) {
    console.error('Invalid outlet RID. All RIDs must be numeric strings.');
    process.exitCode = 2;
    return;
  }
  if (new Set(OUTLET_RIDS).size !== OUTLET_RIDS.length) {
    console.error('Duplicate outlet RIDs are not allowed.');
    process.exitCode = 2;
    return;
  }

  const extractionStartedAt = Date.now();
  const yesterday = getYesterday();
  let browser;
  let fatalError = null;
  const outletResults = [];

  try {
    // Headless Chromium is required for cloud/container execution.
    // Cloud authentication must be provisioned separately; a local Chrome profile is not assumed.
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1440, height: 1000 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await ensureDashboardReady(page);

    for (const rid of OUTLET_RIDS) {
      console.log(`Starting outlet RID ${rid}`);
      try {
        await selectOutlet(page, rid);
        await selectDate(page, 'To', yesterday);
        await selectDate(page, 'From', yesterday);
        const metrics = await extractMetrics(page);
        const dates = await getReportDates(page, yesterday.iso);

        outletResults.push({
          outlet_rid: rid,
          status: 'success',
          metrics,
        });

        // Dates are read for validation; one request uses the same range for all outlets.
        if (dates.fromDate !== yesterday.iso || dates.toDate !== yesterday.iso) {
          console.warn(`Dashboard date mismatch for RID ${rid}: ${JSON.stringify(dates)}`);
        }
        console.log(`Completed outlet RID ${rid}`);
      } catch (error) {
        outletResults.push({
          outlet_rid: rid,
          status: 'failed',
          error: {
            code: 'OUTLET_SCRAPE_FAILED',
            message: error?.message || String(error),
          },
        });
        console.error(`Failed outlet RID ${rid}: ${error?.message || error}`);
      }
    }
  } catch (error) {
    fatalError = error;
    console.error('Fatal scraper error:', error?.message || error);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // If dashboard startup failed, mark all requested outlets as failed so the response
  // remains aligned with the requested schema and the caller can inspect the error.
  if (fatalError) {
    const recorded = new Set(outletResults.map(item => item.outlet_rid));
    for (const rid of OUTLET_RIDS) {
      if (!recorded.has(rid)) {
        outletResults.push({
          outlet_rid: rid,
          status: 'failed',
          error: {
            code: 'SCRAPER_STARTUP_FAILED',
            message: fatalError.message || String(fatalError),
          },
        });
      }
    }
  }

  const successfulOutlets = outletResults.filter(item => item.status === 'success').length;
  const failedOutlets = outletResults.length - successfulOutlets;
  const finishedAt = new Date();
  const output = {
    report_metadata: {
      platform: 'swiggy',
      report_name: 'ads_performance',
      from_date: yesterday.iso,
      to_date: yesterday.iso,
      extracted_at: formatTimestampWithTimezone(finishedAt, TIMEZONE),
      extraction_duration_ms: Date.now() - extractionStartedAt,
      total_outlets: OUTLET_RIDS.length,
      successful_outlets: successfulOutlets,
      failed_outlets: failedOutlets,
    },
    outlets: outletResults,
    batch_summary: {
      total_batches: 1,
      outlets_per_batch: OUTLET_RIDS.length,
      completed_batches: outletResults.length === OUTLET_RIDS.length ? 1 : 0,
    },
  };

  const jsonOutput = JSON.stringify(output, null, 2);
  // Keep stdout machine-readable for Lambda/API callers; diagnostics go to stderr via console.
  process.stdout.write(jsonOutput + '\n');

  const timestampForFile = output.report_metadata.extracted_at.replace(/[:+]/g, '-');
  const outputPath = path.resolve(
    process.cwd(),
    `swiggy_ads_performance_multi_${yesterday.iso}_${timestampForFile}.json`
  );
  try {
    fs.writeFileSync(outputPath, jsonOutput + '\n', 'utf8');
    console.error(`JSON saved to: ${outputPath}`);
  } catch (error) {
    console.error(`Could not save local JSON file: ${error.message}`);
  }

  if (fatalError || failedOutlets > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('Unhandled scraper error:', error?.stack || error);
  process.exitCode = 1;
});
