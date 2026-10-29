const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const gameNames = { context: "Semantic Hunt", krillion: "Krillion", wordle: "Wordle elimination" };
const descriptions = {
  context: "Chat guesses a secret noun. Each win builds the streak, then a new word starts automatically.",
  krillion: "One answer per viewer. When time runs out, AI scores relevance and originality.",
  wordle: "A shared five-letter word, six guesses each. Solve before the timer to survive.",
};
const instructions = {
  context: "Type a word directly in Twitch chat. Known compounds like sand castle work too. Every guess is compared with the same secret. Category hints can reveal at the start, halfway through, or in the final quarter. Solver earns 100 points, Biggest Leap 50, and Pathfinder 30. Useful new best guesses must gain at least one similarity point. With clutch time enabled, a five-point improvement in the final ten seconds adds five seconds, once per viewer and up to fifteen seconds per round.",
  krillion: "Submit one answer with !answer YOUR ANSWER. Scores reveal when the timer ends.",
  wordle: "Type !join, then !guess WORD. Each viewer has a personal board and up to six guesses.",
};
let draft = {};
try { draft = JSON.parse(localStorage.getItem("brb-game-settings") || "{}"); } catch {}
if (!draft || typeof draft !== "object") draft = {};
let selectedGame = gameNames[draft.mode] ? draft.mode : "context";
let selectedDifficulty = ["easy", "normal", "hard"].includes(draft.difficulty) ? draft.difficulty : "easy";
let clutchEnabled = draft.clutchEnabled !== false;
let hintsEnabled = draft.hintsEnabled !== false;
let hintTiming = ["start", "middle", "end"].includes(draft.hintTiming) ? draft.hintTiming : "middle";
const durations = { context: 60, krillion: 30, wordle: 45 };
for (const mode of Object.keys(durations)) {
  const choices = mode === "context" ? [30, 45, 60, 120, 180, 300] : [30, 45, 60];
  if (choices.includes(draft.durations?.[mode])) durations[mode] = draft.durations[mode];
}
let latestState = null;
let latestConfig = null;
let startingFresh = false;
let controlsAllowed = false;
let busy = false;
let events = null;
let eventView = null;
let configRequest = null;
let hydratedGame = false;
let editorDirty = false;
let overlaySource = null;
let quota = null;
let hydratedSettings = false;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

function saveDraft() {
  try {
    localStorage.setItem("brb-game-settings", JSON.stringify({
      mode: selectedGame, durations, prompt: $("#krillion-prompt").value, difficulty: selectedDifficulty, clutchEnabled, hintsEnabled, hintTiming,
    }));
  } catch {}
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed (" + response.status + ")");
  return result;
}

function canEditCurrent() {
  return !startingFresh && latestState?.kind === selectedGame &&
    (latestState.phase === "playing" || selectedGame === "context" && latestState.phase === "finished");
}

