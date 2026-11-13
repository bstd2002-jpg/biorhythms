// Version stamp: the page checks this matches its own, to catch an outdated script.js
// (for example one the browser cached). Update both numbers together.
window.APP_VERSION = "55";

// ---------------------------------------------
// Logging days
// ---------------------------------------------
const KEY = "periodDays";
const load = () => JSON.parse(localStorage.getItem(KEY) || "[]");
const save = days => localStorage.setItem(KEY, JSON.stringify([...new Set(days)].sort()));

// Period flow per logged period day: { "YYYY-MM-DD": "spotting" | "light" | "medium" | "heavy" }
const FLOW_KEY = "periodFlow";
const FLOWS = {
  spotting: { label: "Spotting", size: 4 },
  light:    { label: "Light",    size: 6 },
  medium:   { label: "Medium",   size: 8 },
  heavy:    { label: "Heavy",    size: 11 },
};
const loadFlow = () => { try { return JSON.parse(localStorage.getItem(FLOW_KEY) || "{}"); } catch { return {}; } };
const saveFlow = f => localStorage.setItem(FLOW_KEY, JSON.stringify(f));

// Missed birth control pills: a sorted list of dates (only used with a pill)
const MISSED_KEY = "missedPills";
const loadMissed = () => { try { return JSON.parse(localStorage.getItem(MISSED_KEY) || "[]"); } catch { return []; } };
const saveMissed = days => localStorage.setItem(MISSED_KEY, JSON.stringify([...new Set(days)].sort()));

// Discharge: stored separately as { "YYYY-MM-DD": "type" }
const DKEY = "dischargeDays";
const DISCHARGE_TYPES = {
  dry:      { label: "Dry",       color: "#7b8794" },   // cool grey
  sticky:   { label: "Sticky",    color: "#5c8a9e" },   // dusty blue
  creamy:   { label: "Creamy",    color: "#3fa796" },   // teal
  watery:   { label: "Watery",    color: "#2f7fd1" },   // blue
  eggwhite: { label: "Egg-white", color: "#7a4fc4" },   // violet
};
const AMOUNTS = {
  light:    { label: "Light",    size: 5 },
  moderate: { label: "Moderate", size: 7 },
  heavy:    { label: "Heavy",    size: 10 },
};

// Entries are { type, amount }. Older entries were just the type string, so convert those.
const toEntry = v => typeof v === "string" ? { type: v, amount: "" } : { type: v.type, amount: v.amount || "" };

const loadDischarge = () => {
  const raw = JSON.parse(localStorage.getItem(DKEY) || "{}");
  for (const day in raw) raw[day] = toEntry(raw[day]);
  return raw;
};
const saveDischarge = obj => localStorage.setItem(DKEY, JSON.stringify(obj));

// ---------------------------------------------
// Finding cycle starts
// ---------------------------------------------
const DAY = 86400000;

// Phones: taller plots (the legends wrap onto more rows) and smaller legend labels
const narrowScreen = () => window.matchMedia("(max-width: 640px)").matches;
// Charts react to taps (click) and the mouse, but not to touches while scrolling, so details
// don't pop up as you scroll past a chart on a phone
if (window.Chart) Chart.defaults.events = ["mousemove", "mouseout", "click"];
const legendLabels = () => narrowScreen() ? { boxWidth: 12, boxHeight: 8, padding: 6, font: { size: 11 } } : {};
const toDate = s => new Date(s + "T00:00:00");

function cycleStarts(days, maxGap = 2) {
  const starts = [];
  let prev = null;
  for (const s of days) {
    const d = toDate(s);
    if (!prev || Math.round((d - prev) / DAY) > maxGap) starts.push(d);
    prev = d;
  }
  return starts;
}

// ---------------------------------------------
// Phase estimates
//
// Ovulation comes from your logged discharge when possible: the last day of clear,
// stretchy (watery or egg-white) discharge in a cycle. Cervical mucus is clear and
// copious before ovulation and turns thick and scant after it (Reed & Carr, p. 14–15).
//
// Otherwise ovulation is placed one luteal phase before the cycle ends. The luteal
// phase is ~14 days (Reed & Carr, p. 1); once you have cycles with discharge-based
// ovulation, your own average luteal length is used instead.
// ---------------------------------------------
const PHASES = {
  follicular: { label: "Follicular",       color: "#d6f0ea" },
  ovulation:  { label: "Ovulation (est.)", color: "#d9d2f5" },
  luteal:     { label: "Luteal",           color: "#dae3f6" },
};

const FERTILE_TYPES = new Set(["watery", "eggwhite"]);
const DEFAULT_LUTEAL = 14;
const PEAK_CONFIRM_DAYS = 3;   // in the current cycle, a peak counts as final after this many days

const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
const keyOf = d => dateStr(d.getFullYear(), d.getMonth(), d.getDate());

// Days after cycle start of the last watery/egg-white day before `untilIdx`, or null.
// Period days are skipped.
function peakIndex(start, untilIdx, discharge, periodSet) {
  let peak = null;
  for (let i = 0; i < untilIdx; i++) {
    const key = keyOf(addDays(start, i));
    const e = discharge[key];
    if (e && FERTILE_TYPES.has(e.type) && !periodSet.has(key)) peak = i;
  }
  return peak;
}

// A discharge peak this close to the next period is too late to be ovulation
const MIN_LUTEAL = 7, MAX_LUTEAL = 20;

// Your average luteal length from completed cycles with a discharge peak, else 14 days
function lutealLength(starts, discharge, periodSet) {
  const lengths = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const len = Math.round((starts[i + 1] - starts[i]) / DAY);
    const peak = peakIndex(starts[i], len, discharge, periodSet);
    if (peak == null) continue;
    const luteal = len - peak;
    if (luteal >= MIN_LUTEAL && luteal <= MAX_LUTEAL) lengths.push(luteal);
  }
  if (lengths.length === 0) return { days: DEFAULT_LUTEAL, count: 0 };
  return { days: Math.round(lengths.reduce((a, b) => a + b) / lengths.length), count: lengths.length };
}

// One entry per cycle:
// { start, ov, ovIdx, end, len, current, fromDischarge, tentative, luteal, lutealCount }
function cyclePhases(days) {
  const starts = cycleStarts(days);
  if (starts.length === 0) return [];
  const discharge = loadDischarge();
  const periodSet = new Set(days);
  const luteal = lutealLength(starts, discharge, periodSet);
  const avg = averageLength(starts);
  const today = toDate(todayStr());

  return starts.map((start, i) => {
    const next = starts[i + 1];
    let len, peak, tentative = false;

    if (next) {
      // Completed cycle: actual length, peak anywhere in it
      len = Math.round((next - start) / DAY);
      peak = peakIndex(start, len, discharge, periodSet);
      if (peak != null && len - peak < MIN_LUTEAL) peak = null;
    } else {
      // Current cycle: look up to today; expected length follows from the peak if there is one
      const todayIdx = Math.round((today - start) / DAY);
      peak = peakIndex(start, todayIdx + 1, discharge, periodSet);
      if (peak != null) tentative = todayIdx - peak < PEAK_CONFIRM_DAYS;
      len = peak != null ? peak + luteal.days : avg;
    }

    const ovIdx = peak != null ? peak : Math.max(1, len - luteal.days);
    return {
      start,
      ov: addDays(start, ovIdx),
      ovIdx,
      end: addDays(start, len - 1),
      len,
      current: !next,
      fromDischarge: peak != null,
      tentative,
      luteal: luteal.days,
      lutealCount: luteal.count,
    };
  });
}

// ---------------------------------------------
// Hormone curves (shapes tuned to the Britannica diagram)
// ---------------------------------------------

// Asymmetric Gaussian: sdL controls the rise, sdR the fall
const ag = (x, mu, sdL, sdR) => {
  const sd = x < mu ? sdL : sdR;
  return Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
};
const g = (x, mu, sd) => ag(x, mu, sd, sd);

// d = days since cycle start (0 = first day of period), len = cycle length,
// ov = ovulation day (days after start); defaults to 14 days before the cycle ends
// Timings follow Reed & Carr (Endotext): LH peak ~11 h before ovulation, surge onset ~34 h before;
// estradiol's luteal peak ~2/3 of its preovulatory peak; FSH highest as menses begins.
function hormones(d, len = 28, ov = len - 14) {
  return {
    LH:           0.04 + 0.96 * ag(d, ov - 0.45, 0.45, 0.9),
    FSH:          0.08 + 0.20 * ag(d, 1, 3, 7)             // highest as the period starts
                       + 0.20 * ag(d, len + 1, 3, 7)       // rising again at cycle end
                       + 0.33 * ag(d, ov - 0.45, 0.4, 1.5), // mid-cycle surge with LH
    estradiol:    0.05 + 0.87 * ag(d, ov - 1.5, 3.2, 1.0)
                       + 0.56 * g(d, ov + 8, 3.2),
    progesterone: 0.02 + 0.86 * ag(d, ov + 8.5, 4.3, 2.1),
  };
}

// ---------------------------------------------
// Menstrual cycle → daily rhythms (Baker & Driver 2007; Shechter et al. 2010)
//
// The body clock's timing doesn't change across the cycle, but in the luteal phase
// progesterone raises body temperature (~0.4 °C), shrinks its daily swing, and slightly
// reduces REM sleep. Estrogen lowers temperature, so it's lowest just before ovulation.
// Hormonal birth control replaces the natural cycle: temperature stays at a luteal-like level.
// ---------------------------------------------
// Stored as "1" for the combined pill (what older versions saved), or "minipill" / "liletta".
// Only the combined pill has a hormone model so far; the others show the natural cycle with a caution.
const BC_KEY = "hormonalBirthControl";
const BC_TYPES = {
  none:     { label: "No hormonal birth control" },
  combined: { label: "Combined pill", sub: "Estrogen + progestin" },
  minipill: { label: "Progestin-only pill", sub: "The \u201cmini pill\u201d" },
  liletta:  { label: "Liletta IUD", sub: "Hormonal IUD (levonorgestrel)" },
};
function birthControlType() {
  try {
    const v = localStorage.getItem(BC_KEY);
    return v === "1" ? "combined" : v === "minipill" || v === "liletta" ? v : "none";
  } catch { return "none"; }
}
function setBirthControlType(t) {
  try {
    if (!BC_TYPES[t] || t === "none") localStorage.removeItem(BC_KEY);
    else localStorage.setItem(BC_KEY, t === "combined" ? "1" : t);
  } catch {}
}
const usesBirthControl = () => birthControlType() === "combined";
const takesPill = () => ["combined", "minipill"].includes(birthControlType());

// Where `date` (+ `frac` of a day) falls in the logged/predicted cycles:
// { d, len, ov, P, E, phase, cycleDay, daysToNext } or null before the first logged cycle.
// P = progesterone and E = the pre-ovulatory estradiol surge, both scaled 0–1.
// Past the current cycle's expected end, cycles repeat with the same length.
function cycleStateAt(cycles, date, frac = 0) {
  let c = null;
  for (const x of cycles) if (x.start <= date) c = x;
  if (!c) return null;
  let d = (date - c.start) / DAY + frac, len = c.len, ov = c.ovIdx;
  if (c.current && d >= len) {
    d %= len;
    ov = Math.max(1, len - c.luteal);
  }
  const P = (hormones(d, len, ov).progesterone - 0.02) / 0.86;
  const E = ag(d, ov - 1.5, 3.2, 1.0);
  const phase = d < ov ? "follicular" : d < ov + 1 ? "ovulation" : "luteal";
  return { d, len, ov, P, E, phase, cycleDay: Math.floor(d) + 1, daysToNext: Math.ceil(len - d) };
}

const TEMP = {
  mesor: 36.8,          // °C daily average in the follicular phase (placeholder)
  amp: 0.45,            // °C: half of the 0.8–1 °C daily swing (Baker p. 614)
  minBeforeWake: 3.5,   // h: daily low ~3.5 h before waking (Shechter Table 2: 4:34 AM, wake ~8 AM)
  maxAfterMin: 14,      // h: daily high in the late afternoon / early evening (placeholder)
  lutealRise: 0.4,      // °C higher at the progesterone peak (Baker p. 615)
  lutealAmpCut: 0.26,   // daily swing 26% smaller (0.31 → 0.23 °C, Shechter Table 2)
  estrogenDrop: 0.1,    // °C lower at the pre-ovulatory estrogen peak (placeholder; Baker p. 615)
  progLagDays: 1,       // temperature follows progesterone by ~24 h (Baker p. 615)
};

// Core body temperature (°C) at hour h. `nights` as for alertingAt; `cycleAt(h)` gives
// { P, E } for that moment (P already lagged), or null for no cycle effect.
function temperatureAt(h, nights, cycleAt) {
  const points = [];
  for (const n of nights) {
    const low = n.wake - TEMP.minBeforeWake;
    points.push({ t: low, v: 0 }, { t: low + TEMP.maxAfterMin, v: 1 });
  }
  points.sort((a, b) => a.t - b.t);
  let v = points[points.length - 1].v;
  if (h <= points[0].t) v = points[0].v;
  else for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (h <= b.t) { v = a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * (h - a.t) / (b.t - a.t))) / 2; break; }
  }
  const c = cycleAt(h) || { P: 0, E: 0 };
  const mesor = TEMP.mesor + TEMP.lutealRise * c.P - TEMP.estrogenDrop * c.E;
  const amp = TEMP.amp * (1 - TEMP.lutealAmpCut * c.P);
  return mesor + amp * (2 * v - 1);
}

// ---------------------------------------------
// Cortisol (relative; personal levels differ up to ~100-fold, so no units)
//
// Lowest around bedtime, rising through the second half of the night, a burst of ~50%
// within 30–60 min of waking (the cortisol awakening response), then falling through the
// day with a flatter afternoon. Exercise of ~20 min or more at moderate or vigorous effort
// adds a bump peaking 20–30 min after it ends. Bright light soon after waking makes the
// morning burst larger. In the luteal phase it's slightly lower with a smaller daily swing
// (a small, inconsistent effect). All sizes are placeholders.
// ---------------------------------------------
const CORTISOL = {
  // Daily curve, as (hours from usual bedtime/mid-sleep/wake, level) points
  nadir: 0.08,            // ~30 min before usual bedtime (low ~10–11 PM: Kulzhanova p. 8171)
  midSleep: 0.15,         // rise begins in the second half of the night
  atWake: 0.55,           // at usual wake time
  lateMorning: 0.45,      // 4 h after waking
  afternoon: 0.3,         // 9 h after waking: flat-ish afternoon (Montero-López p. 69)
  car: 0.3,               // awakening burst, ~+55% of the wake level (38–75%: Ozgocer p. 58)
  carPeak: 0.6,           // h after waking: highest at 30–60 min (Ozgocer p. 60)
  carLightBoost: 0.2,     // bright light within 1 h of waking: burst up to 20% larger (Ozgocer p. 64)
  exerciseMinMinutes: 20, // shorter sessions don't raise it (Prado p. 8)
  exerciseAmp: { moderate: 0.12, vigorous: 0.22 },
  exercisePeakAfter: 25 / 60, // h after the session ends (20–30 min: Prado p. 8)
  lutealDrop: 0.1,        // up to 10% lower at the progesterone peak (Kulzhanova; Prado)
  lutealSwingCut: 0.15,   // daily swing up to 15% smaller (Baker p. 616)
};

// nights: clock nights { bed, mid, wake }; wakes: [{ t, boost }] actual final wake times;
// sessions: [{ end, minutes, intensity }]; progAt(h): progesterone 0–1 (0 = no cycle effect)
function cortisolAt(h, nights, wakes, sessions, progAt) {
  const C = CORTISOL, points = [];
  for (const n of nights) {
    points.push({ t: n.bed - 0.5, v: C.nadir }, { t: n.mid, v: C.midSleep }, { t: n.wake, v: C.atWake },
                { t: n.wake + 4, v: C.lateMorning }, { t: n.wake + 9, v: C.afternoon });
  }
  points.sort((a, b) => a.t - b.t);
  let v = points[points.length - 1].v;
  if (h <= points[0].t) v = points[0].v;
  else for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (h <= b.t) { v = a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * (h - a.t) / (b.t - a.t))) / 2; break; }
  }
  for (const w of wakes) if (h > w.t - 0.2) v += C.car * (1 + w.boost) * ag(h, w.t + C.carPeak, 0.3, 0.7);
  for (const x of sessions) {
    if (x.minutes < C.exerciseMinMinutes || !(x.intensity in C.exerciseAmp)) continue;
    const dur = x.minutes / 60;
    v += C.exerciseAmp[x.intensity] * ag(h, x.end + C.exercisePeakAfter, Math.min(0.6, dur / 2 + 0.2), 0.8);
  }
  const P = progAt(h);
  const centre = 0.3;    // the swing shrinks around this level
  return (centre + (v - centre) * (1 - C.lutealSwingCut * P)) * (1 - C.lutealDrop * P);
}

// ---------------------------------------------
// Cosine fit (for logged measurements like temperature)
// t: array of numbers (days since start), y: array of values
// ---------------------------------------------
function fitCosine(t, y, period) {
  const w = 2 * Math.PI / period;
  const M = [[0,0,0],[0,0,0],[0,0,0]], r = [0,0,0];
  for (let i = 0; i < t.length; i++) {
    const row = [Math.cos(w * t[i]), Math.sin(w * t[i]), 1];
    for (let j = 0; j < 3; j++) {
      r[j] += row[j] * y[i];
      for (let k = 0; k < 3; k++) M[j][k] += row[j] * row[k];
    }
  }
  const det = m => m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
                 - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
                 + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const D = det(M);
  const [a, b, C] = [0,1,2].map(c =>
    det(M.map((row, i) => row.map((v, j) => j === c ? r[i] : v))) / D);
  return { A: Math.hypot(a, b), phase: Math.atan2(-b, a), C, w };
}

// ---------------------------------------------
// Interface
// ---------------------------------------------
const calendar   = document.getElementById("calendar");
const monthLabel = document.getElementById("monthLabel");

// Which month the calendar is showing (month is 0-11)
let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth();

// Day panel: edit period and discharge for the selected day
let selectedDay = null;   // "YYYY-MM-DD"
const dayPanel       = document.getElementById("dayPanel");
const panelDate      = document.getElementById("panelDate");
const panelPeriod    = document.getElementById("panelPeriod");
const panelDischarge = document.getElementById("panelDischarge");
const panelAmount    = document.getElementById("panelAmount");

panelDischarge.add(new Option("None", ""));
for (const [value, t] of Object.entries(DISCHARGE_TYPES)) {
  panelDischarge.add(new Option(t.label, value));
}
panelAmount.add(new Option("Not set", ""));
for (const [value, a] of Object.entries(AMOUNTS)) {
  panelAmount.add(new Option(a.label, value));
}

function renderPanel(days) {
  dayPanel.hidden = !selectedDay;
  if (!selectedDay) return;
  const entry = loadDischarge()[selectedDay];
  panelDate.textContent = fmt(toDate(selectedDay));
  panelPeriod.checked = days.includes(selectedDay);
  flowField.hidden = !panelPeriod.checked;
  const flow = loadFlow()[selectedDay];
  for (const b of flowSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.flow === flow));
  panelMissed.checked = loadMissed().includes(selectedDay);
  panelDischarge.value = entry ? entry.type : "";
  panelAmount.value = entry ? entry.amount : "";
  panelAmount.disabled = !entry;           // amount only applies once a type is chosen
}

const flowField = document.getElementById("flowField");
const flowSeg = document.getElementById("flowSeg");
for (const b of flowSeg.querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const f = loadFlow();
    if (f[selectedDay] === b.dataset.flow) delete f[selectedDay];   // click again to clear
    else f[selectedDay] = b.dataset.flow;
    saveFlow(f);
    render();
  });
}

const panelMissed = document.getElementById("panelMissed");
panelMissed.addEventListener("change", () => {
  const current = loadMissed();
  saveMissed(panelMissed.checked ? [...current, selectedDay] : current.filter(x => x !== selectedDay));
  render();
});

panelPeriod.addEventListener("change", () => {
  const current = load();
  save(panelPeriod.checked ? [...current, selectedDay] : current.filter(x => x !== selectedDay));
  if (!panelPeriod.checked) { const f = loadFlow(); delete f[selectedDay]; saveFlow(f); }
  render();
});

panelDischarge.addEventListener("change", () => {
  const dc = loadDischarge();
  const isNewDay = !dc[selectedDay];   // logging discharge on a day that had none
  if (panelDischarge.value) {
    dc[selectedDay] = { type: panelDischarge.value, amount: dc[selectedDay]?.amount || "" };
  } else {
    delete dc[selectedDay];
  }
  saveDischarge(dc);
  render();
  if (panelDischarge.value && isNewDay) maybeWarnDischarge();
});

// Warning shown when a discharge day is logged, unless turned off
const dischargeWarning = document.getElementById("dischargeWarning");
const hideWarningBox   = document.getElementById("hideDischargeWarning");

// Birth control note under Cycles (the setting itself is in Settings)
const bcStatus = document.getElementById("bcStatus");
function renderBcStatus() {
  const t = birthControlType();
  document.body.classList.toggle("pill-user", takesPill());
  bcStatus.hidden = t === "none";
  if (t === "none") return;
  const name = BC_TYPES[t].label;
  bcStatus.className = "bc-status" + (t === "combined" ? "" : " caution");
  bcStatus.textContent = t === "combined"
    ? `Birth control: ${name}. The cycle chart shows estimated hormone levels on the pill instead of a natural ` +
      "cycle, menstrual-cycle effects on the daily rhythms are turned off, and body temperature stays at a " +
      "luteal-like level. "
    : `Birth control: ${name}. Ovulation may still happen, and bleeding is often irregular, lighter or absent, ` +
      "so period and ovulation predictions are less reliable. The charts show a natural cycle for now; a model " +
      `for ${t === "liletta" ? "Liletta" : "the progestin-only pill"} will be added later. `;
  if (takesPill()) {
    const since = keyOf(addDays(toDate(todayStr()), -29));
    const n = loadMissed().filter(d => d >= since && d <= todayStr()).length;
    const p = document.createElement("span");
    p.style.display = "block";
    p.style.margin = "6px 0";
    p.textContent = `Missed pills in the last 30 days: ${n}. Log one from the day card below the calendar. ` +
      "The estimates assume every pill was taken. After a missed pill, check your pill's leaflet or ask a " +
      "pharmacist whether you need backup contraception.";
    bcStatus.appendChild(p);
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Change in Settings";
  btn.addEventListener("click", () => openSetup(false));
  bcStatus.appendChild(btn);
}
const WARN_KEY = "hideDischargeWarning";

function maybeWarnDischarge() {
  if (localStorage.getItem(WARN_KEY) === "1" || dischargeWarning.open) return;
  dischargeWarning.showModal();
}

dischargeWarning.addEventListener("close", () => {
  if (hideWarningBox.checked) localStorage.setItem(WARN_KEY, "1");
});

panelAmount.addEventListener("change", () => {
  const dc = loadDischarge();
  if (!dc[selectedDay]) return;
  dc[selectedDay].amount = panelAmount.value;
  saveDischarge(dc);
  render();
});

// Legend under the calendar
const legend = document.getElementById("legend");
for (const [label, cls, color] of [["Period (dot size = flow)", "", "#d9455f"], ["Cycle start", "start", "#8b1a2f"],
                                   ["Predicted period", "ring", "#d9455f"]]) {
  const item = document.createElement("span");
  item.className = cls;
  item.textContent = label;
  item.style.setProperty("--dc", color);
  legend.appendChild(item);
}
{
  const item = document.createElement("span");
  item.className = "missed pill-ui";
  item.textContent = "Missed pill";
  legend.appendChild(item);
  const br = document.createElement("span");
  br.className = "legend-break";
  legend.appendChild(br);
}
legend.lastChild.classList.add("discharge-ui");
for (const t of Object.values(DISCHARGE_TYPES)) {
  const item = document.createElement("span");
  item.classList.add("discharge-ui");
  item.textContent = t.label;
  item.style.setProperty("--dc", t.color);
  legend.appendChild(item);
}
{
  const br = document.createElement("span");
  br.className = "legend-break";
  legend.appendChild(br);
}
for (const p of Object.values(PHASES)) {
  const item = document.createElement("span");
  item.className = "phase";
  item.textContent = p.label;
  item.style.setProperty("--dc", p.color);
  legend.appendChild(item);
}

// Today's date as "YYYY-MM-DD" in local time
// (input.valueAsDate uses UTC, which can be off by a day in the evening)
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const fmt = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function emptyNote(list, text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  list.appendChild(li);
}

const pad = n => String(n).padStart(2, "0");
const dateStr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;   // m is 0-11

function renderCalendar(days) {
  const logged = new Set(days);
  const discharge = loadDischarge();
  const startSet = new Set(cycleStarts(days).map(d =>
    dateStr(d.getFullYear(), d.getMonth(), d.getDate())));
  const today = todayStr();
  const p = predictNext(days);
  const predicted = new Set();
  if (p) {
    for (const d = new Date(p.date); d <= p.end; d.setDate(d.getDate() + 1)) {
      predicted.add(dateStr(d.getFullYear(), d.getMonth(), d.getDate()));
    }
  }

  // Estimated phase for every day of every cycle
  const phaseOf = {};
  const ovNote = {};
  for (const c of cyclePhases(days)) {
    for (const d = new Date(c.start); d <= c.end; d.setDate(d.getDate() + 1)) {
      const key = keyOf(d);
      const diff = Math.round((d - c.ov) / DAY);
      phaseOf[key] = diff < 0 ? "follicular" : diff === 0 ? "ovulation" : "luteal";
    }
    ovNote[keyOf(c.ov)] = c.fromDischarge ? "Ovulation (from discharge)" : "Ovulation (estimated)";
  }

  calendar.innerHTML = "";
  monthLabel.textContent = new Date(viewYear, viewMonth, 1)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // Weekday headings
  for (const name of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const el = document.createElement("div");
    el.className = "dow";
    el.textContent = name;
    calendar.appendChild(el);
  }

  // Blank cells before the 1st so it lands on the right weekday
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  for (let i = 0; i < firstWeekday; i++) calendar.appendChild(document.createElement("div"));

  // One button per day
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const pill = takesPill(), missedSet = new Set(loadMissed()), flows = loadFlow();
  for (let d = 1; d <= daysInMonth; d++) {
    const s = dateStr(viewYear, viewMonth, d);
    const btn = document.createElement("button");
    btn.className = "day";
    btn.textContent = d;
    if (logged.has(s))   btn.classList.add("logged");
    if (startSet.has(s)) btn.classList.add("start");
    if (s === today)     btn.classList.add("today");
    if (predicted.has(s) && !logged.has(s)) btn.classList.add("predicted");
    const entry = discharge[s];
    const t = entry && DISCHARGE_TYPES[entry.type];
    const a = entry && AMOUNTS[entry.amount];
    if (t) {
      btn.classList.add("discharge");
      btn.style.setProperty("--dc", t.color);
      btn.style.setProperty("--ds", `${a ? a.size : 7}px`);   // dot size follows amount
    }
    const missed = pill && missedSet.has(s);
    if (missed) {
      const m = document.createElement("span");
      m.className = "missed-mark";
      m.textContent = "✕";
      btn.appendChild(m);
    }
    const flow = logged.has(s) && FLOWS[flows[s]];
    if (flow) btn.style.setProperty("--fs", `${flow.size}px`);
    btn.title = [
      logged.has(s) && (flow ? `Period (${flow.label.toLowerCase()} flow)` : "Period"),
      missed && "Missed pill",
      t && `Discharge: ${t.label}${a ? ` (${a.label.toLowerCase()})` : ""}`,
      ovNote[s],
    ].filter(Boolean).join(", ") || "Nothing logged";

    if (phaseOf[s]) btn.classList.add(phaseOf[s]);
    if (s === selectedDay) btn.classList.add("selected");

    btn.addEventListener("click", () => {
      selectedDay = s;
      render();
    });
    calendar.appendChild(btn);
  }
}

function render() {
  const days = load();
  renderBcStatus();
  renderCalendar(days);
  renderPanel(days);
  renderPrediction(days);
  renderChart(days);
  renderHistory(days);
  renderRhythms();
}

// ---------------------------------------------
// Prediction: last start + average cycle length
// ---------------------------------------------
const summary = document.getElementById("summary");

// Each period as { start, end }, grouping days with the same gap tolerance as cycleStarts
function periodRuns(days, maxGap = 2) {
  const runs = [];
  for (const s of days) {
    const d = toDate(s);
    const last = runs[runs.length - 1];
    if (last && Math.round((d - last.end) / DAY) <= maxGap) last.end = d;
    else runs.push({ start: d, end: d });
  }
  return runs;
}

// Average period length in days, counting only periods that are over
// (a period counts as over once more than maxGap days have passed since its last logged day)
function averageDuration(days, maxGap = 2) {
  const today = toDate(todayStr());
  const done = periodRuns(days, maxGap).filter(r => Math.round((today - r.end) / DAY) > maxGap);
  if (done.length === 0) return { days: 5, count: 0 };
  const total = done.reduce((sum, r) => sum + Math.round((r.end - r.start) / DAY) + 1, 0);
  return { days: Math.round(total / done.length), count: done.length };
}

// Next start = current cycle start + its expected length. That length is the average
// cycle, unless discharge has pinned down ovulation (then ovulation + luteal length).
function predictNext(days) {
  const cycles = cyclePhases(days);
  if (cycles.length === 0) return null;
  const cur = cycles[cycles.length - 1];
  const date = addDays(cur.start, cur.len);   // calendar-day math, safe across daylight saving

  const dur = averageDuration(days);
  const end = addDays(date, dur.days - 1);

  return { date, end, len: cur.len, cur, count: cycles.length - 1, dur: dur.days, durCount: dur.count };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One shaded box: a heading, a two-column table of [label, value] rows, and an optional note
function summaryBox(title, className, rows, note) {
  const box = document.createElement("div");
  box.className = `summary-box ${className}`;

  const heading = document.createElement("h3");
  heading.textContent = title;
  box.appendChild(heading);

  const table = document.createElement("table");
  for (const [label, value] of rows) {
    const row = table.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = label;
    const td = document.createElement("td");
    td.textContent = value;
    row.append(th, td);
  }
  box.appendChild(table);

  if (note) {
    const p = document.createElement("p");
    p.className = "summary-note";
    p.textContent = note;
    box.appendChild(p);
  }
  return box;
}

function renderPrediction(days) {
  summary.innerHTML = "";
  const p = predictNext(days);
  if (!p) return;

  const inDays = Math.round((p.date - toDate(todayStr())) / DAY);
  const until = inDays > 0 ? plural(inDays, "day")
              : inDays === 0 ? "Today"
              : `${plural(-inDays, "day")} late`;

  const lutealBasis = p.cur.lutealCount > 0
    ? `your average ${p.cur.luteal}-day luteal phase`
    : `a typical ${p.cur.luteal}-day luteal phase`;
  const basis = p.cur.fromDischarge
    ? `Based on ovulation${p.cur.tentative ? " possibly" : ""} on ${fmt(p.cur.ov)} from discharge, plus ${lutealBasis}.`
    : p.count > 0 ? "Based on your average cycle length."
    : "Based on a typical 28-day cycle until you have a completed cycle.";

  summary.append(
    summaryBox("Predictions", "predicted", [
      ["Next period start",      fmt(p.date)],
      ["Next period duration",   `${plural(p.dur, "day")} (${fmtRange(p.date, p.end)})`],
      ["Days until next period", until],
    ], basis),
  );
}

document.getElementById("prevMonth").addEventListener("click", () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  render();
});

document.getElementById("nextMonth").addEventListener("click", () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  render();
});

