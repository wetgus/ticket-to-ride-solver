import {
  USA_BOARD,
  areCitiesConnected,
  createBaseRulesConfig,
  getLegalClaimRouteActions
} from "../dist/browser.js";

const TRAIN_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "black",
  "white",
  "orange",
  "pink",
  "locomotive"
];

const SORTED_TRAIN_COLORS = [
  "black",
  "blue",
  "green",
  "locomotive",
  "orange",
  "pink",
  "red",
  "white",
  "yellow"
];

const CITY_POSITIONS = {
  vancouver: [70, 70],
  seattle: [90, 130],
  portland: [95, 185],
  "san-francisco": [105, 310],
  "los-angeles": [110, 430],
  "las-vegas": [165, 390],
  "salt-lake-city": [220, 315],
  phoenix: [225, 430],
  "santa-fe": [305, 395],
  "el-paso": [325, 470],
  calgary: [195, 95],
  helena: [285, 170],
  winnipeg: [365, 95],
  duluth: [465, 180],
  omaha: [455, 275],
  denver: [355, 300],
  "kansas-city": [505, 330],
  "oklahoma-city": [485, 400],
  dallas: [520, 470],
  houston: [555, 530],
  "little-rock": [565, 410],
  "new-orleans": [650, 520],
  atlanta: [730, 430],
  miami: [840, 585],
  charleston: [810, 445],
  raleigh: [785, 385],
  nashville: [665, 360],
  "saint-louis": [585, 320],
  pittsburgh: [760, 250],
  chicago: [620, 240],
  toronto: [740, 180],
  "sault-st-marie": [635, 120],
  montreal: [830, 120],
  boston: [905, 120],
  "new-york": [875, 175],
  washington: [860, 235]
};

const scoreRoutePoints = {
  1: 1,
  2: 2,
  3: 4,
  4: 7,
  5: 10,
  6: 15
};

const setupPlayerCount = document.getElementById("setup-player-count");
const setupOurSeat = document.getElementById("setup-our-seat");
const workspaceMode = document.getElementById("workspace-mode");
const startGameButton = document.getElementById("start-game");
const undoButton = document.getElementById("undo-button");
const statusText = document.getElementById("status-text");
const phaseLabel = document.getElementById("phase-label");
const activePlayerLabel = document.getElementById("active-player-label");
const turnLabel = document.getElementById("turn-label");
const actionModeLabel = document.getElementById("action-mode-label");
const handCards = document.getElementById("hand-cards");
const ownedTicketsList = document.getElementById("owned-tickets-list");
const playersSummary = document.getElementById("players-summary");
const boardContainer = document.getElementById("board-container");
const claimRouteModeButton = document.getElementById("claim-route-mode");
const cancelModeButton = document.getElementById("cancel-mode");
const contextTitle = document.getElementById("context-title");
const contextPanel = document.getElementById("context-panel");
const turnRecommendations = document.getElementById("turn-recommendations");
const actionRecommendations = document.getElementById("action-recommendations");
const blindDrawInsight = document.getElementById("blind-draw-insight");
const actionLog = document.getElementById("action-log");
const playWorkspace = document.getElementById("play-workspace");
const metadataWorkspace = document.getElementById("metadata-workspace");
const metadataGameIdInput = document.getElementById("metadata-game-id");
const metadataVariantSelect = document.getElementById("metadata-variant");
const metadataPlayerNameInput = document.getElementById("metadata-player-name");
const metadataSelectionTypeSelect = document.getElementById("metadata-selection-type");
const metadataMoveNumberInput = document.getElementById("metadata-move-number");
const metadataOfferedTickets = document.getElementById("metadata-offered-tickets");
const metadataKeptTickets = document.getElementById("metadata-kept-tickets");
const metadataAddSelectionButton = document.getElementById("metadata-add-selection");
const metadataDownloadButton = document.getElementById("metadata-download");
const metadataResetButton = document.getElementById("metadata-reset");
const metadataSelectionList = document.getElementById("metadata-selection-list");
const metadataPreview = document.getElementById("metadata-preview");
const replayWorkspace = document.getElementById("replay-workspace");
const replayFileInput = document.getElementById("replay-file-input");
const replayGameSelect = document.getElementById("replay-game-select");
const replayPrevStepButton = document.getElementById("replay-prev-step");
const replayNextStepButton = document.getElementById("replay-next-step");
const replayStepLabel = document.getElementById("replay-step-label");
const replayTableState = document.getElementById("replay-table-state");
const replayBoardContainer = document.getElementById("replay-board-container");
const replayHandCards = document.getElementById("replay-hand-cards");
const replayOwnedTicketsList = document.getElementById("replay-owned-tickets-list");
const replayPlayersSummary = document.getElementById("replay-players-summary");
const replayActionLog = document.getElementById("replay-action-log");
const replayStepDetail = document.getElementById("replay-step-detail");

const solverWorker = new Worker("./solver-worker.js", { type: "module" });

let pendingSolverRequestId = 0;
let solverSnapshot = null;
let session = createEmptySession();
let history = [];
let currentWorkspaceMode = "play";
let scheduledRenderHandle = 0;
let metadataState = createMetadataState();
let replayState = createEmptyReplayState();

function createEmptyHand() {
  return {
    red: 0,
    blue: 0,
    green: 0,
    yellow: 0,
    black: 0,
    white: 0,
    orange: 0,
    pink: 0,
    locomotive: 0
  };
}

function createPlayer(playerIndex, ourSeat) {
  return {
    id: `p${playerIndex}`,
    seat: playerIndex,
    name: playerIndex === ourSeat ? "You" : `Player ${playerIndex}`,
    score: 0,
    trainsRemaining: 45,
    claimedRouteIds: [],
    handCount: 4,
    exactHand: playerIndex === ourSeat ? createEmptyHand() : null,
    knownTicketIds: [],
    publicTicketCount: 0,
    observedVisibleLowerBound: createEmptyHand()
  };
}

function createEmptySession() {
  return {
    started: false,
    playerCount: 4,
    ourSeat: null,
    players: [],
    faceUpCards: [],
    drawPileCount: 98,
    discardCount: 0,
    claimedRoutes: {},
    phase: "setup",
    activePlayerSeat: 1,
    turnNumber: 0,
    actionMode: null,
    currentTurnAction: null,
    currentTurnDrawCount: 0,
    pendingReplacement: null,
    pendingHiddenDraw: null,
    pendingClaimPayment: null,
    pendingOffer: null,
    pendingStartingPool: [],
    selectedPoolSlot: 0,
    stagedSelfTicketIds: [],
    stagedHand: createEmptyHand(),
    stagedHandCount: 0,
    setupQueue: [],
    knownOutOfDeckCounts: createEmptyHand(),
    log: []
  };
}

function createMetadataState() {
  return {
    gameId: "",
    gameVariant: "usa-base",
    players: []
  };
}