function renderEditor() {
  $("#game-mode").value = selectedGame;
  $(".setup-panel").dataset.game = selectedGame;
  $("#game-description").textContent = descriptions[selectedGame];
  $("#context-difficulty").value = selectedDifficulty;
  $("#context-clutch").checked = clutchEnabled;
  $("#context-hints").checked = hintsEnabled;
  $("#context-hint-timing").value = hintTiming;
  const targetCount = latestState?.targetCounts?.[selectedDifficulty];
  const remaining = latestState?.contextNextDifficulty === selectedDifficulty ? latestState?.bagRemaining : null;
  $("#context-bag-note").textContent = (targetCount ? targetCount.toLocaleString() + " nouns. " : "") + (Number.isFinite(remaining) ? remaining + " left in this bag. " : "") + "Automatic picks do not repeat until this pool is used.";
  $("#context-model-note").textContent = "Local commonsense associations" + (latestState?.supportedWords ? " · " + latestState.supportedWords.toLocaleString() + " supported guess words" : "") + ". Rank #1 is the answer; percentages show association strength.";
  $$(".mode-settings").forEach((section) => section.classList.toggle("hidden", section.dataset.mode !== selectedGame));
  for (const mode of Object.keys(durations)) {
    $$("#" + mode + "-duration button").forEach((button) => {
      const selected = Number(button.dataset.seconds) === durations[mode];
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  const editing = canEditCurrent();
  $("#setup-heading").textContent = editing ? "Edit your game" : "Set up your game";
  $("#context-secret-field").classList.toggle("hidden", editing);
  $("#krillion-prompt-field").classList.toggle("hidden", editing);
  const nextKrillion = selectedGame === "krillion" && latestState?.kind === "krillion" && latestState.phase === "round-complete";
  $("#game-submit").textContent = busy ? "Saving…" : editing ? selectedGame === "context" ? "Apply settings" : "Apply timer" : nextKrillion ? "Start next round →" : "Start " + gameNames[selectedGame] + " →";
  $("#game-submit").disabled = busy || !controlsAllowed || selectedGame === "krillion" && !editing && !quota?.available;
  $("#context-hint-timing").disabled = busy || !controlsAllowed || !hintsEnabled;
  $("#krillion-quota").textContent = quota ? quota.available ? quota.dailyRemaining + " judged rounds left today · $" + Number(quota.monthlyRemainingUsd).toFixed(2) + " shared AI budget left this month." : quota.reason : "Connect Twitch to see your Krillion allowance.";
  $("#editor-note").textContent = editing
    ? selectedGame === "context" ? "Timer, hint and clutch changes apply now. Difficulty changes apply to the next word. Answers and progress are kept." : "Timer changes keep this round’s answers and progress. Time is measured from when the round began."
    : startingFresh && latestState?.kind !== "idle"
      ? "Starting fresh resets the current game and its progress."
      : selectedGame === "context" ? "Each new round uses this time limit." : "";
  const sameGameRunning = latestState?.kind === selectedGame && (latestState.phase === "playing" || selectedGame === "context" && latestState.phase === "finished");
  $("#fresh-game").classList.toggle("hidden", !sameGameRunning);
  $("#fresh-game").textContent = startingFresh ? "Back to editing" : "Start fresh";
  $("#fresh-game").disabled = busy || !controlsAllowed;
  $("#stop-game").disabled = busy || !controlsAllowed || !latestState || latestState.kind === "idle";
  $("#viewer-instructions").textContent = instructions[latestState?.kind !== "idle" && latestState ? latestState.kind : selectedGame];
}

function renderClock() {
  const state = latestState;
  const timed = state?.endsAt && (state.phase === "playing" || state.kind === "context" && state.phase === "finished");
  const seconds = timed ? Math.max(0, Math.ceil((state.endsAt - (state.paused ? state.pausedAt : Date.now())) / 1000)) : null;
  $("#stat-clock").textContent = seconds === null ? "—" : Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function renderControl(state) {
  const previousTarget = latestState?.privateTarget;
  latestState = state;
  if (state.krillionQuota) quota = state.krillionQuota;
  if (state.kind !== "idle" && !editorDirty && !startingFresh && (!hydratedGame || selectedGame === state.kind)) {
    if (!hydratedGame) selectedGame = state.kind;
    durations[state.kind] = state.durationSeconds;
    if (state.kind === "context") {
      selectedDifficulty = state.contextNextDifficulty || "easy";
      clutchEnabled = state.contextClutchEnabled !== false;
      hintsEnabled = state.contextHintsEnabled !== false;
      hintTiming = ["start", "middle", "end"].includes(state.contextHintTiming) ? state.contextHintTiming : "middle";
    }
    hydratedGame = true;
    saveDraft();
  }
  $("#live-title").textContent = gameNames[state.kind] || "No game running";
  const phase = state.kind === "context" && state.phase === "finished" ? "NEXT ROUND" : state.phase.toUpperCase().replaceAll("-", " ");
  $("#phase-badge").textContent = state.paused ? "PAUSED" : phase;
  $("#phase-badge").classList.toggle("active", state.phase === "playing");
  $("#live-message").textContent = state.message;
  $("#current-difficulty").classList.toggle("hidden", state.kind !== "context");
  const difficultyName = (value) => value === "normal" ? "Standard" : value === "hard" ? "Expert" : "Easy";
  $("#current-difficulty").textContent = "This word: " + difficultyName(state.contextDifficulty) + (state.contextDifficulty !== state.contextNextDifficulty ? " · Next word: " + difficultyName(state.contextNextDifficulty) : "");
  $("#stat-round").textContent = state.round || "—";
  const players = state.players || [];
  const count = state.kind === "wordle" ? players.filter((player) => player.alive).length :
    state.kind === "krillion" ? state.krillionAnswerCount || 0 :
      state.contextPlayerCount ?? new Set((state.contextGuesses || []).map((guess) => guess.by)).size;
  $("#stat-players").textContent = String(count);
  const privateAnswer = $("#control-secret");
  privateAnswer.classList.toggle("hidden", !state.privateTarget || state.phase !== "playing");
  $("#private-answer").textContent = state.privateTarget || "";
  if (previousTarget !== state.privateTarget) privateAnswer.open = false;
  $("#krillion-prompt-live").classList.toggle("hidden", state.kind !== "krillion");
  $("#krillion-prompt-live").textContent = state.krillionPrompt || "";
  $("#retry-krillion-judging").classList.toggle("hidden", !(state.kind === "krillion" && state.phase === "round-complete" && !state.krillionJudged));
  $("#storage-note").textContent = state.storageWarning || "";
  $("#storage-note").classList.toggle("hidden", !state.storageWarning);
  renderCommunity(state);
  renderClock();
  renderEditor();
}

function renderCommunity(state) {
  const records = state.community || {};
  $("#community-name").textContent = (records.name || "Your community") + " · " + (records.contributors || 0) + " contributors";
  $("#record-summary").textContent = (records.wins || 0) + (records.wins === 1 ? " win · best streak " : " wins · best streak ") + (records.bestStreak || 0);
  $("#record-wins").textContent = String(records.wins || 0);
  $("#record-streak").textContent = String(records.bestStreak || 0);
  $("#record-fastest").textContent = records.fastestSolve ? (records.fastestSolve.ms / 1000).toFixed(1) + "s" : "—";
  $("#record-fastest-detail").textContent = records.fastestSolve ? records.fastestSolve.by + " found “" + records.fastestSolve.word + "” · " + (records.fastestSolve.difficulty === "normal" ? "Standard" : records.fastestSolve.difficulty === "hard" ? "Expert" : "Easy") : "Records are saved for this community after each round.";
  for (const [id, scores] of [["session-leaders", state.contextSessionScores || []], ["community-leaders", records.leaderboard || []]]) {
    const list = $("#" + id);
    list.replaceChildren();
    if (!scores.length) {
      const empty = document.createElement("li");
      empty.className = "empty-contributors";
      empty.textContent = "No awards yet. Help chat get closer.";
      list.append(empty);
    }
    for (const score of scores.slice(0, 5)) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const points = document.createElement("strong");
      name.textContent = score.displayName;
      points.textContent = score.points + " pts";
      row.append(name, points);
      list.append(row);
    }
  }
}

function connectEvents(view) {
  if (events && view === eventView) return;
  events?.close();
  eventView = view;
  events = new EventSource("/api/events?view=" + view);
  events.addEventListener("state", (event) => {
    try { renderControl(JSON.parse(event.data)); } catch (error) { console.warn(error); }
  });
  events.addEventListener("patch", (event) => {
    try { renderControl({ ...latestState, ...JSON.parse(event.data) }); } catch (error) { console.warn(error); }
  });
  events.addEventListener("connection", () => refreshConfig());
  events.onopen = () => refreshConfig();
  events.onerror = () => {
    $("#connection-state").textContent = "Restoring dashboard…";
    refreshConfig();
  };
}

async function refreshConfig() {
  if (configRequest) return configRequest;
  configRequest = (async () => {
    try {
      const config = await request("/api/config");
      latestConfig = config;
      quota = config.krillionQuota;
      if (!hydratedSettings && config.settings?.mode) {
        const settings = config.settings;
        for (const mode of Object.keys(durations)) if ((mode === "context" ? [30, 45, 60, 120, 180, 300] : [30, 45, 60]).includes(settings.durations?.[mode])) durations[mode] = settings.durations[mode];
        if (gameNames[settings.mode]) { selectedGame = settings.mode; durations[selectedGame] = settings.durationSeconds || durations[selectedGame]; }
        if (["easy", "normal", "hard"].includes(settings.difficulty)) selectedDifficulty = settings.difficulty;
        clutchEnabled = settings.clutchEnabled !== false;
        hintsEnabled = settings.hintsEnabled !== false;
        hintTiming = ["start", "middle", "end"].includes(settings.hintTiming) ? settings.hintTiming : "middle";
        if (typeof settings.prompt === "string") $("#krillion-prompt").value = settings.prompt;
        hydratedSettings = true;
      }
      controlsAllowed = !config.twitchConfigured || config.twitchAuthenticated;
      $("#account-tools").classList.toggle("hidden", !config.twitchAuthenticated);
      $("#operator-link").classList.toggle("hidden", !config.isOwner);
      $("#rotate-overlay").classList.toggle("hidden", !config.twitchAuthenticated);
      $(".overlay-link").classList.toggle("hidden", !config.overlayUrl);
      $("#source-placeholder").textContent = config.overlayUrl ? "TRANSPARENT OVERLAY" : "CONNECT TWITCH TO GET YOUR PERSONAL SOURCE";
      if (overlaySource !== config.overlayUrl) {
        overlaySource = config.overlayUrl;
        $("#overlay-url").textContent = overlaySource || "Connect an invited Twitch account first.";
        $("#overlay-preview").src = overlaySource ? overlaySource + "?preview=1" : "about:blank";
        if (overlaySource) $(".overlay-link").href = overlaySource;
      }
      const status = $("#connection-state");
      status.textContent = config.twitchConnected ? "Connected · " + config.channel : config.status;
      status.closest(".status-pill").classList.toggle("connected", Boolean(config.twitchConnected));
      status.closest(".status-pill").title = config.message;
      const connect = $("#connect-button");
      connect.classList.toggle("hidden", Boolean(config.twitchAuthenticated));
      connect.disabled = !config.twitchConfigured;
      connect.textContent = config.twitchConfigured ? "Connect Twitch" : "Twitch setup needed";
      connect.title = config.message;
      $("#logout-button").classList.toggle("hidden", !config.twitchAuthenticated);
      const note = $("#connection-note");
      note.classList.toggle("hidden", !config.twitchConfigured || config.twitchConnected);
      note.textContent = config.message;
      $("#demo-tools").classList.toggle("hidden", config.twitchConfigured);
      if (controlsAllowed) connectEvents("control");
      else { events?.close(); events = null; eventView = null; }
      renderEditor();
    } catch (error) {
      $("#connection-state").textContent = "Waiting for server…";
      console.warn(error);
    }
  })();
  try { await configRequest; } finally { configRequest = null; }
}

async function control(body) {
  const result = await request("/api/control", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  renderControl(result.state);
  return result;
}

$("#krillion-prompt").value = typeof draft.prompt === "string" ? draft.prompt : "";
$("#game-mode").addEventListener("change", (event) => {
  editorDirty = true;
  selectedGame = event.target.value;
  startingFresh = false;
  saveDraft();
  renderEditor();
});
for (const mode of Object.keys(durations)) {
  $$("#" + mode + "-duration button").forEach((button) => button.addEventListener("click", () => {
    editorDirty = true;
    durations[mode] = Number(button.dataset.seconds);
    saveDraft();
    renderEditor();
  }));
}
$("#krillion-prompt").addEventListener("input", () => { editorDirty = true; saveDraft(); });
$("#context-secret").addEventListener("input", () => { editorDirty = true; });
$("#context-difficulty").addEventListener("change", (event) => { editorDirty = true; selectedDifficulty = event.target.value; saveDraft(); renderEditor(); });
$("#context-hints").addEventListener("change", (event) => { editorDirty = true; hintsEnabled = event.target.checked; saveDraft(); renderEditor(); });
$("#context-hint-timing").addEventListener("change", (event) => { editorDirty = true; hintTiming = event.target.value; saveDraft(); renderEditor(); });
$("#context-clutch").addEventListener("change", (event) => { editorDirty = true; clutchEnabled = event.target.checked; saveDraft(); renderEditor(); });
$("#fresh-game").addEventListener("click", () => { startingFresh = !startingFresh; renderEditor(); });
$("#game-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !controlsAllowed) return;
  const editing = canEditCurrent();
  const body = editing
    ? { action: "configure", durationSeconds: durations[selectedGame], difficulty: selectedGame === "context" ? selectedDifficulty : undefined, clutchEnabled: selectedGame === "context" ? clutchEnabled : undefined, hintsEnabled: selectedGame === "context" ? hintsEnabled : undefined, hintTiming: selectedGame === "context" ? hintTiming : undefined }
    : { action: selectedGame, durationSeconds: durations[selectedGame],
        difficulty: selectedGame === "context" ? selectedDifficulty : undefined, clutchEnabled: selectedGame === "context" ? clutchEnabled : undefined,
        hintsEnabled: selectedGame === "context" ? hintsEnabled : undefined,
        hintTiming: selectedGame === "context" ? hintTiming : undefined,
        secret: selectedGame === "context" ? $("#context-secret").value.trim() || undefined : undefined,
        prompt: selectedGame === "krillion" ? $("#krillion-prompt").value.trim() || undefined : undefined };
  busy = true;
  renderEditor();
  try {
    await control(body);
    startingFresh = false;
    editorDirty = false;
    hydratedGame = true;
    $("#context-secret").value = "";
    saveDraft();
    toast(editing ? selectedGame === "context" ? "Hunt settings updated." : "Round timer updated." : gameNames[selectedGame] + " is live.");
  } catch (error) { toast(error.message); }
  finally { busy = false; renderEditor(); }
});
$("#stop-game").addEventListener("click", async () => {
  try { await control({ action: "stop" }); startingFresh = false; renderEditor(); toast("Game stopped."); }
  catch (error) { toast(error.message); }
});
$("#retry-krillion-judging").addEventListener("click", async () => {
  try { await control({ action: "retry-krillion-judging" }); }
  catch (error) { toast(error.message); }
});
$("#connect-button").addEventListener("click", () => { location.href = "/auth/start"; });
$("#logout-button").addEventListener("click", async () => {
  try {
    await request("/auth/logout", { method: "POST" });
    location.href = "/";
  } catch (error) { toast(error.message); }
});
$("#overlay-url").textContent = "Connect Twitch to get your personal OBS URL.";
$("#copy-overlay").addEventListener("click", async () => {
  if (!overlaySource) { toast("Connect Twitch first."); return; }
  try { await navigator.clipboard.writeText(overlaySource); toast("Browser source URL copied."); }
  catch { toast("Select the URL above to copy it."); }
});
$("#rotate-overlay").addEventListener("click", async () => {
  if (!confirm("Replace your OBS URL? Your old source will stop working. Paste the new URL into OBS afterward.")) return;
  try { await request("/api/overlay/rotate", { method: "POST" }); await refreshConfig(); toast("OBS URL replaced. Update your source in OBS."); }
  catch (error) { toast(error.message); }
});
$("#delete-account").addEventListener("click", async () => {
  try {
    await request("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: $("#delete-confirm").value }) });
    location.href = "/?notice=deleted";
  } catch (error) { toast(error.message); }
});
$("#demo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#demo-message").value.trim();
  if (!text || latestConfig?.twitchConfigured) return;
  const login = $("#demo-name").value.trim() || "viewer1";
  try {
    await request("/api/demo/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login, displayName: login, text }) });
    $("#demo-message").value = "";
    $("#demo-message").focus();
  } catch (error) { toast(error.message); }
});

const params = new URLSearchParams(location.search);
if (params.get("notice") === "invite-required") toast("This beta is invite-only. Ask the operator to invite your Twitch account.");
if (params.get("notice") === "deleted") toast("Your channel data and Twitch access have been removed.");
if (params.has("connected")) {
  toast("Twitch connected. Restoring chat…");
  params.delete("connected");
  history.replaceState(null, "", location.pathname + (params.size ? "?" + params : ""));
}
renderEditor();
refreshConfig();
setInterval(renderClock, 250);
setInterval(refreshConfig, 10_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshConfig(); });