// ---------------------------------------------
// Hormone chart
// ---------------------------------------------
const chartNote = document.getElementById("chartNote");
const canvas    = document.getElementById("hormoneChart");
let chart = null;

// ---------------------------------------------
// Estimated hormone levels on a combined pill (21 active days, then 7 pill-free days, during
// which the withdrawal bleed you log as a period happens). The pill's estrogen and progestin
// suppress FSH and LH, so there is no LH surge and no ovulation; follicles barely grow, so the
// body makes little estradiol of its own; progesterone stays low because the pill's progestin
// is a different molecule. In the pill-free week suppression wears off: FSH climbs back to
// early-follicular levels and follicles start to grow, so estradiol creeps up until the next
// pack; about a week of active pills suppresses things again.
// (Baerwald & Pierson 2004, p. 1–6; Birtch 2005, §1.3.4; Pralong, "Oral contraception and
// the HPG axis".) Levels are on the natural-cycle curves' scale, so "early-follicular" means
// the natural curves' day 1–3 values (FSH ~0.28, LH ~0.04, estradiol ~0.06–0.1).
// ---------------------------------------------
const BC_MODEL = {
  pillFreeBefore: 2,   // pill-free days at the end of the cycle (the bleed starts ~2 days in)
  pillFreeAfter: 5,    // ...and at the start of the next, for 7 in all
  // Days for levels to fall back once pills restart (~95% back within a week: Birtch §1.3.4)
  recoverDays: { FSH: 2, LH: 2, estradiol: 2.5, progesterone: 2 },
  base: { FSH: 0.10, LH: 0.03, estradiol: 0.05, progesterone: 0.02 },   // on active pills
  rise: { FSH: 0.18, LH: 0.02, estradiol: 0.05, progesterone: 0 },      // by the end of the pill-free week:
                                                                         // early-follicular FSH and estradiol (p. 5)
};
const isPillFree = (d, len) => d >= len - BC_MODEL.pillFreeBefore || d < BC_MODEL.pillFreeAfter;

function hormonesBC(d, len) {
  const M = BC_MODEL, span = M.pillFreeBefore + M.pillFreeAfter;
  const sinceStop = d >= len - M.pillFreeBefore ? d - (len - M.pillFreeBefore)
                  : d < M.pillFreeAfter ? d + M.pillFreeBefore : null;
  const out = {};
  for (const k of Object.keys(M.base)) {
    const t = d - M.pillFreeAfter, tau = M.recoverDays[k];
    // Rising through the pill-free week; falling once pills restart. Estradiol levels off for
    // about a day first, since a follicle that has started growing keeps going briefly as FSH
    // falls (p. 5).
    const f = sinceStop != null ? sinceStop / span
            : k === "estradiol" ? (1 + t / tau) * Math.exp(-t / tau)
            : Math.exp(-t / tau);
    const shape = k === "estradiol" ? f * f : f;   // estradiol rises late, as follicles grow
    out[k] = M.base[k] + M.rise[k] * shape;
  }
  return out;
}

// The curves the charts draw: natural cycle, or estimates on the pill
const displayHormones = (d, len, ov) => usesBirthControl() ? hormonesBC(d, len) : hormones(d, len, ov);
const BC_PHASES = {
  active:   { label: "Active pills",   color: "#dfe2ec" },
  pillfree: { label: "Pill-free days", color: "#f6d5dc" },
};

// Display names (data keys stay short)
const HORMONE_NAMES = {
  FSH: "Follicle-stimulating hormone (FSH)",
  LH: "Luteinizing hormone (LH)",
  estradiol: "Estradiol",
  progesterone: "Progesterone",
};
const hormoneKey = name => Object.keys(HORMONE_NAMES).find(k => HORMONE_NAMES[k] === name) ?? name;

// Cool tones, each distinct from the others and from the indigo ovulation line
const COLORS = {
  FSH:          "#2bb39a",   // sea green
  LH:           "#b5398f",   // plum
  estradiol:    "#2f8fd8",   // sky blue
  progesterone: "#0f5e6e",   // deep teal
};

// Average length of completed cycles, or 28 if there are none yet
function averageLength(starts) {
  const lengths = starts.slice(1).map((s, i) => Math.round((s - starts[i]) / DAY));
  if (lengths.length === 0) return 28;
  return Math.round(lengths.reduce((a, b) => a + b) / lengths.length);
}

// Draws a dashed vertical line at options.x
const todayLine = {
  id: "todayLine",
  afterDraw(chart, args, options) {
    if (options.x == null) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    const px = x.getPixelForValue(options.x);
    ctx.save();
    ctx.strokeStyle = "#333";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Shaded follicular/luteal bands behind the curves, with a line at estimated ovulation
const OVULATION_LINE = "#4b3fa3";   // deep indigo, distinct from every hormone color

const phaseBands = {
  id: "phaseBands",
  beforeDatasetsDraw(chart, args, o) {
    if (o.ov == null) return;
    const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
    const x0 = x.getPixelForValue(0);
    const xo = x.getPixelForValue(o.ov);
    const x1 = x.getPixelForValue(o.len);
    ctx.save();
    ctx.fillStyle = PHASES.follicular.color + "99";
    ctx.fillRect(x0, top, xo - x0, bottom - top);
    ctx.fillStyle = PHASES.luteal.color + "99";
    ctx.fillRect(xo, top, x1 - xo, bottom - top);

    ctx.strokeStyle = OVULATION_LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xo, top);
    ctx.lineTo(xo, bottom);
    ctx.stroke();

    ctx.fillStyle = "#666";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Follicular", (x0 + xo) / 2, top + 14);
    ctx.fillText("Luteal", (xo + x1) / 2, top + 14);
    ctx.fillText("Ovulation", xo, bottom - 6);

    // Remember where the phase labels are so hovering them can show a tip
    const labelBox = (key, text, cx, baseline) => {
      const w = ctx.measureText(text).width;
      return { key, left: cx - w / 2 - 4, right: cx + w / 2 + 4, top: baseline - 13, bottom: baseline + 4 };
    };
    chart.$phaseLabels = [
      labelBox("follicular", "Follicular", (x0 + xo) / 2, top + 14),
      labelBox("luteal", "Luteal", (xo + x1) / 2, top + 14),
    ];
    ctx.restore();
  },
};

// ---------------------------------------------
// Hover tips: y-axis units and what each hormone does
// ---------------------------------------------
const chartTip = document.getElementById("chartTip");

const Y_AXIS_INFO =
  "Relative level: each curve is scaled to its own range, from about 0 (its lowest point) " +
  "to 1 (its peak), so heights can't be compared between hormones. In lab tests, LH and FSH " +
  "are measured in mIU/mL, estradiol in pg/mL, and progesterone in ng/mL.";

// What makes each hormone rise, and what it does (shown when hovering the legend).
// From Reed & Carr, Endotext (2018); page numbers are the PDF's.
const HORMONE_INFO = {
  FSH:
    "Rises: in the last few days of the previous cycle, as the corpus luteum's hormones and " +
    "inhibin A fall. Declines once the period starts (feedback from estrogen and inhibin B), " +
    "with a small surge alongside LH at mid-cycle, driven by progesterone.\n" +
    "Function: recruits a group of follicles (days 1–4), one of which becomes dominant, and switches " +
    "on aromatase, which turns androgens into estrogen.\n" +
    "Source: Reed & Carr, p. 2–4, p. 7.",
  LH:
    "Rises: low early in the cycle, rising by mid-follicular phase from estrogen's positive " +
    "feedback. The surge needs estradiol above ~200 pg/mL for ~50 h; it starts 34–36 h before " +
    "ovulation and peaks 10–12 h before.\n" +
    "Function: has theca cells make androgens (turned into estrogen with FSH's help), triggers " +
    "ovulation, turns the follicle into the corpus luteum, and drives its progesterone in pulses.\n" +
    "Source: Reed & Carr, p. 4–5, p. 7, p. 11.",
  estradiol:
    "Rises: as the dominant follicle grows, peaking just before the LH surge and dropping sharply " +
    "after ovulation; rises again mid-luteal alongside progesterone, then falls at the end of the cycle.\n" +
    "Function: builds up the uterine lining (proliferative phase), makes cervical mucus clear, stretchy, " +
    "and ~30× more plentiful, and, once high enough for long enough, triggers the LH surge.\n" +
    "Source: Reed & Carr, p. 1–2, p. 5, p. 10, p. 15.",
  progesterone:
    "Rises: mainly after ovulation, from the corpus luteum (a small rise starts just before). Peaks " +
    "~8–9 days after ovulation, then falls as the corpus luteum declines 9–11 days after ovulation, " +
    "unless pregnancy occurs.\n" +
    "Function: prepares the estrogen-primed uterine lining for implantation (secretory phase), makes " +
    "cervical mucus thick and scant again, and drives the mid-cycle FSH surge. Its fall brings on the period.\n" +
    "Source: Reed & Carr, p. 7, p. 9–10, p. 12, p. 15–16.",
};

// Phase summaries from Reed & Carr, "The Normal Menstrual Cycle and the Control of
// Ovulation" (Endotext, 2018). Citations use the PDF page number and section.
const PHASE_INFO = {
  follicular:
    "Follicular phase: from the first day of your period until ovulation. FSH rises at the end " +
    "of the previous cycle and recruits a group of follicles; one becomes dominant by about day 8. " +
    "Estradiol rises as that follicle grows, and LH begins rising by mid-phase. Body temperature " +
    "is in its lower range. This phase varies (about 10–16 days) and accounts for most differences " +
    "in cycle length.\n\n" +
    "Source: Reed & Carr, Endotext: p. 1, Abstract; p. 2, The Follicular Phase ¶1–2; p. 3; p. 5.",
  luteal:
    "Luteal phase: from ovulation to the next period, fairly constant at about 14 days. The " +
    "leftover follicle becomes the corpus luteum, which mainly secretes progesterone to prepare " +
    "the uterine lining. Progesterone and estradiol peak about 8–9 days after ovulation. The " +
    "corpus luteum starts declining 9–11 days after ovulation unless pregnancy occurs, and the " +
    "fall in progesterone brings on the period.\n\n" +
    "Source: Reed & Carr, Endotext: p. 9–10, Luteal Phase; p. 12 ¶1; p. 15, Menstruation ¶1.",
};

let tipSource = null;   // "axis", "phase", "legend", or null when hidden
let tipCanvas = null;   // the chart canvas the tip belongs to

function showTip(text, mouseEvent, source, target = canvas) {
  tipSource = source;
  tipCanvas = target;
  // "Rises:" and "Function:" labels are underlined
  chartTip.textContent = "";
  for (const part of String(text).split(/(\b(?:Rises|Function)(?=:))/)) {
    if (part === "Rises" || part === "Function") {
      const u = document.createElement("u");
      u.textContent = part;
      chartTip.appendChild(u);
    } else chartTip.append(part);
  }
  chartTip.hidden = false;
  target.style.cursor = source === "legend" ? "pointer" : "help";   // legend items are clickable

  // Place it below-right of the cursor, flipping left if it would go off screen
  let left = mouseEvent.clientX + 12;
  const top = mouseEvent.clientY + 12;
  chartTip.style.left = `${left}px`;
  chartTip.style.top = `${top}px`;
  const box = chartTip.getBoundingClientRect();
  if (box.right > window.innerWidth - 8) left = mouseEvent.clientX - box.width - 12;
  chartTip.style.left = `${Math.max(8, left)}px`;
  if (box.bottom > window.innerHeight - 8) {   // long tips flip above the cursor
    chartTip.style.top = `${Math.max(8, mouseEvent.clientY - box.height - 12)}px`;
  }
}

// Leaving a chart closes its hover details, but not an explanation opened with a "?" tap
// (on phones, a tap elsewhere makes the browser send a "mouse left the chart" event)
function hideHoverTip() {
  if (["help", "rkey", "eatflag"].includes(tipSource)) return;
  hideTip();
}

function hideTip() {
  tipSource = null;
  chartTip.hidden = true;
  if (tipCanvas) tipCanvas.style.cursor = "";
  tipCanvas = null;
}

canvas.addEventListener("mouseleave", hideHoverTip);

// ---- "?" help: tap (or hover with a mouse) for an explanation; tap again or anywhere else to close ----
let lastPointer = "mouse";
document.addEventListener("pointerdown", e => { lastPointer = e.pointerType || "mouse"; }, true);
function attachHelp(btn, getText, source = "help") {
  let wasOpen = false;
  btn.addEventListener("pointerdown", () => { wasOpen = tipSource === source && tipCanvas === btn; });
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (wasOpen && e.pointerType !== "mouse") { wasOpen = false; return hideTip(); }
    const r = btn.getBoundingClientRect();
    showTip(getText(), e.clientX || e.clientY ? e : { clientX: r.left, clientY: r.bottom }, source, btn);
  });
  btn.addEventListener("mousemove", e => { if (lastPointer === "mouse") showTip(getText(), e, source, btn); });
  btn.addEventListener("mouseleave", () => {
    if (lastPointer === "mouse" && tipSource === source && tipCanvas === btn) hideTip();
  });
}
function helpButton(label, getText) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "help-q";
  b.textContent = "?";
  b.setAttribute("aria-label", `What is ${label}?`);
  attachHelp(b, getText);
  return b;
}
// Scrolling closes any open explanation or detail, so it doesn't float over the page
window.addEventListener("scroll", () => { if (tipSource) hideTip(); }, { passive: true });
// A tap anywhere else closes an open explanation
document.addEventListener("pointerdown", e => {
  if (!tipSource || e.target.closest(".help-q, .rkey-name, .eat-flag, #chartTip")) return;
  if (["help", "rkey", "eatflag"].includes(tipSource) || e.pointerType !== "mouse") hideTip();
});

// Key items: a checkbox to show/hide (optional) and a name whose "?" explains it
function buildKey(container, items) {
  container.innerHTML = "";
  for (const it of items) {
    const item = document.createElement("span");
    item.className = "rkey-item" + (it.toggle && !it.checked ? " off" : "") + (it.toggle ? "" : " help-only");
    const check = document.createElement(it.toggle ? "label" : "span");
    check.className = "rkey-check";
    if (it.toggle) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!it.checked;
      box.setAttribute("aria-label", `Show ${it.label}`);
      box.addEventListener("change", () => it.toggle(box.checked));
      check.appendChild(box);
    }
    if (it.color) {
      const sw = document.createElement("span");
      sw.className = "swatch " + (it.swatch || "line-swatch");
      sw.style.background = it.color;
      check.appendChild(sw);
    }
    const name = document.createElement("button");
    name.type = "button";
    name.className = "rkey-name";
    name.textContent = it.label;
    name.setAttribute("aria-label", `What is ${it.label}?`);
    attachHelp(name, () => it.info, "rkey");
    item.append(check, name);
    container.appendChild(item);
  }
}

// Shows a tip while the mouse is over the y-axis label or a phase label
const inBox = (e, b) => e.x >= b.left && e.x <= b.right && e.y >= b.top && e.y <= b.bottom;

const axisHover = {
  id: "axisHover",
  afterEvent(chart, args) {
    if (tipSource === "legend") return;
    const e = args.event;
    if (e.type === "mouseout") { hideHoverTip(); return; }

    const phase = (chart.$phaseLabels || []).find(b => inBox(e, b));
    if (phase) return showTip(PHASE_INFO[phase.key], e.native, "phase");

    if (inBox(e, chart.scales.y)) return showTip(Y_AXIS_INFO, e.native, "axis");

    // Hovering a hormone curve: what it is, its level there, and what it does
    const curve = nearestCurve(chart, e);
    if (curve) return showTip(curve, e.native, "curve");

    if (tipSource === "axis" || tipSource === "phase" || tipSource === "curve") hideTip();
  },
};

// The visible hormone line within a few pixels of the pointer, as tip text (or null)
function nearestCurve(chart, e) {
  const area = chart.chartArea;
  if (!area || e.x < area.left || e.x > area.right || e.y < area.top - 4 || e.y > area.bottom + 4) return null;
  let best = null;
  chart.data.datasets.forEach((ds, i) => {
    if (!chart.isDatasetVisible(i)) return;
    const pts = chart.getDatasetMeta(i).data;
    let j = 0;
    while (j < pts.length - 1 && pts[j + 1].x < e.x) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const t = b.x > a.x ? (e.x - a.x) / (b.x - a.x) : 0;
    const y = a.y + (b.y - a.y) * Math.max(0, Math.min(1, t));
    const dist = Math.abs(y - e.y);
    if (dist <= 8 && (!best || dist < best.dist)) {
      const v = ds.data[j].y + (ds.data[Math.min(j + 1, ds.data.length - 1)].y - ds.data[j].y) * Math.max(0, Math.min(1, t));
      best = { dist, label: ds.label, v, day: Math.floor(chart.scales.x.getValueForPixel(e.x)) + 1 };
    }
  });
  if (!best) return null;
  const key = hormoneKey(best.label);
  return `${best.label} · cycle day ${best.day}: ${best.v.toFixed(2)} (relative)\n\n` +
         (HORMONE_INFO[key] ?? "");
}

// ---------------------------------------------
// Cycle navigation for the chart
// ---------------------------------------------
const chartTitle   = document.getElementById("chartTitle");
const prevCycleBtn = document.getElementById("prevCycle");
const nextCycleBtn = document.getElementById("nextCycle");
let viewCycle = null;   // index of the cycle shown; null = the current (latest) cycle

// "Oct 4 – Oct 31, 2026", or with both years if the range crosses New Year
function fmtRange(a, b) {
  const md = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return a.getFullYear() === b.getFullYear()
    ? `${md(a)} – ${md(b)}, ${b.getFullYear()}`
    : `${fmt(a)} – ${fmt(b)}`;
}

// Key above the line chart: hormones (checkbox + "?") and the phases and y-axis ("?" only)
const cycleKey = document.getElementById("cycleKey");
function renderCycleKey() {
  const g = goals.hormones, items = [];
  for (const name of Object.keys(COLORS)) {
    const listed = isDetailed(g) || (isOn(g) && (name === "estradiol" || name === "progesterone")) || polarShow[name];
    if (!listed) continue;
    items.push({ label: HORMONE_NAMES[name], color: COLORS[name], checked: polarShow[name], info: HORMONE_INFO[name],
                 toggle: on => { polarShow[name] = on; applyDisplay(); } });
  }
  if (!usesBirthControl()) {
    items.push({ label: "Follicular phase", color: "#c3e9df", swatch: "dot", info: PHASE_INFO.follicular });
    items.push({ label: "Luteal phase", color: "#c9d6f2", swatch: "dot", info: PHASE_INFO.luteal });
  }
  items.push({ label: "Relative level", info: Y_AXIS_INFO });
  buildKey(cycleKey, items);
}

// viewCycle = last + 1 shows the predicted next cycle
function stepCycle(dir) {
  const last = cyclePhases(load()).length - 1;
  if (last < 0) return;
  const to = Math.max(0, Math.min(last + 1, (viewCycle ?? last) + dir));
  viewCycle = to === last ? null : to;
  renderChart(load());
}
prevCycleBtn.addEventListener("click", () => stepCycle(-1));
// "Today": back to the current cycle (enabled only when looking at another one)
const cycleTodayBtn = document.getElementById("cycleToday");
cycleTodayBtn.addEventListener("click", () => { viewCycle = null; renderChart(load()); });
nextCycleBtn.addEventListener("click", () => stepCycle(1));

// The next cycle as predicted from your averages (same fields as cyclePhases entries)
function predictedCycle(days, cycles) {
  const p = predictNext(days);
  if (!p) return null;
  const len = averageLength(cycles.map(c => c.start));
  const ovIdx = Math.max(1, len - p.cur.luteal);
  return {
    start: p.date, ov: addDays(p.date, ovIdx), ovIdx, end: addDays(p.date, len - 1), len,
    current: false, predicted: true, fromDischarge: false, tentative: false,
    luteal: p.cur.luteal, lutealCount: p.cur.lutealCount, periodLen: p.dur,
  };
}

// Keeps the ‹ › buttons level with the middle of the plot area (not the whole chart,
// whose legend and axis labels are different heights)
const alignArrows = {
  id: "alignArrows",
  afterLayout(chart) {
    const offset = (chart.chartArea.top + chart.chartArea.bottom) / 2 - chart.height / 2;
    for (const btn of [prevCycleBtn, nextCycleBtn]) btn.style.transform = `translateY(${offset}px)`;
  },
};