function createEmptyReplayState() {
  return {
    payload: null,
    gameIndex: 0,
    stepIndex: 0
  };
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function pushHistory() {
  history.push(cloneState(session));
  undoButton.disabled = false;
}

function restoreHistory() {
  const previous = history.pop();
  if (!previous) {
    return;
  }

  session = previous;
  if (history.length === 0) {
    undoButton.disabled = true;
  }
  rerender();
}

function updateStatus(message) {
  statusText.textContent = message;
}

function queueUIRefresh(withRecommendations = false) {
  if (scheduledRenderHandle) {
    window.cancelAnimationFrame(scheduledRenderHandle);
  }

  scheduledRenderHandle = window.requestAnimationFrame(() => {
    scheduledRenderHandle = 0;
    if (withRecommendations) {
      rerender();
    } else {
      render();
    }
  });
}

function routeById(routeId) {
  return USA_BOARD.routes.find((route) => route.id === routeId);
}

function ticketById(ticketId) {
  return USA_BOARD.tickets.find((ticket) => ticket.id === ticketId);
}

function ticketLabel(ticketId) {
  const ticket = ticketById(ticketId);
  return ticket
    ? `${ticket.fromCity} -> ${ticket.toCity} (${ticket.points})`
    : ticketId;
}

const SORTED_TICKETS = [...USA_BOARD.tickets].sort((left, right) =>
  ticketLabel(left.id).localeCompare(ticketLabel(right.id))
);

const ROUTES_BY_ID = new Map(USA_BOARD.routes.map((route) => [route.id, route]));
const PARALLEL_GROUPS = buildParallelGroups();
let lastRenderTurnKey = "";

function currentPlayer() {
  return session.players.find((player) => player.seat === session.activePlayerSeat) ?? null;
}

function ourPlayer() {
  if (session.ourSeat == null) {
    return null;
  }
  return session.players.find((player) => player.seat === session.ourSeat) ?? null;
}

function isOurTurn() {
  return session.ourSeat != null && session.activePlayerSeat === session.ourSeat;
}

function addLogEntry(text) {
  session.log.unshift(text);
}

function colorTitle(color) {
  return color === "locomotive" ? "Locomotive" : color[0].toUpperCase() + color.slice(1);
}

function colorRoleLabel(color) {
  return color === "locomotive" ? "Wild" : "Train";
}

function colorGlyph(color) {
  if (color === "locomotive") {
    return "★";
  }

  return "●";
}

function colorCardMarkup(color, caption) {
  return `
    <div class="pool-card-inner card-color-${color}">
      <div class="pool-card-header">
        <span class="pool-card-badge">${colorRoleLabel(color)}</span>
        <span class="pool-card-corner">${colorGlyph(color)}</span>
      </div>
      <div class="pool-card-color train-color-${color}"></div>
      <div class="pool-card-title">${colorTitle(color)}</div>
      ${caption ? `<div class="pool-card-caption">${caption}</div>` : ""}
    </div>
  `;
}

function routeColorClass(color) {
  return `route-${color ?? "gray"}`;
}

function playerChipClass(seat) {
  return `player-color-${seat}`;
}

function isTicketCompleted(ticketId) {
  const ticket = ticketById(ticketId);
  const our = ourPlayer();
  const solverState = buildSolverState();
  if (!ticket || !our) {
    return false;
  }

  if (!solverState) {
    return false;
  }

  return areCitiesConnected(
    solverState.publicState,
    our.id,
    ticket.fromCity,
    ticket.toCity,
    ROUTES_BY_ID
  );
}

function initializeGame() {
  const playerCount = Number(setupPlayerCount.value);

  session = {
    started: true,
    playerCount,
    ourSeat: null,
    players: Array.from({ length: playerCount }, (_, index) =>
      createPlayer(index + 1, null)
    ),
    faceUpCards: [],
    drawPileCount: 110 - playerCount * 4,
    discardCount: 0,
    claimedRoutes: {},
    phase: "initial-hand-setup",
    activePlayerSeat: 1,
    turnNumber: 0,
    actionMode: null,
    currentTurnAction: null,
    currentTurnDrawCount: 0,
    pendingReplacement: null,
    pendingHiddenDraw: null,
    pendingClaimPayment: null,
    pendingOffer: {
      kind: "initial-self-choice",
      playerSeat: null,
      ticketIds: [],
      minimumKeepCount: 2
    },
    pendingStartingPool: Array.from({ length: 5 }, () => null),
    selectedPoolSlot: 0,
    stagedSelfTicketIds: [],
    stagedHand: createEmptyHand(),
    stagedHandCount: 0,
    setupQueue: Array.from({ length: playerCount }, (_, index) => index + 1),
    knownOutOfDeckCounts: createEmptyHand(),
    log: ["New game initialized."]
  };

  history = [];
  undoButton.disabled = true;
  solverSnapshot = null;
  updateStatus("Enter your 4 starting train cards, then continue to initial ticket choice.");
  rerender();
}

function buildSolverState() {
  if (!session.started) {
    return null;
  }

  const actualOurPlayer = ourPlayer();
  const surrogatePlayer =
    actualOurPlayer ??
    (session.phase === "initial-self-choice" ? session.players[0] ?? null : null);
  const ourPlayerId = surrogatePlayer?.id;
  const ourHand = actualOurPlayer?.exactHand ?? session.stagedHand;
  const ourTrainsRemaining = actualOurPlayer?.trainsRemaining ?? 45;
  if (!surrogatePlayer || !ourPlayerId || !ourHand) {
    return null;
  }

  const internalPhase =
    session.phase === "initial-self-choice" ||
    session.phase === "opponent-ticket-keep" ||
    session.phase === "self-ticket-keep"
      ? "resolving-ticket-keep"
      : session.phase === "awaiting-initial-pool"
        ? "ready"
        : session.phase;

  const activePlayerId =
    session.phase === "initial-self-choice" ? ourPlayerId : `p${session.activePlayerSeat}`;

  const pendingTicketChoice =
    session.pendingOffer &&
    (session.pendingOffer.kind === "initial-self-choice" ||
      session.pendingOffer.kind === "self-ticket-keep")
      ? {
          playerId:
            session.pendingOffer.playerSeat != null
              ? `p${session.pendingOffer.playerSeat}`
              : ourPlayerId,
          offeredTicketIds: [...session.pendingOffer.ticketIds],
          minimumKeepCount: session.pendingOffer.minimumKeepCount
        }
      : undefined;

  return {
    rules: createBaseRulesConfig(session.playerCount),
    publicState: {
      currentPlayerId: activePlayerId,
      firstPlayerId: "p1",
      turnNumber: session.turnNumber,
      phase: internalPhase,
      playerOrder: session.players.map((player) => player.id),
      players: session.players.map((player) => ({
        playerId: player.id,
        displayName: player.name,
        score: player.score,
        trainsRemaining: player.trainsRemaining,
        handCount: player.handCount,
        claimedRouteIds: [...player.claimedRouteIds],
        ticketsDrawnCount: player.publicTicketCount
      })),
      faceUpCards:
        session.phase === "initial-self-choice" ? [] : [...session.faceUpCards],
      discardCount: session.discardCount,
      drawPileCount: session.drawPileCount,
      claimedRoutes: { ...session.claimedRoutes }
    },
    ourState: {
      playerId: ourPlayerId,
      trainsRemaining: ourTrainsRemaining,
      hand: { ...ourHand },
      ticketIds:
        session.phase === "initial-self-choice"
          ? []
          : [...(actualOurPlayer?.knownTicketIds ?? session.stagedSelfTicketIds)]
    },
    beliefs: session.players
      .filter((player) => player.id !== ourPlayerId)
      .map((player) => ({
        playerId: player.id,
        handColorLowerBounds: { ...player.observedVisibleLowerBound },
        handColorExpectedCounts: { ...player.observedVisibleLowerBound },
        ticketFamilyPosterior: [],
        archetypePosterior: [],
        corridorInterest: []
      })),
    ...(pendingTicketChoice ? { pendingTicketChoice } : {}),
    annotations: {
      activePlanTags: [],
      securedTicketIds: [],
      atRiskTicketIds: [],
      bottleneckRouteIds: [],
      knownOutOfDeckCounts: { ...session.knownOutOfDeckCounts }
    }
  };
}

function spendObservedColor(player, color, count) {
  player.observedVisibleLowerBound[color] = Math.max(
    0,
    (player.observedVisibleLowerBound[color] ?? 0) - count
  );
}

function addKnownOutOfDeckColor(color, count = 1) {
  session.knownOutOfDeckCounts[color] = (session.knownOutOfDeckCounts[color] ?? 0) + count;
}

function requestRecommendations() {
  if (currentWorkspaceMode !== "play") {
    solverSnapshot = null;
    return;
  }

  const solverState = buildSolverState();
  if (!solverState) {
    solverSnapshot = null;
    renderRecommendations();
    return;
  }

  const recommendForSelf =
    session.phase === "initial-self-choice" ||
    session.phase === "self-ticket-keep" ||
    isOurTurn();

  if (!recommendForSelf) {
    solverSnapshot = null;
    renderRecommendations();
    return;
  }

  pendingSolverRequestId += 1;
  solverWorker.postMessage({
    requestId: pendingSolverRequestId,
    gameState: solverState
  });
}

solverWorker.addEventListener("message", (event) => {
  const { ok, requestId, turnEvaluation, actionEvaluation, blindDrawInsight: insight, error } =
    event.data ?? {};

  if (requestId !== pendingSolverRequestId) {
    return;
  }

  if (!ok) {
    solverSnapshot = {
      error
    };
    renderRecommendations();
    return;
  }

  solverSnapshot = {
    turnEvaluation,
    actionEvaluation,
    blindDrawInsight: insight
  };
  renderRecommendations();
});

function renderRecommendations() {
  turnRecommendations.innerHTML = "";
  actionRecommendations.innerHTML = "";
  blindDrawInsight.innerHTML = "";

  if (!solverSnapshot) {
    turnRecommendations.innerHTML = "<div class='recommendation-card'>No self recommendation for this step.</div>";
    actionRecommendations.innerHTML = "<div class='recommendation-card'>No self recommendation for this step.</div>";
    return;
  }

  if (solverSnapshot.error) {
    turnRecommendations.innerHTML = `<div class='recommendation-card'>Solver error: ${solverSnapshot.error}</div>`;
    actionRecommendations.innerHTML = "";
    return;
  }

  const maybeBlindAction = solverSnapshot.actionEvaluation?.alternatives?.find(
    (item) => item.action?.kind === "draw-blind"
  );
  const insight = solverSnapshot.blindDrawInsight;
  if (insight && maybeBlindAction) {
    const useful = insight.topUsefulColors
      .map((entry) => {
        const tickets = entry.usefulTickets.slice(0, 2).join(", ");
        return `
          <div class="blind-draw-chip">
            <span class="blind-draw-swatch train-color-${entry.color}"></span>
            <strong>${colorTitle(entry.color)}</strong>
            <span>${Math.round(entry.probability * 100)}%</span>
            <span class="subtle-chip">value ${entry.usefulness.toFixed(1)}</span>
            ${tickets ? `<span class="subtle-chip">${tickets}</span>` : ""}
          </div>
        `;
      })
      .join("");

    blindDrawInsight.innerHTML = `
      <div class="blind-draw-panel">
        <div class="blind-draw-title">Blind draw odds</div>
        <div class="blind-draw-summary">
          <span><strong>Locomotive:</strong> ${Math.round(
            insight.locomotiveProbability * 100
          )}%</span>
          <span><strong>Best colors:</strong> weighted by probability and follow-up value</span>
        </div>
        <div class="blind-draw-chip-list">${useful}</div>
      </div>
    `;
  }

  const renderList = (target, recommendations, mode) => {
    recommendations.slice(0, 8).forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "recommendation-card";
      const title =
        mode === "turn"
          ? item.actions.map((action) => formatAction(action)).join(" -> ")
          : formatAction(item.action);
      card.innerHTML = `
        <strong>#${index + 1} ${title}</strong>
        <div class="meta-line">utility ${item.utilityScore.toFixed(2)} | confidence ${item.confidence.toFixed(2)}</div>
        <ul>${item.rationale.map((line) => `<li>${line}</li>`).join("")}</ul>
      `;
      target.appendChild(card);
    });
  };

  renderList(turnRecommendations, solverSnapshot.turnEvaluation.alternatives, "turn");
  renderList(actionRecommendations, solverSnapshot.actionEvaluation.alternatives, "action");
}

function formatAction(action) {
  if (!action?.kind) {
    return "unknown action";
  }

  switch (action.kind) {
    case "claim-route":
      return `claim ${action.routeId}`;
    case "draw-face-up":
      return `take ${action.color} from pool (${action.drawIndex})`;
    case "draw-blind":
      return `draw hidden (${action.drawIndex})`;
    case "draw-tickets":
      return "draw destination tickets";
    case "keep-tickets":
      return `keep ${action.keptTicketIds.join(", ")}`;
    default:
      return action.kind;
  }
}

function renderTopSummary() {
  phaseLabel.textContent = session.phase;
  const player = currentPlayer();
  activePlayerLabel.textContent =
    session.phase === "initial-self-choice"
      ? "You (seat pending)"
      : player
        ? player.name
        : "-";
  turnLabel.textContent = String(session.turnNumber);
  actionModeLabel.textContent = session.actionMode ?? "-";
}

