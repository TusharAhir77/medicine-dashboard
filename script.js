// =====================================================
//  SETTINGS
// =====================================================
const DEMO_MODE    = false;   // true = fake data (no device needed), false = real Blynk data
const BLYNK_TOKEN  = "wq1qW3d_IbSSHFtNwZFmlVCeRlvJ-ekl";
const BLYNK_SERVER = "https://blr1.blynk.cloud";
const REFRESH_MS   = 3000;    // update every 3 seconds
const SCHEDULE_SYNC_MS = 15000; // re-read the schedule from the device every 15 seconds

// =====================================================
//  HELPERS
// =====================================================
const el = (id) => document.getElementById(id);

// The schedule the dashboard is currently using
let currentSchedule = ["08:00", "14:00", "21:00"];

// true when the user changed the form but has not pressed "Save schedule" yet
let formDirty = false;

function setOnline(isOnline, label) {
  el("statusDot").className = "dot " + (isOnline ? "online" : "offline");
  el("statusText").textContent = label || (isOnline ? "Online" : "Offline");
}

// Blynk may return keys as "v0" or "V0", so check both
function pick(data, pin) {
  const value = data[pin.toLowerCase()] ?? data[pin.toUpperCase()];
  return value === undefined || value === null || value === "" ? "--" : value;
}

// Put the values on the cards
function showValues(data) {
  el("doseStatus").textContent  = pick(data, "v0");
  el("nextDose").textContent    = pick(data, "v2");
  el("takenToday").textContent  = pick(data, "v3");
  el("missedToday").textContent = pick(data, "v4");
}

// "14:30" -> 870 (minutes after midnight)
function minutesOf(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// =====================================================
//  DEMO MODE (fake data that changes over time)
// =====================================================
const demoEvents = [
  { status: "Device online" },
  { status: "Dose due - take your medicine" },
  { status: "Dose TAKEN on time", taken: 1 },
  { status: "Device online" },
  { status: "Dose due - take your medicine" },
  { status: "Dose MISSED - caregiver notified", missed: 1 },
  { status: "Device online" }
];
let demoStep = 0, demoTaken = 0, demoMissed = 0;

function demoValues() {
  const ev = demoEvents[demoStep];
  demoTaken  += ev.taken  || 0;
  demoMissed += ev.missed || 0;

  const done = demoTaken + demoMissed;
  const next = done < currentSchedule.length
    ? currentSchedule[done]
    : "Tomorrow " + currentSchedule[0];

  const result = { v0: ev.status, v2: next, v3: demoTaken, v4: demoMissed };

  demoStep++;
  if (demoStep >= demoEvents.length) {   // start the demo day again
    demoStep = 0; demoTaken = 0; demoMissed = 0;
  }
  return result;
}

// Remember the schedule in the browser while in demo mode
function saveDemoSchedule(times) {
  try { localStorage.setItem("demoSchedule", times.join(",")); } catch (e) {}
}
function readDemoSchedule() {
  try {
    const text = localStorage.getItem("demoSchedule");
    return text ? text.split(",") : null;
  } catch (e) { return null; }
}

// =====================================================
//  REAL DATA FROM BLYNK
// =====================================================
async function readValues() {
  const url = `${BLYNK_SERVER}/external/api/get?token=${BLYNK_TOKEN}&v0&v1&v2&v3&v4`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Blynk said: " + (await res.text()));
  return res.json();
}

async function readOnline() {
  const url = `${BLYNK_SERVER}/external/api/isHardwareConnected?token=${BLYNK_TOKEN}`;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  return text === "true";
}

// =====================================================
//  HISTORY + SCHEDULE STATUS
//  The device only sends counters (V3 = taken, V4 = missed).
//  When a counter goes up, we log one event in the history and
//  mark the matching dose time in "Today's schedule" as Taken / Missed.
// =====================================================
const STORE_KEY = "doseState";
let lastTaken = null;
let lastMissed = null;

function todayStr() {
  return new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD
}

// state = { date, results: { "08:00": "taken", "14:00": "missed" }, history: [...] }
function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}

  if (!saved) return { date: todayStr(), results: {}, history: [] };

  const history = Array.isArray(saved.history) ? saved.history : [];
  let results = {};
  if (saved.results && typeof saved.results === "object" && !Array.isArray(saved.results)) {
    results = saved.results;
  }
  if (saved.date !== todayStr()) results = {};   // new day: clear badges, keep history

  return { date: todayStr(), results: results, history: history };
}