function renderChart(days) {
  hideTip();
  if (chart) { chart.destroy(); chart = null; }

  const cycles = cyclePhases(days);
  const circle = cycleMode === "circle";
  syncViewControls();
  canvas.style.display = circle ? "none" : "";
  polarCanvas.style.display = circle && cycles.length ? "block" : "none";
  polarOptions.hidden = !circle;
  if (circle) for (const btn of [prevCycleBtn, nextCycleBtn]) btn.style.transform = "";
  cycleTodayBtn.disabled = true;
  if (cycles.length === 0) {
    chartTitle.textContent = Object.keys(COLORS).some(n => polarShow[n]) ? "Hormones this cycle" : "This cycle";
    prevCycleBtn.disabled = nextCycleBtn.disabled = true;
    chartNote.textContent = "Log a period day to see the chart.";
    return;
  }

  // Pick the cycle to show; fall back to the current one if the index no longer fits
  const last = cycles.length - 1;
  if (viewCycle != null && (viewCycle === last || viewCycle > last + 1)) viewCycle = null;
  const idx = viewCycle ?? last;
  cycleTodayBtn.disabled = idx === last;
  const cur = idx === last + 1 ? predictedCycle(days, cycles) : cycles[idx];
  prevCycleBtn.disabled = idx === 0;
  nextCycleBtn.disabled = idx === last + 1;
  nextCycleBtn.title = idx === last ? "Next cycle (predicted)" : "";
  const anyHormone = Object.keys(COLORS).some(n => polarShow[n]);
  chartTitle.textContent = cur.predicted ? "Next cycle (predicted)"
    : cur.current ? (anyHormone ? "Hormones this cycle" : "This cycle")
    : `${anyHormone ? "Hormones " : ""}${fmtRange(cur.start, cur.end)}`;

  const start = cur.start;
  const len = cur.len;
  const ovX = cur.ovIdx;
  const todayX = Math.round((toDate(todayStr()) - start) / DAY);

  const phaseNow = !cur.current || todayX >= len ? null
                 : todayX < ovX ? "follicular"
                 : todayX === ovX ? "ovulation"
                 : "luteal";

  const source = cur.predicted ? `estimated as ${cur.luteal} days before the period after it`
    : cur.fromDischarge
    ? (cur.tentative
        ? "from your discharge so far; it may move if you log more clear or stretchy days"
        : "from your last clear or stretchy discharge day")
    : cur.current
      ? `estimated as ${cur.luteal} days before the expected period`
      : `estimated as ${cur.luteal} days before the next period started`;

  const intro = cur.predicted
      ? `Next period expected ${fmt(cur.start)}, lasting about ${plural(cur.periodLen, "day")}; ` +
        `then a ${len}-day cycle if it matches your average. `
    : !cur.current ? `${len}-day cycle. `
    : phaseNow ? `Day ${todayX + 1} of an expected ${len}-day cycle: ${PHASES[phaseNow].label.toLowerCase()} phase. `
    : `Day ${todayX + 1}, past the expected ${len}-day length. `;

  chartNote.textContent = intro + `Ovulation: ${fmt(cur.ov)} (day ${ovX + 1}), ${source}.` +
    "";
  if (usesBirthControl()) {
    chartNote.textContent = "Hormonal birth control is on, so these are estimates for a combined pill (21 active " +
      "days, then 7 pill-free days around your logged bleed): FSH and LH stay suppressed with no LH surge or " +
      "ovulation, your own estradiol and progesterone stay low, and FSH and estradiol creep up in the pill-free " +
      "week. Other methods (a hormonal IUD, implant or progestin-only pill) can differ.";
    const inCycle = loadMissed().filter(d => d >= keyOf(cur.start) && d <= keyOf(addDays(cur.start, cur.len - 1))).length;
    if (inCycle) chartNote.textContent += ` You logged ${plural(inCycle, "missed pill")} in this cycle; ` +
      "the estimates don't account for missed pills.";
  }

  cycleKey.hidden = circle;
  if (circle) { canvas.parentElement.style.height = ""; return renderPolarSingle(cur, days); }
  renderCycleKey();

  const xs = [];
  for (let d = 0; d <= len; d += 0.25) xs.push(d); // fine steps so the LH spike shows

  const datasets = Object.keys(COLORS).map(name => ({
    label: HORMONE_NAMES[name],
    data: xs.map(d => ({ x: d, y: displayHormones(d, len, ovX)[name] })),
    hidden: !polarShow[name],
    borderColor: COLORS[name],
    backgroundColor: COLORS[name],   // fills the legend box; lines stay unfilled
    borderWidth: 2,
    pointRadius: 0,
  }));

  const narrow = narrowScreen();
  canvas.parentElement.style.height = narrow ? "270px" : "";
  chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    options: {
      animation: false,
      maintainAspectRatio: !narrow,      // phones: fill the 270px box instead of a wide shape
      aspectRatio: 2.4,
      scales: {
        x: {
          type: "linear", min: 0, max: len,
          title: { display: true, text: "Cycle day" },
          ticks: { stepSize: narrow ? 4 : 2, maxRotation: 0, callback: v => v + 1 }, // x=0 is cycle day 1
        },
        y: {
          min: 0, max: 1.05,
          title: { display: true, text: "Relative level" },
          ticks: { display: false },
        },
      },
      plugins: {
        todayLine: { x: cur.current && todayX <= len ? todayX : null },
        phaseBands: { ov: usesBirthControl() ? null : ovX, len },
        tooltip: { enabled: false },   // hovering a curve shows its description instead (axisHover)
        legend: { display: false },     // the key above the chart shows, hides and explains each hormone
      },
    },
    plugins: [phaseBands, todayLine, axisHover, alignArrows],
  });
}


// =============================================
// Circle view of the cycle
//
// One turn is one cycle, day 1 at the top, running clockwise. The ring shows the phases
// (period, follicular, ovulation day, luteal); the hormones you pick are drawn inside it,
// further from the centre = higher. Dots outside the ring are logged period and discharge
// days. With "3/6/12 cycles", each ring is one cycle (oldest in the middle) on a shared day
// scale, with dashed lines at the averages, like the sleep-patterns chart.
// =============================================
const polarCanvas   = document.getElementById("cyclePolar");
const polarOptions  = document.getElementById("polarOptions");
const cycleStats    = document.getElementById("cycleStats");

// Day colours for the circle view and cycle history
const DAY_COLORS = { follicular: "#c3e9df", ovulation: "#cbbff3", luteal: "#c9d6f2" };
const PERIOD_COLOR = "#f3c4cd", PERIOD_DOT = "#d9455f", PERIOD_START_DOT = "#8b1a2f";
const FERTILE_COLOR = "#b9a8ec", PREMENSTRUAL_COLOR = "#e2c3da";
const AVG_LINE = "#1aa6b7", AVG_TEXT = "#11717c";

// Remembered view choices (per browser; the app works without them)
const CYCLE_VIEW_KEY = "cycleViewPrefs";
const viewPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(CYCLE_VIEW_KEY) || "{}"); } catch { return {}; }
})();
let cycleMode = viewPrefs.mode === "circle" ? "circle" : "line";
let historyMode = viewPrefs.historyMode === "circle" ? "circle" : "bars";
let historyRange = [3, 6, 12].includes(viewPrefs.historyRange) ? viewPrefs.historyRange : 6;
function saveViewPrefs() {
  try {
    localStorage.setItem(CYCLE_VIEW_KEY, JSON.stringify({ mode: cycleMode, historyMode, historyRange }));
  } catch {}
}

// ---- Goals: what you said you're interested in decides what's shown ----
// Each goal turns on its sections; "Fine-tune what's shown" in Settings adjusts the details.
// polarShow holds every on/off choice (the name is historical: it now covers all charts).
const GOALS_KEY = "goals";
const DISPLAY_KEY = "displayPrefs";
const GOAL_DEFS = [
  { key: "period", label: "Predicting my period", levels: true,
    desc: { simple: "Average cycle and period length, and when your next period is due.",
            detailed: "Adds ovulation day, luteal phase, the premenstrual week, and how much each varies." } },
  { key: "fertility", label: "Predicting fertility",
    desc: { on: "The estimated fertile window and ovulation day, using discharge if you log it." } },
  { key: "hormones", label: "Understanding how hormones change across the menstrual cycle", levels: true,
    desc: { simple: "Estradiol and progesterone through your cycle.",
            detailed: "Adds follicle-stimulating hormone (FSH) and luteinizing hormone (LH)." } },
  { key: "sleep", label: "Tracking sleep", levels: true,
    desc: { simple: "Log bedtime and wake time, and see your sleep patterns.",
            detailed: "Adds estimated sleep stages and how substances affect them." } },
  { key: "circadian", label: "Understanding my circadian rhythms",
    sub: "Biological processes that cycle about every 24 hours", levels: true,
    desc: { simple: "Melatonin and cortisol across the day.",
            detailed: "Adds body temperature, sleep pressure, the alerting signal, light, meals, the eating window and exercise." } },
  { key: "mood", label: "Understanding changes in mood and energy", soon: true },
  { key: "anatomyMenstrual", label: "Learning about menstrual-related anatomy", soon: true },
  { key: "anatomyCircadian", label: "Learning about circadian-related anatomy", soon: true },
  { key: "health", label: "Tracking health issues", sub: "e.g. chronic congestion or back pain", soon: true },
];
const isOn = v => !!v && v !== "off";
const isDetailed = v => v === "detailed";

function goalsToShow(g) {
  const c = g.circadian;
  return {
    discharge: isOn(g.period) || !!g.fertility || isOn(g.hormones),
    avgOvulation: isDetailed(g.period) || !!g.fertility, avgLuteal: isDetailed(g.period),
    variation: isDetailed(g.period), premenstrual: isDetailed(g.period), fertile: !!g.fertility,
    estradiol: isOn(g.hormones), progesterone: isOn(g.hormones), FSH: isDetailed(g.hormones), LH: isDetailed(g.hormones),
    rMelatonin: isOn(c), rCortisol: isOn(c), rTemp: isDetailed(c), rAdenosine: isDetailed(c), rAlerting: isDetailed(c),
    rPressure: isDetailed(c), rPropensity: isDetailed(c), rLight: isDetailed(c), rMeals: isDetailed(c),
    rExercise: isDetailed(c), eatingWindow: isDetailed(c),
    rStages: isDetailed(g.sleep), adherence: false,
  };
}

const readJSON = key => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
const savedDisplay = readJSON(DISPLAY_KEY);
let goals = readJSON(GOALS_KEY);
const hasOldData = (() => {
  try {
    return !!savedDisplay || (readJSON("periodDays") || []).length > 0 ||
           Object.values(readJSON("rhythmLog") || {}).some(v => v && Object.keys(v).length);
  } catch { return false; }
})();
const MEDIUM_SHOW = goalsToShow({ period: "detailed", hormones: "simple", sleep: "simple", circadian: "detailed" });
const polarShow = { ...MEDIUM_SHOW, discharge: true, ...(savedDisplay?.show || {}) };
const firstVisit = !goals && !hasOldData;
if (!goals && hasOldData) {
  // Someone who used the tracker before goals existed: work out goals from what they had showing
  const p = polarShow;
  goals = {
    period: p.variation ? "detailed" : "simple", fertility: !!p.fertile,
    hormones: p.FSH || p.LH ? "detailed" : p.estradiol || p.progesterone ? "simple" : "off",
    sleep: p.rStages ? "detailed" : "simple",
    circadian: ["rTemp", "rAdenosine", "rAlerting", "rPressure", "rPropensity", "rLight", "rMeals", "rExercise"]
      .some(k => p[k]) ? "detailed" : "simple",
  };
  try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch {}
}
if (!goals) {   // first visit: nothing picked yet; the welcome asks
  goals = { period: "off", fertility: false, hormones: "off", sleep: "off", circadian: "off" };
  Object.assign(polarShow, goalsToShow(goals));
}

function saveDisplay() {
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify({ show: polarShow })); } catch {}
}

function syncDetailControls() {
  for (const box of document.querySelectorAll("input[data-show]")) box.checked = !!polarShow[box.dataset.show];
}

// Which whole sections show, from the goals (and discharge from its own switch)
function applySections() {
  const g = goals;
  const menstrual = isOn(g.period) || !!g.fertility || isOn(g.hormones);
  document.getElementById("menstrualSection").hidden = !menstrual;
  document.getElementById("cycleHistorySection").hidden = !(isOn(g.period) || g.fertility);
  const rhythmsOn = isOn(g.sleep) || isOn(g.circadian);
  document.getElementById("rhythms").hidden = !rhythmsOn;
  document.getElementById("aboutRhythms").hidden = !rhythmsOn;
  document.getElementById("rhythmChartArea").hidden = !(isOn(g.circadian) || polarShow.rStages);
  document.getElementById("rhythmTitle").textContent = isOn(g.circadian) ? "Daily rhythms" : "Sleep";
  document.getElementById("sleepPatternsSection").hidden = !isOn(g.sleep);
  document.body.classList.toggle("hide-discharge", !polarShow.discharge);
  const soon = GOAL_DEFS.filter(d => d.soon && g[d.key]);
  const box = document.getElementById("comingSoon");
  box.hidden = !soon.length;
  box.innerHTML = "";
  if (soon.length) {
    const head = document.createElement("strong");
    head.textContent = "Coming soon";
    const ul = document.createElement("ul");
    for (const d of soon) { const li = document.createElement("li"); li.textContent = d.label; ul.appendChild(li); }
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "You said you're interested in these. They'll appear here once they're built.";
    box.append(head, ul, note);
  }
}

let setupDraft = null;   // { goals, show, bc } while Settings is open, to undo on Cancel

function applyDisplay() {
  syncDetailControls();
  applySections();
  if (!setupDraft) saveDisplay();
  const days = load();
  renderChart(days);
  renderHistory(days);
  for (const k in rhythmHidden) delete rhythmHidden[k];   // the new choices win over legend clicks
  syncLogCards();
  renderRhythms();
}

for (const box of document.querySelectorAll("input[data-show]")) {
  box.addEventListener("change", () => { polarShow[box.dataset.show] = box.checked; applyDisplay(); });
}

// ---- Welcome / Settings dialog ----
const setupDialog = document.getElementById("setupDialog");
const goalList = document.getElementById("goalList");
const bcList = document.getElementById("bcList");
const goalError = document.getElementById("goalError");

for (const d of GOAL_DEFS) {
  const row = document.createElement("div");
  row.className = "goal-row";
  row.dataset.goal = d.key;
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  const text = document.createElement("span");
  text.textContent = d.label;
  if (d.sub) { const sub = document.createElement("span"); sub.className = "goal-sub"; sub.textContent = d.sub; text.appendChild(sub); }
  label.append(box, text);
  row.appendChild(label);
  let seg = null;
  if (d.levels) {
    seg = document.createElement("div");
    seg.className = "segmented";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", `${d.label}: detail`);
    for (const lv of ["simple", "detailed"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.level = lv;
      b.textContent = lv === "simple" ? "Simple" : "Detailed";
      b.addEventListener("click", () => { goals[d.key] = lv; goalsChanged(d.key); });
      seg.appendChild(b);
    }
    row.appendChild(seg);
  } else if (d.soon) {
    const tag = document.createElement("span");
    tag.className = "soon-tag";
    tag.textContent = "Coming soon";
    row.appendChild(tag);
  }
  const desc = document.createElement("p");
  desc.className = "goal-desc";
  row.appendChild(desc);
  box.addEventListener("change", () => {
    goals[d.key] = d.levels ? (box.checked ? (row.dataset.lastLevel || "simple") : "off") : box.checked;
    goalsChanged(d.key);
  });
  goalList.appendChild(row);
}
for (const [value, t] of Object.entries(BC_TYPES)) {
  const label = document.createElement("label");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "bcType";
  radio.value = value;
  const text = document.createElement("span");
  text.textContent = t.label;
  if (t.sub) { const sub = document.createElement("span"); sub.className = "goal-sub"; sub.textContent = t.sub; text.appendChild(sub); }
  label.append(radio, text);
  radio.addEventListener("change", () => { setBirthControlType(value); render(); });
  bcList.appendChild(label);
}

function syncSetup() {
  for (const d of GOAL_DEFS) {
    const row = goalList.querySelector(`[data-goal="${d.key}"]`);
    const v = goals[d.key], on = isOn(v);
    row.querySelector("input").checked = on;
    row.classList.toggle("checked", on);
    if (d.levels) {
      if (on) row.dataset.lastLevel = v;
      const seg = row.querySelector(".segmented");
      seg.hidden = !on;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.level === v));
    }
    row.querySelector(".goal-desc").textContent = !on || !d.desc ? "" : d.desc[d.levels ? v : "on"] ?? "";
  }
  const t = birthControlType();
  for (const r of bcList.querySelectorAll("input")) r.checked = r.value === t;
  syncDetailControls();
}

const hasMainGoal = () => GOAL_DEFS.some(d => !d.soon && isOn(goals[d.key]));

function goalsChanged(changed) {
  Object.assign(polarShow, goalsToShow(goals));
  // Choosing circadian rhythms starts the daily rhythms on the line plot, not the 24-hour clock
  if (changed === "circadian" && isOn(goals.circadian)) setRhythmMode("line");
  goalError.hidden = true;
  syncSetup();
  applyDisplay();
}

// ---- Install step (first visit in a browser) and the backup acknowledgement ----
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const devicePlatform = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    ? "ios" : /Android/i.test(navigator.userAgent) ? "android" : "desktop";
const offerInstall = () => location.protocol.startsWith("http") && !isStandalone();

function showSetupStep(step) {
  document.getElementById("installStep").hidden = step !== "install";
  document.getElementById("installThen").hidden = step !== "then";
  document.getElementById("goalsStep").hidden = step !== "goals";
  document.getElementById("setupIntro").hidden = step !== "goals";
  if (step === "install") {
    const mine = devicePlatform();
    for (const el of document.querySelectorAll(".install-howto")) el.hidden = el.dataset.platform !== mine;
    document.getElementById("installOther").hidden = false;
  }
  setupDialog.scrollTop = 0;
}
document.getElementById("installOther").addEventListener("click", e => {
  for (const el of document.querySelectorAll(".install-howto")) el.hidden = false;
  e.currentTarget.hidden = true;
});
document.getElementById("installDone").addEventListener("click", () => showSetupStep("then"));
document.getElementById("installBack").addEventListener("click", () => showSetupStep("install"));
for (const id of ["installSkip", "installSkip2"]) {
  document.getElementById(id).addEventListener("click", () => showSetupStep("goals"));
}

const backupAck = document.getElementById("backupAck");
const ackBox = document.getElementById("ackBox");
const ackGo = document.getElementById("ackGo");
ackBox.addEventListener("change", () => { ackGo.disabled = !ackBox.checked; });
document.getElementById("ackBack").addEventListener("click", () => backupAck.close());
ackGo.addEventListener("click", () => {
  if (!ackBox.checked) return;
  try { localStorage.setItem("backupAcknowledged", String(Date.now())); } catch {}
  backupAck.close();
  closeSetup(true);
  toast("You're all set. Settings (in the ☰ menu, top right) changes these any time.");
});

function openSetup(welcome) {
  setupDraft = { goals: { ...goals }, show: { ...polarShow }, bc: birthControlType() };
  setupDialog.classList.toggle("welcome", welcome);
  document.getElementById("setupTitle").textContent = welcome ? "Welcome to Biological Rhythms Tracker" : "Settings";
  document.getElementById("setupIntro").textContent = welcome
    ? "Which of the following are you interested in? You can change these later in Settings."
    : "What you're interested in decides what the tracker shows. Changes show behind this window as you make them.";
  document.getElementById("setupDone").textContent = welcome ? "Get started" : "Save";
  document.getElementById("fineTune").open = false;
  goalError.hidden = true;
  syncSetup();
  showSetupStep(welcome && offerInstall() ? "install" : "goals");
  setupDialog.showModal();
}

function closeSetup(keep) {
  if (!keep && setupDraft) {
    goals = setupDraft.goals;
    for (const k in polarShow) delete polarShow[k];
    Object.assign(polarShow, setupDraft.show);
    setBirthControlType(setupDraft.bc);
  }
  setupDraft = null;
  if (keep) {
    try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch {}
  }
  setupDialog.close();
  applyDisplay();
  render();
}

document.getElementById("setupForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!hasMainGoal()) { goalError.hidden = false; goalError.scrollIntoView({ block: "nearest" }); return; }
  if (setupDialog.classList.contains("welcome")) {   // first time: confirm they'll back up before starting
    ackBox.checked = false;
    ackGo.disabled = true;
    backupAck.showModal();
    return;
  }
  closeSetup(true);
  toast("Settings saved");
});
document.getElementById("setupCancel").addEventListener("click", () => closeSetup(false));
setupDialog.addEventListener("cancel", e => {
  e.preventDefault();                                     // Esc: the welcome needs an answer; Settings cancels
  if (!setupDialog.classList.contains("welcome")) closeSetup(false);
});
document.getElementById("settingsBtn").addEventListener("click", () => openSetup(false));

// ☰ menu (top right): Settings, Export and Import
const menuBtn = document.getElementById("menuBtn");
const appMenu = document.getElementById("appMenu");
function setMenu(open) {
  appMenu.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", () => setMenu(appMenu.hidden));
appMenu.addEventListener("click", e => { if (e.target.closest("button")) setMenu(false); });
document.addEventListener("pointerdown", e => { if (!appMenu.hidden && !e.target.closest(".menu-wrap")) setMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !appMenu.hidden) { setMenu(false); menuBtn.focus(); } });

// ---- Controls ----
function syncViewControls() {
  for (const b of document.querySelectorAll("#cycleView button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === cycleMode));
  }
  syncDetailControls();
  polarOptions.hidden = cycleMode !== "circle";
  const bc = usesBirthControl();
  for (const el of document.querySelectorAll(".key-natural")) el.hidden = bc;
  for (const el of document.querySelectorAll(".key-bc")) el.hidden = !bc;
}

for (const b of document.querySelectorAll("#cycleView button")) {
  b.addEventListener("click", () => { cycleMode = b.dataset.mode; saveViewPrefs(); renderChart(load()); });
}
// Each hormone chip gets a "?" for its explanation (hover on the chip still works with a mouse)
for (const chip of polarOptions.querySelectorAll(".chip[data-info]")) {
  const key = chip.dataset.info;
  chip.appendChild(helpButton(HORMONE_NAMES[key] ?? key, () => HORMONE_INFO[key] ?? PHASE_INFO[key] ?? ""));
}
for (const [cls, key] of [["key-follicular", "follicular"], ["key-luteal", "luteal"]]) {
  const el = document.querySelector(`.cycle-key .${cls}`);
  if (el) el.appendChild(helpButton(`the ${key} phase`, () => PHASE_INFO[key]));
}
for (const chip of polarOptions.querySelectorAll(".chip[data-info]")) {
  chip.addEventListener("mousemove", e => {
    const key = chip.dataset.info;
    showTip(HORMONE_INFO[key] ?? PHASE_INFO[key] ?? "", e, "chip", chip);
  });
  chip.addEventListener("mouseleave", () => { if (tipSource === "chip") hideTip(); });
}
polarCanvas.addEventListener("mouseleave", hideHoverTip);

// Scrolling sideways (trackpad, Shift + wheel) or swiping steps to the next/previous cycle
let swipeAccum = 0, swipeLock = 0;
polarCanvas.addEventListener("wheel", e => {
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
  if (!dx) return;
  e.preventDefault();
  if (Date.now() < swipeLock) return;
  swipeAccum += dx;
  if (Math.abs(swipeAccum) > 60) {
    stepCycle(swipeAccum > 0 ? 1 : -1);
    swipeAccum = 0;
    swipeLock = Date.now() + 500;   // one step per gesture
  }
}, { passive: false });
let swipeStart = null;
polarCanvas.addEventListener("pointerdown", e => { swipeStart = { x: e.clientX, y: e.clientY }; });
polarCanvas.addEventListener("pointerup", e => {
  if (!swipeStart) return;
  const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) stepCycle(dx < 0 ? 1 : -1);   // swipe left = next
});
polarCanvas.addEventListener("pointercancel", () => { swipeStart = null; });
let wasNarrow = narrowScreen();
window.addEventListener("resize", () => {
  const nowNarrow = narrowScreen(), crossed = nowNarrow !== wasNarrow;
  wasNarrow = nowNarrow;
  if (cycleMode === "circle" || crossed) renderChart(load());
  if (historyMode === "circle") renderHistory(load());
  if (crossed && rhythmMode !== "circle") renderRhythms();
});

// ---- Drawing helpers ----
function polarSetup(el = polarCanvas) {
  const box = el.parentElement;
  const size = Math.max(280, Math.min(box.clientWidth || 520, 540));
  const dpr = window.devicePixelRatio || 1;
  el.style.width = el.style.height = `${size}px`;
  el.width = el.height = Math.round(size * dpr);
  const ctx = el.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  return { ctx, size, cx: size / 2, cy: size / 2, R: size / 2 - 30, canvas: el };
}

// Day position (0 = start of cycle day 1) → angle; day 1 at the top, clockwise
// `top` is the day position drawn at 12 o'clock (today's, when today is in view)
const polarAngle = (pos, turn, top = 0) => -Math.PI / 2 + 2 * Math.PI * (pos - top) / turn;

function ringArc(ctx, g, r0, r1, a0, a1, fill) {
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, r1, a0, a1);
  ctx.arc(g.cx, g.cy, r0, a1, a0, true);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// Fills a ring day by day, merging runs of the same colour so there are no seams
function ringDays(ctx, g, r0, r1, n, A, style) {
  let from = 0;
  for (let i = 1; i <= n; i++) {
    const a = style(from), b = i < n ? style(i) : null;
    if (b && a.fill === b.fill && a.alpha === b.alpha) continue;
    ctx.globalAlpha = a.alpha;
    ringArc(ctx, g, r0, r1, A(from), A(i), a.fill);
    from = i;
  }
  ctx.globalAlpha = 1;
}

function radial(ctx, g, a, r0, r1) {
  ctx.beginPath();
  ctx.moveTo(g.cx + r0 * Math.cos(a), g.cy + r0 * Math.sin(a));
  ctx.lineTo(g.cx + r1 * Math.cos(a), g.cy + r1 * Math.sin(a));
  ctx.stroke();
}

function pill(ctx, text, x, y, stroke, color) {
  ctx.font = "11px sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255, 255, 255, 0.93)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2 - 6, y - 9, w + 12, 18, 9);
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = color || "#3d4556";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

// Cycle-day numbers around the edge
function dayLabels(ctx, g, turn, top = 0) {
  const every = turn > 36 || g.R < 170 ? 2 : 1;
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#5a6272";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < turn; i++) {
    if (i % every && i !== 0) continue;
    const a = polarAngle(i + 0.5, turn, top);
    ctx.fillText(String(i + 1), g.cx + (g.R + 15) * Math.cos(a), g.cy + (g.R + 15) * Math.sin(a));
  }
}

// Which day/radius the mouse is over
function polarHit(e, g, turn, top = 0) {
  const rect = g.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left - g.cx, y = e.clientY - rect.top - g.cy;
  const r = Math.hypot(x, y);
  let frac = (Math.atan2(y, x) + Math.PI / 2) / (2 * Math.PI);
  const pos = ((frac * turn + top) % turn + turn) % turn;
  return { r, day: Math.floor(pos), pos };
}

const polarDateLabel = d => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

// Logged period days and discharge entries inside a cycle, by day index
function cycleLogs(cycle, periodSet, discharge, upTo = cycle.len) {
  const out = [];
  for (let i = 0; i < upTo; i++) {
    const key = keyOf(addDays(cycle.start, i));
    out.push({ period: periodSet.has(key), discharge: discharge[key] || null });
  }
  return out;
}

const phaseOfDay = (i, c) => i < c.ovIdx ? "follicular" : i === c.ovIdx ? "ovulation" : "luteal";