function renderHand() {
  handCards.innerHTML = "";
  const our = ourPlayer();
  const hand = our?.exactHand ?? (session.phase === "initial-self-choice" ? session.stagedHand : null);
  if (!hand) {
    handCards.innerHTML = "<div class='empty-state'>Your seat is not chosen yet.</div>";
    return;
  }

  const visibleColors = SORTED_TRAIN_COLORS.filter((color) => hand[color] > 0);
  if (visibleColors.length === 0) {
    handCards.innerHTML = "<div class='empty-state'>No train cards recorded yet.</div>";
    return;
  }

  visibleColors.forEach((color) => {
    const card = document.createElement("div");
    card.className = "train-card";
    card.innerHTML = `
      <div class="train-card-color train-color-${color}"></div>
      <div class="train-card-header">
        <span class="train-card-name">${colorTitle(color)}</span>
        <span class="train-card-count">${hand[color]}</span>
      </div>
      <div class="train-card-actions">
        <button type="button" data-hand-color="${color}" data-delta="-1">-</button>
        <button type="button" data-hand-color="${color}" data-delta="1">+</button>
      </div>
    `;
    handCards.appendChild(card);
  });
}

function renderOwnedTickets() {
  const our = ourPlayer();
  ownedTicketsList.innerHTML = "";

  if (!our) {
    return;
  }

  if (session.phase === "initial-self-choice") {
    ownedTicketsList.innerHTML =
      "<div class='empty-state'>No owned tickets yet during initial ticket choice.</div>";
    return;
  }

  if (our.knownTicketIds.length === 0) {
    ownedTicketsList.innerHTML = "<div class='empty-state'>No tickets recorded.</div>";
    return;
  }

  const completed = our.knownTicketIds.filter((ticketId) => isTicketCompleted(ticketId));
  const pending = our.knownTicketIds.filter((ticketId) => !isTicketCompleted(ticketId));

  const createTicketSection = (title, ticketIds, completedState) => {
    const section = document.createElement("div");
    section.className = "ticket-section";
    section.innerHTML = `<p class="ticket-section-title">${title}</p>`;

    if (ticketIds.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = completedState
        ? "No covered destinations yet."
        : "No uncovered destinations right now.";
      section.appendChild(empty);
      return section;
    }

    ticketIds.forEach((ticketId) => {
      const ticket = ticketById(ticketId);
      const card = document.createElement("div");
      card.className = `ticket-card ${completedState ? "completed" : "pending"}`;
      card.innerHTML = `
        <strong>${ticket?.fromCity ?? "?"} -> ${ticket?.toCity ?? "?"}</strong>
        <div class="ticket-points">${ticket?.points ?? "?"} points</div>
      `;
      section.appendChild(card);
    });

    return section;
  };

  ownedTicketsList.appendChild(createTicketSection("Covered", completed, true));
  ownedTicketsList.appendChild(createTicketSection("Not Covered", pending, false));
}

function renderPlayersSummary() {
  playersSummary.innerHTML = "";

  session.players.forEach((player) => {
    const card = document.createElement("div");
    card.className = `player-summary-card ${player.seat === session.activePlayerSeat ? "active-turn" : ""}`;
    const handCount =
      player.id === ourPlayer()?.id && player.exactHand
        ? Object.values(player.exactHand).reduce((sum, count) => sum + count, 0) || player.handCount
        : player.handCount;
    card.innerHTML = `
      <div class="player-summary-top">
        <strong>${player.name}</strong>
        <span class="player-chip ${playerChipClass(player.seat)}">${player.seat}</span>
      </div>
      <div class="player-stats">
        <div class="player-stat">Score: ${player.score}</div>
        <div class="player-stat">Trains: ${player.trainsRemaining}</div>
        <div class="player-stat">Cards: ${handCount}</div>
        <div class="player-stat">Tickets: ${player.id === ourPlayer()?.id ? player.knownTicketIds.length : player.publicTicketCount}</div>
        <div class="player-stat">Routes: ${player.claimedRouteIds.length}</div>
        <div class="player-stat">Seat: ${player.seat}</div>
      </div>
    `;
    playersSummary.appendChild(card);
  });
}

function renderActionLog() {
  actionLog.innerHTML = "";

  if (session.log.length === 0) {
    actionLog.innerHTML = "<div class='empty-state'>No actions yet.</div>";
    return;
  }

  session.log.slice(0, 20).forEach((entry) => {
    const node = document.createElement("div");
    node.className = "log-entry";
    node.textContent = entry;
    actionLog.appendChild(node);
  });
}

function getReplayGames() {
  return replayState.payload?.games ?? [];
}

function getReplayGame() {
  return getReplayGames()[replayState.gameIndex] ?? null;
}

function getReplayStep() {
  const game = getReplayGame();
  if (!game || replayState.stepIndex <= 0) {
    return null;
  }
  return game.steps?.[replayState.stepIndex - 1] ?? null;
}

function getReplaySnapshot() {
  const game = getReplayGame();
  if (!game) {
    return null;
  }
  if (replayState.stepIndex <= 0) {
    return game.initialSnapshot ?? null;
  }
  return game.steps?.[replayState.stepIndex - 1]?.snapshot ?? null;
}

function ticketCompletedForSnapshot(snapshot, ticketId) {
  const ticket = ticketById(ticketId);
  if (!ticket || !snapshot?.ourState?.playerId) {
    return false;
  }

  return areCitiesConnected(
    snapshot.publicState,
    snapshot.ourState.playerId,
    ticket.fromCity,
    ticket.toCity,
    ROUTES_BY_ID
  );
}

function renderReplayHand() {
  replayHandCards.innerHTML = "";
  const snapshot = getReplaySnapshot();
  const hand = snapshot?.ourState?.hand;

  if (!hand) {
    replayHandCards.innerHTML = "<div class='empty-state'>Load a replay to inspect Codex hand state.</div>";
    return;
  }

  const visibleColors = SORTED_TRAIN_COLORS.filter((color) => (hand[color] ?? 0) > 0);
  if (visibleColors.length === 0) {
    replayHandCards.innerHTML = "<div class='empty-state'>No visible Codex hand cards in this snapshot.</div>";
    return;
  }

  visibleColors.forEach((color) => {
    const card = document.createElement("div");
    card.className = "train-card static-card";
    card.innerHTML = `
      <div class="train-card-color train-color-${color}"></div>
      <div class="train-card-header">
        <span class="train-card-name">${colorTitle(color)}</span>
        <span class="train-card-count">${hand[color]}</span>
      </div>
    `;
    replayHandCards.appendChild(card);
  });
}

function renderReplayTickets() {
  replayOwnedTicketsList.innerHTML = "";
  const snapshot = getReplaySnapshot();
  const ticketIds = snapshot?.ourState?.ticketIds ?? [];

  if (ticketIds.length === 0) {
    replayOwnedTicketsList.innerHTML = "<div class='empty-state'>No Codex tickets visible in this snapshot.</div>";
    return;
  }

  const completed = ticketIds.filter((ticketId) => ticketCompletedForSnapshot(snapshot, ticketId));
  const pending = ticketIds.filter((ticketId) => !ticketCompletedForSnapshot(snapshot, ticketId));

  const renderSection = (title, ids, completedState) => {
    const section = document.createElement("div");
    section.className = "ticket-section";
    section.innerHTML = `<p class="ticket-section-title">${title}</p>`;

    if (ids.length === 0) {
      section.innerHTML += `<div class="empty-state">${completedState ? "No covered tickets." : "No uncovered tickets."}</div>`;
      return section;
    }

    ids.forEach((ticketId) => {
      const ticket = ticketById(ticketId);
      const card = document.createElement("div");
      card.className = `ticket-card ${completedState ? "completed" : "pending"}`;
      card.innerHTML = `
        <strong>${ticket?.fromCity ?? "?"} -> ${ticket?.toCity ?? "?"}</strong>
        <div class="ticket-points">${ticket?.points ?? "?"} points</div>
      `;
      section.appendChild(card);
    });

    return section;
  };

  replayOwnedTicketsList.appendChild(renderSection("Covered", completed, true));
  replayOwnedTicketsList.appendChild(renderSection("Not Covered", pending, false));
}

function renderReplayPlayers() {
  replayPlayersSummary.innerHTML = "";
  const snapshot = getReplaySnapshot();
  const game = getReplayGame();
  const currentStep = getReplayStep();
  const activeSeat = currentStep?.actorSeat != null ? currentStep.actorSeat + 1 : null;

  if (!snapshot) {
    replayPlayersSummary.innerHTML = "<div class='empty-state'>No replay loaded.</div>";
    return;
  }

  snapshot.publicState.players.forEach((player, index) => {
    const card = document.createElement("div");
    card.className = `player-summary-card ${activeSeat === index + 1 ? "active-turn" : ""}`;
    const agentName = game?.agentNames?.[index] ?? player.displayName;
    card.innerHTML = `
      <div class="player-summary-top">
        <strong>${player.displayName}</strong>
        <span class="player-chip ${playerChipClass(index + 1)}">${index + 1}</span>
      </div>
      <div class="meta-line">${agentName}</div>
      <div class="player-stats">
        <div class="player-stat">Score: ${player.score}</div>
        <div class="player-stat">Trains: ${player.trainsRemaining}</div>
        <div class="player-stat">Cards: ${player.handCount}</div>
        <div class="player-stat">Tickets: ${player.ticketsDrawnCount}</div>
        <div class="player-stat">Routes: ${player.claimedRouteIds.length}</div>
      </div>
    `;
    replayPlayersSummary.appendChild(card);
  });
}

