'use strict';
/* CK444 Aviator Tracker - statistics only. No predictions, no backend. */

/* =====================================================================
   PART 1: Pure logic (no DOM) - this part is unit-tested with Node.
   ===================================================================== */
const MIN_ROUNDS = 50;   // rounds needed before the signal module shows anything
const MIN_TESTED = 30;   // tested signals needed before accuracy is shown
const THRESHOLD = 2;     // the "2x" line used everywhere
const BUCKETS = [
  [1, 1.5, '1-1.5'], [1.5, 2, '1.5-2'], [2, 3, '2-3'],
  [3, 5, '3-5'], [5, 10, '5-10'], [10, Infinity, '10+']
];

/** Accepts "2.40x", "2,40", Bengali digits. Returns number (>=1.00, <=100000, 2 decimals) or null. */
function parseMultiplier(input) {
  let s = String(input === undefined || input === null ? '' : input).trim();
  s = s.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  s = s.replace(/[xX×]\s*$/, '').trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const v = parseFloat(s);
  if (!(v >= 1 && v <= 100000)) return null;
  return Math.round(v * 100) / 100;
}

/** 95% Wilson score interval for k successes in n trials. */
function wilson(k, n, z) {
  z = z || 1.96;
  if (n <= 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

function computeStats(vals) {
  const n = vals.length;
  if (!n) return { n: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sorted = vals.slice().sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const below = vals.filter(v => v < THRESHOLD).length;
  const variance = vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  return {
    n, mean, median, min: sorted[0], max: sorted[n - 1], std: Math.sqrt(variance),
    below, above: n - below, pctBelow: below / n * 100, pctAbove: (n - below) / n * 100
  };
}

function bucketCounts(vals) {
  const n = vals.length;
  return BUCKETS.map(([lo, hi, label]) => {
    const count = vals.filter(v => v >= lo && v < hi).length;
    return { label, count, pct: n ? count / n * 100 : 0 };
  });
}

/** Current run of results below 2x (or at/above 2x). vals are oldest -> newest. */
function currentStreak(vals) {
  if (!vals.length) return { type: null, len: 0 };
  const type = vals[vals.length - 1] < THRESHOLD ? 'below' : 'above';
  let len = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if ((vals[i] < THRESHOLD ? 'below' : 'above') === type) len++; else break;
  }
  return { type, len };
}

/**
 * Experimental rule (walk-forward test):
 *   after k consecutive results below 2x, the "signal" says: next round >= 2x.
 * Every test uses only the rounds BEFORE the tested round.
 * Accuracy is always compared with the baseline share of >=2x rounds.
 * Nothing here is stored - it is recomputed from history, so edits/deletes stay consistent.
 */
function evaluateSignal(vals, k) {
  let tested = 0, correct = 0, streak = 0;
  for (let i = 0; i < vals.length; i++) {
    if (streak >= k) {
      tested++;
      if (vals[i] >= THRESHOLD) correct++;
    }
    streak = vals[i] < THRESHOLD ? streak + 1 : 0;
  }
  const baselineCount = vals.filter(v => v >= THRESHOLD).length;
  const baseline = vals.length ? baselineCount / vals.length : 0;
  const ci = wilson(correct, tested);
  return {
    k, tested, correct, incorrect: tested - correct,
    accuracy: tested ? correct / tested : null, ci, baseline,
    activeNow: streak >= k, streakNow: streak
  };
}

function indicators(vals) {
  const n = vals.length;
  const out = { n };
  if (n >= 10) out.avgLast10 = vals.slice(-10).reduce((a, b) => a + b, 0) / 10;
  if (n >= 20) {
    const last20 = vals.slice(-20);
    out.pctAboveLast20 = last20.filter(v => v >= THRESHOLD).length / 20 * 100;
  }
  if (n >= 1) out.streak = currentStreak(vals);
  return out;
}

/** Complementary error function (Abramowitz-Stegun 7.1.26), good to ~1e-7. */
function erfc(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 1 - sign * y;
}

/**
 * Randomness checks on the sequence "round >= 2x?" (1/0).
 * - Wald-Wolfowitz runs test: too few or too many runs means the order is not random-like.
 * - Lag-1 autocorrelation: does one round's result relate to the next?
 * These can only say "no evidence of a pattern" or "possible pattern in this sample".
 */
function randomnessTests(vals) {
  const n = vals.length;
  if (n < MIN_ROUNDS) return { n, sufficient: false };
  const b = vals.map(v => (v >= THRESHOLD ? 1 : 0));
  const n1 = b.reduce((a, x) => a + x, 0), n0 = n - n1;
  if (n1 === 0 || n0 === 0) return { n, sufficient: false };
  let runs = 1;
  for (let i = 1; i < n; i++) if (b[i] !== b[i - 1]) runs++;
  const mean = 2 * n1 * n0 / n + 1;
  const variance = (mean - 1) * (mean - 2) / (n - 1);
  const z = variance > 0 ? (runs - mean) / Math.sqrt(variance) : 0;
  const p = Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
  const m = n1 / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    den += (b[i] - m) * (b[i] - m);
    if (i < n - 1) num += (b[i] - m) * (b[i + 1] - m);
  }
  const r1 = den > 0 ? num / den : 0;
  const r1Limit = 1.96 / Math.sqrt(n);
  return {
    n, sufficient: true, runs, expectedRuns: mean, z, p, r1, r1Limit,
    flagged: p < 0.05 || Math.abs(r1) > r1Limit
  };
}

/** How many rounds were recorded since local midnight. */
function todayCount(rowsList, now) {
  const d = new Date(now === undefined ? Date.now() : now);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  return rowsList.filter(r => r.ts >= start).length;
}

/** Synthetic crash-style numbers for DEMO ONLY (not real game results). */
function genDemo(count, rng) {
  rng = rng || Math.random;
  const out = [];
  for (let i = 0; i < count; i++) {
    const u = rng();
    let m = 0.97 / (1 - u);
    if (m < 1) m = 1;
    if (m > 1000) m = 1000;
    out.push(Math.floor(m * 100) / 100);
  }
  return out;
}

function csvEscape(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
function toCsv(rows, dataset) {
  const lines = ['id,multiplier,timestamp_iso,local_time,dataset'];
  rows.forEach(r => {
    const d = new Date(r.ts);
    lines.push([r.id, r.v.toFixed(2), csvEscape(d.toISOString()), csvEscape(d.toLocaleString('en-GB')), dataset].join(','));
  });
  return lines.join('\r\n');
}

/* =====================================================================
   PART 2: Translations
   ===================================================================== */
const I18N = {
  bn: {
    app_title: 'CK444 Aviator ট্র্যাকার',
    nav_dashboard: 'ড্যাশবোর্ড', nav_history: 'হিস্ট্রি', nav_analysis: 'বিশ্লেষণ', nav_settings: 'সেটিংস',
    entry_title: 'নতুন ফলাফল যোগ করুন',
    entry_hint: 'গেম স্ক্রিনে যে মাল্টিপ্লায়ার দেখেছেন সেটা নিজে লিখুন (যেমন 2.40x)।',
    entry_btn: 'যোগ করুন',
    err_invalid: 'সঠিক মান লিখুন: 1.00 থেকে 100000 এর মধ্যে, সর্বোচ্চ ২ দশমিক ঘর (যেমন 2.40 বা 2.40x)।',
    err_storage: 'ডেটা সংরক্ষণ করা যায়নি (ব্রাউজারের স্টোরেজ বন্ধ বা ভর্তি)।',
    added: 'যোগ হয়েছে', saved: 'সংরক্ষিত', deleted: 'মুছে ফেলা হয়েছে',
    stat_total: 'মোট রাউন্ড', stat_avg: 'গড় মাল্টিপ্লায়ার', stat_below: '2x এর নিচে', stat_above: '2x বা তার বেশি',
    recent: 'সাম্প্রতিক রাউন্ড', no_data: 'এখনো কোনো ডেটা নেই।',
    disclaimer: 'এটি শুধু পরিসংখ্যান ট্র্যাকার। অতীত ফলাফল ভবিষ্যৎ ফলাফলের নিশ্চয়তা দেয় না।\nকোনো সিগনাল নিশ্চিত নয়, কোনো লাভের নিশ্চয়তা নেই। এই অ্যাপ গেম সার্ভার বা RNG-এর ডেটা পায় না এবং কিছুই নিয়ন্ত্রণ করে না।\nজুয়া ঝুঁকিপূর্ণ। যা হারাতে পারবেন না, তা কখনো বাজি ধরবেন না।',
    history_title: 'সব রাউন্ড', edit: 'এডিট', del: 'মুছুন', more: 'আরও দেখান',
    edit_title: 'মান এডিট করুন', save: 'সংরক্ষণ', cancel: 'বাতিল', ok: 'ঠিক আছে', confirm: 'নিশ্চিত করুন',
    confirm_delete: 'এই রাউন্ডটি মুছে ফেলবেন?',
    an_title: 'পরিসংখ্যান বিশ্লেষণ',
    an_note: 'এগুলো শুধু রেকর্ড করা অতীত ডেটার বর্ণনা। ভবিষ্যৎ ফলাফলের নিশ্চয়তা নয়। বড় মানের কারণে গড় বেশি দেখাতে পারে; median তুলনায় বেশি তথ্যবহুল।',
    an_rounds: 'রেকর্ড করা রাউন্ড', an_median: 'Median', an_max: 'সর্বোচ্চ', an_min: 'সর্বনিম্ন', an_std: 'স্ট্যান্ডার্ড ডেভিয়েশন',
    chart_hist: 'মাল্টিপ্লায়ার বণ্টন (%)', chart_line: 'সাম্প্রতিক ৫০ রাউন্ড',
    th_range: 'রেঞ্জ', th_count: 'সংখ্যা', th_pct: 'শতাংশ',
    ind_title: 'বর্ণনামূলক সূচক',
    ind_last10: 'শেষ ১০ রাউন্ডের গড়', ind_last20: 'শেষ ২০ রাউন্ডে 2x+ হার',
    ind_streak_below: 'বর্তমানে টানা 2x এর নিচে', ind_streak_above: 'বর্তমানে টানা 2x বা বেশি',
    ind_note: 'এগুলো শুধু বর্ণনা, ভবিষ্যদ্বাণী নয়।',
    sig_title: 'পরীক্ষামূলক সিগনাল মডিউল',
    sig_badge: 'পরীক্ষামূলক - নিশ্চিত ভবিষ্যদ্বাণী নয়',
    insufficient: 'পর্যাপ্ত ডেটা নেই',
    need_data: 'কমপক্ষে {n}টি রাউন্ড দরকার (এখন {c}টি)।',
    need_tested: 'নির্ভুলতা দেখাতে কমপক্ষে {n}টি পরীক্ষিত সিগনাল দরকার (এখন {c}টি)।',
    sig_rule: 'নিয়ম: টানা {k}টি রাউন্ড 2x এর নিচে এলে সিগনাল বলে "পরের রাউন্ড 2x বা বেশি"। প্রতিটি পরীক্ষা শুধু তার আগের ডেটা ব্যবহার করে।',
    sig_active: 'এই মুহূর্তে নিয়মের শর্ত পূর্ণ (টানা {s}টি 2x এর নিচে)। এটি ভবিষ্যদ্বাণী নয়, শুধু একটি পরীক্ষামূলক সূচক।',
    sig_inactive: 'এই মুহূর্তে নিয়মের শর্ত পূর্ণ নয়।',
    sig_tested: 'পরীক্ষিত সিগনাল', sig_correct: 'সঠিক', sig_wrong: 'ভুল', sig_acc: 'পরীক্ষিত নির্ভুলতা',
    sig_ci: '95% অনিশ্চয়তা সীমা', sig_base: 'তুলনার ভিত্তি (সব রাউন্ডে 2x+ হার)',
    sig_v_same: 'ফলাফল: পরীক্ষিত হার ভিত্তি হার থেকে আলাদা, এটা এই ডেটায় প্রমাণ হয়নি।',
    sig_v_higher: 'ফলাফল: এই নমুনায় হার ভিত্তির চেয়ে বেশি। কাকতালীয় হতে পারে; ভবিষ্যতে টিকবে এমন নিশ্চয়তা নেই।',
    sig_v_lower: 'ফলাফল: এই নমুনায় হার ভিত্তির চেয়ে কম।',
    sig_foot: 'পরপর রাউন্ড একে অপরের সাথে মিলে যেতে পারে, তাই সীমাটি আসলে আরও বড় হতে পারে।',
    set_lang: 'ভাষা', set_mode: 'ডেটা সেট',
    mode_real: 'আসল (নিজে লেখা)', mode_demo: 'ডেমো (কৃত্রিম)',
    mode_note: 'ডেমো ডেটা কৃত্রিমভাবে তৈরি, আসল গেমের ফলাফল নয়। দুই সেট আলাদা থাকে, কখনো মিশে না।',
    set_k: 'সিগনালের নিয়ম: টানা কতটি 2x এর নিচে',
    set_data: 'ডেটা ম্যানেজমেন্ট',
    set_export: 'CSV এক্সপোর্ট', set_demo_load: 'ডেমো ডেটা লোড করুন (200টি কৃত্রিম)',
    set_demo_clear: 'ডেমো ডেটা মুছুন', set_delete_all: 'বর্তমান সেটের সব ডেটা মুছুন',
    confirm_demo: 'এই ডেটা কৃত্রিমভাবে তৈরি, আসল ফলাফল নয়। ডেমো সেটে লোড করবেন? (আগের ডেমো ডেটা বদলে যাবে)',
    confirm_demo_clear: 'ডেমো ডেটা মুছে ফেলবেন?',
    confirm_all: 'আপনি কি নিশ্চিত? "{m}" সেটের সব ইতিহাস স্থায়ীভাবে মুছে যাবে। এটা ফেরানো যাবে না।',
    demo_loaded: 'ডেমো ডেটা লোড হয়েছে', cleared: 'মুছে ফেলা হয়েছে',
    demo_banner: 'ডেমো মোড: এই ডেটা কৃত্রিম, আসল গেমের ফলাফল নয়।', demo_badge: 'ডেমো',
    install: 'অ্যাপ হিসেবে ইন্সটল করুন',
    undo: 'শেষ এন্ট্রি বাতিল (Undo)', undone: 'শেষ এন্ট্রি বাতিল হয়েছে',
    sigcard_title: 'এখনকার পরীক্ষামূলক সূচক',
    sigcard_active: 'শর্ত পূর্ণ: টানা {s}টি 2x এর নিচে',
    sigcard_idle: 'এখন কোনো সূচক সক্রিয় নেই',
    sigcard_record: 'পরীক্ষিত রেকর্ড: {t}টির মধ্যে {c}টি সঠিক, সাধারণ হার {b}',
    sigcard_note: 'এটি ভবিষ্যদ্বাণী নয়। পরের রাউন্ড সম্পূর্ণ এলোমেলো হতে পারে।',
    rnd_title: 'এলোমেলো কি না যাচাই',
    rnd_runs: 'Runs টেস্ট: p-মান', rnd_runs_n: 'রান সংখ্যা (প্রত্যাশিত)', rnd_r1: 'লাগোয়া রাউন্ডের সম্পর্ক (lag-1)', rnd_limit: 'সাধারণ সীমা',
    rnd_v_ok: 'ফলাফল: এই ডেটায় কোনো প্যাটার্নের প্রমাণ নেই। ফল এলোমেলোর মতোই আচরণ করছে।',
    rnd_v_flag: 'ফলাফল: এই নমুনায় সম্ভাব্য প্যাটার্ন দেখা যাচ্ছে। তবে প্রতি ২০টি টেস্টের ১টিতে কাকতালীয়ভাবেই এমন আসে। আরও ডেটা জমিয়ে আবার দেখুন। এটা সিগনালের প্রমাণ নয়।',
    rnd_note: 'ম্যানুয়াল এন্ট্রিতে ভুল বা বাদ পড়া রাউন্ড থাকলে ফলাফল বিভ্রান্ত করতে পারে।',
    set_limit: 'আজকের রাউন্ড সীমা (বিরতির রিমাইন্ডার)', limit_off: 'বন্ধ',
    limit_note: 'আজ যত রাউন্ড লিখেছেন তা গুনে সীমা পার হলে সতর্ক করে।',
    limit_banner: 'আজ {c}টি রাউন্ড লেখা হয়েছে, আপনার সীমা {l}। একটু বিরতি নিন।',
    live_title: 'লাইভ স্ক্রিন রিডিং (OCR)',
    live_body: 'এই ওয়েব অ্যাপ (PWA) অন্য অ্যাপের স্ক্রিন পড়তে পারে না। Android Chrome-এ অন্য অ্যাপের স্ক্রিন ক্যাপচার সমর্থিত নয়।\nভবিষ্যতে আলাদা Android অ্যাপে MediaProjection (স্পষ্ট ব্যবহারকারী অনুমতিসহ) ও অন-ডিভাইস OCR দিয়ে দেখা মাল্টিপ্লায়ার পড়ার চেষ্টা করা সম্ভব, কিন্তু এখানে তৈরি করা হয়নি। কোনো লগইন, নিরাপত্তা বা অ্যান্টি-বট ব্যবস্থা এড়ানো হবে না এবং সার্ভারের গোপন ডেটা পাওয়ার দাবি করা হবে না। সাইটের নিয়মাবলিও দেখে নিন।\nতাই নির্ভরযোগ্য পদ্ধতি হলো ম্যানুয়াল এন্ট্রি, যেটা এখানে আছে।'
  },
  en: {
    app_title: 'CK444 Aviator Tracker',
    nav_dashboard: 'Dashboard', nav_history: 'History', nav_analysis: 'Analysis', nav_settings: 'Settings',
    entry_title: 'Add a new result',
    entry_hint: 'Type the multiplier you saw on the game screen (e.g. 2.40x).',
    entry_btn: 'Add',
    err_invalid: 'Enter a valid value: between 1.00 and 100000, up to 2 decimals (e.g. 2.40 or 2.40x).',
    err_storage: 'Could not save data (browser storage is blocked or full).',
    added: 'Added', saved: 'Saved', deleted: 'Deleted',
    stat_total: 'Total rounds', stat_avg: 'Average multiplier', stat_below: 'Below 2x', stat_above: '2x or higher',
    recent: 'Recent rounds', no_data: 'No data yet.',
    disclaimer: 'This is a statistics tracker only. Past results do not guarantee future outcomes.\nNo signal is certain and no profit is guaranteed. This app has no access to game-server or RNG data and controls nothing.\nGambling is risky. Never bet money you cannot afford to lose.',
    history_title: 'All rounds', edit: 'Edit', del: 'Delete', more: 'Show more',
    edit_title: 'Edit value', save: 'Save', cancel: 'Cancel', ok: 'OK', confirm: 'Confirm',
    confirm_delete: 'Delete this round?',
    an_title: 'Statistical analysis',
    an_note: 'These describe recorded past data only and do not guarantee future outcomes. Large values can inflate the average; the median is usually more informative.',
    an_rounds: 'Recorded rounds', an_median: 'Median', an_max: 'Maximum', an_min: 'Minimum', an_std: 'Standard deviation',
    chart_hist: 'Multiplier distribution (%)', chart_line: 'Last 50 rounds',
    th_range: 'Range', th_count: 'Count', th_pct: 'Percent',
    ind_title: 'Descriptive indicators',
    ind_last10: 'Average of last 10', ind_last20: '2x+ share in last 20',
    ind_streak_below: 'Current streak below 2x', ind_streak_above: 'Current streak at/above 2x',
    ind_note: 'These are descriptions, not predictions.',
    sig_title: 'Experimental signal module',
    sig_badge: 'EXPERIMENTAL - not a guaranteed prediction',
    insufficient: 'Insufficient Data',
    need_data: 'At least {n} rounds are needed (now {c}).',
    need_tested: 'At least {n} tested signals are needed to show accuracy (now {c}).',
    sig_rule: 'Rule: after {k} consecutive results below 2x, the signal says "next round 2x or higher". Every test uses only data from before that round.',
    sig_active: 'The rule condition is met right now ({s} in a row below 2x). This is not a prediction, only an experimental indicator.',
    sig_inactive: 'The rule condition is not met right now.',
    sig_tested: 'Tested signals', sig_correct: 'Correct', sig_wrong: 'Incorrect', sig_acc: 'Tested accuracy',
    sig_ci: '95% uncertainty range', sig_base: 'Baseline (2x+ share across all rounds)',
    sig_v_same: 'Result: this data does not show the tested rate differs from the baseline.',
    sig_v_higher: 'Result: in this sample the rate is above baseline. It may be coincidence; there is no guarantee it will hold.',
    sig_v_lower: 'Result: in this sample the rate is below baseline.',
    sig_foot: 'Consecutive tests can overlap, so the true uncertainty may be wider than shown.',
    set_lang: 'Language', set_mode: 'Data set',
    mode_real: 'Real (typed by you)', mode_demo: 'Demo (synthetic)',
    mode_note: 'Demo data is synthetic and not real game results. The two sets are kept separate and never mixed.',
    set_k: 'Signal rule: consecutive results below 2x',
    set_data: 'Data management',
    set_export: 'Export CSV', set_demo_load: 'Load demo data (200 synthetic rounds)',
    set_demo_clear: 'Clear demo data', set_delete_all: 'Delete all data in current set',
    confirm_demo: 'This data is synthetic, not real results. Load it into the demo set? (existing demo data will be replaced)',
    confirm_demo_clear: 'Clear the demo data?',
    confirm_all: 'Are you sure? All history in the "{m}" set will be deleted permanently. This cannot be undone.',
    demo_loaded: 'Demo data loaded', cleared: 'Cleared',
    demo_banner: 'DEMO MODE: this data is synthetic, not real game results.', demo_badge: 'DEMO',
    install: 'Install as app',
    undo: 'Undo last entry', undone: 'Last entry removed',
    sigcard_title: 'Experimental indicator now',
    sigcard_active: 'Condition met: {s} in a row below 2x',
    sigcard_idle: 'No indicator is active right now',
    sigcard_record: 'Tested record: {c} of {t} correct, baseline {b}',
    sigcard_note: 'This is not a prediction. The next round can be completely random.',
    rnd_title: 'Randomness check',
    rnd_runs: 'Runs test: p-value', rnd_runs_n: 'Runs (expected)', rnd_r1: 'Neighbour-round correlation (lag-1)', rnd_limit: 'Normal limit',
    rnd_v_ok: 'Result: no evidence of a pattern in this data. Results behave like random.',
    rnd_v_flag: 'Result: a possible pattern appears in this sample. About 1 in 20 tests shows this by pure chance. Collect more data and check again. This is not proof of a signal.',
    rnd_note: 'Mistyped or missing manual entries can distort the result.',
    set_limit: 'Daily round limit (break reminder)', limit_off: 'Off',
    limit_note: 'Counts rounds you entered today and warns when the limit is passed.',
    limit_banner: '{c} rounds entered today; your limit is {l}. Take a break.',
    live_title: 'Live screen reading (OCR)',
    live_body: 'This web app (PWA) cannot read other apps\' screens. Android Chrome does not support capturing other apps\' screens.\nA separate native Android app could try to read the visible multiplier using MediaProjection (with explicit user permission) and on-device OCR, but that is not built here. It would never bypass login, security or anti-bot controls, and it cannot claim access to private server data. Also check the site\'s terms.\nThe reliable method is manual entry, which is what this app provides.'
  }
};

/* =====================================================================
   PART 3: App (browser only)
   ===================================================================== */
const STORE_KEY = 'ck444_tracker_v1';
let state = defaultState();
let currentView = 'dashboard';
let historyLimit = 50;
let deferredInstall = null;

function defaultState() {
  return { lang: 'bn', mode: 'real', k: 3, limit: 0, nextId: 1, data: { real: [], demo: [] } };
}
function sanitizeRows(a) {
  if (!Array.isArray(a)) return [];
  return a.filter(r => r && Number.isFinite(r.v) && r.v >= 1 && Number.isFinite(r.ts) && Number.isInteger(r.id))
          .map(r => ({ id: r.id, v: Math.round(r.v * 100) / 100, ts: r.ts }));
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const p = JSON.parse(raw);
    const s = defaultState();
    s.lang = p.lang === 'en' ? 'en' : 'bn';
    s.mode = p.mode === 'demo' ? 'demo' : 'real';
    s.k = [2, 3, 4, 5, 6].includes(p.k) ? p.k : 3;
    s.limit = [0, 10, 20, 30, 50, 100].includes(p.limit) ? p.limit : 0;
    s.data.real = sanitizeRows(p.data && p.data.real);
    s.data.demo = sanitizeRows(p.data && p.data.demo);
    const maxId = Math.max(0, ...s.data.real.map(r => r.id), ...s.data.demo.map(r => r.id));
    s.nextId = Math.max(maxId + 1, Number.isInteger(p.nextId) ? p.nextId : 1);
    return s;
  } catch (e) { return defaultState(); }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; }
  catch (e) { toast(t('err_storage')); return false; }
}

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function t(key, params) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.bn[key] || key;
  if (params) Object.keys(params).forEach(k => { s = s.split('{' + k + '}').join(params[k]); });
  return s;
}
function rows() { return state.data[state.mode]; }
function vals() { return rows().map(r => r.v); }
function f2(x) { return (x === undefined || x === null || !isFinite(x)) ? '-' : x.toFixed(2); }
function fp(x) { return (x === undefined || x === null || !isFinite(x)) ? '-' : x.toFixed(1) + '%'; }
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString(state.lang === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB',
      { dateStyle: 'short', timeStyle: 'medium' });
  } catch (e) { return new Date(ts).toLocaleString(); }
}
function multClass(v) { return v >= 10 ? 'high' : (v >= THRESHOLD ? 'mid' : 'low'); }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- modal (confirm / edit) ---------- */
function openModal(opts) {
  return new Promise(resolve => {
    const m = $('#modal'), inp = $('#modalInput'), err = $('#modalErr');
    const ok = $('#modalOk'), cancel = $('#modalCancel');
    $('#modalTitle').textContent = opts.title;
    $('#modalMsg').textContent = opts.msg || '';
    err.textContent = '';
    ok.textContent = opts.okLabel || t('ok');
    cancel.textContent = t('cancel');
    ok.className = 'btn' + (opts.danger ? ' danger' : '');
    const isInput = opts.input !== undefined;
    inp.hidden = !isInput;
    if (isInput) inp.value = opts.input;
    m.hidden = false;
    if (isInput) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    function close(v) {
      m.hidden = true;
      ok.onclick = cancel.onclick = m.onclick = inp.onkeydown = null;
      resolve(v);
    }
    ok.onclick = () => {
      if (isInput) {
        const v = parseMultiplier(inp.value);
        if (v === null) { err.textContent = t('err_invalid'); return; }
        close(v);
      } else close(true);
    };
    cancel.onclick = () => close(isInput ? null : false);
    m.onclick = e => { if (e.target === m) cancel.onclick(); };
    inp.onkeydown = e => { if (e.key === 'Enter') ok.onclick(); };
  });
}