// ---- One cycle ----
// Days are circles around a ring, shaded by phase with the day number inside; today sits at
// the top. Just inside the ring, a band marks the period (always), the fertile window and the
// premenstrual week (optional). Outside it, each hormone you pick is a shaded area that reaches
// further out the higher it is.
function renderPolarSingle(c, days) {
  const g = polarSetup(), { ctx, cx, cy } = g;
  const R = g.R + 18;                            // this view has no day labels outside, so use the room
  const len = c.len;
  const today = toDate(todayStr());
  const todayX = Math.round((today - c.start) / DAY);
  const showToday = c.current && todayX >= 0 && todayX < len;
  const top = showToday ? todayX + 0.5 : 0.5;    // the day drawn at 12 o'clock
  const logs = cycleLogs(c, new Set(days), loadDischarge());
  const onBC = usesBirthControl();
  const phaseName = i => onBC ? BC_PHASES[isPillFree(i, len) ? "pillfree" : "active"].label : PHASES[phaseOfDay(i, c)].label;
  if (c.predicted) for (let i = 0; i < Math.min(c.periodLen, len); i++) logs[i].period = true;
  const A = pos => polarAngle(pos, len, top);

  // Ring of day circles: big enough for a number, then as much room outside as possible
  const ringR = Math.max(0.56 * R, 8.5 * len / (Math.PI * 0.86));
  const bead = Math.min(15, Math.PI * ringR / len * 0.86);
  const bandR = ringR - bead - 7, bandW = 6;     // period / fertile / premenstrual band
  const dotR = bandR - 11;                       // logged discharge dots
  const base = ringR + bead + 5, outerR = R;     // hormone areas
  const small = R < 160;

  // Hormone areas (drawn first, so the day circles sit on top)
  const shown = Object.keys(COLORS).filter(n => polarShow[n]);
  ctx.strokeStyle = "#e6e9f0";
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    ctx.beginPath(); ctx.arc(cx, cy, base + f * (outerR - base), 0, 2 * Math.PI); ctx.stroke();
  }
  for (const name of shown) {
    ctx.beginPath();
    const pts = [];
    // Level on day x is drawn at the middle of that day's circle; covering positions 0..len
    // exactly means the shape meets itself (with a small step) where the cycle wraps around
    for (let x = -0.5; x <= len - 0.5 + 1e-9; x += 0.1) {
      const v = Math.max(0, Math.min(1.05, displayHormones(Math.max(0, x), len, c.ovIdx)[name]));
      pts.push([A(x + 0.5), base + (outerR - base) * v / 1.05]);
    }
    pts.forEach(([a, r], i) => {
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    for (let i = pts.length - 1; i >= 0; i--) {
      const a = pts[i][0];
      ctx.lineTo(cx + base * Math.cos(a), cy + base * Math.sin(a));
    }
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = COLORS[name];
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS[name];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([a, r], i) => {
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }

  // Today: a dashed line up from today's circle (at the top), labelled at the end
  if (showToday) {
    const a = A(todayX + 0.5);
    ctx.strokeStyle = "#1f2a44";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    radial(ctx, g, a, ringR + bead + 3, outerR - 10);
    ctx.setLineDash([]);
  }

  // Inner band: period (logged days), fertile window and premenstrual week (if chosen)
  const band = (from, to, color) => ringArc(ctx, g, bandR - bandW / 2, bandR + bandW / 2, A(from), A(to), color);
  ctx.strokeStyle = "#eef1f7";
  ctx.lineWidth = bandW;
  ctx.beginPath(); ctx.arc(cx, cy, bandR, 0, 2 * Math.PI); ctx.stroke();   // faint track
  if (polarShow.fertile && !onBC) band(Math.max(0, c.ovIdx - 5), c.ovIdx + 1, FERTILE_COLOR);
  if (polarShow.premenstrual) band(Math.max(c.ovIdx + 1, len - 7), len, PREMENSTRUAL_COLOR);
  for (let i = 0; i < len; i++) {
    if (!logs[i].period) continue;
    let j = i;
    while (j + 1 < len && logs[j + 1].period) j++;
    ctx.globalAlpha = c.predicted ? 0.5 : 1;
    band(i, j + 1, PERIOD_DOT);
    ctx.globalAlpha = 1;
    i = j;
  }

  // Logged discharge: colour = type, size = amount
  logs.forEach((l, i) => {
    if (!l.discharge || !DISCHARGE_TYPES[l.discharge.type]) return;
    const a = A(i + 0.5), size = (AMOUNTS[l.discharge.amount] || { size: 7 }).size / 2;
    ctx.fillStyle = DISCHARGE_TYPES[l.discharge.type].color;
    ctx.beginPath();
    ctx.arc(cx + dotR * Math.cos(a), cy + dotR * Math.sin(a), Math.min(size, 4.5), 0, 2 * Math.PI);
    ctx.fill();
  });

  // Day circles
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.max(8, Math.min(12, Math.round(bead * 0.95)))}px sans-serif`;
  for (let i = 0; i < len; i++) {
    const a = A(i + 0.5), x = cx + ringR * Math.cos(a), y = cy + ringR * Math.sin(a);
    const ph = onBC ? (isPillFree(i, len) ? "pillfree" : "active") : phaseOfDay(i, c);
    const future = c.predicted || (showToday && i > todayX);
    ctx.globalAlpha = future ? 0.5 : 1;
    ctx.fillStyle = onBC ? BC_PHASES[ph].color : DAY_COLORS[ph];
    ctx.beginPath(); ctx.arc(x, y, bead, 0, 2 * Math.PI); ctx.fill();
    if (ph === "ovulation") {
      ctx.strokeStyle = OVULATION_LINE; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = future ? 0.6 : 1;
    ctx.fillStyle = "#1f2a44";
    ctx.fillText(String(i + 1), x, y + 0.5);
    ctx.globalAlpha = 1;
    if (showToday && i === todayX) {
      ctx.strokeStyle = "#1f2a44"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, bead + 2.5, 0, 2 * Math.PI); ctx.stroke();
    }
  }

  if (showToday) {
    const a = A(todayX + 0.5), md = today.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    pill(ctx, `Today · ${md}`, cx + (outerR - 2) * Math.cos(a), cy + (outerR - 2) * Math.sin(a), "#1f2a44", "#1f2a44");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
  }

  // Centre text
  ctx.fillStyle = "#1f2a44";
  ctx.font = small ? "bold 15px sans-serif" : "bold 20px sans-serif";
  const dy = small ? 0.7 : 1;
  if (c.predicted) {
    const md = c.start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    ctx.fillText("Next period", cx, cy - 14 * dy);
    ctx.font = small ? "10px sans-serif" : "12px sans-serif";
    ctx.fillStyle = "#5a6272";
    ctx.fillText(`expected ${md}`, cx, cy + 6 * dy);
    ctx.fillText(`~${len}-day cycle (predicted)`, cx, cy + 22 * dy);
  } else if (c.current && todayX >= 0) {
    const phaseNow = showToday ? phaseOfDay(todayX, c) : null;
    ctx.fillText(`Day ${todayX + 1}`, cx, cy - 16 * dy);
    ctx.font = small ? "10px sans-serif" : "12px sans-serif";
    ctx.fillStyle = "#5a6272";
    ctx.fillText(todayX < len ? `of ~${len}` : `past ~${len}`, cx, cy + 4 * dy);
    if (phaseNow) ctx.fillText(phaseName(todayX).replace(" (est.)", ""), cx, cy + 20 * dy);
  } else {
    ctx.fillText(`${len} days`, cx, cy - 8);
    ctx.font = small ? "10px sans-serif" : "12px sans-serif";
    ctx.fillStyle = "#5a6272";
    const md = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    ctx.fillText(small ? `${md(c.start)} – ${md(c.end)}` : fmtRange(c.start, c.end), cx, cy + 12);
  }

  // Hover: the day, its date and phase, anything logged, and the hormones shown
  polarCanvas.onmousemove = e => {
    const hit = polarHit(e, g, len, top);
    if (hit.r > outerR + 4 || hit.r < dotR - 8) { if (tipSource === "polar") hideTip(); return; }
    const i = hit.day, l = logs[i];
    // Over the hormone areas: the hormone whose shaded area the pointer is in (the innermost edge above it)
    if (hit.r >= base - 2 && shown.length) {
      let x = hit.pos - 0.5;
      if (x < 0) x += len;
      const lv = hormones(x, len, c.ovIdx);
      const edge = n => base + (outerR - base) * Math.max(0, Math.min(1.05, lv[n])) / 1.05;
      const over = shown.filter(n => edge(n) >= hit.r - 3).sort((a, b) => edge(a) - edge(b))[0];
      if (over) {
        return showTip(`${HORMONE_NAMES[over]} · cycle day ${i + 1} (${polarDateLabel(addDays(c.start, i))}): ` +
                       `${lv[over].toFixed(2)} (relative)\n\n${HORMONE_INFO[over]}`, e, "polar", polarCanvas);
      }
    }
    const lines = [`Cycle day ${i + 1} · ${polarDateLabel(addDays(c.start, i))}`];
    lines.push(phaseName(i) + (c.predicted || (showToday && i > todayX) ? " (predicted)" : "") +
               (showToday && i === todayX ? " · today" : ""));
    if (l.period) lines.push(c.predicted ? "Expected period (from your average length)"
                                         : "Period (menstruation, part of the follicular phase)" +
                                           (FLOWS[loadFlow()[keyOf(addDays(c.start, i))]]
                                             ? `, ${FLOWS[loadFlow()[keyOf(addDays(c.start, i))]].label.toLowerCase()} flow` : ""));
    if (takesPill() && loadMissed().includes(keyOf(addDays(c.start, i)))) lines.push("Missed pill");
    if (polarShow.fertile && !onBC && i >= c.ovIdx - 5 && i <= c.ovIdx) lines.push("In the estimated fertile window");
    if (polarShow.premenstrual && i >= len - 7 && i > c.ovIdx) lines.push("Premenstrual week");
    if (l.discharge && DISCHARGE_TYPES[l.discharge.type]) {
      const amt = AMOUNTS[l.discharge.amount];
      lines.push(`Discharge: ${DISCHARGE_TYPES[l.discharge.type].label}${amt ? `, ${amt.label.toLowerCase()}` : ""}`);
    }
    if (shown.length) {
      const lv = displayHormones(i, len, c.ovIdx);
      for (const n of shown) lines.push(`${HORMONE_NAMES[n]}: ${lv[n].toFixed(2)} (relative)`);
    }
    showTip(lines.join("\n"), e, "polar", polarCanvas);
  };
  polarCanvas.onclick = null;
  polarCanvas.style.cursor = "";
}

// ---- Cycle history: finished cycles only, as rings or as bars ----
const historyPolar   = document.getElementById("historyPolar");
const historyBarsBox = document.getElementById("historyBarsBox");
const historyBars    = document.getElementById("historyBars");
const historyNote    = document.getElementById("historyNote");
const historyKey     = document.getElementById("historyKey");
let historyChart = null;


function syncHistoryControls() {
  for (const b of document.querySelectorAll("#historyView button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === historyMode));
  }
  for (const b of document.querySelectorAll("#historyRange button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.range) === historyRange));
  }
}
for (const b of document.querySelectorAll("#historyView button")) {
  b.addEventListener("click", () => { historyMode = b.dataset.mode; saveViewPrefs(); renderHistory(load()); });
}
for (const b of document.querySelectorAll("#historyRange button")) {
  b.addEventListener("click", () => { historyRange = Number(b.dataset.range); saveViewPrefs(); renderHistory(load()); });
}
historyPolar.addEventListener("mouseleave", hideHoverTip);

// Open one past cycle in the main chart at the top of the page
function openCycle(index) {
  hideTip();
  viewCycle = index;
  renderChart(load());
  chartTitle.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Days of the period run that starts each cycle (logged days from day 1 on)
function periodSpan(c, periodSet) {
  let n = 0;
  while (n < c.len && periodSet.has(keyOf(addDays(c.start, n)))) n++;
  return n;
}

function renderHistory(days) {
  if (historyChart) { historyChart.destroy(); historyChart = null; }
  syncHistoryControls();
  const all = cyclePhases(days);
  const done = all.map((c, index) => ({ ...c, index })).filter(c => !c.current);
  historyPolar.style.display = historyBarsBox.style.display = "none";
  renderAverages(done.slice(-historyRange), days);
  if (!done.length) {
    historyKey.hidden = true;
    historyNote.textContent = "Cycle history appears once you have a finished cycle " +
      "(log the first day of your next period).";
    return;
  }
  historyKey.hidden = false;
  const shown = done.slice(-historyRange);
  const n = shown.length;
  const periodSet = new Set(days);
  const avgOv = mean(shown.map(c => c.ovIdx));
  const avgLen = mean(shown.map(c => c.len));

  historyNote.textContent = (n < historyRange ? `Your ${plural(n, "finished cycle")}` : `Your last ${n} finished cycles`) +
    (historyMode === "circle"
      ? ", one ring each, oldest in the middle, all on the same day scale with day 1 at the top. "
      : ", one bar each, from day 1 at the top to the last day at the bottom. ") +
    "Dashed lines mark the averages. Hover for details; click a cycle to open it in the chart above.";

  if (historyMode === "circle") historyCircle(shown, periodSet, avgOv, avgLen);
  else historyBarChart(shown, periodSet, avgOv, avgLen);

}

// Averages panel beside Cycle history, one colour per kind. What it shows follows the detail
// level: cycle and period length always; ovulation day and luteal phase from Medium; how much
// each varies only in Detailed.
const AVG_KINDS = {
  length:    { label: "Cycle length",  cls: "avg-length" },
  period:    { label: "Period length", cls: "avg-period" },
  ovulation: { label: "Ovulation day", cls: "avg-ovulation" },
  luteal:    { label: "Luteal phase",  cls: "avg-luteal" },
};

function renderAverages(shown, days) {
  cycleStats.innerHTML = "";
  const head = document.createElement("h3");
  head.className = "avg-title";
  head.textContent = shown.length ? `Averages · last ${plural(shown.length, "cycle")}` : "Averages";
  cycleStats.appendChild(head);

  const tile = (kind, value, sub) => {
    const t = document.createElement("div");
    t.className = `stat ${AVG_KINDS[kind].cls}`;
    for (const [cls, text] of [["label", AVG_KINDS[kind].label], ["value", value], ["sub", sub]]) {
      if (!text) continue;
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      t.appendChild(el);
    }
    cycleStats.appendChild(t);
  };
  const showVar = !!polarShow.variation;
  const spread = xs => !showVar ? "" : xs.length > 1 ? `varies ±${stdev(xs).toFixed(1)} days` : "need 2+ cycles to show variation";
  const periodSet = new Set(days);

  if (!shown.length) {
    const dur = averageDuration(days);
    tile("length", "28 days", "typical value until you finish a cycle");
    tile("period", plural(dur.days, "day"), dur.count ? plural(dur.count, "period") : "typical value until a period ends");
    return;
  }

  const lens = shown.map(c => c.len);
  tile("length", `${mean(lens).toFixed(1)} days`, spread(lens));
  const periods = shown.map(c => periodSpan(c, periodSet)).filter(x => x > 0);
  if (periods.length) tile("period", `${mean(periods).toFixed(1)} days`, spread(periods));
  if (polarShow.avgOvulation) {
    const ovs = shown.map(c => c.ovIdx + 1);
    const fromD = shown.filter(c => c.fromDischarge).length;
    tile("ovulation", `day ${mean(ovs).toFixed(1)}`,
         [spread(ovs), showVar ? `${fromD} of ${shown.length} from discharge` : ""].filter(Boolean).join(" · "));
  }
  if (polarShow.avgLuteal) {
    const lut = shown.map(c => c.len - c.ovIdx);
    tile("luteal", `${mean(lut).toFixed(1)} days`, spread(lut));
  }
}

const cycleSummaryLines = (c, p) => [
  `${fmtRange(c.start, c.end)} · ${c.len} days`,
  p ? `Period: days 1–${p}` : "Period: not logged",
  `Follicular: days 1–${c.ovIdx}`,
  `Ovulation: day ${c.ovIdx + 1} (${c.fromDischarge ? "from discharge" : "estimated"})`,
  `Luteal: days ${c.ovIdx + 2}–${c.len} (${c.len - c.ovIdx - 1} days)`,
];

// Rings, oldest in the middle; day 1 at the top
function historyCircle(shown, periodSet, avgOv, avgLen) {
  historyPolar.style.display = "block";
  const n = shown.length;
  const turn = Math.max(...shown.map(c => c.len));
  const g = polarSetup(historyPolar), { ctx, cx, cy, R } = g;
  const inner = 0.24 * R, outer = 0.8 * R;   // leaves room for the average labels
  const step = (outer - inner) / n, gap = Math.min(3, step * 0.15);
  const A = pos => polarAngle(pos, turn);
  const rings = [];

  shown.forEach((c, j) => {
    const r0 = inner + j * step + gap / 2, r1 = inner + (j + 1) * step - gap / 2;
    rings.push({ r0, r1, c });
    ringDays(ctx, g, r0, r1, c.len, A, i => ({ fill: DAY_COLORS[phaseOfDay(i, c)], alpha: 1 }));
    // Period: a red strip along the ring's inner edge (it's the start of the follicular phase)
    const p = periodSpan(c, periodSet);
    if (p) ringArc(ctx, g, r0, r0 + Math.max(2, Math.min(4, (r1 - r0) * 0.3)), A(0), A(p), PERIOD_DOT);
  });

  ctx.strokeStyle = AVG_LINE;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  if (polarShow.avgOvulation) radial(ctx, g, A(avgOv + 0.5), inner - 6, outer + 4);
  if (avgLen < turn - 0.2) radial(ctx, g, A(avgLen), inner - 6, outer + 4);
  ctx.setLineDash([]);
  dayLabels(ctx, g, turn);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1f2a44";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(plural(n, "cycle"), cx, cy - 7);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#5a6272";
  ctx.fillText("oldest inside", cx, cy + 10);

  const avgLabels = [[`avg length ${Math.round(avgLen)} days`, Math.min(avgLen, turn - 0.01)]];
  if (polarShow.avgOvulation) avgLabels.push([`avg ovulation day ${Math.round(avgOv) + 1}`, avgOv + 0.5]);
  for (const [text, pos] of avgLabels) {
    const a = A(pos), r = 0.9 * R;
    pill(ctx, text, cx + r * Math.cos(a), cy + r * Math.sin(a), AVG_LINE, AVG_TEXT);
  }

  const ringAt = e => {
    const hit = polarHit(e, g, turn);
    const ring = rings.find(x => hit.r >= x.r0 - gap / 2 && hit.r <= x.r1 + gap / 2);
    return ring && hit.day < ring.c.len ? { ring, day: hit.day } : null;
  };
  historyPolar.onmousemove = e => {
    const h = ringAt(e);
    if (!h) { historyPolar.style.cursor = ""; if (tipSource === "polar") hideTip(); return; }
    const c = h.ring.c;
    const lines = cycleSummaryLines(c, periodSpan(c, periodSet));
    lines.push(`Day ${h.day + 1}: ${polarDateLabel(addDays(c.start, h.day))}`, "Click to open this cycle");
    showTip(lines.join("\n"), e, "polar", historyPolar);
    historyPolar.style.cursor = "pointer";
  };
  historyPolar.onclick = e => { const h = ringAt(e); if (h) openCycle(h.ring.c.index); };
}

// One bar per cycle, like the sleep-patterns chart: day 1 at the top. Each phase is a rounded
// segment with a white edge, ovulation is a violet dot, and the period a red strip.
function historyBarChart(shown, periodSet, avgOv, avgLen) {
  historyBarsBox.style.display = "block";
  const maxLen = Math.max(...shown.map(c => c.len));
  const md = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const periods = shown.map(c => periodSpan(c, periodSet));
  const seg = (label, data, color, extra = {}) => ({
    type: "bar", label, data, backgroundColor: color, borderColor: "#fff", borderWidth: 2,
    borderRadius: 12, borderSkipped: false, grouped: false, barPercentage: 0.55, categoryPercentage: 0.9,
    order: 2, ...extra,
  });

  historyChart = new Chart(historyBars, {
    type: "bar",
    data: {
      labels: shown.map(c => [md(c.start), `${c.len} days`]),
      datasets: [
        seg("Follicular", shown.map(c => [0, c.ovIdx + 0.5]), DAY_COLORS.follicular),
        seg("Luteal", shown.map(c => [c.ovIdx + 0.5, c.len]), DAY_COLORS.luteal),
        // order: lower draws on top
        seg("Period", periods.map(p => p ? [0.4, p - 0.4] : null), PERIOD_DOT,
            { barPercentage: 0.1, borderWidth: 0, borderRadius: 4, order: 1 }),
        { type: "line", label: "Ovulation", data: shown.map(c => c.ovIdx + 0.5), showLine: false,
          pointRadius: 7, pointHoverRadius: 8, pointBackgroundColor: DAY_COLORS.ovulation,
          pointBorderColor: OVULATION_LINE, pointBorderWidth: 2, order: 0 },
      ],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          reverse: true, min: 0, max: maxLen + 1,
          title: { display: true, text: "Cycle day" },
          grid: { color: "#eef1f7" },
          border: { display: false },
          ticks: { stepSize: 7, callback: v => v % 7 === 0 ? `day ${v + 1}` : "" },   // weekly marks only
        },
        x: { grid: { display: false }, border: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => cycleSummaryLines(shown[items[0].dataIndex], 0)[0],
            label: () => null,
            afterBody: items => {
              const i = items[0].dataIndex;
              return cycleSummaryLines(shown[i], periods[i]).slice(1).concat("Click to open this cycle");
            },
          },
        },
        patternMarks: {
          lines: [
            ...(polarShow.avgOvulation ? [{ at: avgOv + 0.5, label: `avg ovulation day ${Math.round(avgOv) + 1}` }] : []),
            { at: avgLen, label: `avg length ${Math.round(avgLen)} days` },
          ],
          showDurations: false,
        },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const index = shown[elements[0].index].index;
        setTimeout(() => openCycle(index));   // after Chart.js finishes handling this click
      },
      onHover: (e, elements) => { historyBars.style.cursor = elements.length ? "pointer" : ""; },
    },
    plugins: [patternMarks],
  });
}

// =============================================
// Daily rhythms: sleep, meals, exercise, and the two-process model
// =============================================
//
// PLACEHOLDER MODELS (to be replaced with your fitted curves):
// - Sleep pressure = Process S of the two-process model. Rises toward 1 while awake and
//   decays toward 0 while asleep, with the classic time constants (about 18.2 h rising,
//   4.2 h falling). This tracks sleepiness and deep-sleep (slow-wave) need.
// - Adenosine, following Reichert et al. (2022): it changes within minutes, not hours,
//   so it's roughly a square wave, high while awake and low while asleep (p. 4). It rises
//   further when waking is prolonged beyond the normal daily duration (p. 4, p. 13).
//   Levels and the ~16 h threshold are placeholders.
// - Body clock: tracked as the time of the melatonin peak, simulated day by day. Each day
//   it moves partway toward that night's logged sleep, and logged light, melatonin, and
//   caffeine nudge it earlier or later depending on their timing. Melatonin is driven by
//   the clock (SCN), not by sleep itself (Doghramji 2007, p. S18), so one odd night barely
//   moves it. Shift sizes and rates are placeholders.
// - Melatonin: rises in the evening, peaks mid-sleep, and falls gradually in the second
//   half of the night (Doghramji p. S18). Light suppresses it while you're exposed.
//   A melatonin dose adds a short spike.
// - Alerting signal = Process C: the clock's wake-promoting drive. Rises through the day,
//   peaks ~2.5 h before usual bedtime, and falls at night as melatonin rises (Doghramji
//   p. S17–S18, Fig. 1).
// - Meals and exercise are logged and drawn on the chart but don't shift the curves yet.

// Storage: { sleep: { wakeDate: { bed, wake } }, meals: { date: [{ time, size }] },
//            exercise: { date: [{ time, minutes, intensity }] },
//            substances: { date: [{ time, type, amount, name? }] },
//            light: { date: [{ time, minutes, kind }] },
//            wakings: { wakeDate: [{ time, minutes }] } }   times are "HH:MM"
//   (wakings are awakenings during the night that ends on wakeDate)
const RKEY = "rhythmLog";
const loadRhythms = () => {
  const r = JSON.parse(localStorage.getItem(RKEY) || "{}");
  return { sleep: r.sleep || {}, meals: r.meals || {}, exercise: r.exercise || {},
           substances: r.substances || {}, light: r.light || {}, wakings: r.wakings || {} };
};

// Light: weight scales how strongly it shifts the clock; suppress is how much it
// lowers melatonin while you're exposed (placeholders)
const LIGHT_TYPES = {
  bright: { label: "Bright (outdoors / light box)", short: "bright", weight: 1,    suppress: 0.7 },
  indoor: { label: "Indoor light",                  short: "indoor", weight: 0.3,  suppress: 0.3 },
  screen: { label: "Screens",                       short: "screens", weight: 0.15, suppress: 0.15 },
};

// Substances: unit is shown with the amount; "other" has a written-in name and free-text amount
const SUBSTANCES = {
  alcohol:    { label: "Alcohol",    unit: "standard drinks", short: "drinks", step: 0.5 },
  caffeine:   { label: "Caffeine",   unit: "mg",              short: "mg",     step: 1 },
  marijuana:  { label: "Marijuana",  unit: "mg THC",          short: "mg THC", step: 1 },
  melatonin:  { label: "Melatonin",  unit: "mg",              short: "mg",     step: 0.5 },
  sertraline: { label: "Sertraline", unit: "mg",              short: "mg",     step: "any" },
  other:      { label: "Other",      unit: "mg",              short: "mg",     step: "any" },
};
const describeSubstance = (s, short = false) => {
  const def = SUBSTANCES[s.type];
  const name = s.type === "other" ? s.name : def.label;
  if (s.amount === "" || s.amount == null) return name;
  // Older "other" entries stored free text like "200 mg"; show those as written
  const numeric = typeof s.amount === "number" || /^\d+(\.\d+)?$/.test(s.amount);
  return numeric ? `${name} ${s.amount} ${short ? def.short : def.unit}` : `${name} ${s.amount}`;
};
const saveRhythms = r => localStorage.setItem(RKEY, JSON.stringify(r));

const DEFAULT_SLEEP = { bed: "23:00", wake: "07:00" };
const TAU_WAKE = 18.2, TAU_SLEEP = 4.2;   // hours
const MEAL_SIZES = { snack: "Snack", meal: "Meal", large: "Large meal" };
const INTENSITIES = { light: "light", moderate: "moderate", vigorous: "vigorous" };
const RHYTHM_COLORS = { melatonin: "#3b3f9e", alerting: "#b5398f", pressure: "#1aa6b7",
                        adenosine: "#2f8f4e", propensity: "#8a94a6", temperature: "#d1693a",
                        cortisol: "#b8932a" };

// Body clock (placeholder values)
const CLOCK = {
  spinupDays: 21,        // simulate this many days before the first one shown, so it settles
  defaultMid: 3,         // melatonin peak with no logs: 3 AM (middle of 11 PM – 7 AM)
  defaultDur: 8,         // usual hours of sleep with no logs
  followSleep: 0.5,      // fraction of the gap to a night's logged sleep closed per day
  sleepMaxLater: 1,      // ...but at most 1 h later
  sleepMaxEarlier: 0.5,  // ...or 30 min earlier per day (advancing is harder)
  totalMaxLater: 1.5,    // cap on the whole day's shift, all cues together
  totalMaxEarlier: 1,
  lightGain: 0.5,        // h later per hour of bright light at the most sensitive time before the low
                         // point (1 h of light at night delayed ~36 min: Tähkämö et al. 2019, p. 164)
  lightAdvanceGain: 0.25,// h earlier per hour after it: morning light alone shifts less in daily life
                         // (Tähkämö p. 162–163, 165)
  pullUsual: 0.25,       // unlogged nights: fraction of the gap to your usual mid-sleep closed per day
  usualDays: 14,         // "usual" = average logged mid-sleep over this many days before
  lightMaxHours: 2,      // longer exposures count as 2 h
  lightWidth: 3.5,       // light shifts most ~3.5 h either side of the early-morning low point
  melGain: 0.5,          // h shift for a ~3 mg dose at its most effective time
  melWidth: 7,           // melatonin shifts most ~7 h either side (evening: earlier; morning: later)
  caffeineDelay: 2 / 3,  // h later per 200 mg in the 6 h before usual bedtime (Reichert et al., p. 2)
};
const ALERT_LOW = 0.1, ALERT_HIGH = 0.9;

// Adenosine (placeholder values)
const ADENOSINE_TAU = 10 / 60;               // hours: responds within ~10 minutes
const ADENOSINE_WAKE = 0.55;                 // level during a normal day awake
const ADENOSINE_SLEEP = 0.15;                // level during sleep
const NORMAL_WAKE_HOURS = 16;                // beyond this, adenosine climbs further...
const EXTENDED_WAKE_RISE = 0.35;             // ...by up to this much, reached 8 h later

const toHours = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h + m / 60; };

// 7.5 -> "7:30 AM"; 24 -> "12:00 AM"
const clockLabel = (h, withMinutes = true) => {
  const total = Math.round((((h % 24) + 24) % 24) * 60);
  const d = new Date(2000, 0, 1, Math.floor(total / 60), total % 60);
  return d.toLocaleTimeString(undefined, withMinutes
    ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
};

// A night's sleep in hours relative to midnight at the start of the wake date.
// Bedtime at or after the wake time means the previous evening.
function sleepTimes(entry) {
  const wake = toHours(entry.wake);
  let bed = toHours(entry.bed);
  if (bed >= wake) bed -= 24;
  return { bed, wake };
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const wrap12 = x => ((x + 12) % 24 + 24) % 24 - 12;   // hours, folded into -12 ... +12

// How strongly a cue shifts the clock, by its timing: x is hours after the clock's
// early-morning low point (negative = before). Zero far away, strongest `w` hours either side.
const shiftShape = (x, w) => (x / w) * Math.exp(0.5 - (x * x) / (2 * w * w));

// Usual sleep length: average of logged nights in the 7 days ending on `date`
function usualDuration(date, log) {
  const lengths = [];
  for (let k = -6; k <= 0; k++) {
    const e = log.sleep[keyOf(addDays(date, k))];
    if (e) { const t = sleepTimes(e); lengths.push(t.wake - t.bed); }
  }
  return lengths.length ? mean(lengths) : CLOCK.defaultDur;
}

// The body clock for wake dates day+fromK ... day+toK. Each state is the night ending on
// that date: { mid (melatonin peak), dur, bed, wake }, in hours relative to that date's
// midnight. Cues logged during a date (that night's sleep, light, melatonin, caffeine)
// shift the clock for the following night.
function clockStates(day, log, fromK, toK) {
  const start = fromK - CLOCK.spinupDays;
  // Start from the average logged mid-sleep near the beginning, if any, so it settles quickly
  const seed = [];
  for (let k = start; k < start + 14; k++) {
    const e = log.sleep[keyOf(addDays(day, k))];
    if (e) { const t = sleepTimes(e); seed.push((t.bed + t.wake) / 2); }
  }
  let mid = seed.length ? mean(seed) : CLOCK.defaultMid;

  const states = {};
  for (let k = start; k <= toK; k++) {
    const key = keyOf(addDays(day, k));
    const dur = usualDuration(addDays(day, k), log);
    if (k >= fromK) states[k] = { mid, dur, bed: mid - dur / 2, wake: mid + dur / 2 };

    const lowPoint = mid + dur / 2 - 2;        // ~2 h before usual wake: most light-sensitive
    const tonightBed = 24 + mid - dur / 2;     // usual bedtime this evening
    let shift = 0;

    // Move partway toward this night's logged sleep, or, if it isn't logged, gently back
    // toward your usual timing (stands in for the daily cues that keep a real clock entrained)
    const e = log.sleep[key];
    let gap = null;
    if (e) {
      const t = sleepTimes(e);
      gap = wrap12((t.bed + t.wake) / 2 - mid) * CLOCK.followSleep;
    } else {
      const recent = [];
      for (let j = k - CLOCK.usualDays; j < k; j++) {
        const r = log.sleep[keyOf(addDays(day, j))];
        if (r) { const t = sleepTimes(r); recent.push((t.bed + t.wake) / 2); }
      }
      const usualMid = recent.length ? mean(recent) : CLOCK.defaultMid;
      gap = wrap12(usualMid - mid) * CLOCK.pullUsual;
    }
    shift += Math.max(-CLOCK.sleepMaxEarlier, Math.min(CLOCK.sleepMaxLater, gap));
    // Light before the low point moves the clock later; after it, earlier
    for (const L of log.light[key] || []) {
      const x = wrap12(toHours(L.time) + L.minutes / 120 - lowPoint);   // middle of the exposure
      const dose = Math.min(L.minutes / 60, CLOCK.lightMaxHours) * LIGHT_TYPES[L.kind].weight;
      const sh = shiftShape(x, CLOCK.lightWidth);         // negative before the low point → later
      shift -= (sh < 0 ? CLOCK.lightGain : CLOCK.lightAdvanceGain) * dose * sh;
    }
    for (const sub of log.substances[key] || []) {
      if (!(sub.amount > 0)) continue;
      const t = toHours(sub.time);
      if (sub.type === "melatonin") {
        // Roughly opposite to light: evening doses move the clock earlier, morning doses later
        const x = wrap12(t - lowPoint);
        shift += CLOCK.melGain * Math.min(1, Math.sqrt(sub.amount / 3)) * shiftShape(x, CLOCK.melWidth);
      } else if (sub.type === "caffeine") {
        const before = tonightBed - t;
        if (before >= 0 && before <= 6) shift += Math.min(1, CLOCK.caffeineDelay * sub.amount / 200);
      }
    }
    mid += Math.max(-CLOCK.totalMaxEarlier, Math.min(CLOCK.totalMaxLater, shift));
  }
  return states;
}

// Sleep episodes for the nights whose wake dates are day+fromK ... day+toK, in hours
// relative to `day`'s midnight. Unlogged nights use the usual sleep from the body clock.
function sleepEpisodes(day, log, states, fromK, toK) {
  const eps = [];
  for (let k = fromK; k <= toK; k++) {
    const e = log.sleep[keyOf(addDays(day, k))];
    const t = e ? sleepTimes(e) : states[k];
    eps.push({ start: 24 * k + t.bed, end: 24 * k + t.wake, logged: !!e });
  }
  return eps;
}

// Process S at each of `hours` (sorted), simulated from 2 days before the first one
// so it has settled by the time it's drawn
function sleepPressureAt(hours, episodes) {
  const step = 0.1;
  const asleep = t => episodes.some(e => t >= e.start && t < e.end);
  const out = [];
  let S = 0.5, t = hours[0] - 48, i = 0;
  while (i < hours.length) {
    if (t >= hours[i] - 1e-9) { out.push(S); i++; continue; }
    S = asleep(t) ? S * Math.exp(-step / TAU_SLEEP) : 1 - (1 - S) * Math.exp(-step / TAU_WAKE);
    t += step;
  }
  return out;
}

// Adenosine at each of `hours` (sorted): moves quickly toward a low level while asleep and
// a higher one while awake, and climbs further the longer you stay awake past ~16 h
function adenosineLevelAt(hours, episodes) {
  const step = 0.05;                                  // 3-minute steps
  const asleep = t => episodes.some(e => t >= e.start && t < e.end);
  const out = [];
  let t = hours[0] - 48, i = 0;
  let A = ADENOSINE_WAKE, awakeSince = t, wasAsleep = false;
  while (i < hours.length) {
    if (t >= hours[i] - 1e-9) { out.push(A); i++; continue; }
    const sleeping = asleep(t);
    if (wasAsleep && !sleeping) awakeSince = t;       // just woke up
    wasAsleep = sleeping;
    let target = ADENOSINE_SLEEP;
    if (!sleeping) {
      const extra = Math.min(1, Math.max(0, (t - awakeSince - NORMAL_WAKE_HOURS) / 8));
      target = ADENOSINE_WAKE + EXTENDED_WAKE_RISE * extra;
    }
    A += (target - A) * (1 - Math.exp(-step / ADENOSINE_TAU));
    t += step;
  }
  return out;
}

// A melatonin dose over time (hours since taking it), peak = 1: absorbed with a ~15 min
// half-time and cleared with a ~45 min half-life. (Doghramji p. S19 cites 0.5–5.6 min;
// most sources put oral melatonin nearer 20–60 min.)
const DOSE_KA = Math.LN2 / 0.25, DOSE_KE = Math.LN2 / 0.75;
const DOSE_TMAX = Math.log(DOSE_KA / DOSE_KE) / (DOSE_KA - DOSE_KE);
const DOSE_PEAK = Math.exp(-DOSE_KE * DOSE_TMAX) - Math.exp(-DOSE_KA * DOSE_TMAX);
const doseCurve = t => t <= 0 ? 0 : (Math.exp(-DOSE_KE * t) - Math.exp(-DOSE_KA * t)) / DOSE_PEAK;

// Melatonin at hour h. `nights`: { mid, bed, wake } from the body clock, in hours relative
// to the same midnight as h. `light`: exposures { start, end, suppress }. `doses`: { at, amp }.
const LIGHT_HALF_LIFE = 10 / 60; // h: melatonin falls within ~30 min of light and recovers within
                                 // ~15–30 min after it ends (Thapan, in Tähkämö et al. 2019, p. 161, 165)
function melatoninAt(h, nights, light, doses) {
  let m = 0;
  for (const n of nights) {
    const sdRise = (n.mid - (n.bed - 2)) / 2.5;   // rising from ~2 h before usual bedtime
    const sdFall = ((n.wake + 1.5) - n.mid) / 2.2; // falls more gradually, through the morning
    m += 0.97 * ag(h, n.mid, sdRise, sdFall);
  }
  // Light cuts melatonin production; the measured level follows within minutes (first-order,
  // 10-minute half-time), so it falls over ~30 min in light and recovers ~30 min after.
  for (const L of light) {
    if (h <= L.start) continue;
    const settle = t => 1 - 0.5 ** (t / LIGHT_HALF_LIFE);
    const sEnd = L.suppress * settle(Math.min(h, L.end) - L.start);
    const s = h < L.end ? sEnd : sEnd * 0.5 ** ((h - L.end) / LIGHT_HALF_LIFE);
    m *= 1 - s;
  }
  for (const d of doses) m += d.amp * doseCurve(h - d.at);
  return 0.03 + m;
}

// Alerting signal (Process C) at hour h: low ~1 h before each usual wake time, high
// ~2.5 h before each usual bedtime, with smooth (cosine) changes between.
function alertingAt(h, nights) {
  const points = [];
  for (const n of nights) {
    points.push({ t: n.wake - 1, v: ALERT_LOW });
    points.push({ t: n.bed - 2.5, v: ALERT_HIGH });
  }
  points.sort((a, b) => a.t - b.t);
  if (h <= points[0].t) return points[0].v;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (h <= b.t) {
      const f = (1 - Math.cos(Math.PI * (h - a.t) / (b.t - a.t))) / 2;
      return a.v + (b.v - a.v) * f;
    }
  }
  return points[points.length - 1].v;
}

// ---------------------------------------------
// Sleep stages (estimated hypnogram)
//
// A model estimate, not a measurement. Each sleep bout is laid out as repeating cycles
// (N1 at the start of a bout, then N2 → N3 → N2 → REM). Cycles lengthen through the night
// (70–100 min early, 90–120 later: Medscape p. 1). Deep sleep (N3) in each cycle is sized
// by the sleep pressure (Process S) left at the cycle's start, so it's concentrated early
// and larger after sleep loss (Shirota et al. 2021, Fig. 1; Medscape p. 1). REM lengthens
// across the night (first <10 min, later much longer: Medscape p. 1; Shirota Fig. 1).
// After a logged awakening, sleep resumes through N1 (Shirota Table 3; Medscape p. 1).
// Sertraline (antidepressants) and alcohol delay the first REM period and reduce REM
// (StatPearls REM p. 4–5; StatPearls Sleep Stages p. 7). All amounts are placeholders.
// ---------------------------------------------
const STAGES = {
  wake: { label: "Awake",               short: "W", row: 0, color: "#aab4c3" },
  rem:  { label: "REM (dreaming)",      short: "R", row: 1, color: "#7a4fc4" },
  n1:   { label: "N1 (light)",          short: "1", row: 2, color: "#9ec5e8" },
  n2:   { label: "N2",                  short: "2", row: 3, color: "#3d8fd1" },
  n3:   { label: "N3 (deep, slow-wave)", short: "3", row: 4, color: "#1f3a8a" },
};
const STAGE_MODEL = {
  onsetN1: 5,                          // min of N1 when falling asleep (StatPearls: 1–5 min)
  cycleMinutes: [85, 95, 100, 105],    // cycle lengths; later cycles are 110 min
  laterCycleMinutes: 110,
  remMinutes: [10, 19, 22, 26],        // REM per cycle (Shirota Fig. 1 ≈ 10%, 20%, 21%, 25%)
  remIncreaseLater: 6,                 // later cycles: +6 min each...
  remMax: 60,                          // ...up to 60 min (Medscape: last REM may exceed 60)
  n3First: 42,                         // min of N3 in a cycle starting at typical bedtime pressure
  pressureFloor: 0.12,                 // sleep pressure below this gives no N3
  pressureTypical: 0.6,                // typical sleep pressure at bedtime
  n3Cap: 1.5,                          // up to 1.5× the typical N3 after sleep loss
  minN2: 10,                           // every cycle keeps at least 10 min of N2
  sertralineRem: 0.7,                  // REM × this, and no REM in the first cycle
  alcoholRem: 0.85,                    // REM × this, and no REM in the first cycle
  alcoholWindow: 6,                    // h before sleep that alcohol counts
  sertralineWindow: 36,                // h before sleep that a sertraline dose counts
  lutealRemCut: 0.1,                   // REM up to 10% lower at the progesterone peak
                                       // (25.2% → 22.7% of the night, Shechter Table 1)
  // Cannabis (Velzeboer et al. 2025): no consistent effect below ~20 mg THC; higher doses
  // reduce REM (dose-dependent, fading with repeated use); stopping after regular use
  // brings a REM rebound with an earlier first REM. Sizes are placeholders.
  thcWindow: 6,                        // h before sleep that THC counts toward the night's dose
  thcThreshold: 20,                    // mg THC: below this, no effect (p. 12)
  thcRemCutAtThreshold: 0.25,          // REM reduced 25% at 20 mg...
  thcRemCutMax: 0.45,                  // ...rising to 45% at 70 mg or more
  thcRemCutMaxDose: 70,
  thcTolerance: 0.7,                   // each consecutive prior high-dose night keeps 70% of the effect
  withdrawalRegularDays: 5,            // "regular use": THC on at least 5 of the 7 days before the last dose
  withdrawalDays: 7,                   // effects last from day 1 to day 7 after the last dose, fading
  withdrawalRemBoost: 0.4,             // REM up to +40%
  withdrawalEarlierRem: 25,            // first REM up to 25 min earlier
};

const cycleMinutes = k => STAGE_MODEL.cycleMinutes[k] ?? STAGE_MODEL.laterCycleMinutes;
const remMinutes = k => k < STAGE_MODEL.remMinutes.length
  ? STAGE_MODEL.remMinutes[k]
  : Math.min(STAGE_MODEL.remMax, STAGE_MODEL.remMinutes.at(-1) +
             STAGE_MODEL.remIncreaseLater * (k - STAGE_MODEL.remMinutes.length + 1));

// Segments { stage, start, end } (hours) for one night's sleep. `wakings`: { start, end }
// inside the episode. `pressureAt(h)` gives sleep pressure. `opts`: { remFactor, noFirstRem }.
function sleepStages(episode, wakings, pressureAt, opts) {
  const M = STAGE_MODEL, segs = [];
  const push = (stage, a, b) => { if (b > a + 1e-6) segs.push({ stage, start: a, end: b }); };

  // Sleep bouts between awakenings
  const bouts = [];
  let cur = episode.start;
  for (const w of wakings) {
    if (w.start > cur) bouts.push([cur, w.start]);
    push("wake", Math.max(w.start, episode.start), Math.min(w.end, episode.end));
    cur = Math.max(cur, w.end);
  }
  if (cur < episode.end) bouts.push([cur, episode.end]);

  let cycle = 0;
  for (const [a, b] of bouts) {
    let t = a, firstOfBout = true;
    while (t < b - 1e-6) {
      const len = cycleMinutes(cycle) - (cycle === 0 ? opts.firstCycleShorter || 0 : 0);
      const rem = cycle === 0 && opts.noFirstRem ? 0 : remMinutes(cycle) * opts.remFactor;
      const n1 = firstOfBout ? M.onsetN1 : 0;
      const excess = (pressureAt(t) - M.pressureFloor) / (M.pressureTypical - M.pressureFloor);
      let n3 = M.n3First * Math.max(0, Math.min(M.n3Cap, excess));
      n3 = Math.min(n3, len - rem - n1 - M.minN2);
      const n2 = len - rem - n1 - n3;
      // N1 → N2 → N3 → N2 → REM, each piece cut off where the bout ends
      let x = t;
      for (const [stage, mins] of [["n1", n1], ["n2", n2 * 0.6], ["n3", n3], ["n2", n2 * 0.4], ["rem", rem]]) {
        const end = Math.min(b, x + mins / 60);
        push(stage, x, end);
        x = end;
        if (x >= b) break;
      }
      t += len / 60;
      cycle++;
      firstOfBout = false;
    }
  }
  return segs.sort((p, q) => p.start - q.start);
}

// What makes each curve rise, and what it does (shown when hovering the legend)
const RHYTHM_INFO = {
  "Melatonin":
    "Rises: in darkness, on a schedule set by the body clock (SCN); light switches it off. " +
    "Peaks mid-sleep.\n" +
    "Function: tells the body clock it's night and quiets its alerting signal, letting sleep " +
    "pressure take over. Also lowers body temperature.\n" +
    "Source: Doghramji 2007, p. S18.",
  "Alerting signal (Process C)":
    "Rises: through the day, driven by the body clock; peaks ~2–3 h before your usual " +
    "bedtime, then falls as melatonin rises.\n" +
    "Function: promotes wakefulness, holding off the sleep pressure that builds during the day.\n" +
    "Source: Doghramji 2007, p. S17–S18, Fig. 1.",
  "Sleep pressure (Process S)":
    "Rises: the longer you're awake; clears during sleep.\n" +
    "Function: the body's drive to sleep: sleepiness and the need for deep (slow-wave) sleep. " +
    "Sleep loss carries over into longer, deeper sleep the next night.\n" +
    "Source: two-process model; Doghramji 2007, p. S18.",
  "Adenosine":
    "Rises: within minutes of waking, as active brain cells use energy (ATP); climbs further " +
    "if you stay awake much longer than usual. Drops within minutes of falling asleep.\n" +
    "Function: binds A1 and A2A receptors to quiet wake-promoting brain areas and deepen sleep. " +
    "Caffeine works by blocking these receptors.\n" +
    "Source: Reichert et al. 2022, p. 3–4.",
  "Sleep stages":
    "Estimated, not measured. Sleep runs in ~90-minute cycles: light N1 and N2, deep N3, then " +
    "REM (dreaming). Deep sleep comes mostly early in the night and grows after sleep loss; REM " +
    "lengthens toward morning. After waking in the night, sleep resumes through light N1.\n" +
    "Sources: StatPearls Sleep Stages p. 3–4; Medscape p. 1; Shirota et al. 2021, Fig. 1, Table 3.",
  "Body temperature":
    "Rises: through the day to a late-afternoon high; falls in the evening as melatonin rises, " +
    "to a low ~3–4 h before waking. Swings ~0.8–1 °C. In the luteal phase progesterone raises it " +
    "~0.4 °C and shrinks the nighttime dip; it's lowest just before ovulation.\n" +
    "Function: sleep usually starts as temperature falls; a higher nighttime temperature goes with " +
    "taking longer to fall asleep. Right-hand axis, in °C.\n" +
    "Sources: Baker & Driver 2007, p. 614–615; Shechter et al. 2010, p. 651, 653.",
  "Cortisol":
    "Rises: in the second half of the night, with a burst of ~40–75% in the first 30–60 min after " +
    "waking (bigger with bright morning light); falls through the day to a low around bedtime. " +
    "Hard exercise of 20+ min adds a bump 20–30 min later. Slightly lower in the luteal phase.\n" +
    "Function: the main stress hormone: mobilizes energy (glucose), supports blood pressure, and tunes " +
    "the immune response. How high your own levels run varies up to ~100-fold between people.\n" +
    "Sources: Kulzhanova et al. 2023; Ozgocer et al. 2022; Montero-López et al. 2018; Prado et al. 2025.",
  "Sleep propensity":
    "How likely sleep is right now: high when sleep pressure is high and the alerting " +
    "signal is low. It combines the two processes (S and C) and is a model estimate, " +
    "not a measured hormone.",
};

// Which curves you've hidden or shown from the legend, kept across redraws
const rhythmHidden = {};
const RHYTHM_PREF = {
  "Melatonin": "rMelatonin", "Alerting signal (Process C)": "rAlerting", "Sleep pressure (Process S)": "rPressure",
  "Adenosine": "rAdenosine", "Cortisol": "rCortisol", "Body temperature": "rTemp", "Sleep propensity": "rPropensity",
};

// --- Chart ---
const rhythmCanvas = document.getElementById("rhythmChart");
const rhythmDate   = document.getElementById("rhythmDate");
const rhythmNote   = document.getElementById("rhythmNote");
let rhythmChart = null;

// Inside the plot: sleep shading and a "now" line. Faint dotted guides mark event times.
const rhythmMarks = {
  id: "rhythmMarks",
  beforeDatasetsDraw(chart, args, o) {
    const { ctx, chartArea: { left, right, top, bottom }, scales: { x } } = chart;
    const px = h => Math.min(right, Math.max(left, x.getPixelForValue(h)));
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";

    for (const e of o.sleep) {
      if (e.end <= x.min || e.start >= x.max) continue;   // outside the time window
      const a = px(e.start), b = px(e.end);
      ctx.fillStyle = "#e3e7f5";
      ctx.fillRect(a, top, b - a, bottom - top);
      // Label it only if it fits inside the shaded part
      const text = e.logged ? "Sleep" : e.start >= o.now ? "Sleep (predicted)" : "Sleep (usual)";
      if (ctx.measureText(text).width + 8 <= b - a) {
        ctx.fillStyle = "#5a6272";
        ctx.fillText(text, (a + b) / 2, top + 13);
      }
    }

    // Faint dotted guides from each event in the rows below up through the plot
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    for (const lane of o.lanes) {
      ctx.strokeStyle = lane.color + "55";
      for (const it of lane.items) {
        if (it.start < x.min || it.start > x.max) continue;
        const gx = px(it.start);
        ctx.beginPath();
        ctx.moveTo(gx, top + 20);
        ctx.lineTo(gx, bottom);
        ctx.stroke();
      }
    }

    // A divider at each midnight in view, with the day names on either side
    for (const m of o.midnights) {
      if (m.at <= x.min || m.at >= x.max) continue;
      const mx = x.getPixelForValue(m.at);
      ctx.setLineDash([]);
      ctx.strokeStyle = "#8a94a6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, top);
      ctx.lineTo(mx, bottom);
      ctx.stroke();
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#5a6272";
      // Day names on either side, each only if it fits inside the plot
      const before = `${m.before} ◂`, after = `▸ ${m.after}`;
      if (mx - 5 - ctx.measureText(before).width > left) {
        ctx.textAlign = "right";
        ctx.fillText(before, mx - 5, bottom - 6);
      }
      if (mx + 5 + ctx.measureText(after).width < right) {
        ctx.textAlign = "left";
        ctx.fillText(after, mx + 5, bottom - 6);
      }
      ctx.font = "11px sans-serif";
      ctx.lineWidth = 1;
    }

    if (o.now != null && o.now > x.min && o.now < x.max) {
      const nx = px(o.now);
      ctx.strokeStyle = "#333";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(nx, top);
      ctx.lineTo(nx, bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

// Below the plot: one timeline row per kind of event (meals, exercise, substances).
// Items close in time wrap onto extra lines instead of overlapping. The chart grows
// its bottom padding to fit however many lines are needed.
const LANE_LINE = 20, LANE_GAP = 6, LANE_TOP = 8, STAGE_ROW = 11;
let RHYTHM_PLOT_HEIGHT = 270;   // px for the legend, plot, and axis; event rows are added below

// Assigns each item a line within its row so labels don't collide
function packLane(items, xOf, ctx, left, right) {
  const lineEnds = [];
  return items.map(it => {
    const x0 = xOf(it.start);
    const x1 = it.end != null ? Math.max(xOf(it.end), x0 + 4) : x0;
    const w = ctx.measureText(it.label).width;
    let labelX = x1 + 7;                         // label just right of the marker or bar
    const flip = labelX + w > right;             // too close to the right edge: put it on the left
    if (flip) labelX = x0 - 7;
    const from = Math.min(x0 - 6, flip ? labelX - w : labelX);
    const to = Math.max(x1 + 6, flip ? labelX : labelX + w);
    let line = lineEnds.findIndex(end => from > end + 4);
    if (line === -1) { line = lineEnds.length; lineEnds.push(-Infinity); }
    lineEnds[line] = to;
    return { ...it, x0, x1, labelX, flip, line };
  });
}

const rhythmLanes = {
  id: "rhythmLanes",
  afterDraw(chart, args, o) {
    const { ctx, chartArea: { left, right }, scales: { x } } = chart;
    const xOf = h => Math.min(right, Math.max(left, x.getPixelForValue(h)));
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    let y = x.bottom + LANE_TOP;
    let needed = 0;

    // Estimated sleep stages: one row per stage (Awake at top, N3 at bottom)
    const visibleStages = (o.stages || []).filter(sg => sg.end > x.min && sg.start < x.max);
    chart.$stageStrip = null;
    if (visibleStages.length) {
      const h = STAGE_ROW * 5;
      ctx.fillStyle = "#f1f4fa";
      ctx.beginPath();
      ctx.roundRect(left, y, right - left, h, 6);
      ctx.fill();
      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = "#5a6272";
      for (const st of Object.values(STAGES)) ctx.fillText(st.short, left - 6, y + st.row * STAGE_ROW + STAGE_ROW / 2);
      const placed = [];
      for (const sg of visibleStages) {
        const a = xOf(sg.start), b = xOf(sg.end), st = STAGES[sg.stage];
        ctx.globalAlpha = o.now != null && sg.start >= o.now ? 0.45 : 1;   // future = lighter
        ctx.fillStyle = st.color;
        ctx.fillRect(a, y + st.row * STAGE_ROW + 1, Math.max(1, b - a), STAGE_ROW - 2);
        ctx.globalAlpha = 1;
        placed.push({ ...sg, a, b });
      }
      chart.$stageStrip = { top: y, bottom: y + h, left, right, segments: placed };
      ctx.font = "11px sans-serif";
      y += h + LANE_GAP;
      needed += h + LANE_GAP;
    }

    for (const lane of o.lanes) {
      const visible = lane.items.filter(it => (it.end ?? it.start) >= x.min && it.start <= x.max);
      if (visible.length === 0) continue;
      const placed = packLane(visible, xOf, ctx, left, right);
      const lines = Math.max(...placed.map(p => p.line)) + 1;
      const h = lines * LANE_LINE;

      // Tinted row with the card's icon in the left margin
      ctx.fillStyle = lane.tint;
      ctx.beginPath();
      ctx.roundRect(left, y, right - left, h, 6);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.font = "13px sans-serif";
      ctx.fillText(lane.icon, left - 14, y + LANE_LINE / 2);
      ctx.font = "11px sans-serif";

      for (const it of placed) {
        const cy = y + it.line * LANE_LINE + LANE_LINE / 2;
        ctx.fillStyle = lane.color;
        ctx.beginPath();
        if (lane.shape === "bar") {
          ctx.roundRect(it.x0, cy - 4, it.x1 - it.x0, 8, 4);
        } else if (lane.shape === "diamond") {
          ctx.moveTo(it.x0, cy - 5); ctx.lineTo(it.x0 + 5, cy); ctx.lineTo(it.x0, cy + 5); ctx.lineTo(it.x0 - 5, cy);
          ctx.closePath();
        } else {
          ctx.arc(it.x0, cy, 4, 0, 2 * Math.PI);
        }
        ctx.fill();
        ctx.textAlign = it.flip ? "right" : "left";
        ctx.fillText(it.label, it.labelX, cy + 0.5);
      }
      y += h + LANE_GAP;
      needed += h + LANE_GAP;
    }
    ctx.restore();

    // Make the chart taller by however much the rows need, so the plot keeps its size
    // (redraws once if the space changed)
    let want = needed ? needed + LANE_TOP : 0;
    if (chart.$panning) want = Math.max(want, chart.$laneSpace || 0);   // no jumping mid-pan
    if (chart.$laneSpace !== want) {
      chart.$laneSpace = want;
      chart.options.layout.padding = { bottom: want };
      chart.canvas.parentElement.style.height = `${RHYTHM_PLOT_HEIGHT + want}px`;
      requestAnimationFrame(() => { if (chart.ctx) { chart.resize(); chart.update("none"); } });
    }
  },
};

// Hovering the stage strip names the stage under the mouse
const stageHover = {
  id: "stageHover",
  afterEvent(chart, args) {
    const e = args.event, strip = chart.$stageStrip;
    if (tipSource === "legend" || panState?.moved) return;
    const over = strip && e.type !== "mouseout" && e.x >= strip.left && e.x <= strip.right &&
                 e.y >= strip.top && e.y <= strip.bottom;
    const seg = over && strip.segments.find(sg => e.x >= sg.a && e.x <= Math.max(sg.b, sg.a + 1));
    if (seg) {
      showTip(`Estimated stage: ${STAGES[seg.stage].label}, ${clockLabel(seg.start)} – ${clockLabel(seg.end)}.\n` +
              "A model estimate from your sleep times and sleep pressure, not a measurement. See Methods.",
              e.native, "stage", rhythmCanvas);
    } else if (over) {
      showTip(RHYTHM_INFO["Sleep stages"], e.native, "stage", rhythmCanvas);
    } else if (tipSource === "stage") {
      hideTip();
    }
  },
};

// --- Logging controls ---
const sleepBed = document.getElementById("sleepBed");
const sleepWake = document.getElementById("sleepWake");
const sleepStatus = document.getElementById("sleepStatus");
const mealTime = document.getElementById("mealTime");
const mealSize = document.getElementById("mealSize");
const mealList = document.getElementById("mealList");
const exTime = document.getElementById("exTime");
const exMinutes = document.getElementById("exMinutes");
const exIntensity = document.getElementById("exIntensity");
const exList = document.getElementById("exList");

const byTime = (a, b) => a.time.localeCompare(b.time);

// Updates the selected day's log with `change(log)` and redraws
function editRhythms(change) {
  const log = loadRhythms();
  change(log);
  saveRhythms(log);
  renderRhythms();
}

document.getElementById("sleepSave").addEventListener("click", () => {
  if (!sleepBed.value || !sleepWake.value) return alert("Enter both a bedtime and a wake time.");
  editRhythms(log => { log.sleep[selectedDay] = { bed: sleepBed.value, wake: sleepWake.value }; });
});

// Awakenings during the night that ends on the selected day
const wakingTime = document.getElementById("wakingTime");
const wakingMinutes = document.getElementById("wakingMinutes");
const wakingList = document.getElementById("wakingList");
document.getElementById("wakingAdd").addEventListener("click", () => {
  const minutes = Number(wakingMinutes.value);
  if (!wakingTime.value || !(minutes > 0)) return alert("Enter the time you woke and how many minutes you were awake.");
  editRhythms(log => {
    log.wakings[selectedDay] = [...(log.wakings[selectedDay] || []),
      { time: wakingTime.value, minutes }].sort(byTime);
  });
  wakingTime.value = "";
});

document.getElementById("sleepClear").addEventListener("click", () => {
  editRhythms(log => { delete log.sleep[selectedDay]; });
});

document.getElementById("mealAdd").addEventListener("click", () => {
  if (!mealTime.value) return alert("Enter a time for the meal.");
  editRhythms(log => {
    log.meals[selectedDay] = [...(log.meals[selectedDay] || []),
      { time: mealTime.value, size: mealSize.value }].sort(byTime);
  });
  mealTime.value = "";
});

document.getElementById("exAdd").addEventListener("click", () => {
  const minutes = Number(exMinutes.value);
  if (!exTime.value || !(minutes > 0)) return alert("Enter a start time and a number of minutes.");
  editRhythms(log => {
    log.exercise[selectedDay] = [...(log.exercise[selectedDay] || []),
      { time: exTime.value, minutes, intensity: exIntensity.value }].sort(byTime);
  });
  exTime.value = "";
});

// Light
const lightTime = document.getElementById("lightTime");
const lightMinutes = document.getElementById("lightMinutes");
const lightKind = document.getElementById("lightKind");
const lightList = document.getElementById("lightList");
for (const [value, t] of Object.entries(LIGHT_TYPES)) lightKind.add(new Option(t.label, value));

document.getElementById("lightAdd").addEventListener("click", () => {
  const minutes = Number(lightMinutes.value);
  if (!lightTime.value || !(minutes > 0)) return alert("Enter a start time and a number of minutes.");
  editRhythms(log => {
    log.light[selectedDay] = [...(log.light[selectedDay] || []),
      { time: lightTime.value, minutes, kind: lightKind.value }].sort(byTime);
  });
  lightTime.value = "";
});

// Substances: the unit label and the "Name" box follow the chosen substance
const subType = document.getElementById("subType");
const subName = document.getElementById("subName");
const subNameField = document.getElementById("subNameField");
const subAmount = document.getElementById("subAmount");
const subAmountLabel = document.getElementById("subAmountLabel");
const subTime = document.getElementById("subTime");
const subList = document.getElementById("subList");

function updateSubstanceFields() {
  const def = SUBSTANCES[subType.value];
  const other = subType.value === "other";
  subNameField.hidden = !other;
  subAmount.step = def.step;
  subAmount.placeholder = other ? "optional" : "";
  subAmountLabel.textContent = other ? `Amount (${def.unit}, optional)` : `Amount (${def.unit})`;
}
subType.addEventListener("change", () => { subAmount.value = ""; updateSubstanceFields(); });
updateSubstanceFields();

document.getElementById("subAdd").addEventListener("click", () => {
  const other = subType.value === "other";
  const name = subName.value.trim();
  const blank = subAmount.value.trim() === "";
  const amount = blank ? "" : Number(subAmount.value);
  if (other && !name) return alert("Enter a name for the substance.");
  if (!(other && blank) && !(amount > 0)) return alert("Enter an amount.");
  if (!subTime.value) return alert("Enter a time.");
  const entry = { time: subTime.value, type: subType.value, amount };
  if (other) entry.name = name;
  editRhythms(log => {
    log.substances[selectedDay] = [...(log.substances[selectedDay] || []), entry].sort(byTime);
  });
  subAmount.value = ""; subName.value = ""; subTime.value = "";
});

// ---------------------------------------------
// Logging cards fold away: the header (and what's already logged) stays visible; the boxes
// for typing in times and amounts appear when you open the card. Cards for things the
// detail level doesn't show (light, meals, exercise) are hidden altogether.
// ---------------------------------------------
const LOG_CARD_PREF = { light: "rLight", meals: "rMeals", exercise: "rExercise" };
for (const card of document.querySelectorAll(".rhythm-log .log-card")) {
  const header = card.querySelector("header");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "card-toggle";
  const title = card.querySelector("h3").textContent;
  const set = open => {
    card.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Close" : "Log";
    toggle.setAttribute("aria-label", `${open ? "Close" : "Open"} ${title} logging`);
  };
  set(false);
  header.appendChild(toggle);
  header.addEventListener("click", e => {
    if (e.target.closest("input, select, a")) return;
    set(!card.classList.contains("open"));
    if (card.classList.contains("open")) card.querySelector(".log-fields input, .log-fields select")?.focus();
  });
}
function syncLogCards() {
  for (const [cls, pref] of Object.entries(LOG_CARD_PREF)) {
    const card = document.querySelector(`.rhythm-log .log-card.${cls}`);
    if (card) card.hidden = !(polarShow[pref] || (cls === "meals" && polarShow.eatingWindow));
  }
}
syncLogCards();

// ---------------------------------------------
// Regular doses: saved substance + amount + usual time. "Log" adds one to the selected day;
// "every day" doses log themselves each day from the day they're turned on (entries marked
// auto), so the models see them. Deleting a day's entry doesn't bring it back.
// Storage: savedDoses = [{ id, type, name?, amount, time, daily, since, filledThrough }]
// ---------------------------------------------
const DOSES_KEY = "savedDoses";
const loadDoses = () => { try { return JSON.parse(localStorage.getItem(DOSES_KEY) || "[]"); } catch { return []; } };
const saveDoses = list => localStorage.setItem(DOSES_KEY, JSON.stringify(list));
const doseList = document.getElementById("doseList");
const adherenceToggle = document.getElementById("adherenceToggle");
const sameDose = (a, b) => a.type === b.type && a.time === b.time && String(a.amount) === String(b.amount) &&
                           (a.type !== "other" || a.name === b.name);
const doseEntry = d => ({ time: d.time, type: d.type, amount: d.amount, ...(d.type === "other" ? { name: d.name } : {}) });

// Adds missing daily entries up to today (at most 60 days back)
function fillDailyDoses() {
  const doses = loadDoses();
  const today = todayStr();
  if (!doses.some(d => d.daily && d.filledThrough !== today)) return;
  const log = loadRhythms();
  for (const d of doses) {
    if (!d.daily || d.filledThrough === today) continue;
    let day = d.filledThrough ? addDays(toDate(d.filledThrough), 1) : toDate(d.since || today);
    const earliest = addDays(toDate(today), -60);
    if (day < earliest) day = earliest;
    for (; keyOf(day) <= today; day = addDays(day, 1)) {
      const key = keyOf(day);
      const list = log.substances[key] || [];
      if (!list.some(e => sameDose(e, d))) log.substances[key] = [...list, { ...doseEntry(d), auto: true }].sort(byTime);
    }
    d.filledThrough = today;
  }
  saveRhythms(log);
  saveDoses(doses);
}

// For a daily dose: days in the last `n` (counting today, and only from the day it was
// turned on) with no entry for that substance at any time or amount
function missedDays(dose, log, n) {
  const today = toDate(todayStr());
  const start = dose.since ? toDate(dose.since) : today;
  let days = 0, missed = 0;
  for (let k = n - 1; k >= 0; k--) {
    const day = addDays(today, -k);
    if (day < start) continue;
    days++;
    const took = (log.substances[keyOf(day)] || [])
      .some(e => e.type === dose.type && (dose.type !== "other" || e.name === dose.name));
    if (!took) missed++;
  }
  return { days, missed };
}

function renderDoses() {
  const doses = loadDoses();
  doseList.innerHTML = "";
  adherenceToggle.hidden = !doses.some(d => d.daily);
  if (!doses.length) return emptyNote(doseList, "No daily medications yet.");
  for (const d of doses) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = clockLabel(toHours(d.time));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = describeSubstance(d);
    const daily = document.createElement("button");
    daily.type = "button";
    daily.className = "dose-daily";
    daily.setAttribute("aria-pressed", String(!!d.daily));
    daily.textContent = d.daily ? "✓ daily" : "paused";
    daily.title = d.daily ? "Logged automatically each day. Click to pause."
                          : "Paused. Click to log it automatically each day again, from today";
    daily.addEventListener("click", () => {
      const list = loadDoses(), x = list.find(y => y.id === d.id);
      x.daily = !x.daily;
      if (x.daily) { x.since = todayStr(); delete x.filledThrough; }
      saveDoses(list);
      renderRhythms();
    });
    const logBtn = document.createElement("button");
    logBtn.type = "button";
    logBtn.className = "btn ghost small-btn";
    logBtn.textContent = "Log";
    logBtn.title = "Add this dose to the selected day";
    logBtn.addEventListener("click", () => {
      editRhythms(log => {
        const list = log.substances[selectedDay] || [];
        if (list.some(e => sameDose(e, d))) return toast("Already logged for this day");
        log.substances[selectedDay] = [...list, doseEntry(d)].sort(byTime);
      });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove saved dose ${describeSubstance(d)}`);
    remove.title = "Remove this saved dose (days already logged stay)";
    remove.addEventListener("click", () => {
      saveDoses(loadDoses().filter(y => y.id !== d.id));
      renderRhythms();
    });
    li.append(time, what, daily, logBtn, remove);
    if (d.daily && polarShow.adherence) {
      const log = loadRhythms();
      const part = (n, label) => {
        const r = missedDays(d, log, n);
        if (!r.days) return "";
        const pct = Math.round(100 * r.missed / r.days);
        return `${label}: missed ${pct}% (${r.missed} of ${plural(r.days, "day")}` +
               (r.days < n ? " since you started" : "") + ")";
      };
      const stats = document.createElement("span");
      stats.className = "dose-stats";
      stats.textContent = [part(7, "Last week"), part(30, "Last month")].filter(Boolean).join(" · ");
      li.appendChild(stats);
    }
    doseList.appendChild(li);
  }
}