function renderReplayStepDetail() {
  replayStepDetail.innerHTML = "";
  const game = getReplayGame();
  const step = getReplayStep();

  if (!game) {
    replayStepDetail.innerHTML = "<div class='empty-state'>Load a replay JSON file.</div>";
    return;
  }

  if (!step) {
    replayStepDetail.innerHTML = `
      <div class="empty-state">
        Initial snapshot for <strong>${game.gameId}</strong>. Step forward to begin the replay.
      </div>
    `;
    return;
  }

  const codexDecision = step.codexDecision;
  replayStepDetail.innerHTML = `
    <div class="stack-list">
      <div><strong>Actor:</strong> seat ${step.actorSeat + 1} (${step.actorName})</div>
      <div><strong>Move:</strong> ${step.move?.summary ?? "Unknown move"}</div>
      ${
        step.index < (game.agentNames?.length ?? 4)
          ? "<div class='meta-line'>Setup phase: initial destination-ticket keeps are recorded in seat order before the main turn order begins.</div>"
          : ""
      }
      ${
        codexDecision
          ? `
            <div><strong>Codex chose:</strong> ${formatAction(codexDecision.chosenAction ?? { kind: "unknown" })}</div>
            <div><strong>Reasons:</strong></div>
            <ul class="replay-rationale-list">
              ${(codexDecision.topRationale ?? []).map((line) => `<li>${line}</li>`).join("")}
            </ul>
          `
          : "<div class='empty-state'>No Codex rationale on this step.</div>"
      }
    </div>
  `;
}

function renderReplayTableState() {
  const snapshot = getReplaySnapshot();
  replayTableState.innerHTML = "";

  if (!snapshot) {
    replayTableState.innerHTML = "<div class='empty-state'>No replay state loaded.</div>";
    return;
  }

  const faceUpCards = snapshot.publicState.faceUpCards ?? [];
  replayTableState.innerHTML = `
    <div class="replay-table-grid">
      <div class="deck-card replay-deck-card">
        <strong>Train Deck</strong>
        <div>Remaining: ${snapshot.publicState.drawPileCount}</div>
        <div class="meta-line">Discard: ${snapshot.publicState.discardCount}</div>
      </div>
      <div class="deck-card replay-deck-card">
        <strong>Route Deck</strong>
        <div>Phase: ${snapshot.publicState.phase}</div>
        <div class="meta-line">Turn: ${snapshot.publicState.turnNumber}</div>
      </div>
      <div class="replay-faceup-block">
        <strong>Face-up Pool</strong>
        <div class="pool-card-row replay-pool-row" id="replay-faceup-row"></div>
      </div>
    </div>
  `;

  const row = replayTableState.querySelector("#replay-faceup-row");
  faceUpCards.forEach((color) => {
    const card = document.createElement("div");
    card.className = "pool-card static-pool-card";
    card.innerHTML = colorCardMarkup(color, "Visible");
    row.appendChild(card);
  });
}

function renderReplayLog() {
  replayActionLog.innerHTML = "";
  const game = getReplayGame();

  if (!game) {
    replayActionLog.innerHTML = "<div class='empty-state'>No replay loaded.</div>";
    return;
  }

  game.steps.forEach((step, index) => {
    const node = document.createElement("div");
    node.className = `log-entry ${index + 1 === replayState.stepIndex ? "active-log-entry" : ""}`;
    node.innerHTML = `
      <strong>#${index + 1}</strong> ${step.move?.summary ?? "Unknown move"}
      ${
        step.codexDecision?.topRationale?.[0]
          ? `<div class="meta-line">Codex: ${step.codexDecision.topRationale[0]}</div>`
          : ""
      }
    `;
    replayActionLog.appendChild(node);
  });
}

