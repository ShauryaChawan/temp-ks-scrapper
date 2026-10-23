const puppeteer = require('puppeteer');
const readline = require('node:readline/promises');
const fs = require('node:fs');
const path = require('node:path');

const PAGE_URL =
  'https://partner.swiggy.com/food/business-metrics/ads-performance/restaurant/10979';

const TARGET_RID = '26584';
const REPORT_ID = '34874332-c1f5-4380-84dc-9d3517a87c79';
const ACTION_DELAY_MS = 1000;
const INITIAL_WAIT_MS = 30000;
const EXTENDED_WAIT_MS = 120000;
const INITIAL_POLL_INTERVAL_MS = 2000;
const EXTENDED_POLL_INTERVAL_MS = 5000;
const TIMEZONE = 'Asia/Kolkata';
const CURRENCY = 'INR';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatTimestampWithTimezone(date, timeZone) {
  // Format the extraction timestamp in the configured timezone with an explicit UTC offset.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  // Compare the zoned wall-clock fields to the same instant rounded to seconds.
  const instantAtSecond = Math.floor(date.getTime() / 1000) * 1000;
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((zonedAsUtc - instantAtSecond) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetRemainder}`;
}

async function pressEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function clickAndWait(page, selector) {
  await page.locator(selector).click();
  await sleep(ACTION_DELAY_MS);
}

function getYesterday() {
  // Use the computer's local date; configure the machine timezone as Asia/Kolkata.
  const date = new Date();
  date.setDate(date.getDate() - 1);

  return {
    day: date.getDate(),
    month: date.getMonth(),
    year: date.getFullYear(),
    display: [
      String(date.getDate()).padStart(2, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      date.getFullYear(),
    ].join('/'),
    iso: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-'),
  };
}

async function selectDate(page, placeholder, target) {
  console.log(`\nSelecting ${placeholder} date: ${target.display}`);

  await clickAndWait(page, `input[placeholder="${placeholder}"]`);

  // Navigate the calendar until the target month is displayed.
  for (let attempt = 0; attempt < 24; attempt++) {
    const calendar = await page.evaluate(() => {
      const caption = document.querySelector('.DayPicker-Caption');

      return {
        caption: caption?.innerText?.trim() || null,
        hasNext: !!document.querySelector('.DayPicker-NavButton--next'),
        hasPrevious: !!document.querySelector('.DayPicker-NavButton--prev'),
        dayPickerVisible: !!document.querySelector('.DayPicker'),
      };
    });

    if (!calendar.dayPickerVisible || !calendar.caption) {
      throw new Error(
        `Calendar not detected for "${placeholder}". Observed state: ${JSON.stringify(calendar)}`
      );
    }

    const match = calendar.caption.match(/([A-Za-z]+)\s+(\d{4})/);
    if (!match) {
      throw new Error(`Cannot parse calendar caption: "${calendar.caption}"`);
    }

    const monthNames = [
      'january', 'february', 'march', 'april',
      'may', 'june', 'july', 'august',
      'september', 'october', 'november', 'december',
    ];

    const visibleMonth = monthNames.indexOf(match[1].toLowerCase());
    const visibleYear = Number(match[2]);

    if (visibleMonth < 0) {
      throw new Error(`Unknown calendar month: ${match[1]}`);
    }

    const visibleIndex = visibleYear * 12 + visibleMonth;
    const targetIndex = target.year * 12 + target.month;

    if (visibleIndex === targetIndex) break;

    if (attempt === 23) {
      throw new Error('Could not navigate to the target calendar month.');
    }

    const direction = visibleIndex < targetIndex
      ? '.DayPicker-NavButton--next'
      : '.DayPicker-NavButton--prev';

    const exists = direction.endsWith('--next')
      ? calendar.hasNext
      : calendar.hasPrevious;

    if (!exists) {
      throw new Error(`Calendar navigation button not found: ${direction}`);
    }

    await clickAndWait(page, direction);
  }

  // Select the target day in the displayed month.
  const selected = await page.evaluate(dayNumber => {
    const dayCells = [...document.querySelectorAll('.DayPicker-Day')];

    const cell = dayCells.find(el => {
      const isOutside = el.classList.contains('DayPicker-Day--outside');
      const isDisabled = el.classList.contains('DayPicker-Day--disabled')
        || el.getAttribute('aria-disabled') === 'true';

      return !isOutside && !isDisabled
        && el.innerText.trim() === String(dayNumber);
    });

    if (!cell) {
      return {
        success: false,
        availableDays: dayCells.map(el => ({
          text: el.innerText.trim(),
          ariaLabel: el.getAttribute('aria-label'),
          className: el.className,
        })),
      };
    }

    cell.click();
    return { success: true };
  }, target.day);

  if (!selected.success) {
    throw new Error(
      `Could not select day ${target.day}. Calendar cells: ${JSON.stringify(selected.availableDays)}`
    );
  }

  await sleep(ACTION_DELAY_MS);

  const actualValue = await page.$eval(
    `input[placeholder="${placeholder}"]`,
    input => input.value
  );

  console.log(`${placeholder} date now: ${actualValue}`);

  const normalizedActual = actualValue.includes('-')
    ? actualValue.split('-').reverse().join('/')
    : actualValue;

  if (normalizedActual !== target.display) {
    throw new Error(
      `${placeholder} date mismatch. Expected ${target.display}, received ${actualValue}`
    );
  }
}

function parseMetricValue(metric, rawValue) {
  const cleaned = String(rawValue).replace(/[₹,\s]/g, '');
  const value = Number(cleaned);

  if (!Number.isFinite(value)) {
    throw new Error(`Could not parse metric "${metric}" value "${rawValue}"`);
  }

  const units = {
    'Ad Spends': CURRENCY,
    'Impressions': 'count',
    'Menu Visits': 'count',
    'Orders': 'count',
    'NU Orders': 'count',
    'Sales': CURRENCY,
    'AOV': 'INR_per_order',
    'CPC': 'INR_per_click',
    'ROAS': 'ratio',
  };

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

  if (!keys[metric]) {
    throw new Error(`Unexpected metric label: ${metric}`);
  }

  return {
    key: keys[metric],
    data: {
      value,
      unit: units[metric],
    },
  };
}

async function main() {
  // Start total-duration measurement after the user confirms the page is ready.
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './chrome-profile',
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('Chrome opened.');
    await pressEnter(
      'Log in if needed and wait for Ads Performance to load. Press ENTER...'
    );

    const extractionStartedAt = Date.now();

    // 1. Open the outlet filter.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')]
        .some(button => button.innerText.includes('Outlet name & RID'))
    );

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .find(el => el.innerText.includes('Outlet name & RID'));

      if (!button) throw new Error('Outlet filter button not found');
      button.click();
    });
    await sleep(ACTION_DELAY_MS);

    // 2. Find the outlet sidebar and deselect every checked outlet.
    await page.waitForSelector('input[placeholder="Search outlet by name or RID"]');

    const checkedIds = await page.evaluate(() => {
      const search = document.querySelector(
        'input[placeholder="Search outlet by name or RID"]'
      );

      let node = search;
      let sidebar = null;

      while (node && node !== document.body) {
        const hasCheckboxes = node.querySelector('input[type="checkbox"]');
        const hasConfirm = [...node.querySelectorAll('button')]
          .some(button => button.innerText.trim().toLowerCase() === 'confirm');

        if (hasCheckboxes && hasConfirm) {
          sidebar = node;
          break;
        }

        node = node.parentElement;
      }

      if (!sidebar) {
        throw new Error('Could not identify the outlet sidebar containing Confirm.');
      }

      return [...sidebar.querySelectorAll('input[type="checkbox"]:checked')]
        .map(checkbox => checkbox.id)
        .filter(Boolean);
    });

    console.log(`Found ${checkedIds.length} selected outlets to deselect.`);

    for (const id of checkedIds) {
      const unchecked = await page.evaluate(outletId => {
        const checkbox = document.getElementById(outletId);
        if (!checkbox || checkbox.type !== 'checkbox') return false;
        if (checkbox.checked) checkbox.click();
        return !checkbox.checked;
      }, id);

      if (!unchecked) {
        throw new Error(`Could not deselect outlet checkbox ${id}`);
      }
    }

    console.log('All previously selected outlets have been deselected.');

    // 3. Search for the desired outlet.
    await page.locator(
      'input[placeholder="Search outlet by name or RID"]'
    ).fill(TARGET_RID);
    await sleep(ACTION_DELAY_MS);

    // 4. Select the matching outlet by DOM ID.
    await page.waitForFunction(rid => {
      const checkbox = document.getElementById(rid);
      return checkbox && checkbox.type === 'checkbox';
    }, {}, TARGET_RID);

    const selected = await page.evaluate(rid => {
      const checkbox = document.getElementById(rid);
      if (!checkbox || checkbox.type !== 'checkbox') return false;
      if (!checkbox.checked) checkbox.click();
      return checkbox.checked;
    }, TARGET_RID);

    if (!selected) {
      throw new Error(`Could not select outlet RID ${TARGET_RID}`);
    }

    await sleep(ACTION_DELAY_MS);
    console.log(`Selected outlet RID ${TARGET_RID}.`);

    // 5. Confirm the outlet selection.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .find(el => el.innerText.trim().toLowerCase() === 'confirm');

      if (!button) throw new Error('Confirm button not found');
      button.click();
    });

    await sleep(ACTION_DELAY_MS);
    console.log('Outlet selection confirmed.');

    // 6. Set both From and To dates to yesterday.
    const yesterday = getYesterday();
    console.log('Target date (yesterday):', yesterday.display);

    await selectDate(page, 'To', yesterday);
    await selectDate(page, 'From', yesterday);

    // 7. Find the Power BI iframe and extract the metric cards.
    console.log('\nWaiting for Power BI metrics: poll every 2 seconds for 30 seconds, then every 5 seconds until 2 minutes total...');

    const waitStartedAt = Date.now();
    let lastStatus = null;
    let metrics = null;
    let extendedWaitEnabled = false;
    let nextPollIntervalMs = INITIAL_POLL_INTERVAL_MS;

    // Poll every 2 seconds for the first 30 seconds.
    // If metrics are still unavailable, extend the overall timeout to 2 minutes
    // and slow polling to every 5 seconds.
    while (Date.now() - waitStartedAt < EXTENDED_WAIT_MS) {
      const elapsedMs = Date.now() - waitStartedAt;

      if (!extendedWaitEnabled && elapsedMs >= INITIAL_WAIT_MS) {
        extendedWaitEnabled = true;
        nextPollIntervalMs = EXTENDED_POLL_INTERVAL_MS;
        console.log(
          '\n30 seconds elapsed without all metrics. ' +
          'Extending total wait to 2 minutes and polling every 5 seconds...'
        );
      }
      const frame = page.frames().find(candidate => {
        const frameUrl = candidate.url();
        return frameUrl.includes('app.powerbi.com/reportEmbed')
          && frameUrl.includes(REPORT_ID);
      });

      if (!frame) {
        lastStatus = {
          attachedFrameFound: false,
          loaded: false,
          frameUrls: page.frames()
            .map(candidate => candidate.url())
            .filter(url => url.includes('powerbi.com')),
        };
      } else {
        try {
          const result = await frame.evaluate(() => {
            const cards = [...document.querySelectorAll('.card[aria-label]')];
            const extracted = [];

            for (const card of cards) {
              for (const item of [...card.querySelectorAll('.cardItemContainer')]) {
                const labelElement = item.querySelector('.details');
                const valueElement = item.querySelector('.caption');

                const label = labelElement?.getAttribute('title')
                  || labelElement?.innerText?.trim();
                const value = valueElement?.getAttribute('title')
                  || valueElement?.innerText?.trim();

                if (label && value) extracted.push({ metric: label, value });
              }
            }

            return {
              readyState: document.readyState,
              cardCount: cards.length,
              metrics: extracted,
              bodyTextLength: document.body?.innerText?.trim().length || 0,
              bodyText: (document.body?.innerText || '').trim().slice(0, 1200),
              pageTitle: document.title || null,
              pageUrl: location.href,
            };
          });

          const requiredMetrics = [
            'Ad Spends', 'Impressions', 'Menu Visits', 'Orders',
            'NU Orders', 'Sales', 'AOV', 'CPC', 'ROAS',
          ];
          const foundLabels = new Set(result.metrics.map(item => item.metric));
          const missingMetrics = requiredMetrics.filter(label => !foundLabels.has(label));
          const loaded = missingMetrics.length === 0;

          lastStatus = {
            attachedFrameFound: true,
            loaded,
            cardCount: result.cardCount,
            metricCount: result.metrics.length,
            missingMetrics,
            readyState: result.readyState,
            bodyTextLength: result.bodyTextLength,
            bodyText: result.bodyText,
            pageTitle: result.pageTitle,
            pageUrl: result.pageUrl,
          };

          if (loaded) {
            // Convert extracted labels and display strings into numeric values + units.
            metrics = {};
            for (const item of result.metrics) {
              const parsed = parseMetricValue(item.metric, item.value);
              metrics[parsed.key] = parsed.data;
            }
            break;
          }
        } catch (error) {
          lastStatus = {
            attachedFrameFound: true,
            loaded: false,
            error: error.message,
          };
        }
      }

      const elapsedSeconds = Math.round((Date.now() - waitStartedAt) / 1000);
      console.log(`[${elapsedSeconds}s] Power BI check:`, JSON.stringify(lastStatus));

      // Keep the initial 2-second cadence until 30 seconds; then use 5 seconds.
      const currentElapsedMs = Date.now() - waitStartedAt;
      const remainingToPhaseChangeMs = extendedWaitEnabled
        ? nextPollIntervalMs
        : Math.min(
            nextPollIntervalMs,
            Math.max(1, INITIAL_WAIT_MS - currentElapsedMs)
          );
      await sleep(remainingToPhaseChangeMs);
    }

    if (!metrics) {
      console.error('\nPower BI metrics were not available within 2 minutes.');
      console.error('The browser will remain open so you can inspect the report.');
      console.error('Last Power BI status and diagnostic text:');
      console.dir(lastStatus, { depth: null });
      console.error('\nInspect the visible Chrome window. If the report later loads, rerun the scraper.');
      console.error('The process will remain alive. Press Ctrl+C only when you want to stop it.');

      // Keep Chrome and the Node process alive for manual inspection.
      await new Promise(() => {});
    }

    // 8. Read the final selected date values and dashboard result summary.
    const finalState = await page.evaluate(() => ({
      dates: [...document.querySelectorAll(
        'input[placeholder="From"], input[placeholder="To"]'
      )].map(input => ({
        field: input.placeholder,
        value: input.value,
      })),
      resultSummary: [...document.querySelectorAll('h3')]
        .find(el => el.innerText.includes('Showing results for'))
        ?.innerText || null,
    }));

    const fromDate = finalState.dates.find(date => date.field === 'From')?.value;
    const toDate = finalState.dates.find(date => date.field === 'To')?.value;

    // Normalize dashboard date values into ISO YYYY-MM-DD format.
    const toIsoDate = value => {
      if (!value) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

      const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
    };

    const extractionFinishedAt = new Date();
    const extractionDurationMs = Date.now() - extractionStartedAt;

    const output = {
      report_metadata: {
        platform: 'swiggy',
        report_name: 'ads_performance',
        from_date: toIsoDate(fromDate) || yesterday.iso,
        to_date: toIsoDate(toDate) || yesterday.iso,
        extracted_at: formatTimestampWithTimezone(extractionFinishedAt, TIMEZONE),
        extraction_duration_ms: extractionDurationMs,
        currency: CURRENCY,
        timezone: TIMEZONE,
      },
      outlet: {
        rid: TARGET_RID,
      },
      metrics,
    };

    // 9. Print and save JSON output.
    const jsonOutput = JSON.stringify(output, null, 2);
    console.log('\n--- JSON OUTPUT ---\n');
    console.log(jsonOutput);

    const timestampForFile = output.report_metadata.extracted_at.replace(/[:+]/g, '-');
    const outputFileName =
      `swiggy_ads_performance_${TARGET_RID}_${output.report_metadata.from_date}_${timestampForFile}.json`;
    const outputPath = path.resolve(process.cwd(), outputFileName);

    fs.writeFileSync(outputPath, jsonOutput + '\n', 'utf8');
    console.log(`\nJSON saved to: ${outputPath}`);

    console.log('\n--- FINAL DASHBOARD STATE ---');
    console.dir(finalState, { depth: null });

    console.log('\n--- FINAL POWER BI STATUS ---');
    console.dir(lastStatus, { depth: null });

    console.log('\nFilter workflow complete.');
    console.log('Chrome remains open. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (error) {
    console.error('\nScraper error:', error);
    console.error('Chrome will remain open for inspection. Press Ctrl+C when finished.');
    // Keep the browser open after unexpected errors too, so the page can be inspected.
    await new Promise(() => {});
  }
}

main();