// "Add daily medication": a small form at the bottom of the Substances card
const doseForm = document.getElementById("doseForm");
const doseAddBtn = document.getElementById("doseAddBtn");
const doseType = document.getElementById("doseType");
const doseName = document.getElementById("doseName");
const doseNameField = document.getElementById("doseNameField");
const doseAmount = document.getElementById("doseAmount");
const doseAmountLabel = document.getElementById("doseAmountLabel");
const doseTime = document.getElementById("doseTime");

function updateDoseFields() {
  const def = SUBSTANCES[doseType.value];
  const other = doseType.value === "other";
  doseNameField.hidden = !other;
  doseAmount.step = def.step;
  doseAmount.placeholder = other ? "optional" : "";
  doseAmountLabel.textContent = other ? `Amount (${def.unit}, optional)` : `Amount (${def.unit})`;
}
doseType.addEventListener("change", () => { doseAmount.value = ""; updateDoseFields(); });
updateDoseFields();

function showDoseForm(open) {
  doseForm.hidden = !open;
  doseAddBtn.parentElement.hidden = open;
  if (open) {
    doseAmount.value = ""; doseName.value = ""; doseTime.value = "";
    updateDoseFields();
    doseType.focus();
  }
}
doseAddBtn.addEventListener("click", () => showDoseForm(true));
document.getElementById("doseCancel").addEventListener("click", () => showDoseForm(false));