function renderReplayGameOptions() {
  const games = getReplayGames();
  replayGameSelect.innerHTML = "";

  games.forEach((game, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}. ${game.gameId}`;
    replayGameSelect.appendChild(option);
  });

  replayGameSelect.value = String(replayState.gameIndex);
}

function renderReplayWorkspace() {
  renderReplayGameOptions();
  const game = getReplayGame();
  const snapshot = getReplaySnapshot();
  const step = getReplayStep();

  replayPrevStepButton.disabled = !game || replayState.stepIndex <= 0;
  replayNextStepButton.disabled = !game || replayState.stepIndex >= (game?.steps?.length ?? 0);

  replayStepLabel.textContent = game
    ? `Game ${replayState.gameIndex + 1} of ${getReplayGames().length} | Step ${replayState.stepIndex} / ${game.steps.length}`
    : "No replay loaded.";

  if (!snapshot) {
    replayBoardContainer.innerHTML = "<div class='empty-state replay-empty'>Load a replay JSON exported from benchmark.</div>";
    replayTableState.innerHTML = "<div class='empty-state'>No replay state loaded.</div>";
    renderReplayHand();
    renderReplayTickets();
    renderReplayPlayers();
    renderReplayStepDetail();
    renderReplayLog();
    return;
  }

  renderReplayTableState();
  renderBoardInto(replayBoardContainer, snapshot.publicState.claimedRoutes, null);
  renderReplayHand();
  renderReplayTickets();
  renderReplayPlayers();
  renderReplayStepDetail();
  renderReplayLog();

  if (step?.move?.summary) {
    updateStatus(`Replay: ${step.move.summary}`);
  }
}

function ownerClass(routeId, claimedRoutes = session.claimedRoutes) {
  const ownerId = claimedRoutes[routeId];
  return ownerId ? `claimed-${ownerId}` : "";
}

function renderBoardInto(container, claimedRoutes, actionMode = null) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 980 640");
  svg.setAttribute("class", "board-svg");

  const watermark = document.createElementNS("http://www.w3.org/2000/svg", "text");
  watermark.setAttribute("x", "36");
  watermark.setAttribute("y", "606");
  watermark.setAttribute("class", "board-watermark");
  watermark.textContent = "USA";
  svg.appendChild(watermark);

  USA_BOARD.routes.forEach((route) => {
    const from = CITY_POSITIONS[route.cityA];
    const to = CITY_POSITIONS[route.cityB];
    if (!from || !to) {
      return;
    }

    let start = from;
    let end = to;
    if (route.parallelGroup) {
      const group = PARALLEL_GROUPS.get(route.parallelGroup) ?? [];
      const offsetIndex = group.findIndex((candidate) => candidate.id === route.id);
      const direction = offsetIndex === 0 ? -1 : 1;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy) || 1;
      const normalX = (-dy / length) * 7 * direction;
      const normalY = (dx / length) * 7 * direction;
      start = [from[0] + normalX, from[1] + normalY];
      end = [to[0] + normalX, to[1] + normalY];
    }

    const groupNode = document.createElementNS("http://www.w3.org/2000/svg", "g");
    groupNode.setAttribute(
      "class",
      `route-line ${ownerClass(route.id, claimedRoutes)} ${actionMode === "claim-route" ? "claim-mode" : ""}`
    );
    groupNode.dataset.routeId = route.id;

    const shadow = document.createElementNS("http://www.w3.org/2000/svg", "line");
    shadow.setAttribute("x1", String(start[0]));
    shadow.setAttribute("y1", String(start[1]));
    shadow.setAttribute("x2", String(end[0]));
    shadow.setAttribute("y2", String(end[1]));
    shadow.setAttribute("class", "route-shadow");
    groupNode.appendChild(shadow);

    const bed = document.createElementNS("http://www.w3.org/2000/svg", "line");
    bed.setAttribute("x1", String(start[0]));
    bed.setAttribute("y1", String(start[1]));
    bed.setAttribute("x2", String(end[0]));
    bed.setAttribute("y2", String(end[1]));
    bed.setAttribute("class", `route-bed ${routeColorClass(route.color)}`);
    groupNode.appendChild(bed);

    const claim = document.createElementNS("http://www.w3.org/2000/svg", "line");
    claim.setAttribute("x1", String(start[0]));
    claim.setAttribute("y1", String(start[1]));
    claim.setAttribute("x2", String(end[0]));
    claim.setAttribute("y2", String(end[1]));
    claim.setAttribute("class", "route-claim");
    groupNode.appendChild(claim);

    if (claimedRoutes[route.id]) {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const segmentSpan = 1 / route.length;
      for (let index = 0; index < route.length; index += 1) {
        const centerT = (index + 0.5) * segmentSpan;
        const carLengthT = Math.min(0.8 * segmentSpan, 0.12);
        const half = carLengthT / 2;
        const x1 = start[0] + dx * (centerT - half);
        const y1 = start[1] + dy * (centerT - half);
        const x2 = start[0] + dx * (centerT + half);
        const y2 = start[1] + dy * (centerT + half);

        const outline = document.createElementNS("http://www.w3.org/2000/svg", "line");
        outline.setAttribute("x1", String(x1));
        outline.setAttribute("y1", String(y1));
        outline.setAttribute("x2", String(x2));
        outline.setAttribute("y2", String(y2));
        outline.setAttribute("class", "route-train-outline");
        groupNode.appendChild(outline);

        const trainCar = document.createElementNS("http://www.w3.org/2000/svg", "line");
        trainCar.setAttribute("x1", String(x1));
        trainCar.setAttribute("y1", String(y1));
        trainCar.setAttribute("x2", String(x2));
        trainCar.setAttribute("y2", String(y2));
        trainCar.setAttribute("class", "route-train-car");
        groupNode.appendChild(trainCar);
      }
    }

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hit.setAttribute("x1", String(start[0]));
    hit.setAttribute("y1", String(start[1]));
    hit.setAttribute("x2", String(end[0]));
    hit.setAttribute("y2", String(end[1]));
    hit.setAttribute("class", "route-hit");
    hit.dataset.routeId = route.id;
    groupNode.appendChild(hit);

    svg.appendChild(groupNode);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String((start[0] + end[0]) / 2));
    label.setAttribute("y", String((start[1] + end[1]) / 2 - 4));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "route-label");
    label.textContent = String(route.length);
    svg.appendChild(label);
  });

  USA_BOARD.cities.forEach((city) => {
    const point = CITY_POSITIONS[city.id];
    if (!point) {
      return;
    }

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(point[0]));
    dot.setAttribute("cy", String(point[1]));
    dot.setAttribute("r", "4");
    dot.setAttribute("class", "city-dot");
    svg.appendChild(dot);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(point[0] + 6));
    label.setAttribute("y", String(point[1] - 6));
    label.setAttribute("class", "city-label");
    label.textContent = city.name;
    svg.appendChild(label);
  });

  container.innerHTML = "";
  container.appendChild(svg);
}

function renderBoard() {
  renderBoardInto(boardContainer, session.claimedRoutes, session.actionMode);
}

function renderTicketSelector(ticketIds, minimumKeepCount, actionLabel, submitId) {
  const wrapper = document.createElement("div");
  wrapper.className = "ticket-offer-layout";
  wrapper.innerHTML = `
    <div>Select at least ${minimumKeepCount} ticket(s).</div>
    <div class="stack-list" id="ticket-offer-stack"></div>
    <div class="inline-buttons">
      <button id="${submitId}" type="button">${actionLabel}</button>
    </div>
  `;
  const stack = wrapper.querySelector("#ticket-offer-stack");
  ticketIds.forEach((ticketId) => {
    const card = document.createElement("div");
    card.className = "ticket-card";
    card.innerHTML = `
      <label>
        <input type="checkbox" data-ticket-choice="${ticketId}" />
        <span>${ticketLabel(ticketId)}</span>
      </label>
    `;
    stack.appendChild(card);
  });
  return wrapper;
}

function renderColorChoiceRow(container, datasetName, caption) {
  SORTED_TRAIN_COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pool-card";
    button.dataset[datasetName] = color;
    button.innerHTML = colorCardMarkup(color, caption);
    container.appendChild(button);
  });
}

function renderContextPanel() {
  contextPanel.innerHTML = "";

  if (!session.started) {
    contextTitle.textContent = "Setup";
    contextPanel.innerHTML =
      "<div class='empty-state'>Choose player count, your seat, then press Start New Game.</div>";
    return;
  }

  if (session.phase === "initial-hand-setup") {
    contextTitle.textContent = "Starting Hand";
    const selectedCards = SORTED_TRAIN_COLORS.flatMap((color) =>
      Array.from({ length: session.stagedHand[color] }, () => colorTitle(color))
    );
    contextPanel.innerHTML = `
      <div class="setup-layout">
        <div>Choose your 4 starting train cards before destination tickets.</div>
        <div class="meta-line">Selected: ${selectedCards.join(", ") || "none yet"}</div>
        <div class="pool-card-row" id="starting-hand-row"></div>
        <div class="inline-buttons">
          <button id="reset-starting-hand" type="button">Reset Hand</button>
          <button id="confirm-starting-hand" type="button">Continue to Initial Tickets</button>
        </div>
      </div>
    `;
    const row = contextPanel.querySelector("#starting-hand-row");
    SORTED_TRAIN_COLORS.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pool-card";
      button.dataset.startingHandColor = color;
      button.innerHTML = `
        <div class="pool-card-color train-color-${color}"></div>
        <strong>${colorTitle(color)}</strong>
        <div class="meta-line">Count: ${session.stagedHand[color]}</div>
      `;
      row.appendChild(button);
    });
    return;
  }

  if (session.phase === "initial-self-choice") {
    contextTitle.textContent = "Initial Ticket Choice";
    const currentOffer = session.pendingOffer?.ticketIds ?? [];
    const wrapper = document.createElement("div");
    wrapper.className = "setup-layout";
    wrapper.innerHTML = `
      <div>Choose the 3 initial destination tickets that were offered to you.</div>
      <label>
        Offered tickets
        <select id="initial-offer-select" multiple size="8"></select>
      </label>
      <div class="inline-buttons">
        <button id="save-initial-offer" type="button">Set Initial Offer</button>
      </div>
    `;
    const select = wrapper.querySelector("#initial-offer-select");
    SORTED_TICKETS.forEach((ticket) => {
      const option = document.createElement("option");
      option.value = ticket.id;
      option.textContent = ticketLabel(ticket.id);
      option.selected = currentOffer.includes(ticket.id);
      select.appendChild(option);
    });
    contextPanel.appendChild(wrapper);

    if (currentOffer.length > 0) {
      contextPanel.appendChild(
        renderTicketSelector(
          currentOffer,
          session.pendingOffer?.minimumKeepCount ?? 2,
          "Confirm kept tickets",
          "confirm-initial-keep"
        )
      );
    }
    return;
  }

  if (session.phase === "initial-opponent-choice") {
    const seat = session.setupQueue[0];
    const player = session.players.find((candidate) => candidate.seat === seat);
    contextTitle.textContent = "Opponent Initial Tickets";
    contextPanel.innerHTML = `
      <div class="opponent-choice-layout">
        <div>How many destination tickets did ${player?.name ?? `Player ${seat}`} keep?</div>
        <div class="inline-buttons">
          <button data-opponent-keep="2" type="button">Kept 2</button>
          <button data-opponent-keep="3" type="button">Kept 3</button>
        </div>
      </div>
    `;
    return;
  }

  if (session.phase === "choose-seat") {
    contextTitle.textContent = "Choose Your Seat";
    contextPanel.innerHTML = `
      <div class="opponent-choice-layout">
        <div>You know your turn order only after the initial ticket choice. Select your seat now.</div>
        <div class="inline-buttons">
          ${session.players
            .map(
              (player) =>
                `<button data-seat-choice="${player.seat}" type="button">Seat ${player.seat}</button>`
            )
            .join("")}
        </div>
      </div>
    `;
    return;
  }

  if (session.phase === "awaiting-initial-pool") {
    contextTitle.textContent = "Set Starting Pool";
    const wrapper = document.createElement("div");
    wrapper.className = "setup-layout";
    wrapper.innerHTML = `
      <div>Set the 5 visible train cards that appear after all initial ticket choices.</div>
      <div class="pool-card-row" id="initial-pool-row"></div>
      <div>Choose a slot, then choose a color.</div>
      <div class="pool-card-row" id="initial-pool-picker"></div>
      <div class="inline-buttons">
        <button id="clear-starting-pool" type="button">Clear Pool</button>
        <button id="confirm-starting-pool" type="button">Confirm Starting Pool</button>
      </div>
    `;
    const row = wrapper.querySelector("#initial-pool-row");
    for (let index = 0; index < 5; index += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `pool-card ${session.selectedPoolSlot === index ? "active" : ""}`;
      button.dataset.poolSlot = String(index);
      const color = session.pendingStartingPool[index];
      button.innerHTML = color
        ? colorCardMarkup(color, `Slot ${index + 1}`)
        : `
            <div class="pool-card-inner empty-pool-card">
              <div class="pool-card-header">
                <span class="pool-card-badge">Pool</span>
                <span class="pool-card-corner">+</span>
              </div>
              <div class="pool-card-color pool-card-color-empty"></div>
              <div class="pool-card-title">Slot ${index + 1}</div>
              <div class="pool-card-caption">Select color</div>
            </div>
          `;
      row.appendChild(button);
    }
    const picker = wrapper.querySelector("#initial-pool-picker");
    renderColorChoiceRow(picker, "startingPoolColor", "Set selected slot");
    contextPanel.appendChild(wrapper);
    return;
  }

  if (session.pendingClaimPayment) {
    const player = session.players.find(
      (candidate) => candidate.seat === session.pendingClaimPayment.playerSeat
    );
    const route = routeById(session.pendingClaimPayment.routeId);
    contextTitle.textContent = "Claim Payment";
    const colorOptions =
      route?.color === "gray"
        ? SORTED_TRAIN_COLORS.filter((color) => color !== "locomotive")
        : [route?.color].filter(Boolean);
    const selectedColor =
      session.pendingClaimPayment.primaryColor ?? colorOptions[0] ?? "red";
    contextPanel.innerHTML = `
      <div class="setup-layout">
        <div>Record which cards ${player?.name ?? "the active player"} spent to claim <strong>${route?.id ?? session.pendingClaimPayment.routeId}</strong>.</div>
        <div class="meta-line">For colored routes, just set locomotives if any were mixed in.</div>
        <div><strong>Primary color</strong></div>
        <div class="pool-card-row" id="claim-payment-color-row"></div>
        <label>
          Locomotives used
          <select id="claim-payment-locomotives">
            ${Array.from({ length: (route?.length ?? 0) + 1 }, (_, index) => {
              const selected = session.pendingClaimPayment.locomotives === index ? "selected" : "";
              return `<option value="${index}" ${selected}>${index}</option>`;
            }).join("")}
          </select>
        </label>
        <div class="inline-buttons">
          <button id="confirm-claim-payment" type="button">Confirm Claim Payment</button>
        </div>
      </div>
    `;
    const row = contextPanel.querySelector("#claim-payment-color-row");
    colorOptions.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `pool-card ${selectedColor === color ? "active" : ""}`;
      button.dataset.claimPaymentColor = color;
      button.innerHTML = colorCardMarkup(color, "Claim color");
      row.appendChild(button);
    });
    return;
  }

  if (session.pendingReplacement) {
    contextTitle.textContent = "Reveal Replacement Card";
    const wrapper = document.createElement("div");
    wrapper.className = "pool-layout";
    wrapper.innerHTML = `
      <div>Choose which card was revealed from the deck to refill the visible pool.</div>
      <div class="pool-card-row" id="replacement-row"></div>
    `;
    const row = wrapper.querySelector("#replacement-row");
    renderColorChoiceRow(row, "replacementColor", "Refill pool");
    contextPanel.appendChild(wrapper);
    return;
  }

  if (session.pendingHiddenDraw) {
    const player = session.players.find(
      (candidate) => candidate.seat === session.pendingHiddenDraw.playerSeat
    );
    contextTitle.textContent = "Reveal Hidden Draw";
    const wrapper = document.createElement("div");
    wrapper.className = "pool-layout";
    wrapper.innerHTML = `
      <div>Choose which color ${player?.name ?? "the active player"} drew from the hidden deck.</div>
      <div class="pool-card-row" id="hidden-reveal-row"></div>
    `;
    const row = wrapper.querySelector("#hidden-reveal-row");
    renderColorChoiceRow(row, "hiddenRevealColor", "Reveal drawn card");
    contextPanel.appendChild(wrapper);
    return;
  }

  if (session.phase === "self-ticket-keep") {
    contextTitle.textContent = "Choose Kept Tickets";
    contextPanel.appendChild(
      renderTicketSelector(
        session.pendingOffer?.ticketIds ?? [],
        session.pendingOffer?.minimumKeepCount ?? 1,
        "Confirm kept tickets",
        "confirm-self-ticket-keep"
      )
    );
    return;
  }

  if (session.phase === "opponent-ticket-keep") {
    const seat = session.pendingOffer?.playerSeat;
    const player = session.players.find((candidate) => candidate.seat === seat);
    contextTitle.textContent = "Opponent Ticket Draw";
    contextPanel.innerHTML = `
      <div class="opponent-choice-layout">
        <div>How many tickets did ${player?.name ?? `Player ${seat}`} keep from the draw?</div>
        <div class="inline-buttons">
          <button data-opponent-ticket-keep="1" type="button">Kept 1</button>
          <button data-opponent-ticket-keep="2" type="button">Kept 2</button>
          <button data-opponent-ticket-keep="3" type="button">Kept 3</button>
        </div>
      </div>
    `;
    return;
  }

  if (session.phase === "self-ticket-draw") {
    contextTitle.textContent = "Self Ticket Draw";
    const wrapper = document.createElement("div");
    wrapper.className = "ticket-offer-layout";
    wrapper.innerHTML = `
      <div>Select the tickets you drew from the destination deck.</div>
      <label>
        Offered tickets
        <select id="self-ticket-offer" multiple size="8"></select>
      </label>
      <div class="inline-buttons">
        <button id="set-self-ticket-offer" type="button">Set Drawn Tickets</button>
      </div>
    `;
    const select = wrapper.querySelector("#self-ticket-offer");
    const selected = session.pendingOffer?.ticketIds ?? [];
    SORTED_TICKETS.forEach((ticket) => {
      const option = document.createElement("option");
      option.value = ticket.id;
      option.textContent = ticketLabel(ticket.id);
      option.selected = selected.includes(ticket.id);
      select.appendChild(option);
    });
    contextPanel.appendChild(wrapper);

    if ((session.pendingOffer?.ticketIds ?? []).length > 0) {
      contextPanel.appendChild(
        renderTicketSelector(
          session.pendingOffer.ticketIds,
          session.pendingOffer.minimumKeepCount,
          "Confirm kept tickets",
          "confirm-self-ticket-draw"
        )
      );
    }
    return;
  }

  contextTitle.textContent = "Current Turn";
  const player = currentPlayer();
  const wrapper = document.createElement("div");
  wrapper.className = "pool-layout";
  wrapper.innerHTML = `
    <div><strong>${player?.name ?? "-"}</strong> to act.</div>
    <div>Click the pool, the train deck, the route deck, or use claim mode on the board.</div>
    <div class="table-control-grid">
      <button class="deck-card" id="draw-hidden-deck" type="button">
        <strong>Train Deck</strong>
        <div>Draw hidden train card</div>
        <div class="meta-line">Remaining: ${session.drawPileCount}</div>
      </button>
      <button class="deck-card" id="draw-ticket-deck" type="button">
        <strong>Route Deck</strong>
        <div>Draw destination tickets</div>
      </button>
    </div>
    <div>
      <strong>Visible Pool</strong>
      <div class="pool-card-row" id="visible-pool-row"></div>
    </div>
  `;

  const poolRow = wrapper.querySelector("#visible-pool-row");
  session.faceUpCards.forEach((color, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pool-card";
    button.dataset.faceUpIndex = String(index);
    button.innerHTML = colorCardMarkup(color, "Take from pool");
    poolRow.appendChild(button);
  });

  contextPanel.appendChild(wrapper);
}

function render() {
  playWorkspace.classList.toggle("hidden", currentWorkspaceMode !== "play");
  replayWorkspace.classList.toggle("hidden", currentWorkspaceMode !== "replay");
  metadataWorkspace.classList.toggle("hidden", currentWorkspaceMode !== "metadata");

  if (currentWorkspaceMode === "metadata") {
    renderMetadataBuilder();
    return;
  }

  if (currentWorkspaceMode === "replay") {
    renderReplayWorkspace();
    return;
  }

  renderTopSummary();
  renderHand();
  renderOwnedTickets();
  renderPlayersSummary();
  renderBoard();
  renderContextPanel();
  renderActionLog();
  renderRecommendations();

  const turnKey = `${session.turnNumber}:${session.activePlayerSeat}:${session.phase}`;
  if (lastRenderTurnKey && lastRenderTurnKey !== turnKey) {
    boardContainer.classList.remove("turn-transition");
    window.requestAnimationFrame(() => {
      boardContainer.classList.add("turn-transition");
    });
  } else if (!boardContainer.classList.contains("turn-transition")) {
    boardContainer.classList.remove("turn-transition");
  }
  lastRenderTurnKey = turnKey;

  claimRouteModeButton.disabled =
    !session.started ||
    session.phase === "initial-self-choice" ||
    session.phase === "initial-opponent-choice" ||
    session.phase === "awaiting-initial-pool" ||
    Boolean(session.pendingReplacement) ||
    Boolean(session.pendingHiddenDraw) ||
    Boolean(session.pendingClaimPayment);
  cancelModeButton.disabled = session.actionMode === null;
  setupOurSeat.disabled = true;
}

function rerender() {
  render();
  requestRecommendations();
}

function endTurn() {
  session.currentTurnAction = null;
  session.currentTurnDrawCount = 0;
  session.actionMode = null;
  session.activePlayerSeat =
    session.activePlayerSeat === session.playerCount ? 1 : session.activePlayerSeat + 1;
  if (session.activePlayerSeat === 1) {
    session.turnNumber += 1;
  }
  session.phase = "ready";
}

function setInitialSelfOffer(ticketIds) {
  pushHistory();
  session.pendingOffer = {
    kind: "initial-self-choice",
    playerSeat: null,
    ticketIds: [...ticketIds],
    minimumKeepCount: 2
  };
  addLogEntry(`Initial offer set: ${ticketIds.map(ticketLabel).join("; ")}`);
  rerender();
}

function addStartingHandCard(color) {
  const currentCount = Object.values(session.stagedHand).reduce((sum, value) => sum + value, 0);
  if (currentCount >= 4) {
    updateStatus("Starting hand already has 4 cards.");
    return;
  }

  pushHistory();
  session.stagedHand[color] += 1;
  session.stagedHandCount += 1;
  addLogEntry(`Added ${color} to starting hand.`);
  render();
}

function resetStartingHand() {
  pushHistory();
  session.stagedHand = createEmptyHand();
  session.stagedHandCount = 0;
  addLogEntry("Reset starting hand selection.");
  render();
}

function confirmStartingHand() {
  const totalCards = Object.values(session.stagedHand).reduce((sum, value) => sum + value, 0);
  if (totalCards !== 4) {
    updateStatus("Starting hand must contain exactly 4 train cards.");
    return;
  }

  pushHistory();
  session.stagedHandCount = 4;
  session.phase = "initial-self-choice";
  addLogEntry("Starting hand confirmed.");
  updateStatus("Now enter the 3 destination tickets offered to you.");
  rerender();
}

function confirmInitialSelfKeep(keptTicketIds) {
  if (keptTicketIds.length < 2) {
    updateStatus("You must keep at least 2 initial tickets.");
    return;
  }

  pushHistory();
  const our = ourPlayer();
  session.stagedSelfTicketIds = [...keptTicketIds];
  session.pendingOffer = null;
  session.phase = "choose-seat";
  addLogEntry(`You kept initial tickets: ${keptTicketIds.map(ticketLabel).join("; ")}`);
  rerender();
}

function chooseSeat(seat) {
  pushHistory();
  session.ourSeat = seat;
  session.players.forEach((player) => {
    player.name = player.seat === seat ? "You" : `Player ${player.seat}`;
    if (player.seat === seat) {
      player.exactHand = { ...session.stagedHand };
      player.handCount = session.stagedHandCount;
      player.knownTicketIds = [...session.stagedSelfTicketIds];
      player.publicTicketCount = session.stagedSelfTicketIds.length;
    } else {
      player.exactHand = null;
    }
  });
  session.setupQueue = session.players
    .map((player) => player.seat)
    .filter((playerSeat) => playerSeat !== seat);
  session.activePlayerSeat = session.setupQueue[0] ?? 1;
  session.phase = session.setupQueue.length > 0 ? "initial-opponent-choice" : "awaiting-initial-pool";
  addLogEntry(`Your seat is ${seat}.`);
  updateStatus(`Seat ${seat} selected. Now record opponent initial ticket counts.`);
  rerender();
}

function recordOpponentInitialKeep(count) {
  const seat = session.setupQueue[0];
  if (!seat) {
    return;
  }

  pushHistory();
  const player = session.players.find((candidate) => candidate.seat === seat);
  if (player) {
    player.publicTicketCount = count;
  }
  session.setupQueue.shift();
  session.activePlayerSeat = session.setupQueue[0] ?? 1;
  session.phase = session.setupQueue.length > 0 ? "initial-opponent-choice" : "awaiting-initial-pool";
  addLogEntry(`${player?.name ?? `Player ${seat}`} kept ${count} initial ticket(s).`);
  updateStatus(
    session.setupQueue.length > 0
      ? `Recorded. Next opponent: Player ${session.setupQueue[0]}.`
      : "Recorded. Now enter the starting visible pool."
  );
  rerender();
}

function setStartingPool(colors) {
  pushHistory();
  session.faceUpCards = [...colors];
  session.pendingStartingPool = [...colors];
  session.phase = "ready";
  session.activePlayerSeat = 1;
  session.turnNumber = 1;
  addLogEntry(`Starting visible pool: ${colors.join(", ")}.`);
  rerender();
}

function setStartingPoolSlot(slotIndex) {
  session.selectedPoolSlot = slotIndex;
  render();
}

function setStartingPoolColor(color) {
  pushHistory();
  const selectedSlot = session.selectedPoolSlot ?? 0;
  session.pendingStartingPool[selectedSlot] = color;
  if (selectedSlot < 4) {
    session.selectedPoolSlot = selectedSlot + 1;
  }
  render();
}

function clearStartingPool() {
  pushHistory();
  session.pendingStartingPool = Array.from({ length: 5 }, () => null);
  session.selectedPoolSlot = 0;
  render();
}

function beginSelfTicketDraw() {
  pushHistory();
  session.phase = "self-ticket-draw";
  session.pendingOffer = {
    kind: "self-ticket-keep",
    playerSeat: session.ourSeat,
    ticketIds: [],
    minimumKeepCount: 1
  };
  addLogEntry("You drew destination tickets and need to enter the offer.");
  rerender();
}

function setSelfTicketDrawOffer(ticketIds) {
  pushHistory();
  if (!session.pendingOffer) {
    return;
  }
  session.pendingOffer.ticketIds = [...ticketIds];
  addLogEntry(`Self ticket draw offer set: ${ticketIds.map(ticketLabel).join("; ")}`);
  rerender();
}

function confirmSelfTicketDrawKeep(keptTicketIds) {
  if (!session.pendingOffer) {
    return;
  }

  const minimumKeepCount = session.pendingOffer.minimumKeepCount;
  if (keptTicketIds.length < minimumKeepCount) {
    updateStatus(`You must keep at least ${minimumKeepCount} ticket(s).`);
    return;
  }

  pushHistory();
  const our = ourPlayer();
  if (!our) {
    return;
  }
  our.knownTicketIds.push(...keptTicketIds);
  our.publicTicketCount += keptTicketIds.length;
  session.pendingOffer = null;
  session.phase = "ready";
  addLogEntry(`You kept drawn tickets: ${keptTicketIds.map(ticketLabel).join("; ")}`);
  endTurn();
  rerender();
}

function beginOpponentTicketDraw() {
  const player = currentPlayer();
  if (!player) {
    return;
  }
  pushHistory();
  session.phase = "opponent-ticket-keep";
  session.pendingOffer = {
    kind: "opponent-ticket-keep",
    playerSeat: player.seat,
    ticketIds: [],
    minimumKeepCount: 1
  };
  addLogEntry(`${player.name} drew destination tickets.`);
  rerender();
}

function confirmOpponentTicketKeep(count) {
  const seat = session.pendingOffer?.playerSeat;
  if (!seat) {
    return;
  }
  pushHistory();
  const player = session.players.find((candidate) => candidate.seat === seat);
  if (player) {
    player.publicTicketCount += count;
  }
  session.pendingOffer = null;
  session.phase = "ready";
  addLogEntry(`${player?.name ?? `Player ${seat}`} kept ${count} ticket(s) from route draw.`);
  endTurn();
  rerender();
}

function requestFaceUpReplacement(slotIndex) {
  session.pendingReplacement = {
    slotIndex
  };
  queueUIRefresh(false);
}

function requestHiddenDrawReveal(playerSeat) {
  session.pendingHiddenDraw = {
    playerSeat,
    drawIndex: session.currentTurnDrawCount
  };
  queueUIRefresh(false);
}

function finishFaceUpReplacement(color) {
  if (!session.pendingReplacement) {
    return;
  }

  pushHistory();
  session.faceUpCards[session.pendingReplacement.slotIndex] = color;
  session.drawPileCount = Math.max(0, session.drawPileCount - 1);
  session.pendingReplacement = null;

  if (session.currentTurnAction === "drawing" && session.currentTurnDrawCount >= 2) {
    endTurn();
  }

  rerender();
}

function finishHiddenDrawReveal(color) {
  if (!session.pendingHiddenDraw) {
    return;
  }

  pushHistory();
  const player = session.players.find(
    (candidate) => candidate.seat === session.pendingHiddenDraw.playerSeat
  );
  if (!player) {
    return;
  }

  if (player.seat === session.ourSeat && player.exactHand) {
    player.exactHand[color] += 1;
  }

  session.drawPileCount = Math.max(0, session.drawPileCount - 1);
  addLogEntry(`${player.name} revealed hidden draw as ${color}.`);
  session.pendingHiddenDraw = null;

  if (session.currentTurnDrawCount >= 2) {
    endTurn();
  } else {
    session.phase = "drawing-cards";
  }

  rerender();
}

function takeFaceUpCard(index) {
  const player = currentPlayer();
  if (!player) {
    return;
  }
  const color = session.faceUpCards[index];
  if (!color) {
    return;
  }

  pushHistory();
  if (player.seat === session.ourSeat && player.exactHand) {
    player.exactHand[color] += 1;
  } else {
    player.observedVisibleLowerBound[color] += 1;
  }

  session.currentTurnAction = "drawing";
  session.currentTurnDrawCount += 1;
  addLogEntry(`${player.name} took ${color} from the visible pool.`);

  const tookLocomotiveFirst = color === "locomotive" && session.currentTurnDrawCount === 1;
  requestFaceUpReplacement(index);

  if (tookLocomotiveFirst) {
    session.currentTurnDrawCount = 2;
  }

  if (session.currentTurnDrawCount === 1) {
    session.phase = "drawing-cards";
  }

  updateStatus("Choose the replacement card for the visible pool.");
  queueUIRefresh(false);
}

function drawHiddenCard() {
  const player = currentPlayer();
  if (!player) {
    return;
  }

  pushHistory();
  session.currentTurnAction = "drawing";
  session.currentTurnDrawCount += 1;
  player.handCount += 1;
  addLogEntry(`${player.name} drew a hidden train card.`);

  if (player.seat === session.ourSeat) {
    updateStatus("Reveal which hidden train card was drawn.");
    requestHiddenDrawReveal(player.seat);
    return;
  }

  session.drawPileCount = Math.max(0, session.drawPileCount - 1);

  if (session.currentTurnDrawCount >= 2) {
    endTurn();
  } else {
    session.phase = "drawing-cards";
  }

  rerender();
}

function finalizeClaimRoute(player, routeId, payment) {
  const route = routeById(routeId);
  if (!player || !route) {
    return;
  }

  if (player.seat === session.ourSeat) {
    if (player.exactHand) {
      player.exactHand[payment.primaryColor] -= payment.colorCards;
      player.exactHand.locomotive -= payment.locomotives;
    }
  } else {
    spendObservedColor(player, payment.primaryColor, payment.colorCards);
    spendObservedColor(player, "locomotive", payment.locomotives);
  }

  addKnownOutOfDeckColor(payment.primaryColor, payment.colorCards);
  if (payment.locomotives > 0) {
    addKnownOutOfDeckColor("locomotive", payment.locomotives);
  }

  player.claimedRouteIds.push(routeId);
  player.trainsRemaining -= route.length;
  player.score += scoreRoutePoints[route.length];
  player.handCount = Math.max(0, player.handCount - route.length);
  session.claimedRoutes[routeId] = player.id;
  addLogEntry(
    `${player.name} claimed ${route.id} for ${scoreRoutePoints[route.length]} points.`
  );
  endTurn();
}

function claimRoute(routeId) {
  const player = currentPlayer();
  const route = routeById(routeId);
  if (!player || !route) {
    return;
  }

  if (session.claimedRoutes[routeId]) {
    updateStatus("Route is already claimed.");
    return;
  }

  if (player.seat === session.ourSeat) {
    pushHistory();
    const solverState = buildSolverState();
    const legalClaims = solverState
      ? getLegalClaimRouteActions(solverState, USA_BOARD.routes, buildParallelGroups())
      : [];
    const matching = legalClaims
      .filter((action) => action.routeId === routeId)
      .sort(
        (left, right) =>
          left.payment.locomotives - right.payment.locomotives ||
          right.payment.colorCards - left.payment.colorCards
      )[0];

    if (!matching) {
      updateStatus("That route is not currently legal from your exact hand.");
      history.pop();
      return;
    }

    finalizeClaimRoute(player, routeId, matching.payment);
    rerender();
    return;
  }

  pushHistory();
  session.pendingClaimPayment = {
    playerSeat: player.seat,
    routeId,
    primaryColor: route.color === "gray" ? null : route.color,
    locomotives: 0
  };
  updateStatus("Record which cards the opponent spent for this claim.");
  rerender();
}

function confirmPendingClaimPayment() {
  if (!session.pendingClaimPayment) {
    return;
  }

  const player = session.players.find(
    (candidate) => candidate.seat === session.pendingClaimPayment.playerSeat
  );
  const route = routeById(session.pendingClaimPayment.routeId);
  if (!player || !route) {
    return;
  }

  const primaryColor =
    session.pendingClaimPayment.primaryColor ??
    (route.color === "gray" ? "red" : route.color);
  const locomotives = Math.max(0, Math.min(route.length, session.pendingClaimPayment.locomotives));
  const colorCards = Math.max(0, route.length - locomotives);

  finalizeClaimRoute(player, route.id, {
    primaryColor,
    colorCards,
    locomotives
  });
  session.pendingClaimPayment = null;
  rerender();
}

function buildParallelGroups() {
  const groups = new Map();
  USA_BOARD.routes.forEach((route) => {
    if (!route.parallelGroup) {
      return;
    }
    const existing = groups.get(route.parallelGroup) ?? [];
    existing.push(route);
    groups.set(route.parallelGroup, existing);
  });
  return groups;
}

function handleContextClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const actionTarget = target.closest("button");
  const control = actionTarget instanceof HTMLElement ? actionTarget : target;

  if (control.id === "reset-starting-hand") {
    resetStartingHand();
    return;
  }

  if (control.id === "confirm-starting-hand") {
    confirmStartingHand();
    return;
  }

  if (control.dataset.startingHandColor) {
    addStartingHandCard(control.dataset.startingHandColor);
    return;
  }

  if (control.id === "save-initial-offer") {
    const select = document.getElementById("initial-offer-select");
    const ticketIds = [...select.selectedOptions].map((option) => option.value);
    if (ticketIds.length !== 3) {
      updateStatus("Select exactly 3 initial offered tickets.");
      return;
    }
    setInitialSelfOffer(ticketIds);
    return;
  }

  if (control.id === "confirm-initial-keep") {
    const ticketIds = [...document.querySelectorAll("[data-ticket-choice]:checked")].map(
      (input) => input.dataset.ticketChoice
    );
    confirmInitialSelfKeep(ticketIds);
    return;
  }

  if (control.dataset.opponentKeep) {
    recordOpponentInitialKeep(Number(control.dataset.opponentKeep));
    return;
  }

  if (control.dataset.seatChoice) {
    chooseSeat(Number(control.dataset.seatChoice));
    return;
  }

  if (control.id === "confirm-starting-pool") {
    const colors = session.pendingStartingPool.filter(Boolean);
    if (colors.length !== 5) {
      updateStatus("Set all 5 starting pool cards.");
      return;
    }
    setStartingPool(session.pendingStartingPool);
    return;
  }

  if (control.id === "clear-starting-pool") {
    clearStartingPool();
    return;
  }

  if (control.dataset.poolSlot) {
    setStartingPoolSlot(Number(control.dataset.poolSlot));
    return;
  }

  if (control.dataset.startingPoolColor) {
    setStartingPoolColor(control.dataset.startingPoolColor);
    return;
  }

  if (control.dataset.replacementColor) {
    finishFaceUpReplacement(control.dataset.replacementColor);
    return;
  }

  if (control.dataset.hiddenRevealColor) {
    finishHiddenDrawReveal(control.dataset.hiddenRevealColor);
    return;
  }

  if (control.dataset.claimPaymentColor) {
    if (session.pendingClaimPayment) {
      session.pendingClaimPayment.primaryColor = control.dataset.claimPaymentColor;
      queueUIRefresh(false);
    }
    return;
  }

  if (control.id === "confirm-claim-payment") {
    const locomotivesSelect = document.getElementById("claim-payment-locomotives");
    if (session.pendingClaimPayment && locomotivesSelect) {
      session.pendingClaimPayment.locomotives = Number(locomotivesSelect.value || 0);
    }
    confirmPendingClaimPayment();
    return;
  }

  if (control.dataset.faceUpIndex) {
    takeFaceUpCard(Number(control.dataset.faceUpIndex));
    return;
  }

  if (control.id === "draw-hidden-deck") {
    drawHiddenCard();
    return;
  }

  if (control.id === "draw-ticket-deck") {
    if (isOurTurn()) {
      beginSelfTicketDraw();
    } else {
      beginOpponentTicketDraw();
    }
    return;
  }

  if (control.id === "set-self-ticket-offer") {
    const select = document.getElementById("self-ticket-offer");
    const ticketIds = [...select.selectedOptions].map((option) => option.value);
    if (ticketIds.length < 1) {
      updateStatus("Select the tickets you drew.");
      return;
    }
    setSelfTicketDrawOffer(ticketIds);
    return;
  }

  if (control.id === "confirm-self-ticket-draw") {
    const ticketIds = [...document.querySelectorAll("[data-ticket-choice]:checked")].map(
      (input) => input.dataset.ticketChoice
    );
    confirmSelfTicketDrawKeep(ticketIds);
    return;
  }

  if (control.dataset.opponentTicketKeep) {
    confirmOpponentTicketKeep(Number(control.dataset.opponentTicketKeep));
  }
}

function handleBoardClick(event) {
  const target = event.target;
  if (!(target instanceof SVGElement)) {
    return;
  }
  const routeId = target.dataset.routeId;
  if (!routeId || session.actionMode !== "claim-route") {
    return;
  }
  claimRoute(routeId);
}

function handleHandClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.handColor) {
    return;
  }
  const color = target.dataset.handColor;
  const delta = Number(target.dataset.delta || 0);
  const our = ourPlayer();
  if (!our || !our.exactHand || !delta) {
    return;
  }
  pushHistory();
  our.exactHand[color] = Math.max(0, our.exactHand[color] + delta);
  our.handCount = Math.max(0, our.handCount + delta);
  addLogEntry(`Adjusted your ${color} count to ${our.exactHand[color]}.`);
  rerender();
}

function readSelectedOptions(select) {
  return [...select.selectedOptions].map((option) => option.value);
}

function buildMetadataDocument() {
  return {
    gameId: metadataState.gameId || "table-unknown",
    gameVariant: metadataState.gameVariant,
    players: metadataState.players.map((player) => ({
      playerName: player.playerName,
      destinationSelections: player.destinationSelections.map((selection) => ({
        selectionType: selection.selectionType,
        ...(selection.moveNumber != null ? { moveNumber: selection.moveNumber } : {}),
        offered: [...selection.offered],
        kept: [...selection.kept]
      }))
    }))
  };
}

function renderMetadataBuilder() {
  metadataGameIdInput.value = metadataState.gameId;
  metadataVariantSelect.value = metadataState.gameVariant;

  if (metadataOfferedTickets.options.length === 0) {
    SORTED_TICKETS.forEach((ticket) => {
      metadataOfferedTickets.appendChild(new Option(ticketLabel(ticket.id), ticket.id));
      metadataKeptTickets.appendChild(new Option(ticketLabel(ticket.id), ticket.id));
    });
  }

  metadataSelectionList.innerHTML = "";
  if (metadataState.players.length === 0) {
    metadataSelectionList.innerHTML = "<div class='empty-state'>No metadata selections recorded yet.</div>";
  } else {
    metadataState.players.forEach((player) => {
      const card = document.createElement("div");
      card.className = "ticket-card";
      card.innerHTML = `<strong>${player.playerName}</strong>`;
      player.destinationSelections.forEach((selection) => {
        const block = document.createElement("div");
        block.className = "meta-line";
        block.innerHTML = `
          <div>${selection.selectionType}${selection.moveNumber != null ? ` @ move ${selection.moveNumber}` : ""}</div>
          <div>Offered: ${selection.offered.map(ticketLabel).join("; ") || "-"}</div>
          <div>Kept: ${selection.kept.map(ticketLabel).join("; ") || "-"}</div>
        `;
        card.appendChild(block);
      });
      metadataSelectionList.appendChild(card);
    });
  }

  metadataPreview.textContent = JSON.stringify(buildMetadataDocument(), null, 2);
}

function addMetadataSelection() {
  const playerName = metadataPlayerNameInput.value.trim();
  const selectionType = metadataSelectionTypeSelect.value;
  const moveNumber =
    selectionType === "midgame-draw" && metadataMoveNumberInput.value
      ? Number(metadataMoveNumberInput.value)
      : null;
  const offered = readSelectedOptions(metadataOfferedTickets);
  const kept = readSelectedOptions(metadataKeptTickets);

  if (!playerName) {
    updateStatus("Enter player name for metadata selection.");
    return;
  }

  if (offered.length === 0 || kept.length === 0) {
    updateStatus("Metadata selection needs both offered and kept tickets.");
    return;
  }

  metadataState.gameId = metadataGameIdInput.value.trim();
  metadataState.gameVariant = metadataVariantSelect.value;

  let player = metadataState.players.find((candidate) => candidate.playerName === playerName);
  if (!player) {
    player = {
      playerName,
      destinationSelections: []
    };
    metadataState.players.push(player);
  }

  player.destinationSelections.push({
    selectionType,
    moveNumber,
    offered,
    kept
  });

  metadataPlayerNameInput.value = playerName;
  metadataMoveNumberInput.value = "";
  metadataOfferedTickets.selectedIndex = -1;
  metadataKeptTickets.selectedIndex = -1;
  updateStatus(`Added metadata selection for ${playerName}.`);
  render();
}

function resetMetadataBuilder() {
  metadataState = createMetadataState();
  metadataGameIdInput.value = "";
  metadataPlayerNameInput.value = "";
  metadataMoveNumberInput.value = "";
  metadataOfferedTickets.selectedIndex = -1;
  metadataKeptTickets.selectedIndex = -1;
  render();
}

function downloadMetadataJson() {
  const gameId = (metadataState.gameId || "table-unknown").replace(/[^\w\[\]-]+/g, "-");
  const blob = new Blob([`${JSON.stringify(buildMetadataDocument(), null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${gameId}.metadata.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function rerenderOnly() {
  render();
}

function handleWorkspaceModeChange() {
  currentWorkspaceMode = workspaceMode.value;
  updateStatus(
    currentWorkspaceMode === "play"
      ? "Set up the table and continue the game flow."
      : currentWorkspaceMode === "replay"
        ? "Load a benchmark replay JSON and step through the generated game."
        : "Build destination metadata from ticket offers and kept selections."
  );
  render();
}

function handleReplayFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const payload = JSON.parse(String(reader.result ?? "{}"));
      replayState = {
        payload,
        gameIndex: 0,
        stepIndex: 0
      };
      updateStatus(`Loaded replay file with ${payload.games?.length ?? 0} game(s).`);
      render();
    } catch (error) {
      updateStatus(`Could not parse replay file: ${error.message}`);
    }
  });
  reader.readAsText(file);
}

