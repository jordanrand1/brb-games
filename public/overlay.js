const $ = (selector) => document.querySelector(selector);
document.body.classList.toggle("embedded-preview", new URLSearchParams(location.search).has("preview"));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
let lastState = null;

function guessHeat(entry, exact, ai) {
  if (exact) return "solved";
  const score = Number.isFinite(entry.similarity) ? entry.similarity : 0;
  if (ai) return score >= .75 ? "hot" : score >= .55 ? "warm" : score >= .3 ? "cool" : "cold";
  // Rank is relative to this word's neighbors. A weak 17% association must
  // stay cold even if it happens to be the best submitted guess.
  if (entry.rank <= 10 && score >= .5) return "hot";
  if (entry.rank <= 250 && score >= .3) return "warm";
  if (entry.rank <= 1500 && score >= .2) return "cool";
  return "cold";
}

function fitOverlay() {
  const card = document.querySelector(".overlay-card:not(.hidden)");
  if (!card) return;
  const embedded = document.body.classList.contains("embedded-preview");
  const height = window.innerHeight * (embedded ? .94 : .93);
  const width = window.innerWidth * .94;
  const scale = Math.min(1, height / card.offsetHeight, width / card.offsetWidth);
  card.style.transform = "scale(" + scale + ")";
  card.style.transformOrigin = embedded ? "center" : "top right";
}
const overlayResize = new ResizeObserver(fitOverlay);
document.querySelectorAll(".overlay-card").forEach((card) => overlayResize.observe(card));
window.addEventListener("resize", fitOverlay);

function updateContextClock(state) {
  const now = state.paused ? state.pausedAt : Date.now();
  const marathon = state.contextMode === "marathon";
  $("#marathon-banner").classList.toggle("hidden", !marathon);
  if (marathon) {
    const ms = state.phase === "playing" ? Math.max(0, (state.endsAt || now) - now) : state.contextMarathonClockMs || 0;
    const seconds = Math.ceil(ms / 1000);
    $("#marathon-run-clock").textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    $("#marathon-word-count").textContent = String(state.contextMarathonSolves || 0);
    $("#marathon-best").textContent = String(state.community?.bestMarathonWords || 0);
  }
  const category = $("#context-category-hint");
  const hasHint = state.phase === "playing" && state.contextHintsEnabled !== false && (state.contextHint || state.contextHintAt);
  category.classList.toggle("hidden", !hasHint);
  category.classList.toggle("hint-revealed", Boolean(state.contextHint));
  if (hasHint) {
    $("#context-category-label").textContent = state.contextHint ? "CATEGORY REVEALED" : "CATEGORY HINT";
    const wait = Math.max(0, Math.ceil((state.contextHintAt - now) / 1000));
    $("#context-category-text").textContent = state.contextHint || (wait > 0 ? "Reveals in " + Math.floor(wait / 60) + ":" + String(wait % 60).padStart(2, "0") : "Revealing…");
  }
  const remaining = state.endsAt ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0;
  const reveal = state.phase === "finished";
  $("#context-clock").textContent = remaining >= 60 ? Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0") : String(remaining);
  $("#context-clock-label").textContent = state.paused ? "PAUSED" : state.contextMarathonEnded ? "RUN OVER" : state.contextVote ? "VOTE ENDS" : reveal ? "NEXT WORD" : "TIME LEFT";
  const proportion = state.endsAt ? Math.max(0, Math.min(1, (state.endsAt - now) / (reveal ? state.contextVote ? 10000 : 8000 : (state.durationSeconds + (state.contextClutchSeconds || 0)) * 1000))) : 0;
  $("#context-timer").style.setProperty("--timer-angle", proportion * 360 + "deg");
  $("#context-timer").classList.toggle("urgent", !reveal && remaining <= 10);
  const clutch = state.phase === "playing" && state.contextClutchEvent && Date.now() - state.contextClutchEvent.at < 4500;
  $("#context-clutch-banner").classList.toggle("hidden", !clutch);
  $("#context-timer").classList.toggle("clutch-lift", Boolean(clutch));
  if (clutch) $("#context-clutch-by").textContent = state.contextClutchEvent.by + " kept the hunt alive";
}