document.getElementById("doseSave").addEventListener("click", () => {
  const other = doseType.value === "other";
  const name = doseName.value.trim();
  const amount = doseAmount.value.trim() === "" ? "" : Number(doseAmount.value);
  if (other && !name) return alert("Enter a name for the medication.");
  if (!(other && amount === "") && !(amount > 0)) return alert("Enter an amount.");
  if (!doseTime.value) return alert("Enter the usual time you take it.");
  const dose = { id: Date.now().toString(36), type: doseType.value, amount, time: doseTime.value,
                 daily: true, since: todayStr() };
  if (other) dose.name = name;
  const doses = loadDoses();
  if (doses.some(d => sameDose(d, dose))) return alert("That medication is already saved.");
  saveDoses([...doses, dose]);
  showDoseForm(false);
  renderRhythms();
  toast(`Saved; ${describeSubstance(dose)} will log itself each day from today`);
});

// A list of entries for the selected day: a time chip, a description, and a remove button
function renderEntryList(list, entries, describe, kind) {
  list.innerHTML = "";
  if (entries.length === 0) return emptyNote(list, "Nothing logged for this day.");
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = clockLabel(toHours(entry.time));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = describe(entry);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${describe(entry)}`);
    remove.addEventListener("click", () => editRhythms(log => {
      log[kind][selectedDay].splice(i, 1);
      if (log[kind][selectedDay].length === 0) delete log[kind][selectedDay];
    }));
    li.append(time, what, remove);
    list.appendChild(li);
  });
}

// --- Day navigation (moves the shared selected day) ---
function shiftSelectedDay(n) {
  rhythmView = null;
  const d = addDays(toDate(selectedDay), n);
  selectedDay = keyOf(d);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  render();
}
document.getElementById("prevDay").addEventListener("click", () => shiftSelectedDay(-1));
// "Today": back to today with the default view (enabled after moving to another day or panning)
const rhythmTodayBtn = document.getElementById("rhythmToday");
const syncRhythmToday = () => { rhythmTodayBtn.disabled = selectedDay === todayStr() && !rhythmView; };
rhythmTodayBtn.addEventListener("click", () => {
  rhythmView = null;
  const d = toDate(todayStr());
  selectedDay = keyOf(d);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  render();
});
document.getElementById("nextDay").addEventListener("click", () => shiftSelectedDay(1));
document.getElementById("panelRhythms").addEventListener("click", () =>
  document.getElementById("rhythms").scrollIntoView({ behavior: "smooth" }));

// --- Draw everything for the selected day ---
// ---------------------------------------------
// Daily rhythms as a 24-hour clock: midnight at the top, noon at the bottom, running
// clockwise. Curves are drawn inside (further out = higher); sleep is a shaded wedge; the
// estimated sleep stages and logged events (light, meals, exercise, substances) sit in
// rings outside the curves. Shows the selected day, midnight to midnight.
// ---------------------------------------------
const rhythmPolar = document.getElementById("rhythmPolar");
const rhythmKey = document.getElementById("rhythmKey");
let rhythmMode = viewPrefs.rhythmMode === "circle" ? "circle" : "line";

function setRhythmMode(mode) {
  rhythmMode = mode;
  try {
    const v = JSON.parse(localStorage.getItem(CYCLE_VIEW_KEY) || "{}");
    localStorage.setItem(CYCLE_VIEW_KEY, JSON.stringify({ ...v, rhythmMode }));
  } catch {}
}
for (const b of document.querySelectorAll("#rhythmViewMode button")) {
  b.addEventListener("click", () => { setRhythmMode(b.dataset.mode); renderRhythms(); });
}
rhythmPolar.addEventListener("mouseleave", hideHoverTip);
window.addEventListener("resize", () => { if (rhythmMode === "circle") renderRhythms(); });

// Sideways scroll or swipe on the clock changes day, like the arrows
let rSwipeAccum = 0, rSwipeLock = 0, rSwipeStart = null;
rhythmPolar.addEventListener("wheel", e => {
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
  if (!dx) return;
  e.preventDefault();
  if (Date.now() < rSwipeLock) return;
  rSwipeAccum += dx;
  if (Math.abs(rSwipeAccum) > 60) {
    shiftSelectedDay(rSwipeAccum > 0 ? 1 : -1);
    rSwipeAccum = 0;
    rSwipeLock = Date.now() + 500;
  }
}, { passive: false });
rhythmPolar.addEventListener("pointerdown", e => { rSwipeStart = { x: e.clientX, y: e.clientY }; });
rhythmPolar.addEventListener("pointerup", e => {
  if (!rSwipeStart) return;
  const dx = e.clientX - rSwipeStart.x, dy = e.clientY - rSwipeStart.y;
  rSwipeStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) shiftSelectedDay(dx < 0 ? 1 : -1);
});

function syncRhythmMode() {
  for (const b of document.querySelectorAll("#rhythmViewMode button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === rhythmMode));
  }
}

// Key above the chart (line and clock): a checkbox shows or hides each curve, and tapping (or hovering)
// its name explains it, so hiding and getting details are separate on touch screens.
// Simple circadian shows only melatonin and cortisol here; Detailed lists every curve.
const SIMPLE_CURVES = ["rMelatonin", "rCortisol"];
function renderRhythmKey(all, circle) {
  const detailed = isDetailed(goals.circadian) || !isOn(goals.circadian);
  const items = [];
  for (const d of all) {
    const pref = RHYTHM_PREF[d.label];
    if (!detailed && !SIMPLE_CURVES.includes(pref) && !polarShow[pref]) continue;
    items.push({ label: d.label, color: d.color, checked: polarShow[pref], info: RHYTHM_INFO[d.label] ?? d.label,
                 toggle: on => { polarShow[pref] = on; applyDisplay(); } });
  }
  if (polarShow.rStages) items.push({ label: "Sleep stages", info: RHYTHM_INFO["Sleep stages"] });
  buildKey(rhythmKey, items);
}

function renderRhythmCircle({ datasets, episodes, asleep, stages, lanes, nowHours }) {
  const g = polarSetup(rhythmPolar), { ctx, cx, cy } = g;
  const R = g.R + 18;                                  // no labels outside, so use the room
  const A = h => -Math.PI / 2 + 2 * Math.PI * h / 24;
  // Like the cycle circle: an hour ring in the middle, curves shaded outside it,
  // sleep stages and logged events inside it
  const ringR = R < 200 ? Math.max(0.36 * R, 66) : 0.42 * R, ringW = R < 200 ? 18 : 22;
  const base = ringR + ringW / 2 + 4, outerR = R;      // curves
  const st1 = ringR - ringW / 2 - 4, st0 = st1 - 12;   // sleep stages (hypnogram ring)
  const evR = (stages.length ? st0 : st1) - 10;        // logged events
  const clip = (a, b) => [Math.max(0, a), Math.min(24, b)];
  const showNow = nowHours >= 0 && nowHours < 24;
  const level = (d, y) => d.yAxisID === "temp" ? (y - 35.9) / 2 * 1.1 : y;
  // Each curve is shaded from its own low point that day, so the areas show when it rises
  // rather than all filling the same ring (hover shows the actual values)
  const span = d => {
    const ys = d.data.filter(p => p.x >= 0 && p.x <= 24).map(p => level(d, p.y));
    const lo = Math.min(...ys), hi = Math.max(...ys);
    return { lo, range: Math.max(hi - lo, 0.3) };
  };
  const radiusOf = (v, sp) => base + (outerR - base) * Math.max(0, Math.min(1, (v - sp.lo) / sp.range));
  const future = x => showNow ? x > nowHours : nowHours <= 0;

  // Guide circles for the curve area
  ctx.strokeStyle = "#e6e9f0";
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    ctx.beginPath(); ctx.arc(cx, cy, base + f * (outerR - base), 0, 2 * Math.PI); ctx.stroke();
  }

  // Curves: shaded areas reaching further out the higher they are; dashed after now
  // Widest areas first, so smaller ones stay visible on top
  const order = datasets.map(d => ({ d, sp: span(d) }))
    .sort((a, b) => b.sp.range - a.sp.range);
  for (const { d, sp } of order) {
    const pts = d.data.filter(p => p.x >= 0 && p.x <= 24)
      .map(p => ({ x: p.x, a: A(p.x), r: radiusOf(level(d, p.y), sp) }));
    if (pts.length < 2) continue;
    const xy = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = xy(p.a, p.r); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    for (let i = pts.length - 1; i >= 0; i--) { const [x, y] = xy(pts[i].a, base); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = d.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 1.6;
    const stroke = (part, dashed) => {
      if (part.length < 2) return;
      ctx.setLineDash(dashed ? [6, 5] : []);
      ctx.beginPath();
      part.forEach((p, i) => { const [x, y] = xy(p.a, p.r); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    stroke(pts.filter(p => !future(p.x) || (showNow && p.x <= nowHours + 1 / 6)), false);
    stroke(pts.filter(p => future(p.x) || (showNow && p.x >= nowHours - 1 / 6)), true);
    ctx.setLineDash([]);
  }

  // Hour ring: awake time pale, time asleep shaded, an hour number on each hour
  ringArc(ctx, g, ringR - ringW / 2, ringR + ringW / 2, 0, 2 * Math.PI, "#eef1f7");
  for (const sl of asleep) {
    const [a, b] = clip(sl.start, sl.end);
    if (b <= a) continue;
    ctx.globalAlpha = future(a) ? 0.5 : 1;
    ringArc(ctx, g, ringR - ringW / 2, ringR + ringW / 2, A(a), A(b), "#c5cbeb");
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const small = R < 200;
  for (let h = 0; h < 24; h++) {
    if (small && h % 2) continue;
    const a = A(h);
    const label = h === 0 ? "12a" : h === 12 ? "12p" : String(h % 12);
    ctx.font = h % 6 === 0 ? "bold 10px sans-serif" : "10px sans-serif";
    ctx.fillStyle = h % 6 === 0 ? "#1f2a44" : "#5a6272";
    ctx.fillText(label, cx + ringR * Math.cos(a), cy + ringR * Math.sin(a));
  }

  // Sleep stages inside the hour ring, thicker = deeper
  if (stages.length) {
    ringArc(ctx, g, st0, st1, 0, 2 * Math.PI, "#f4f6fb");
    for (const sg of stages) {
      const [a, b] = clip(sg.start, sg.end);
      if (b <= a) continue;
      ctx.globalAlpha = future(sg.start) ? 0.45 : 1;
      const depth = { wake: 0.25, rem: 0.55, n1: 0.4, n2: 0.7, n3: 1 }[sg.stage];
      ringArc(ctx, g, st1 - (st1 - st0) * depth, st1, A(a), A(b), STAGES[sg.stage].color);
      ctx.globalAlpha = 1;
    }
  }

  // Logged events inside: arcs for light and exercise, dots for meals, diamonds for substances
  const hits = [];
  for (const lane of lanes) {
    for (const it of lane.items) {
      if (it.start >= 24 || (it.end ?? it.start) < 0) continue;
      const [a, b] = clip(it.start, it.end ?? it.start);
      ctx.fillStyle = lane.color;
      if (lane.shape === "bar" && b > a) {
        ringArc(ctx, g, evR - 3, evR + 3, A(a), A(Math.max(b, a + 0.1)), lane.color);
      } else {
        const ang = A(a), x = cx + evR * Math.cos(ang), y = cy + evR * Math.sin(ang);
        ctx.beginPath();
        if (lane.shape === "diamond") {
          ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
        } else ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fill();
      }
      hits.push({ from: a - 0.25, to: Math.max(b, a) + 0.25, text: `${lane.icon} ${clockLabel(it.start % 24)} ${it.label}` });
    }
  }

  // Now: a dashed line out from the hour ring, labelled at the end (like Today on the cycle circle)
  if (showNow) {
    const a = A(nowHours);
    ctx.strokeStyle = "#1f2a44";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    radial(ctx, g, a, ringR + ringW / 2 + 2, outerR - 10);
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cx + ringR * Math.cos(a), cy + ringR * Math.sin(a), ringW / 2 + 1, 0, 2 * Math.PI);
    ctx.strokeStyle = "#1f2a44"; ctx.lineWidth = 2; ctx.stroke();
    pill(ctx, `Now ${clockLabel(nowHours)}`, cx + (outerR - 2) * Math.cos(a), cy + (outerR - 2) * Math.sin(a),
         "#1f2a44", "#1f2a44");
  }

  // Centre
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1f2a44";
  ctx.font = small ? "bold 13px sans-serif" : "bold 15px sans-serif";
  const day = toDate(selectedDay);
  ctx.fillText(day.toLocaleDateString(undefined, { weekday: "short" }), cx, cy - 8);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#5a6272";
  ctx.fillText(day.toLocaleDateString(undefined, { month: "short", day: "numeric" }), cx, cy + 9);


  // Hover: the time, whether asleep (and the estimated stage), the curves, and nearby events
  rhythmPolar.onmousemove = e => {
    const rect = rhythmPolar.getBoundingClientRect();
    const x = e.clientX - rect.left - cx, y = e.clientY - rect.top - cy, r = Math.hypot(x, y);
    if (r < evR - 12 || r > R + 6) { if (tipSource === "rpolar") hideTip(); return; }
    let h = ((Math.atan2(y, x) + Math.PI / 2) / (2 * Math.PI) * 24 + 24) % 24;
    h = Math.round(h * 6) / 6;
    const lines = [clockLabel(h) + (showNow ? (h > nowHours ? " (predicted)" : "") : nowHours <= 0 ? " (predicted)" : "")];
    if (asleep.some(s => h >= s.start && h < s.end)) {
      const sg = stages.find(s => h >= s.start && h < s.end);
      lines.push("Asleep" + (sg ? ` · ${STAGES[sg.stage].label}` : ""));
    }
    for (const d of datasets) {
      const p = d.data.reduce((a, q) => Math.abs(q.x - h) < Math.abs(a.x - h) ? q : a);
      lines.push(`${d.label}: ${d.yAxisID === "temp" ? `${p.y.toFixed(2)} °C` : p.y.toFixed(2)}`);
    }
    for (const ev of hits) if (h >= ev.from && h <= ev.to) lines.push(ev.text);
    showTip(lines.join("\n"), e, "rpolar", rhythmPolar);
  };
}

function renderRhythms() {
  syncRhythmToday();
  fillDailyDoses();
  if (tipCanvas === rhythmCanvas) hideTip();
  if (rhythmChart) { rhythmChart.destroy(); rhythmChart = null; }
  const day = toDate(selectedDay);
  const log = loadRhythms();

  // Body clock for every night in the range shown (plus one either side for the curves)
  const states = clockStates(day, log, -PAN_DAYS - 1, PAN_DAYS + 2);
  const usual = states[0];

  rhythmDate.textContent = day.toLocaleDateString(undefined,
    { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  // Logging controls
  const night = log.sleep[selectedDay];
  sleepBed.value = night ? night.bed : "";
  sleepWake.value = night ? night.wake : "";
  sleepStatus.textContent = night
    ? `Logged: ${fmtDuration(sleepTimes(night).wake - sleepTimes(night).bed)} of sleep.`
    : `Not logged; using your usual ${clockLabel(usual.bed)} – ${clockLabel(usual.wake)}.`;
  const meals = log.meals[selectedDay] || [];
  const exercise = log.exercise[selectedDay] || [];
  const substances = log.substances[selectedDay] || [];
  const light = log.light[selectedDay] || [];
  renderEntryList(lightList, light, L => `${L.minutes} min, ${LIGHT_TYPES[L.kind].short}`, "light");
  renderEntryList(wakingList, log.wakings[selectedDay] || [], w => `awake ${w.minutes} min`, "wakings");
  renderEntryList(mealList, meals, m => MEAL_SIZES[m.size], "meals");
  renderEntryList(exList, exercise, x => `${x.minutes} min, ${INTENSITIES[x.intensity]}`, "exercise");
  renderEntryList(subList, substances, s => describeSubstance(s) + (s.auto ? " · daily" : ""), "substances");
  renderDoses();

  const shiftToday = wrap12(states[1].mid - states[0].mid);
  rhythmNote.textContent =
    `Body clock estimate: melatonin peaks around ${clockLabel(usual.mid)} and the alerting ` +
    `signal around ${clockLabel(states[1].bed - 2.5)}` +
    (Math.abs(shiftToday) >= 0.08
      ? `; today's sleep, light, and substances move it ${Math.round(Math.abs(shiftToday) * 60)} min ` +
        `${shiftToday > 0 ? "later" : "earlier"} for tonight. `
      : ". ") +
    "Solid lines are up to now; dashed lines are predictions. The strip under the time axis estimates " +
    "your sleep stages. Tap a name in the key (or hover the strip) for explanations, and see Methods at the bottom of " +
    "the page for how each estimate is made. Drag the chart sideways (or swipe, or Shift + scroll) to move through time.";

  // Everything is computed for PAN_DAYS days either side of this day, so the chart can be
  // panned smoothly. Hours are relative to this day's midnight (negative = earlier days).
  const range = { min: -24 * PAN_DAYS, max: 24 * (PAN_DAYS + 1) };
  const episodes = sleepEpisodes(day, log, states, -PAN_DAYS - 1, PAN_DAYS + 1);
  const clockNights = [];
  for (let k = -PAN_DAYS - 1; k <= PAN_DAYS + 2; k++) {
    const c = states[k];
    clockNights.push({ mid: 24 * k + c.mid, bed: 24 * k + c.bed, wake: 24 * k + c.wake });
  }

  // Logged light (suppresses melatonin while it lasts) and melatonin doses, across the range
  const lightSpans = [], doses = [];
  for (let k = -PAN_DAYS - 1; k <= PAN_DAYS + 1; k++) {
    const key = keyOf(addDays(day, k));
    for (const L of log.light[key] || []) {
      const start = 24 * k + toHours(L.time);
      lightSpans.push({ start, end: start + L.minutes / 60, suppress: LIGHT_TYPES[L.kind].suppress,
                        weight: LIGHT_TYPES[L.kind].weight });
    }
    for (const sub of log.substances[key] || []) {
      if (sub.type === "melatonin" && sub.amount > 0) {
        doses.push({ at: 24 * k + toHours(sub.time), amp: Math.min(1, 0.5 * Math.sqrt(sub.amount)) });
      }
    }
  }

  // Default view: from 2 hours before last night's bedtime (so the whole night shows)
  // to midnight at the end of this day. A panned view is kept until the day changes.
  const lastNight = log.sleep[selectedDay] ? sleepTimes(log.sleep[selectedDay]) : usual;
  const defaultMin = Math.min(-1, Math.floor(lastNight.bed) - 2);
  const view = rhythmView && rhythmView.day === selectedDay
    ? rhythmView
    : { day: selectedDay, min: defaultMin, len: 24 - defaultMin };

  // The current time, in hours relative to this day's midnight
  const now = new Date();
  const todayOffset = Math.round((toDate(todayStr()) - day) / DAY) * 24;
  const nowHours = todayOffset + now.getHours() + now.getMinutes() / 60;

  // Logged awakenings, placed inside each night (a time after that night's wake time
  // means the evening before)
  const fromK = -PAN_DAYS - 1;
  const wakingsByEpisode = episodes.map((ep, i) => {
    const k = fromK + i;
    return (log.wakings[keyOf(addDays(day, k))] || []).map(w => {
      let t = toHours(w.time);
      if (24 * k + t >= ep.end) t -= 24;
      const start = 24 * k + t;
      return { start, end: Math.min(ep.end, start + w.minutes / 60) };
    }).filter(w => w.start >= ep.start && w.start < ep.end).sort((a, b) => a.start - b.start);
  });
  // Time actually asleep: each night minus its awakenings
  const asleep = [];
  episodes.forEach((ep, i) => {
    let cur = ep.start;
    for (const w of wakingsByEpisode[i]) {
      if (w.start > cur) asleep.push({ start: cur, end: w.start });
      cur = Math.max(cur, w.end);
    }
    if (cur < ep.end) asleep.push({ start: cur, end: ep.end });
  });

  // Curves, every 10 minutes across the whole range
  const hours = [];
  for (let h = range.min; h <= range.max + 1e-9; h += 1 / 6) hours.push(h);
  const pressure = sleepPressureAt(hours, asleep);
  const aden = adenosineLevelAt(hours, asleep);

  // Estimated sleep stages for each night
  const pressureAt = h => pressure[Math.max(0, Math.min(pressure.length - 1, Math.round((h - range.min) * 6)))];
  const substanceTimes = type => {
    const times = [];
    for (let k = -PAN_DAYS - 3; k <= PAN_DAYS + 1; k++) {
      for (const sub of log.substances[keyOf(addDays(day, k))] || []) {
        if (sub.type === type) times.push(24 * k + toHours(sub.time));
      }
    }
    return times;
  };
  const sertraline = substanceTimes("sertraline"), alcohol = substanceTimes("alcohol");

  // Menstrual cycle position at hour h (relative to this day's midnight)
  const onBC = usesBirthControl();
  const cycles = cyclePhases(load());
  const cycleAtHour = (h, lagDays = 0) => {
    const t = h / 24 - lagDays, k = Math.floor(t);
    return cycleStateAt(cycles, addDays(day, k), t - k);
  };
  // For temperature: progesterone lagged ~24 h; with birth control, a luteal-like level all month
  const tempCycleAt = h => {
    if (onBC) return { P: 1, E: 0 };
    const now = cycleAtHour(h), lagged = cycleAtHour(h, TEMP.progLagDays);
    return now && lagged ? { P: lagged.P, E: now.E } : null;
  };

  // THC entries { t, mg }, going back far enough to judge regular use before a stop
  const thc = [];
  for (let k = -PAN_DAYS - 16; k <= PAN_DAYS + 1; k++) {
    for (const sub of log.substances[keyOf(addDays(day, k))] || []) {
      if (sub.type === "marijuana" && sub.amount > 0) thc.push({ t: 24 * k + toHours(sub.time), mg: Number(sub.amount) });
    }
  }
  const M = STAGE_MODEL;
  const thcBefore = start => thc.filter(x => x.t <= start + 1 && start - x.t <= M.thcWindow)
                                .reduce((sum, x) => sum + x.mg, 0);
  // Cannabis effects for a night starting at `start`
  function cannabisEffect(start) {
    const mg = thcBefore(start);
    if (mg >= M.thcThreshold) {
      const f = Math.min(1, (mg - M.thcThreshold) / (M.thcRemCutMaxDose - M.thcThreshold));
      let cut = M.thcRemCutAtThreshold + (M.thcRemCutMax - M.thcRemCutAtThreshold) * f;
      let streak = 0;                                   // consecutive earlier high-dose nights
      while (streak < 7 && thcBefore(start - 24 * (streak + 1)) >= M.thcThreshold) streak++;
      cut *= M.thcTolerance ** streak;
      return { kind: "dose", mg, streak, remFactor: 1 - cut, noFirstRem: cut >= 0.1 };
    }
    const past = thc.filter(x => x.t < start);
    if (!past.length) return null;
    const last = Math.max(...past.map(x => x.t));
    const hoursSince = start - last;
    if (hoursSince < 24 || hoursSince > 24 * M.withdrawalDays) return null;
    const useDays = new Set(past.filter(x => x.t > last - 24 * 7).map(x => Math.floor(x.t / 24)));
    if (useDays.size < M.withdrawalRegularDays) return null;
    const w = 1 - (hoursSince - 24) / (24 * (M.withdrawalDays - 1));   // 1 on day 1, fading to 0 by day 7
    return { kind: "withdrawal", day: Math.floor(hoursSince / 24), remFactor: 1 + M.withdrawalRemBoost * w,
             firstCycleShorter: M.withdrawalEarlierRem * w };
  }

  const nightEffects = [];
  const stageSegments = episodes.flatMap((ep, i) => {
    const onSert = sertraline.some(t => t <= ep.start && ep.start - t <= M.sertralineWindow);
    const drank = alcohol.some(t => t <= ep.start + 1 && ep.start - t <= M.alcoholWindow);
    const cannabis = cannabisEffect(ep.start);
    nightEffects[i] = cannabis;
    const cyc = onBC ? null : cycleAtHour(ep.start);
    const remFactor = (onSert ? M.sertralineRem : 1) * (drank ? M.alcoholRem : 1) * (cannabis?.remFactor ?? 1) *
                      (cyc ? 1 - M.lutealRemCut * cyc.P : 1);
    const noFirstRem = onSert || drank || !!cannabis?.noFirstRem;
    return sleepStages(ep, wakingsByEpisode[i], pressureAt,
                       { remFactor, noFirstRem, firstCycleShorter: noFirstRem ? 0 : cannabis?.firstCycleShorter || 0 });
  });

  // Mention cannabis effects on the night ending on the selected day
  const tonightEffect = nightEffects[PAN_DAYS + 1];
  if (tonightEffect?.kind === "dose") {
    rhythmNote.textContent += ` Last night: about ${Math.round(tonightEffect.mg)} mg THC before sleep, so the stage ` +
      `estimate shows less REM and a later first REM` +
      (tonightEffect.streak ? ` (weaker after ${plural(tonightEffect.streak, "earlier night")} of high doses, for tolerance)` : "") +
      ". Below ~20 mg THC no consistent effect has been found (Velzeboer et al. 2025).";
  } else if (tonightEffect?.kind === "withdrawal") {
    rhythmNote.textContent += ` Day ${tonightEffect.day} after stopping regular cannabis use: expect more REM and ` +
      "an earlier first REM (often vivid dreams), and falling asleep may take longer with shorter sleep for the " +
      "first several nights (Velzeboer et al. 2025).";
  }
  // Menstrual cycle note for the selected day
  if (onBC) {
    rhythmNote.textContent += " Hormonal birth control is on, so menstrual-cycle effects are off; the " +
      "temperature curve stays at a luteal-like level, as it does on the pill (Baker & Driver 2007, p. 618).";
  } else {
    const today = cycleStateAt(cycles, day, 0.5);
    const lastNightCycle = cycleAtHour(episodes[PAN_DAYS + 1].start);
    const notes = [];
    if (lastNightCycle && lastNightCycle.P >= 0.5) {
      notes.push(`Luteal phase (cycle day ${today ? today.cycleDay : lastNightCycle.cycleDay}): progesterone is high, ` +
        "so the stage estimate has slightly less REM and body temperature runs higher with a smaller " +
        "nighttime dip. Falling asleep may take longer and you may feel groggier on waking " +
        "(Shechter et al. 2010; Baker & Driver 2007).");
    }
    if (today && today.cycleDay <= 4) {
      notes.push(`Period day ${today.cycleDay}: sleep often feels worse in the first days of a period, ` +
        "even though measured sleep changes little (Baker & Driver 2007).");
    } else if (today && today.daysToNext >= 1 && today.daysToNext <= 7) {
      notes.push(`About ${plural(today.daysToNext, "day")} before the next expected period: sleep often feels ` +
        "worse in the premenstrual week, even though measured sleep changes little (Baker & Driver 2007).");
    }
    if (notes.length) rhythmNote.textContent += " " + notes.join(" ");
  }

  const alerting = hours.map(h => alertingAt(h, clockNights));

  // Cortisol inputs: final wake times (with a boost for bright light soon after), exercise
  const sessions = [];
  for (let k = -PAN_DAYS - 1; k <= PAN_DAYS + 1; k++) {
    for (const x of log.exercise[keyOf(addDays(day, k))] || []) {
      const start = 24 * k + toHours(x.time);
      sessions.push({ end: start + x.minutes / 60, minutes: x.minutes, intensity: x.intensity });
    }
  }
  const wakes = episodes.map(ep => {
    let boost = 0;
    for (const L of lightSpans) {
      if (L.start >= ep.end - 0.25 && L.start <= ep.end + 1) {
        boost = Math.max(boost, CORTISOL.carLightBoost * L.weight);
      }
    }
    return { t: ep.end, boost };
  });
  const progAt = h => { if (onBC) return 0; const c = cycleAtHour(h); return c ? c.P : 0; };
  const datasets = [
    { label: "Melatonin", data: hours.map(h => ({ x: h, y: melatoninAt(h, clockNights, lightSpans, doses) })),
      color: RHYTHM_COLORS.melatonin },
    { label: "Alerting signal (Process C)", data: hours.map((h, i) => ({ x: h, y: alerting[i] })),
      color: RHYTHM_COLORS.alerting },
    { label: "Sleep pressure (Process S)", data: hours.map((h, i) => ({ x: h, y: pressure[i] })),
      color: RHYTHM_COLORS.pressure },
    { label: "Adenosine", data: hours.map((h, i) => ({ x: h, y: aden[i] })),
      color: RHYTHM_COLORS.adenosine },
    { label: "Cortisol", data: hours.map(h => ({ x: h, y: cortisolAt(h, clockNights, wakes, sessions, progAt) })),
      color: RHYTHM_COLORS.cortisol },
    { label: "Body temperature", yAxisID: "temp",
      data: hours.map(h => ({ x: h, y: temperatureAt(h, clockNights, tempCycleAt) })),
      color: RHYTHM_COLORS.temperature },
    // Both processes together: high when sleep pressure is high and the alerting signal is low
    { label: "Sleep propensity",
      data: hours.map((h, i) => ({ x: h, y: Math.max(0, Math.min(1.1, 0.5 + pressure[i] - alerting[i])) })),
      color: RHYTHM_COLORS.propensity },
  ].map(d => ({
    ...d, borderColor: d.color, backgroundColor: d.color, borderWidth: 2, pointRadius: 0,
    hidden: !polarShow[RHYTHM_PREF[d.label]],
    // Solid up to now, dashed after: the future part is a prediction
    segment: { borderDash: seg => seg.p0.parsed.x >= nowHours ? [6, 5] : undefined },
  }));


  // Event rows under the plot, colored like their logging cards, for every day in range
  const entriesInRange = (kind, toItem) => {
    const items = [];
    for (let k = -PAN_DAYS; k <= PAN_DAYS; k++) {
      for (const e of log[kind][keyOf(addDays(day, k))] || []) items.push(toItem(e, 24 * k));
    }
    return items.sort((a, b) => a.start - b.start);
  };
  const lanes = [
    { pref: "rLight", icon: "☀️", shape: "bar", color: "#3d8fd1", tint: "#e1eefa",
      items: entriesInRange("light", (L, off) => ({ start: toHours(L.time) + off,
        end: toHours(L.time) + off + L.minutes / 60, label: `${L.minutes} min ${LIGHT_TYPES[L.kind].short}` })) },
    { pref: "rMeals", icon: "🍽️", shape: "dot", color: "#0f5e6e", tint: "#dcecf7",
      items: entriesInRange("meals", (m, off) => ({ start: toHours(m.time) + off, label: MEAL_SIZES[m.size] })) },
    { pref: "rExercise", icon: "🏃", shape: "bar", color: "#1d6f61", tint: "#d6f0ea",
      items: entriesInRange("exercise", (x, off) => ({ start: toHours(x.time) + off,
        end: toHours(x.time) + off + x.minutes / 60, label: `${x.minutes} min` })) },
    { icon: "💊", shape: "diamond", color: "#6b47b8", tint: "#ece8fb",
      items: entriesInRange("substances", (x, off) => ({ start: toHours(x.time) + off,
        label: describeSubstance(x, true) })) },
  ].filter(l => !l.pref || polarShow[l.pref]);
  const shownStages = polarShow.rStages ? stageSegments : [];
  const dayName = d => d.toLocaleDateString(undefined, { weekday: "short" });
  const midnights = [];
  for (let k = -PAN_DAYS; k <= PAN_DAYS + 1; k++) {
    midnights.push({ at: 24 * k, before: dayName(addDays(day, k - 1)), after: dayName(addDays(day, k)) });
  }

  syncRhythmMode();
  const circle = rhythmMode === "circle";
  const stageLine = "The strip under the time axis estimates your sleep stages. Tap a name in the key (or hover the strip) for explanations";
  const panLine = "Drag the chart sideways (or swipe, or Shift + scroll) to move through time.";
  if (circle) {
    rhythmNote.textContent = rhythmNote.textContent
      .replace(stageLine, "On the clock, midnight is at the top; the hour ring is shaded where you slept, curves " +
        "reach further out the higher they are" +
        (polarShow.rStages ? ", the inner ring estimates your sleep stages (thicker = deeper)" : "") +
        ", and the marks inside are logged events. Tap a name in the key, or hover the clock, for details")
      .replace(panLine, "Swipe or Shift + scroll sideways on the clock (or use the arrows) to change day.");
  } else if (!polarShow.rStages) {
    rhythmNote.textContent = rhythmNote.textContent.replace(stageLine, "Tap a name in the key for an explanation");
  }
  renderRhythmKey(datasets, circle);
  rhythmCanvas.style.display = circle ? "none" : "";
  rhythmPolar.style.display = circle ? "block" : "none";
  rhythmKey.hidden = false;
  if (circle) {
    rhythmCanvas.parentElement.style.height = "";
    renderRhythmCircle({ datasets: datasets.filter(d => !d.hidden), episodes, asleep, stages: shownStages,
                         lanes, nowHours });
    renderSleepPattern(log);
    return;
  }

  RHYTHM_PLOT_HEIGHT = narrowScreen() ? 290 : 270;
  rhythmCanvas.parentElement.style.height = `${RHYTHM_PLOT_HEIGHT}px`;
  rhythmChart = new Chart(rhythmCanvas, {
    type: "line",
    data: { datasets },
    options: {
      animation: false,
      maintainAspectRatio: false,        // height is set by the box around the canvas
      scales: {
        x: {
          type: "linear", min: view.min, max: view.min + view.len,
          ticks: { stepSize: 3, maxRotation: 0, callback: v => clockLabel(v, false) },
          // A tick every 3 hours on the hour (12 AM, 3 AM, ...), wherever the window starts; every 6 on phones
          afterBuildTicks: axis => {
            const step = narrowScreen() ? 6 : 3;
            axis.ticks = [];
            for (let v = Math.ceil(axis.min / step) * step; v <= axis.max; v += step) axis.ticks.push({ value: v });
          },
        },
        y: {
          min: 0, max: 1.15,             // headroom so the "Sleep" label clears the curves
          title: { display: true, text: "Relative level" },
          ticks: { display: false },
        },
        temp: {
          position: "right", min: 35.9, max: 37.9,
          display: "auto",               // only while the temperature curve is shown
          title: { display: true, text: "Body temp (°C)", color: RHYTHM_COLORS.temperature },
          ticks: { stepSize: 0.5, color: RHYTHM_COLORS.temperature },
          grid: { drawOnChartArea: false },
        },
      },
      layout: { padding: { bottom: 0 } },
      plugins: {
        rhythmMarks: { sleep: episodes, lanes, now: nowHours, midnights },
        rhythmLanes: { lanes, stages: shownStages, now: nowHours },
        legend: { display: false },     // the key above the chart shows and hides curves
      },
    },
    plugins: [rhythmMarks, rhythmLanes, stageHover],
  });
  rhythmChart.$day = day;
  rhythmChart.$range = range;
  rhythmChart.$len = view.len;

  renderSleepPattern(log);
}