function saveState(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

// Which dose time does a new event belong to?
// = the latest dose time that has already passed and has no result yet.
function pickSlot(state) {
  const open = currentSchedule.filter((t) => !state.results[t]);
  if (open.length === 0) return null;

  const now = nowMinutes();
  const due = open.filter((t) => minutesOf(t) <= now);
  return due.length ? due[due.length - 1] : open[0];
}

// Look at new V3 / V4 values and record any change
function trackChanges(data) {
  const taken  = parseInt(pick(data, "v3"), 10);
  const missed = parseInt(pick(data, "v4"), 10);
  if (isNaN(taken) || isNaN(missed)) return;

  // First reading, or the device reset its counters (new day):
  // just remember the starting point, do not log anything
  if (lastTaken === null || taken < lastTaken || missed < lastMissed) {
    lastTaken = taken;
    lastMissed = missed;
    renderHistoryAndSchedule();
    return;
  }

  const state = loadState();
  const now = new Date().toLocaleString();

  const add = (result, count) => {
    for (let i = 0; i < count; i++) {
      const slot = pickSlot(state);
      if (slot) state.results[slot] = result;
      state.history.unshift({
        time: now,
        at: slot || "",
        dose: slot ? currentSchedule.indexOf(slot) + 1 : 0,
        result: result
      });
    }
  };

  const changed = taken > lastTaken || missed > lastMissed;
  if (taken  > lastTaken)  add("taken",  taken  - lastTaken);
  if (missed > lastMissed) add("missed", missed - lastMissed);

  state.history = state.history.slice(0, 50);   // keep the last 50 records
  lastTaken = taken;
  lastMissed = missed;

  if (changed) {
    saveState(state);
    renderHistoryAndSchedule();
  }
}

// Draw the history table and refresh the schedule badges
function renderHistoryAndSchedule() {
  const state = loadState();
  const body = el("historyBody");
  body.innerHTML = "";

  if (state.history.length === 0) {
    body.innerHTML = '<tr><td colspan="3">No records yet</td></tr>';
  } else {
    state.history.forEach((h) => {
      const tr = document.createElement("tr");
      let doseText = "Extra dose";
      if (h.dose) doseText = "Dose " + h.dose + (h.at ? " (" + h.at + ")" : "");
      const label = h.result === "taken" ? "Taken" : "Missed";
      [h.time, doseText, label].forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  renderScheduleList(currentSchedule);
}

// "Clear history" button
function clearHistory() {
  if (!confirm("Clear the dose history and today's Taken / Missed marks?")) return;
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  renderHistoryAndSchedule();
}

// =====================================================
//  REFRESH THE CARDS
// =====================================================
let lastScheduleSync = 0;

async function refresh() {
  if (DEMO_MODE) {
    setOnline(true, "Demo mode");
    const d = demoValues();
    showValues(d);
    trackChanges(d);
    return;
  }

  try {
    const [data, online] = await Promise.all([readValues(), readOnline()]);
    setOnline(online);
    showValues(data);
    trackChanges(data);
    renderScheduleList(currentSchedule);   // keeps "Next" correct and handles a new day

    // Now and then, check if the schedule was changed somewhere else
    if (Date.now() - lastScheduleSync > SCHEDULE_SYNC_MS) {
      lastScheduleSync = Date.now();
      syncScheduleFromDevice();
    }
  } catch (err) {
    console.error("Dashboard error:", err);
    setOnline(false);
    el("doseStatus").textContent = "Cannot reach Blynk";
  }
}

// =====================================================
//  SCHEDULE FORM: user chooses how many doses and when
// =====================================================
const DEFAULT_TIMES = {
  1: ["08:00"],
  2: ["08:00", "20:00"],
  3: ["08:00", "14:00", "21:00"],
  4: ["08:00", "12:00", "16:00", "20:00"],
  5: ["07:00", "11:00", "15:00", "19:00", "22:00"],
  6: ["06:00", "10:00", "14:00", "18:00", "21:00", "23:00"]
};

// Draw one time box per dose
function renderTimeInputs(count, values) {
  const box = el("timeInputs");
  box.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const field = document.createElement("label");
    field.className = "time-field";

    const title = document.createElement("span");
    title.textContent = "Dose " + (i + 1);

    const input = document.createElement("input");
    input.type = "time";
    input.required = true;
    input.value = (values && values[i]) || DEFAULT_TIMES[count][i];

    field.append(title, input);
    box.appendChild(field);
  }
}

function readTimeInputs() {
  return [...document.querySelectorAll("#timeInputs input")].map((i) => i.value);
}

// Redraw the "Today's schedule" list (Taken / Missed / Next / Pending)
function renderScheduleList(times) {
  const list = el("scheduleList");
  list.innerHTML = "";

  const results = loadState().results;
  const now = nowMinutes();
  let nextMarked = false;

  times.forEach((time, i) => {
    let cls = "pending";
    let label = "Pending";

    if (results[time] === "taken") {
      cls = "taken";
      label = "Taken";
    } else if (results[time] === "missed") {
      cls = "missed";
      label = "Missed";
    } else if (!nextMarked && minutesOf(time) >= now) {
      cls = "pending next";
      label = "Next";
      nextMarked = true;
    }

    const li = document.createElement("li");
    const a = document.createElement("span");
    const b = document.createElement("span");
    const c = document.createElement("span");

    a.textContent = "Dose " + (i + 1);
    b.textContent = time;
    c.className = "badge " + cls;
    c.textContent = label;

    li.append(a, b, c);
    list.appendChild(li);
  });
}

function showMsg(text, type) {
  const m = el("saveMsg");
  m.textContent = text;
  m.className = "msg " + type;
}

// Turn "8:0" style text into "08:00" and drop bad entries
function cleanTimes(list) {
  return list
    .map((t) => String(t).trim())
    .filter((t) => /^\d{1,2}:\d{1,2}$/.test(t))
    .map((t) => {
      const [h, m] = t.split(":");
      return h.padStart(2, "0") + ":" + m.padStart(2, "0");
    });
}

// Use a new schedule everywhere on the page
function applySchedule(times) {
  currentSchedule = times;
  el("doseCount").value = times.length;
  renderTimeInputs(times.length, times);
  renderScheduleList(times);
  formDirty = false;
}

// Save the schedule (to Blynk V5, or to the browser in demo mode)
async function saveSchedule() {
  const times = readTimeInputs();

  if (times.some((t) => !t)) {
    showMsg("Please fill in every dose time.", "error");
    return;
  }
  if (new Set(times).size !== times.length) {
    showMsg("Two doses have the same time. Please change one.", "error");
    return;
  }

  times.sort();
  const value = times.join(",");
  const btn = el("saveBtn");
  btn.disabled = true;

  try {
    if (DEMO_MODE) {
      saveDemoSchedule(times);
    } else {
      const url = `${BLYNK_SERVER}/external/api/update?token=${BLYNK_TOKEN}&v5=${encodeURIComponent(value)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Blynk returned HTTP " + res.status);
    }

    applySchedule(times);
    lastScheduleSync = Date.now();

    showMsg(
      DEMO_MODE
        ? "Saved: " + value + " (demo mode: not sent to a device)"
        : "Saved: " + value + ". The device updates within a few seconds.",
      "ok"
    );
  } catch (err) {
    console.error("Save error:", err);
    showMsg("Could not save. " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// Read the schedule text (V5) from Blynk. Returns an array like ["08:00","14:00"]
async function fetchDeviceSchedule() {
  const res = await fetch(`${BLYNK_SERVER}/external/api/get?token=${BLYNK_TOKEN}&v5`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  let text = (await res.text()).trim();

  try {                                  // handle JSON or plain text
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) text = String(parsed[0]);
    else if (typeof parsed === "object" && parsed) text = String(parsed.v5 ?? parsed.V5 ?? "");
    else text = String(parsed);
  } catch (e) { /* plain text, keep as is */ }

  return cleanTimes(text.split(",")).slice(0, 6).sort();
}

// If the schedule was changed somewhere else (Blynk app, another browser),
// show the new times here too. Skipped while the user is editing the form.
async function syncScheduleFromDevice() {
  if (DEMO_MODE || formDirty || el("saveBtn").disabled) return;
  try {
    const times = await fetchDeviceSchedule();
    if (times.length === 0) return;
    if (formDirty) return;
    if (times.join(",") !== currentSchedule.join(",")) {
      applySchedule(times);
      showMsg("Schedule updated from the device: " + times.join(", "), "ok");
    }
  } catch (err) {
    console.error("Schedule sync error:", err);
  }
}

// Load the schedule when the page opens
async function loadSchedule() {
  let times = [];

  if (DEMO_MODE) {
    times = cleanTimes(readDemoSchedule() || []).slice(0, 6);
  } else {
    try {
      times = await fetchDeviceSchedule();
    } catch (err) {
      console.error("Load schedule error:", err);
    }
  }

  if (times.length === 0) times = DEFAULT_TIMES[3];   // fallback
  applySchedule(times);
}

// When the user changes the number of doses, redraw the boxes
el("doseCount").addEventListener("change", () => {
  const count = parseInt(el("doseCount").value, 10);
  renderTimeInputs(count, readTimeInputs());
  formDirty = true;
});

// Any change in a time box means "not saved yet"
el("timeInputs").addEventListener("input", () => { formDirty = true; });

el("saveBtn").addEventListener("click", saveSchedule);
el("clearBtn").addEventListener("click", clearHistory);

// =====================================================
//  START
// =====================================================
loadSchedule().then(renderHistoryAndSchedule);   // schedule first, then history + badges
refresh();                                       // run once now
setInterval(refresh, REFRESH_MS);                // then repeat