function render(state) {
  const previousState = lastState;
  lastState = state;
  const waiting = $("#waiting-card");
  const contextCard = $("#context-card");
  const wordleCard = $("#wordle-card");
  const krillionCard = $("#krillion-card");
  waiting.classList.toggle("hidden", state.kind !== "idle");
  contextCard.classList.toggle("hidden", state.kind !== "context");
  wordleCard.classList.toggle("hidden", state.kind !== "wordle");
  krillionCard.classList.toggle("hidden", state.kind !== "krillion");
  if (state.kind === "context") {
    const guesses = state.contextGuesses || [];
    const finished = state.phase === "finished";
    const answerReveal = finished && state.target;
    contextCard.classList.toggle("round-finished", finished);
    contextCard.classList.toggle("round-won", finished && Boolean(state.winner));
    $("#overlay-message").textContent = state.message || "Every guess brings chat a little closer.";
    $("#context-answer").classList.toggle("hidden", !answerReveal);
    if (answerReveal) {
      $("#context-answer-label").textContent = state.winner ? "WORD FOUND! CHAT WINS" : "TIME’S UP · THE WORD WAS";
      $("#context-answer-word").textContent = state.target;
      $("#context-answer-by").textContent = state.contextMarathonEnded ? "Marathon over · " + (state.contextMarathonSolves || 0) + " word" + (state.contextMarathonSolves === 1 ? "" : "s") + " solved" : state.winner ? "Solved by " + state.winner + (state.contextMode === "marathon" ? " · +15 seconds" : "") : "A fresh hunt is coming up.";
    }
    $("#context-round").textContent = "R" + String(state.round || 1).padStart(2, "0");
    $("#theme-vote").classList.toggle("hidden", !state.contextVote);
    if (state.contextVote) $("#theme-options").innerHTML = state.contextVote.options.map((entry, index) => '<div class="theme-option"><b>' + (index + 1) + '</b><span>' + escapeHtml(entry.label) + '</span><i>' + entry.votes + (entry.votes === 1 ? ' vote' : ' votes') + '</i></div>').join("");
    $("#active-theme").classList.toggle("hidden", !state.contextTheme || state.contextTheme === "mystery");
    $("#active-theme").textContent = "THEME · " + ({ animals: "Animals & wildlife", food: "Food & drink", nature: "Nature & gardens", home: "Home & furniture", travel: "Transport & travel", sports: "Sports & games", technology: "Tools & technology" }[state.contextTheme] || "Mystery");
    $("#context-difficulty-badge").textContent = state.contextDifficulty === "normal" ? "STANDARD" : state.contextDifficulty === "hard" ? "EXPERT" : "EASY";
    const community = state.community || {};
    $("#overlay-record-streak").textContent = "BEST STREAK " + (community.bestStreak || 0);
    $("#overlay-record-wins").textContent = (community.wins || 0) + (community.wins === 1 ? " WIN" : " WINS");
    $("#overlay-record-fastest").textContent = "FASTEST " + (community.fastestSolve ? (community.fastestSolve.ms / 1000).toFixed(1) + "s" : "—");
    const awards = finished ? state.contextAwards || [] : [];
    const awardNames = { solver: "SOLVER", biggestLeap: "BIGGEST LEAP", pathfinder: "PATHFINDER" };
    const awardIcons = { solver: "✦", biggestLeap: "↗", pathfinder: "◎" };
    $("#context-awards").classList.toggle("hidden", !awards.length);
    $("#context-awards").style.setProperty("--award-count", String(awards.length || 1));
    $("#context-awards").innerHTML = awards.map((award) => '<div class="hunt-award award-' + escapeHtml(award.kind) + '"><span class="award-icon" aria-hidden="true">' + awardIcons[award.kind] + '</span><span class="award-name">' + awardNames[award.kind] + '</span><strong>' + escapeHtml(award.displayName) + '</strong><span class="award-detail">' + (award.kind === "biggestLeap" ? "+" + award.value + " similarity pts · " : award.kind === "pathfinder" ? award.value + " new best" + (award.value === 1 ? "" : "s") + " · " : "") + "+" + award.points + ' pts</span></div>').join("");
    $("#guess-count").textContent = String(state.contextGuessCount ?? guesses.length);
    const streak = state.contextStreak || 0;
    const levelProgress = state.contextLevelProgress || 0;
    $("#context-hype-level").textContent = "LEVEL " + (state.contextLevel || 1);
    $("#context-hype-wins").textContent = streak ? streak + " consecutive win" + (streak === 1 ? "" : "s") : "Keep the hunt alive";
    $("#context-hype-progress").textContent = levelProgress + " / 3 TO LEVEL UP";
    $("#context-hype-fill").style.width = Math.round(levelProgress / 3 * 100) + "%";
    $("#context-streak-footer").textContent = String(streak);
    const sameRound = previousState?.kind === "context" && previousState.startedAt === state.startedAt;
    const previousLatest = sameRound ? Math.max(0, ...(previousState.contextGuesses || []).map((entry) => entry.at)) : 0;
    const bestHeat = guesses.length ? guessHeat(guesses[0], false, state.semanticMode === "ai") : null;
    const direction = $("#context-direction");
    direction.classList.toggle("hidden", finished || !guesses.length);
    direction.dataset.heat = bestHeat || "cold";
    direction.textContent = bestHeat === "cold" ? "Still cold · try a different topic"
      : bestHeat === "cool" ? "A weak connection · keep exploring other topics too"
        : bestHeat === "warm" ? "Getting warmer · explore related words"
          : "Strong connection · explore this topic";
    $("#overlay-guesses").innerHTML = guesses.length ? guesses.slice(0, 5).map((entry, index) => {
      const exact = finished && entry.word === state.target;
      const hasScore = exact || Number.isFinite(entry.similarity);
      const percentage = exact ? 100 : Math.round(Math.max(0, Math.min(1, entry.similarity || 0)) * 100);
      const heat = guessHeat(entry, exact, state.semanticMode === "ai");
      const heatLabel = exact ? "FOUND IT" : percentage >= 75 ? "SO CLOSE" : percentage >= 55 ? "WARMING UP" : percentage >= 30 ? "GETTING CLOSER" : "KEEP HUNTING";
      const rankLabel = state.semanticMode === "ai" ? heatLabel : "RANK #" + entry.rank;
      const classes = "hunt-guess heat-" + heat + (index === 0 ? " leader" : "") + (entry.at > previousLatest ? " fresh" : "");
      const scoreText = hasScore ? percentage + "<small>%</small>" : "#" + entry.rank;
      return '<div class="' + classes + '" style="--closeness:' + percentage + '%">' +
        '<div class="hunt-guess-top"><span class="guess-place">' + String(index + 1).padStart(2, "0") + '</span>' +
        '<div class="guess-info"><div class="guess-word-line"><strong>' + escapeHtml(entry.word) + '</strong>' + (index === 0 ? '<b class="closest-badge">' + (exact ? 'SOLVED' : heat === 'cold' ? 'BEST SO FAR · COLD' : heat === 'cool' ? 'BEST SO FAR · WEAK' : heat.toUpperCase()) + '</b>' : '') + '</div><span class="guess-viewer">' + escapeHtml(entry.by) + '</span></div>' +
        '<div class="guess-score"><strong>' + scoreText + '</strong><span>' + rankLabel + '</span></div></div>' +
        '<div class="guess-meter" role="progressbar" aria-label="' + escapeHtml(entry.word) + ' similarity" aria-valuemin="0" aria-valuemax="100"' + (hasScore ? ' aria-valuenow="' + percentage + '"' : ' aria-valuetext="Similarity unavailable"') + '><i></i><i></i><i></i><span class="guess-meter-fill"><b></b></span></div></div>';
    }).join("") : '<div class="hunt-empty"><span class="empty-crosshair" aria-hidden="true">◎</span><strong>Who’s got the first guess?</strong><span>Type a noun in chat. Watch the bars heat up.</span></div>';
    updateContextClock(state);
  }
  if (state.kind === "wordle") {
    $("#wordle-message").textContent = state.message || "Join the race with !join, then solve the word.";
    $("#wordle-round").textContent = `· ROUND ${state.round}`;
    $("#overlay-clock").textContent = state.endsAt ? String(Math.max(0, Math.ceil((state.endsAt - (state.paused ? state.pausedAt : Date.now())) / 1000))) : "—";
    const players = state.players || [];
    $("#overlay-players").innerHTML = players.length ? players.slice(0, 6).map((player) => {
      const attempts = player.attempts || [];
      const rows = attempts.length ? attempts.map((attempt) => `<div class="letter-row">${attempt.word.split("").map((letter, index) => `<span class="letter-tile ${attempt.colors[index]}">${escapeHtml(letter)}</span>`).join("")}</div>`).join("") : `<div class="player-empty">Waiting for a first guess…</div>`;
      return `<article class="player-card"><div class="player-top"><strong>${escapeHtml(player.displayName)}</strong><span class="player-badge ${player.alive ? "" : "out"}">${player.alive ? player.solved ? "SOLVED" : "IN THE RACE" : "ELIMINATED"}</span></div><div class="letter-grid">${rows}</div></article>`;
    }).join("") : `<div class="no-players">Be the first in.<br>Type <b>!join</b> in chat.</div>`;
  }
  if (state.kind === "krillion") {
    $("#krillion-question").textContent = state.krillionPrompt || "Answer the prompt.";
    $("#krillion-message").textContent = state.message || "One answer per viewer. Submit with !answer.";
    const answerCount = state.krillionAnswerCount || 0;
    $("#krillion-entries-count").textContent = `${answerCount} answer${answerCount === 1 ? "" : "s"} locked in`;
    $("#krillion-clock").textContent = state.endsAt && state.phase === "playing" ? String(Math.max(0, Math.ceil((state.endsAt - (state.paused ? state.pausedAt : Date.now())) / 1000))) : state.phase === "judging" ? "…" : "—";
    const results = state.krillionAnswers || [];
    $("#krillion-results").innerHTML = state.phase === "round-complete" && results.length
      ? results.slice(0, 8).map((entry, index) => `<div class="krillion-answer-row ${index === 0 && entry.score != null ? "winner" : ""}"><div class="krillion-answer-main"><strong>${escapeHtml(entry.answer)}</strong><span>${escapeHtml(entry.displayName)} · FIT ${entry.relevance == null ? "—" : `${entry.relevance}%`} · ORIGINAL ${entry.novelty == null ? "—" : `${entry.novelty}%`}</span></div><b class="krillion-points">${entry.score == null ? "—" : entry.score}</b></div>`).join("")
      : state.phase === "playing" ? `<div class="krillion-waiting">Scores reveal when time is up. Chat answers are public.</div>`
        : state.phase === "judging" ? `<div class="krillion-waiting">Checking which answers fit and which stood out…</div>`
          : `<div class="krillion-waiting">No answers this round.</div>`;
  }
  requestAnimationFrame(fitOverlay);
}