// ---------------------------------------------
// Panning the daily rhythms chart: drag, horizontal trackpad swipe, or Shift + wheel.
// While panning only the visible window moves. On release, if the middle of the view
// has crossed into another day, that day becomes the selected day.
// ---------------------------------------------
const PAN_DAYS = 2;
let rhythmView = null;   // { day, min, len } after panning; null = the default view
let panState = null;
let wheelTimer = null;

const dayLabel = d => d.toLocaleDateString(undefined,
  { weekday: "long", month: "short", day: "numeric", year: "numeric" });

function panTo(min) {
  const c = rhythmChart;
  if (!c) return;
  const len = c.$len;
  min = Math.max(c.$range.min, Math.min(c.$range.max - len, min));
  c.options.scales.x.min = min;
  c.options.scales.x.max = min + len;
  c.$panning = true;
  c.update("none");
  // Show which day the middle of the view is in while panning
  rhythmDate.textContent = dayLabel(addDays(c.$day, Math.floor((min + len / 2) / 24)));
}

function finishPan() {
  const c = rhythmChart;
  if (!c) return;
  c.$panning = false;
  const min = c.options.scales.x.min;
  const shift = Math.floor((min + c.$len / 2) / 24);   // whole days the middle has moved
  if (shift === 0) {
    rhythmView = { day: selectedDay, min, len: c.$len };
    syncRhythmToday();
    c.update("none");                                    // lets the event rows settle
    return;
  }
  const d = addDays(c.$day, shift);
  selectedDay = keyOf(d);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  rhythmView = { day: selectedDay, min: min - 24 * shift, len: c.$len };
  render();
}

const hoursPerPixel = () => {
  const c = rhythmChart;
  return c.$len / (c.chartArea.right - c.chartArea.left);
};

rhythmCanvas.addEventListener("mouseleave", () => { if (tipCanvas === rhythmCanvas) hideTip(); });

rhythmCanvas.addEventListener("pointerdown", e => {
  if (!rhythmChart || e.button !== 0) return;
  panState = { x: e.clientX, min: rhythmChart.options.scales.x.min, moved: false };
  rhythmCanvas.setPointerCapture(e.pointerId);
  rhythmCanvas.classList.add("panning");
});

rhythmCanvas.addEventListener("pointermove", e => {
  if (!panState) return;
  const dx = e.clientX - panState.x;
  if (!panState.moved && Math.abs(dx) < 3) return;    // ignore tiny movements (clicks)
  if (!panState.moved && tipCanvas === rhythmCanvas) hideTip();
  panState.moved = true;
  panTo(panState.min - dx * hoursPerPixel());
});

const endDrag = () => {
  if (!panState) return;
  const moved = panState.moved;
  panState = null;
  rhythmCanvas.classList.remove("panning");
  if (moved) finishPan();
};
rhythmCanvas.addEventListener("pointerup", endDrag);
rhythmCanvas.addEventListener("pointercancel", endDrag);

// Trackpad sideways swipes, or Shift + mouse wheel. Plain up/down scrolling still scrolls the page.
rhythmCanvas.addEventListener("wheel", e => {
  if (!rhythmChart) return;
  const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!sideways && !e.shiftKey) return;
  e.preventDefault();
  const delta = sideways ? e.deltaX : e.deltaY;
  panTo(rhythmChart.options.scales.x.min + delta * hoursPerPixel());
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(finishPan, 250);
}, { passive: false });

// ---------------------------------------------
// Sleep patterns: one bar per night, bedtime to wake time, over the last N days
// ---------------------------------------------
const patternCanvas = document.getElementById("sleepPattern");
const sleepStats = document.getElementById("sleepStats");
let patternChart = null;
let patternDays = 7;

for (const btn of document.querySelectorAll("#patternRange button")) {
  btn.addEventListener("click", () => {
    patternDays = Number(btn.dataset.days);
    for (const b of document.querySelectorAll("#patternRange button")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    renderSleepPattern(loadRhythms());
  });
}

// 7.5 -> "7h 30m"
function fmtDuration(h) {
  const total = Math.round(h * 60);
  const hrs = Math.floor(total / 60), mins = total % 60;
  return mins ? `${hrs}h ${String(mins).padStart(2, "0")}m` : `${hrs}h`;
}


// Dashed lines for average bedtime and wake time, and hours slept under each bar
const patternMarks = {
  id: "patternMarks",
  afterDatasetsDraw(chart, args, o) {
    const { ctx, chartArea: { left, right }, scales: { y } } = chart;
    ctx.save();
    ctx.font = "11px sans-serif";
    const lineLabels = [];
    for (const line of o.lines) {
      const ly = y.getPixelForValue(line.at);
      ctx.strokeStyle = o.color || "#1aa6b7";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, ly);
      ctx.lineTo(right, ly);
      ctx.stroke();
      lineLabels.push({ text: line.label, y: ly });
    }
    if (o.showDurations) {
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillStyle = "#3d4556";
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        const v = chart.data.datasets[0].data[i];
        if (!v) return;
        ctx.fillText(fmtDuration(v[1] - v[0]), bar.x, Math.max(bar.y, bar.base) + 13);
      });
    }
    // Average labels last, on a white pill so they stay readable over the bars
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    for (const l of lineLabels) {
      const w = ctx.measureText(l.text).width;
      const x = right - w - 12;
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.beginPath();
      ctx.roundRect(x - 6, l.y - 9, w + 12, 18, 9);
      ctx.fill();
      ctx.strokeStyle = o.color || "#1aa6b7";
      ctx.stroke();
      ctx.fillStyle = o.textColor || "#11717c";
      ctx.fillText(l.text, x, l.y + 4);
    }
    ctx.restore();
  },
};