function handleReplayGameChange() {
  replayState.gameIndex = Number(replayGameSelect.value || 0);
  replayState.stepIndex = 0;
  render();
}

function stepReplay(delta) {
  const game = getReplayGame();
  if (!game) {
    return;
  }

  replayState.stepIndex = Math.max(
    0,
    Math.min(game.steps.length, replayState.stepIndex + delta)
  );
  render();
}

startGameButton.addEventListener("click", initializeGame);
undoButton.addEventListener("click", restoreHistory);
workspaceMode.addEventListener("change", handleWorkspaceModeChange);
replayFileInput.addEventListener("change", handleReplayFileChange);
replayGameSelect.addEventListener("change", handleReplayGameChange);
replayPrevStepButton.addEventListener("click", () => stepReplay(-1));
replayNextStepButton.addEventListener("click", () => stepReplay(1));
claimRouteModeButton.addEventListener("click", () => {
  session.actionMode = "claim-route";
  render();
});
cancelModeButton.addEventListener("click", () => {
  session.actionMode = null;
  render();
});
contextPanel.addEventListener("click", handleContextClick);
boardContainer.addEventListener("click", handleBoardClick);
handCards.addEventListener("click", handleHandClick);
metadataAddSelectionButton.addEventListener("click", addMetadataSelection);
metadataResetButton.addEventListener("click", resetMetadataBuilder);
metadataDownloadButton.addEventListener("click", downloadMetadataJson);
metadataGameIdInput.addEventListener("input", () => {
  metadataState.gameId = metadataGameIdInput.value.trim();
  render();
});
metadataVariantSelect.addEventListener("change", () => {
  metadataState.gameVariant = metadataVariantSelect.value;
  render();
});

undoButton.disabled = true;
render();