/* ---------- actions ---------- */
function addRound(v) {
  rows().push({ id: state.nextId++, v, ts: Date.now() });
  if (saveState()) toast(t('added'));
  renderAll();
}
function submitEntry() {
  const inp = $('#entryInput'), err = $('#entryError');
  const v = parseMultiplier(inp.value);
  if (v === null) { err.textContent = t('err_invalid'); return; }
  err.textContent = '';
  addRound(v);
  inp.value = '';
  inp.focus();
}
function undoLast() {
  const list = rows();
  if (!list.length) { toast(t('no_data')); return; }
  list.pop();
  if (saveState()) toast(t('undone'));
  renderAll();
}
async function editRound(id) {
  const r = rows().find(x => x.id === id);
  if (!r) return;
  const v = await openModal({ title: t('edit_title'), input: r.v.toFixed(2), okLabel: t('save') });
  if (v === null) return;
  r.v = v;
  if (saveState()) toast(t('saved'));
  renderAll();
}
async function deleteRound(id) {
  const ok = await openModal({ title: t('confirm'), msg: t('confirm_delete'), okLabel: t('del'), danger: true });
  if (!ok) return;
  const list = rows();
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) list.splice(i, 1);
  if (saveState()) toast(t('deleted'));
  renderAll();
}
async function loadDemo() {
  const ok = await openModal({ title: t('confirm'), msg: t('confirm_demo'), okLabel: t('ok') });
  if (!ok) return;
  const nums = genDemo(200);
  const now = Date.now();
  state.data.demo = nums.map((v, i) => ({ id: state.nextId++, v, ts: now - (nums.length - i) * 60000 }));
  state.mode = 'demo';
  if (saveState()) toast(t('demo_loaded'));
  renderAll();
}
async function clearDemo() {
  const ok = await openModal({ title: t('confirm'), msg: t('confirm_demo_clear'), okLabel: t('del'), danger: true });
  if (!ok) return;
  state.data.demo = [];
  saveState(); toast(t('cleared')); renderAll();
}
async function deleteAll() {
  const label = state.mode === 'demo' ? t('mode_demo') : t('mode_real');
  const ok = await openModal({ title: t('confirm'), msg: t('confirm_all', { m: label }), okLabel: t('del'), danger: true });
  if (!ok) return;
  state.data[state.mode] = [];
  saveState(); toast(t('cleared')); renderAll();
}
function exportCsv() {
  const r = rows();
  if (!r.length) { toast(t('no_data')); return; }
  const blob = new Blob(['\ufeff' + toCsv(r, state.mode)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ck444_' + state.mode + '_rounds.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---------- rendering ---------- */
function applyLang() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  $$('[data-lang]').forEach(b => b.classList.toggle('on', b.getAttribute('data-lang') === state.lang));
}
function renderChrome() {
  const demo = state.mode === 'demo';
  $('#modeBadge').hidden = !demo;
  $('#modeBadge').textContent = t('demo_badge');
  $('#demoBanner').hidden = !demo;
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === state.mode));
  $('#kSelect').value = String(state.k);
  $('#limitSelect').value = String(state.limit);
  const lb = $('#limitBanner');
  const cnt = todayCount(state.data.real);
  const over = state.limit > 0 && state.mode === 'real' && cnt >= state.limit;
  lb.hidden = !over;
  if (over) lb.textContent = t('limit_banner', { c: cnt, l: state.limit });
  $$('.nav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === currentView));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + currentView));
  $('#entryCard').hidden = !(currentView === 'dashboard' || currentView === 'history');
}
function rowHtml(r, withActions) {
  const demoTag = state.mode === 'demo' ? '<span class="demo-tag">' + t('demo_badge') + '</span>' : '';
  return '<li><span class="mult ' + multClass(r.v) + '">' + r.v.toFixed(2) + 'x' + demoTag + '</span>' +
    '<span class="time">' + fmtTime(r.ts) + '</span>' +
    (withActions ? '<span class="actions">' +
      '<button class="btn ghost small" data-act="edit" data-id="' + r.id + '">' + t('edit') + '</button>' +
      '<button class="btn danger small" data-act="del" data-id="' + r.id + '">' + t('del') + '</button></span>' : '') +
    '</li>';
}
function renderDashboard() {
  const s = computeStats(vals());
  $('#statTotal').textContent = s.n;
  $('#statAvg').textContent = s.n ? f2(s.mean) + 'x' : '-';
  $('#statBelow').textContent = s.n ? fp(s.pctBelow) : '-';
  $('#statAbove').textContent = s.n ? fp(s.pctAbove) : '-';
  renderSigCard(vals());
  const recent = rows().slice(-10).reverse();
  $('#recentList').innerHTML = recent.length ? recent.map(r => rowHtml(r, false)).join('')
    : '<li><span class="small">' + t('no_data') + '</span></li>';
}
function renderSigCard(v) {
  let h = '<span class="tag">' + t('sig_badge') + '</span>';
  if (v.length < MIN_ROUNDS) {
    h += '<p class="insuf">' + t('insufficient') + '</p><p class="small">' + t('need_data', { n: MIN_ROUNDS, c: v.length }) + '</p>';
  } else {
    const e = evaluateSignal(v, state.k);
    h += '<p class="sigbig' + (e.activeNow ? ' on' : '') + '">' +
      (e.activeNow ? t('sigcard_active', { s: e.streakNow }) : t('sigcard_idle')) + '</p>';
    h += e.tested >= MIN_TESTED
      ? '<p class="small">' + t('sigcard_record', { t: e.tested, c: e.correct, b: fp(e.baseline * 100) }) + '</p>'
      : '<p class="small">' + t('need_tested', { n: MIN_TESTED, c: e.tested }) + '</p>';
  }
  h += '<p class="small">' + t('sigcard_note') + '</p>';
  $('#sigCardBox').innerHTML = h;
}
function renderHistory() {
  const all = rows().slice().reverse();
  const shown = all.slice(0, historyLimit);
  $('#historyList').innerHTML = shown.length ? shown.map(r => rowHtml(r, true)).join('')
    : '<li><span class="small">' + t('no_data') + '</span></li>';
  $('#moreBtn').hidden = all.length <= historyLimit;
}
function statBox(label, value, red) {
  return '<div class="stat"><span class="label">' + label + '</span><span class="value' + (red ? ' red' : '') + '">' + value + '</span></div>';
}
function renderAnalysis() {
  const v = vals();
  const s = computeStats(v);
  $('#anStats').innerHTML =
    statBox(t('an_rounds'), s.n, true) +
    statBox(t('stat_avg'), s.n ? f2(s.mean) + 'x' : '-') +
    statBox(t('an_median'), s.n ? f2(s.median) + 'x' : '-') +
    statBox(t('an_std'), s.n ? f2(s.std) : '-') +
    statBox(t('an_min'), s.n ? f2(s.min) + 'x' : '-') +
    statBox(t('an_max'), s.n ? f2(s.max) + 'x' : '-') +
    statBox(t('stat_below'), s.n ? fp(s.pctBelow) + ' (' + s.below + ')' : '-') +
    statBox(t('stat_above'), s.n ? fp(s.pctAbove) + ' (' + s.above + ')' : '-');
  const b = bucketCounts(v);
  $('#bucketBody').innerHTML = b.map(x => '<tr><td>' + x.label + 'x</td><td>' + x.count + '</td><td>' + fp(x.pct) + '</td></tr>').join('');
  drawHistogram($('#histCanvas'), b);
  drawLine($('#lineCanvas'), v.slice(-50));
  renderRandomness(v);
  renderIndicators(v);
  renderSignal(v);
}
function renderRandomness(v) {
  const r = randomnessTests(v);
  let h;
  if (!r.sufficient) {
    h = '<p class="insuf">' + t('insufficient') + '</p><p class="small">' + t('need_data', { n: MIN_ROUNDS, c: v.length }) + '</p>';
  } else {
    h = '<div class="grid">' +
      statBox(t('rnd_runs'), r.p.toFixed(3)) +
      statBox(t('rnd_runs_n'), r.runs + ' (' + r.expectedRuns.toFixed(1) + ')') +
      statBox(t('rnd_r1'), r.r1.toFixed(3)) +
      statBox(t('rnd_limit'), '±' + r.r1Limit.toFixed(3)) + '</div>' +
      '<p class="verdict">' + t(r.flagged ? 'rnd_v_flag' : 'rnd_v_ok') + '</p>';
  }
  h += '<p class="small">' + t('rnd_note') + '</p>';
  $('#rndBox').innerHTML = h;
}
function renderIndicators(v) {
  const ind = indicators(v);
  let h = '';
  if (v.length < 10) {
    h = '<p class="insuf">' + t('insufficient') + '</p><p class="small">' + t('need_data', { n: 10, c: v.length }) + '</p>';
  } else {
    h += '<div class="grid">';
    h += statBox(t('ind_last10'), f2(ind.avgLast10) + 'x');
    h += statBox(t('ind_last20'), ind.pctAboveLast20 === undefined ? t('insufficient') : fp(ind.pctAboveLast20));
    h += statBox(ind.streak.type === 'below' ? t('ind_streak_below') : t('ind_streak_above'), ind.streak.len);
    h += '</div><p class="small">' + t('ind_note') + '</p>';
  }
  $('#indBox').innerHTML = h;
}
function renderSignal(v) {
  let h = '<span class="tag">' + t('sig_badge') + '</span><p class="small">' + t('sig_rule', { k: state.k }) + '</p>';
  if (v.length < MIN_ROUNDS) {
    h += '<p class="insuf">' + t('insufficient') + '</p><p class="small">' + t('need_data', { n: MIN_ROUNDS, c: v.length }) + '</p>';
  } else {
    const e = evaluateSignal(v, state.k);
    h += '<div class="status' + (e.activeNow ? ' on' : '') + '">' +
      (e.activeNow ? t('sig_active', { s: e.streakNow }) : t('sig_inactive')) + '</div>';
    h += '<div class="grid">' +
      statBox(t('sig_tested'), e.tested) + statBox(t('sig_correct'), e.correct) +
      statBox(t('sig_wrong'), e.incorrect) +
      statBox(t('sig_acc'), e.tested >= MIN_TESTED ? fp(e.accuracy * 100) : t('insufficient')) + '</div>';
    if (e.tested < MIN_TESTED) {
      h += '<p class="small">' + t('need_tested', { n: MIN_TESTED, c: e.tested }) + '</p>';
    } else {
      h += '<p class="small">' + t('sig_ci') + ': ' + fp(e.ci.lo * 100) + ' - ' + fp(e.ci.hi * 100) + '<br>' +
        t('sig_base') + ': ' + fp(e.baseline * 100) + '</p>';
      const key = e.baseline < e.ci.lo ? 'sig_v_higher' : (e.baseline > e.ci.hi ? 'sig_v_lower' : 'sig_v_same');
      h += '<p class="verdict">' + t(key) + '</p><p class="small">' + t('sig_foot') + '</p>';
    }
  }
  $('#signalBox').innerHTML = h;
}

/* ---------- charts (plain canvas, no libraries) ---------- */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  const w = Math.max(10, r.width), h = Math.max(10, r.height);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawEmpty(ctx, w, h) {
  ctx.fillStyle = '#b4b4bf';
  ctx.font = '16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(t('no_data'), w / 2, h / 2);
}
function drawHistogram(c, buckets) {
  const { ctx, w, h } = setupCanvas(c);
  const total = buckets.reduce((a, b) => a + b.count, 0);
  if (!total) { drawEmpty(ctx, w, h); return; }
  const maxPct = Math.max(...buckets.map(b => b.pct), 1);
  const padL = 8, padR = 8, padT = 24, padB = 26;
  const bw = (w - padL - padR) / buckets.length;
  buckets.forEach((b, i) => {
    const bh = (h - padT - padB) * (b.pct / maxPct);
    const x = padL + i * bw + bw * 0.12, y = h - padB - bh;
    ctx.fillStyle = (i >= 2) ? '#e10600' : '#ffffff';
    ctx.fillRect(x, y, bw * 0.76, bh);
    ctx.fillStyle = '#fff';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.pct.toFixed(0) + '%', x + bw * 0.38, y - 5);
    ctx.fillStyle = '#b4b4bf';
    ctx.fillText(b.label + 'x', x + bw * 0.38, h - 8);
  });
}
function drawLine(c, v) {
  const { ctx, w, h } = setupCanvas(c);
  if (!v.length) { drawEmpty(ctx, w, h); return; }
  const cap = 10, padL = 30, padR = 10, padT = 10, padB = 20;
  const yOf = val => padT + (h - padT - padB) * (1 - (Math.min(val, cap) - 1) / (cap - 1));
  const xOf = i => padL + (v.length === 1 ? (w - padL - padR) / 2 : (w - padL - padR) * i / (v.length - 1));
  ctx.strokeStyle = '#2b2b33'; ctx.fillStyle = '#b4b4bf';
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
  [1, 2, 5, 10].forEach(g => {
    const y = yOf(g);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(g + 'x', padL - 4, y + 4);
  });
  ctx.save();
  ctx.setLineDash([6, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, yOf(2)); ctx.lineTo(w - padR, yOf(2)); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#e10600'; ctx.lineWidth = 2;
  ctx.beginPath();
  v.forEach((val, i) => { const x = xOf(i), y = yOf(val); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
  v.forEach((val, i) => {
    ctx.fillStyle = val >= THRESHOLD ? '#e10600' : '#ffffff';
    ctx.beginPath(); ctx.arc(xOf(i), yOf(val), 3, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#b4b4bf'; ctx.textAlign = 'center';
  ctx.fillText('>10x = 10x', w / 2, h - 5);
}

function renderAll() {
  applyLang();
  renderChrome();
  renderDashboard();
  renderHistory();
  if (currentView === 'analysis') renderAnalysis();
}
function showView(name) {
  currentView = name;
  renderChrome();
  if (name === 'analysis') renderAnalysis();
  window.scrollTo(0, 0);
}

function init() {
  state = loadState();
  $('#entryBtn').addEventListener('click', submitEntry);
  $('#entryInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitEntry(); });
  $$('.nav button').forEach(b => b.addEventListener('click', () => showView(b.getAttribute('data-view'))));
  $$('[data-lang]').forEach(b => b.addEventListener('click', () => {
    state.lang = b.getAttribute('data-lang'); saveState(); renderAll(); if (currentView === 'analysis') renderAnalysis();
  }));
  $$('[data-mode]').forEach(b => b.addEventListener('click', () => {
    state.mode = b.getAttribute('data-mode'); historyLimit = 50; saveState(); renderAll();
  }));
  $('#undoBtn').addEventListener('click', undoLast);
  $('#limitSelect').addEventListener('change', e => { state.limit = parseInt(e.target.value, 10); saveState(); renderAll(); });
  $('#kSelect').addEventListener('change', e => { state.k = parseInt(e.target.value, 10); saveState(); renderAll(); });
  $('#historyList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = parseInt(btn.getAttribute('data-id'), 10);
    if (btn.getAttribute('data-act') === 'edit') editRound(id); else deleteRound(id);
  });
  $('#moreBtn').addEventListener('click', () => { historyLimit += 50; renderHistory(); });
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#demoLoadBtn').addEventListener('click', loadDemo);
  $('#demoClearBtn').addEventListener('click', clearDemo);
  $('#deleteAllBtn').addEventListener('click', deleteAll);
  window.addEventListener('resize', () => { if (currentView === 'analysis') renderAnalysis(); });
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredInstall = e; $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null; $('#installBtn').hidden = true;
  });
  renderAll();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { randomnessTests, todayCount, erfc, parseMultiplier, wilson, computeStats, bucketCounts, currentStreak, evaluateSignal, indicators, genDemo, toCsv, I18N, MIN_ROUNDS, MIN_TESTED };
}