function renderSleepPattern(log) {
  if (patternChart) { patternChart.destroy(); patternChart = null; }
  renderEatingWindow(log);

  // Nights ending on each of the last N days, up to today
  const today = toDate(todayStr());
  const dates = [];
  for (let k = patternDays - 1; k >= 0; k--) dates.push(addDays(today, -k));
  const nights = dates.map(d => {
    const e = log.sleep[keyOf(d)];
    return e ? sleepTimes(e) : null;
  });
  const logged = nights.filter(Boolean);

  // Clock range: an hour of padding around the earliest bedtime and latest wake time
  const lo = logged.length ? Math.floor(Math.min(...logged.map(n => n.bed))) - 1 : -3;
  const rawHi = logged.length ? Math.ceil(Math.max(...logged.map(n => n.wake))) + 1 : 10;
  const hi = lo + 2 * Math.ceil((rawHi - lo) / 2);   // keep the 2-hour ticks lined up

  const selected = keyOf(toDate(selectedDay));
  const colors = dates.map(d => keyOf(d) === selected ? "#1aa6b7" : "#3b3f9e");

  const avgBed = logged.length ? mean(logged.map(n => n.bed)) : null;
  const avgWake = logged.length ? mean(logged.map(n => n.wake)) : null;

  patternChart = new Chart(patternCanvas, {
    type: "bar",
    data: {
      labels: dates.map(d => [d.toLocaleDateString(undefined, { weekday: "short" }),
                              d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })]),
      datasets: [{
        label: "Sleep",
        data: nights.map(n => n ? [n.bed, n.wake] : null),
        backgroundColor: colors,
        borderRadius: 6,
        borderSkipped: false,
        barPercentage: 0.6,
      }],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      scales: {
        y: {
          reverse: true,                 // evening at the top, morning at the bottom
          min: lo, max: hi,
          ticks: { stepSize: 2, callback: v => clockLabel(v, false) },
        },
        x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const [bed, wake] = c.raw;
              return `${clockLabel(bed)} – ${clockLabel(wake)} (${fmtDuration(wake - bed)})`;
            },
          },
        },
        patternMarks: {
          lines: logged.length ? [
            { at: avgBed, label: `avg bedtime ${clockLabel(avgBed)}` },
            { at: avgWake, label: `avg wake ${clockLabel(avgWake)}` },
          ] : [],
          showDurations: patternDays <= 7,
        },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const d = dates[elements[0].index];
        selectedDay = keyOf(d);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        setTimeout(render);   // redraw after Chart.js finishes handling this click
      },
      onHover: (e, elements) => { patternCanvas.style.cursor = elements.length ? "pointer" : ""; },
    },
    plugins: [patternMarks],
  });

  // Averages column beside the chart, one colour per kind
  sleepStats.innerHTML = "";
  const head = document.createElement("h3");
  head.className = "avg-title";
  head.textContent = `Averages · last ${plural(patternDays, "day")}`;
  sleepStats.appendChild(head);
  const tile = (label, value, sub, cls = "") => {
    const t = document.createElement("div");
    t.className = `stat ${cls}`;
    for (const [cls, text] of [["label", label], ["value", value], ["sub", sub]]) {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      t.appendChild(el);
    }
    sleepStats.appendChild(t);
  };
  if (logged.length === 0) {
    tile("Nights logged", `0 of ${patternDays}`, "Log sleep above to see your pattern.", "avg-count");
    return;
  }
  const durations = logged.map(n => n.wake - n.bed);
  const spread = xs => logged.length > 1 ? `varies ±${Math.round(stdev(xs) * 60)} min` : "need 2+ nights";
  tile("Sleep", fmtDuration(mean(durations)),
       logged.length > 1
         ? `${fmtDuration(Math.min(...durations))} – ${fmtDuration(Math.max(...durations))}`
         : "need 2+ nights", "avg-sleep");
  tile("Bedtime", clockLabel(avgBed), spread(logged.map(n => n.bed)), "avg-bed");
  tile("Wake time", clockLabel(avgWake), spread(logged.map(n => n.wake)), "avg-wake");
  tile("Nights logged", `${logged.length} of ${patternDays}`, `last ${patternDays} days`, "avg-count");
}

// ---------------------------------------------
// Eating window: for each day, the span from the first to the last logged meal or snack
// (the "daily eating interval" in Wilkinson, p. 94). Anything logged before 4 AM counts as a
// late snack for the day before, so one midnight snack doesn't stretch the next day. Days with
// only one entry are shown as a dot and left out of the averages, since there's no span to
// measure. Windows over 10 hours are flagged (10 h is the window tested in Wilkinson).
// ---------------------------------------------
const eatCanvas = document.getElementById("eatPattern");
const eatStats = document.getElementById("eatStats");
const eatSection = document.getElementById("eatingWindow");
const EAT_LIMIT = 10;
const EAT_DAY_START = 4;
const EAT_COLOR = "#4f86c6", EAT_FLAG = "#d9822b";
let eatChart = null;
let eatDays = 7;

for (const btn of document.querySelectorAll("#eatRange button")) {
  btn.addEventListener("click", () => {
    eatDays = Number(btn.dataset.days);
    for (const b of document.querySelectorAll("#eatRange button")) b.setAttribute("aria-pressed", String(b === btn));
    renderEatingWindow(loadRhythms());
  });
}

const EAT_FLAG_SHORT = [
  "Over 10 hours. Meal times set the clocks in the liver and gut, so",
  "eating across a long day can pull them out of step with the brain's",
  "clock. Hover the ⚑ under the chart for more.",
];
const EAT_FLAG_INFO = [
  "⚑ Eating window over 10 hours",
  "Body clock: light sets the brain's master clock, but meal times set the clocks in the liver, gut, pancreas " +
  "and fat tissue. Eating spread over a long day, especially late at night under artificial light, can pull those " +
  "clocks out of step with the master clock. A regular daily eating window may help keep them in sync. " +
  "(Currenti p. 727; Jaffe p. 344; Wilkinson p. 92–93)",
  "Heart and blood vessels: in 19 adults with metabolic syndrome who usually ate across 14+ hours, eating within " +
  "a 10-hour window for 12 weeks lowered blood pressure (about −5 / −6.5 mmHg) and LDL cholesterol (−11%), on top " +
  "of their usual medications. It was a small study with no control group. (Wilkinson p. 93, 99, 102)",
  "Mental health: meal timing may affect mood through sleep and the body clock, and fasting raises BDNF, a brain " +
  "growth factor that is low in depression and insomnia (Currenti p. 725–726; Jaffe p. 344–345). Evidence in " +
  "people is early: one trial found lower depression scores with time-restricted eating, and about half of people " +
  "with bipolar disorder who tried a window under 14 hours reported better mood (Johnson p. 3). No trial has yet " +
  "tested it as a treatment for depression (Jaffe p. 345).",
  "This flag is information, not a target. Restricting when you eat isn't right for everyone, including people " +
  "with a history of disordered eating or who take insulin; talk to your clinician first. " +
  "(Currenti p. 729; Jaffe p. 345; Johnson p. 1)",
].join("\n\n");

// First and last meal of each day, in hours from midnight (late snacks can run past 24)
function eatingSpan(log, date) {
  const k = keyOf(date), next = keyOf(addDays(date, 1));
  const times = [
    ...(log.meals[k] || []).map(m => toHours(m.time)).filter(h => h >= EAT_DAY_START),
    ...(log.meals[next] || []).map(m => toHours(m.time)).filter(h => h < EAT_DAY_START).map(h => h + 24),
  ];
  if (!times.length) return null;
  const first = Math.min(...times), last = Math.max(...times);
  return { first, last, count: times.length, len: last - first };
}

function flagBadge(text) {
  const b = document.createElement("span");
  b.className = "eat-flag";
  b.tabIndex = 0;
  b.textContent = text;
  const q = document.createElement("span");
  q.className = "flag-q";
  q.textContent = "?";
  b.appendChild(q);
  b.setAttribute("role", "button");
  b.setAttribute("aria-label", "Why is this flagged?");
  attachHelp(b, () => EAT_FLAG_INFO, "eatflag");
  return b;
}

function renderEatingWindow(log) {
  if (eatChart) { eatChart.destroy(); eatChart = null; }
  eatSection.hidden = !polarShow.eatingWindow;
  if (!polarShow.eatingWindow) return;

  const today = toDate(todayStr());
  const dates = [];
  for (let k = eatDays - 1; k >= 0; k--) dates.push(addDays(today, -k));
  const spans = dates.map(d => eatingSpan(log, d));
  const measured = spans.filter(s => s && s.count > 1);
  const any = spans.filter(Boolean);

  const lo = any.length ? Math.floor(Math.min(...any.map(s => s.first))) - 1 : 6;
  const rawHi = any.length ? Math.ceil(Math.max(...any.map(s => s.last))) + 1 : 22;
  const hi = lo + 2 * Math.ceil((rawHi - lo) / 2);   // keep the 2-hour ticks lined up
  const selected = keyOf(toDate(selectedDay));
  const flagged = s => s && s.count > 1 && s.len > EAT_LIMIT;
  const avgFirst = measured.length ? mean(measured.map(s => s.first)) : null;
  const avgLast = measured.length ? mean(measured.map(s => s.last)) : null;
  const avgLen = measured.length ? mean(measured.map(s => s.len)) : null;

  eatChart = new Chart(eatCanvas, {
    type: "bar",
    data: {
      labels: dates.map(d => [d.toLocaleDateString(undefined, { weekday: "short" }),
                              d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })]),
      datasets: [
        {
          label: "Eating window",
          data: spans.map(s => s && s.count > 1 ? [s.first, s.last] : null),
          backgroundColor: spans.map(s => flagged(s) ? EAT_FLAG : EAT_COLOR),
          borderColor: dates.map(d => keyOf(d) === selected ? "#1f2a44" : "transparent"),
          borderWidth: 2,
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.6,
          grouped: false,
        },
        {
          type: "line",
          label: "One entry",
          data: spans.map(s => s && s.count === 1 ? s.first : null),
          showLine: false,
          pointRadius: 5,
          pointBackgroundColor: EAT_COLOR,
          pointBorderColor: "#fff",
          pointBorderWidth: 1.5,
        },
      ],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          reverse: true,                 // morning at the top, evening at the bottom
          min: lo, max: hi,
          ticks: { stepSize: 2, callback: v => clockLabel(v, false) },
        },
        x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.raw != null,
          callbacks: {
            label: c => {
              const s = spans[c.dataIndex];
              if (s.count === 1) return `One entry at ${clockLabel(s.first)} (no window to measure)`;
              return `${clockLabel(s.first)} – ${clockLabel(s.last)} (${fmtDuration(s.len)}, ${s.count} entries)`;
            },
            afterBody: items => {
              const s = spans[items[0]?.dataIndex];
              return flagged(s) ? [""].concat(EAT_FLAG_SHORT) : [];
            },
          },
        },
        patternMarks: {
          lines: measured.length ? [
            { at: avgFirst, label: `avg first ${clockLabel(avgFirst)}` },
            { at: avgLast, label: `avg last ${clockLabel(avgLast)}` },
          ] : [],
          showDurations: eatDays <= 7,
          color: "#3a6ea5", textColor: "#2c5a8a",
        },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const d = dates[elements[0].index];
        selectedDay = keyOf(d);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        setTimeout(render);
      },
      onHover: (e, elements) => { eatCanvas.style.cursor = elements.length ? "pointer" : ""; },
    },
    plugins: [patternMarks],
  });

  // Summary tiles
  eatStats.innerHTML = "";
  const head = document.createElement("h3");
  head.className = "avg-title";
  head.textContent = `Averages · last ${plural(eatDays, "day")}`;
  eatStats.appendChild(head);
  const tile = (label, value, sub, flag, cls = "") => {
    const t = document.createElement("div");
    t.className = `stat ${cls}` + (flag ? " flagged" : "");
    for (const [cls, text] of [["label", label], ["value", value], ["sub", sub]]) {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      if (cls === "value" && flag) el.append(" ", flagBadge("⚑ over 10 h"));
      t.appendChild(el);
    }
    eatStats.appendChild(t);
  };
  if (!measured.length) {
    tile("Days measured", `0 of ${eatDays}`,
         any.length ? "Log at least two meals or snacks on a day to measure its window."
                    : "Log meals and snacks above to see your eating window.", false, "avg-count");
    return;
  }
  const lens = measured.map(s => s.len);
  const nOver = measured.filter(s => s.len > EAT_LIMIT).length;
  const spread = xs => measured.length > 1 ? `varies ±${Math.round(stdev(xs) * 60)} min` : "need 2+ days";
  tile("Eating window", fmtDuration(avgLen),
       measured.length > 1 ? `${fmtDuration(Math.min(...lens))} – ${fmtDuration(Math.max(...lens))}` : "need 2+ days",
       avgLen > EAT_LIMIT, "avg-window");
  tile("First meal", clockLabel(avgFirst), spread(measured.map(s => s.first)), false, "avg-first");
  tile("Last meal", clockLabel(avgLast), spread(measured.map(s => s.last)), false, "avg-last");
  tile("Days over 10 h", `${nOver} of ${measured.length}`,
       `${measured.length} of ${eatDays} days measured`, false, "avg-count");
  if (nOver && !(avgLen > EAT_LIMIT)) eatStats.lastChild.querySelector(".value").append(" ", flagBadge("⚑ why?"));
}

// ---------------------------------------------
// Backup: export / import
//
// Export saves into a "backups" folder inside the folder you choose (your App folder).
// Web pages can't find their own folder on disk, so the app asks once and remembers the
// choice. This uses the File System Access API (Chrome and Edge); other browsers fall back
// to a normal download and a normal file picker.
// ---------------------------------------------
const exportBtn  = document.getElementById("exportBtn");
const importBtn  = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const importDialog = document.getElementById("importDialog");
const importLatestBtn = document.getElementById("importLatest");
const importLatestInfo = document.getElementById("importLatestInfo");
const folderDialog = document.getElementById("folderDialog");
const toastEl = document.getElementById("toast");

const canUseFolders = "showDirectoryPicker" in window;

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

// --- Remembering the chosen folder (folder handles can be stored in IndexedDB) ---
function handleStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cycleTrackerFiles", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = action(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadFolder = () => handleStore("readonly", s => s.get("appFolder")).catch(() => null);
const rememberFolder = h => handleStore("readwrite", s => s.put(h, "appFolder"));

// Ask for the App folder. The picker must open straight from a click, so this shows a
// short explanation first and opens the picker from that dialog's button.
function pickFolder() {
  return new Promise(resolve => {
    const chooseBtn = document.getElementById("folderChoose");
    const onChoose = async () => {
      try {
        const folder = await window.showDirectoryPicker({ id: "cycleTrackerApp", mode: "readwrite" });
        const hasScript = await folder.getFileHandle("script.js").then(() => true, () => false);
        if (!hasScript && !confirm(`"${folder.name}" doesn't contain script.js. Save backups there anyway?`)) {
          return;   // leave the dialog open so another folder can be chosen
        }
        await rememberFolder(folder);
        folderDialog.close();
        resolve(folder);
      } catch (e) {
        if (e.name !== "AbortError") { folderDialog.close(); resolve(null); }
      }
    };
    chooseBtn.onclick = onChoose;
    folderDialog.onclose = () => resolve(null);   // Cancel; resolving twice is harmless
    folderDialog.showModal();
  });
}

// The backups folder, creating it if needed. With ask = false it never prompts and
// returns null when permission hasn't been granted this session.
async function backupsFolder({ ask = true } = {}) {
  if (!canUseFolders) return null;
  let folder = await loadFolder();
  if (folder) {
    const opts = { mode: "readwrite" };
    let perm = await folder.queryPermission(opts);
    if (perm !== "granted" && ask) perm = await folder.requestPermission(opts);
    if (perm !== "granted") folder = null;
  }
  if (!folder && ask) folder = await pickFolder();
  if (!folder) return null;
  return { app: folder, backups: await folder.getDirectoryHandle("backups", { create: true }) };
}

// "cycle-backup-2026-11-11_0122.json": sorts by name in time order
function backupName() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, "0");
  return `cycle-backup-${todayStr()}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`;
}

// --- Export ---
// Chrome/Edge on a computer: into the chosen backups folder. iPhone (and other browsers that can share
// files): the share sheet, where "Save to Files" keeps it in Files or iCloud Drive. Otherwise a download.
const LAST_BACKUP_KEY = "lastBackup";
async function exportBackup() {
  const backup = { period: load(), periodFlow: loadFlow(), discharge: loadDischarge(), rhythms: loadRhythms(), missedPills: loadMissed(),
                   settings: { hormonalBirthControl: usesBirthControl(), birthControl: birthControlType(),
                               goals, savedDoses: loadDoses() } };
  const json = JSON.stringify(backup, null, 2);
  const name = backupName();
  const done = msg => {
    try { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch {}
    checkBackupReminder();
    toast(msg);
    return true;
  };

  if (canUseFolders) {
    try {
      const dirs = await backupsFolder();
      if (!dirs) { toast("Export cancelled."); return false; }
      const file = await dirs.backups.getFileHandle(name, { create: true });
      const out = await file.createWritable();
      await out.write(json);
      await out.close();
      return done(`Saved ${name} to ${dirs.app.name}/backups.`);
    } catch (e) {
      console.warn("Saving to the folder failed, downloading instead:", e);
    }
  }

  const file = new File([json], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Biological Rhythms Tracker backup" });
      return done(`Backup ${name} shared. If you chose "Save to Files", it's in the Files app.`);
    } catch (e) {
      if (e.name === "AbortError") { toast("Export cancelled."); return false; }
      console.warn("Sharing failed, downloading instead:", e);
    }
  }

  // Fallback: a normal download
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return done(`Saved ${name} to your Downloads folder.`);
}
exportBtn.addEventListener("click", exportBackup);

// --- Backup reminders ---
// Shown at the top when it's been longer than the chosen interval since the last export
// (or since you started logging, if you've never exported). "Later" hides it for 3 days.
const REMIND_EVERY_KEY = "backupEvery", SNOOZE_KEY = "backupSnoozeUntil", FIRST_USE_KEY = "firstUse";
const backupReminder = document.getElementById("backupReminder");
const backupEvery = document.getElementById("backupEvery");
const remindEvery = () => { const v = Number(localStorage.getItem(REMIND_EVERY_KEY) ?? 7); return Number.isFinite(v) ? v : 7; };
const hasAnyData = () => load().length > 0 || Object.keys(loadDischarge()).length > 0 ||
  Object.values(loadRhythms()).some(v => v && Object.keys(v).length);

function checkBackupReminder() {
  let show = false, text = "";
  try {
    const every = remindEvery();
    if (every > 0 && hasAnyData()) {
      if (!localStorage.getItem(FIRST_USE_KEY)) localStorage.setItem(FIRST_USE_KEY, String(Date.now()));
      const last = Number(localStorage.getItem(LAST_BACKUP_KEY)) || 0;
      const since = last || Number(localStorage.getItem(FIRST_USE_KEY));
      const days = Math.floor((Date.now() - since) / DAY);
      const snoozed = Date.now() < (Number(localStorage.getItem(SNOOZE_KEY)) || 0);
      if (days >= every && !snoozed) {
        show = true;
        text = last ? `It's been ${plural(days, "day")} since your last backup.`
                    : "You haven't backed up your data yet.";
        text += " Your data is only on this device, so a backup file is the only way to recover it.";
      }
    }
  } catch {}
  backupReminder.hidden = !show;
  document.getElementById("backupReminderText").textContent = text;
}
document.getElementById("reminderExport").addEventListener("click", exportBackup);
document.getElementById("reminderLater").addEventListener("click", () => {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * DAY)); } catch {}
  checkBackupReminder();
});
backupEvery.value = String(remindEvery());
backupEvery.addEventListener("change", () => {
  try { localStorage.setItem(REMIND_EVERY_KEY, backupEvery.value); } catch {}
  checkBackupReminder();
});

// Ask the browser not to clear this app's storage when space runs low (where supported)
navigator.storage?.persist?.().catch(() => {});

// --- Import ---
// Newest backup in the backups folder, by file name
async function latestBackup(backups) {
  let newest = null;
  for await (const [name, handle] of backups.entries()) {
    if (handle.kind === "file" && /^cycle-backup-.*\.json$/.test(name) && (!newest || name > newest.name)) {
      newest = handle;
    }
  }
  return newest;
}

importBtn.addEventListener("click", async () => {
  importLatestBtn.disabled = !canUseFolders;
  importLatestInfo.textContent = canUseFolders
    ? "From your backups folder."
    : "Only Chrome or Edge on a computer can open a backups folder. Use the option below to pick a backup file.";
  importDialog.showModal();

  // If the folder is already allowed this session, show which file "most recent" means
  const dirs = await backupsFolder({ ask: false }).catch(() => null);
  if (dirs) {
    const newest = await latestBackup(dirs.backups);
    importLatestInfo.textContent = newest
      ? `${newest.name} in ${dirs.app.name}/backups`
      : `No backups in ${dirs.app.name}/backups yet.`;
    importLatestBtn.disabled = !newest;
  }
});

importLatestBtn.addEventListener("click", async () => {
  try {
    const dirs = await backupsFolder();
    if (!dirs) return;
    const newest = await latestBackup(dirs.backups);
    if (!newest) return toast(`No backups found in ${dirs.app.name}/backups.`);
    importDialog.close();
    await importFromFile(await newest.getFile());
  } catch (e) {
    toast("Couldn't open the backups folder: " + e.message);
  }
});

document.getElementById("importChoose").addEventListener("click", async () => {
  importDialog.close();
  if ("showOpenFilePicker" in window) {
    try {
      const dirs = await backupsFolder({ ask: false }).catch(() => null);
      const [handle] = await window.showOpenFilePicker({
        id: "cycleTrackerBackups",
        startIn: dirs ? dirs.backups : "documents",
        types: [{ description: "Cycle tracker backup", accept: { "application/json": [".json"] } }],
      });
      await importFromFile(await handle.getFile());
    } catch (e) {
      if (e.name !== "AbortError") toast("Couldn't open that file: " + e.message);
    }
  } else {
    importFile.click();
  }
});

document.getElementById("changeFolder").addEventListener("click", async () => {
  importDialog.close();
  if (!canUseFolders) return toast("This browser saves backups to Downloads; choosing a folder needs Chrome or Edge.");
  const folder = await pickFolder();
  if (folder) toast(`Backups will be saved in ${folder.name}/backups.`);
});

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = "";          // lets you re-import the same file later
  if (file) await importFromFile(file);
});

async function importFromFile(file) {
  try {
    const summary = importBackupText(await file.text());
    alert(`${file.name}: ${summary}`);
  } catch (e) {
    alert("Couldn't import: " + e.message);
  }
}

// Validates a backup and merges it into what's already logged. Returns a summary.
function importBackupText(text) {
  const data = JSON.parse(text);
  const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // Old backups are a plain array of period days; new ones are { period, discharge }
  const period    = Array.isArray(data) ? data : data?.period;
  const discharge = Array.isArray(data) ? {} : (data?.discharge ?? {});

  // Discharge entries can be the old "type" string or the new { type, amount }
  const validEntry = v => typeof v === "string"
    ? v in DISCHARGE_TYPES
    : v && v.type in DISCHARGE_TYPES && (!v.amount || v.amount in AMOUNTS);

  const valid = Array.isArray(period) && period.every(isDate) &&
    typeof discharge === "object" && !Array.isArray(discharge) &&
    Object.entries(discharge).every(([day, v]) => isDate(day) && validEntry(v));

  // Sleep, meals, and exercise (only in newer backups)
  const rhythms = Array.isArray(data) ? {} : (data?.rhythms ?? {});
  const isTime = s => typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const validRhythms = isObj(rhythms) &&
    Object.entries(rhythms.sleep ?? {}).every(([d, s]) => isDate(d) && isTime(s?.bed) && isTime(s?.wake)) &&
    Object.entries(rhythms.meals ?? {}).every(([d, list]) => isDate(d) && Array.isArray(list) &&
      list.every(m => isTime(m?.time) && m.size in MEAL_SIZES)) &&
    Object.entries(rhythms.exercise ?? {}).every(([d, list]) => isDate(d) && Array.isArray(list) &&
      list.every(x => isTime(x?.time) && x.minutes > 0 && x.intensity in INTENSITIES)) &&
    Object.entries(rhythms.wakings ?? {}).every(([d, list]) => isDate(d) && Array.isArray(list) &&
      list.every(w => isTime(w?.time) && w.minutes > 0)) &&
    Object.entries(rhythms.light ?? {}).every(([d, list]) => isDate(d) && Array.isArray(list) &&
      list.every(L => isTime(L?.time) && L.minutes > 0 && L.kind in LIGHT_TYPES)) &&
    Object.entries(rhythms.substances ?? {}).every(([d, list]) => isDate(d) && Array.isArray(list) &&
      list.every(s => isTime(s?.time) && s.type in SUBSTANCES &&
        (s.type === "other" ? typeof s.name === "string" && s.name.trim() : s.amount > 0)));

  if (!valid || !validRhythms) throw new Error("this doesn't look like a cycle backup file.");

  const imported = {};
  for (const day in discharge) imported[day] = toEntry(discharge[day]);

  if (data?.settings?.birthControl in BC_TYPES) setBirthControlType(data.settings.birthControl);
  else if (typeof data?.settings?.hormonalBirthControl === "boolean")
    setBirthControlType(data.settings.hormonalBirthControl ? "combined" : "none");
  const doses = data?.settings?.savedDoses;
  if (Array.isArray(doses)) {
    const ok = doses.filter(d => d && typeof d.id === "string" && d.type in SUBSTANCES && isTime(d.time));
    const mine = loadDoses();
    saveDoses([...mine, ...ok.filter(d => !mine.some(m => m.id === d.id || sameDose(m, d)))]);
  }
  if (data?.periodFlow && typeof data.periodFlow === "object") {
    const ok = Object.fromEntries(Object.entries(data.periodFlow).filter(([d, v]) => isDate(d) && v in FLOWS));
    saveFlow({ ...loadFlow(), ...ok });
  }
  if (Array.isArray(data?.missedPills)) saveMissed([...loadMissed(), ...data.missedPills.filter(isDate)]);
  save([...load(), ...period]);                           // merges with what's already logged
  saveDischarge({ ...loadDischarge(), ...imported });     // backup wins if a day differs
  const current = loadRhythms();                          // same for rhythms, day by day
  saveRhythms({
    sleep:    { ...current.sleep,    ...(rhythms.sleep ?? {}) },
    meals:    { ...current.meals,    ...(rhythms.meals ?? {}) },
    exercise: { ...current.exercise, ...(rhythms.exercise ?? {}) },
    substances: { ...current.substances, ...(rhythms.substances ?? {}) },
    light:      { ...current.light,      ...(rhythms.light ?? {}) },
    wakings:    { ...current.wakings,    ...(rhythms.wakings ?? {}) },
  });
  render();
  const count = o => Object.keys(o ?? {}).length;
  return `Imported ${period.length} period days, ${count(discharge)} discharge days, ` +
         `and sleep, light, meals, exercise, and substances for ${new Set([...Object.keys(rhythms.sleep ?? {}),
           ...Object.keys(rhythms.meals ?? {}), ...Object.keys(rhythms.exercise ?? {}),
           ...Object.keys(rhythms.substances ?? {}), ...Object.keys(rhythms.light ?? {})]).size} days.`;
}

// ---------------------------------------------
// Start-up (keep at the very bottom)
// ---------------------------------------------
selectedDay = todayStr();
applySections();
render();
checkBackupReminder();
if (firstVisit) openSetup(true);