const sourceToken = location.pathname.startsWith("/overlay/") ? location.pathname.slice(9) : null;
const stream = new EventSource("/api/events" + (sourceToken ? "?source=" + encodeURIComponent(sourceToken) : ""));
stream.addEventListener("state", (event) => {
  try { render(JSON.parse(event.data)); } catch (error) { console.warn("Overlay state could not be read", error); }
});
stream.addEventListener("patch", (event) => {
  try { render({ ...lastState, ...JSON.parse(event.data) }); } catch (error) { console.warn("Overlay update could not be read", error); }
});
stream.onerror = () => { $("#overlay-message") && ($("#overlay-message").textContent = "Reconnecting to the game…"); };
setInterval(() => {
  if (lastState?.kind === "wordle") $("#overlay-clock").textContent = lastState.endsAt ? String(Math.max(0, Math.ceil((lastState.endsAt - (lastState.paused ? lastState.pausedAt : Date.now())) / 1000))) : "—";
  if (lastState?.kind === "context") updateContextClock(lastState);
  if (lastState?.kind === "krillion" && lastState.phase === "playing") $("#krillion-clock").textContent = lastState.endsAt ? String(Math.max(0, Math.ceil((lastState.endsAt - (lastState.paused ? lastState.pausedAt : Date.now())) / 1000))) : "—";
}, 250);
