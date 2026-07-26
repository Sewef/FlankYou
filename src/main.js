import "./style.css";
import OBR, { buildImage, buildShape } from "@owlbear-rodeo/sdk";

import {
  EXTENSION_ID,
  METADATA_FIELDS,
  METADATA_KEY,
  URL,
  RULESET_LABELS,
  RULESETS,
  TEAM_COLORS,
  TEAM_DEFAULT,
  TEAM_LABELS,
  TEAMS,
  normalizeRuleset,
  normalizeTeam,
} from "./constants.js";
import { formatCell } from "./cells.js";
import { isFlanked } from "./flanking.js";
import { toTokenCellInfo } from "./grid.js";
import { escapeHtml } from "./html.js";
import {
  ensureExtensionMetadata,
  getTeam,
  isFlankableImage,
  isFlankUFlankedIcon,
  isFlankUHitbox,
  isImmune,
} from "./items.js";
import { applyTheme } from "./theme.js";

const FLANKED_ICON_IMAGE = {
  width: 256,
  height: 256,
  mime: "image/webp",
  url: `${URL}/flanked.webp`,
};
const FLANKED_ICON_GRID = {
  dpi: 256,
  offset: { x: 0, y: 0 },
};
let gridDpi = 150;
let gridType = null;
let unsubscribeItems = null;
let unsubscribeGrid = null;
let unsubscribeRoomMetadata = null;
let unsubscribeTheme = null;
let isUpdatingTeam = false;
let isUpdatingImmune = false;
let isUpdatingHitboxes = false;
let isUpdatingFlankedIcons = false;
let isUpdatingFlankedMetadata = false;
let showHitbox = localStorage.getItem(`${EXTENSION_ID}/show-hitbox`) === "true";
let refreshPromise = null;
let refreshQueued = false;
let lastTokenInputSignature = null;
let lastHitboxSignature = null;
let lastFlankedIconSignature = null;
let lastFlankedMetadataSignature = null;
let activeTeam = normalizeTeam(localStorage.getItem(`${EXTENSION_ID}/active-team`));
let activeRuleset = normalizeRuleset();
let activeMountsCanFlank = false;

document.querySelector("#app").innerHTML = `
  <main class="panel">
    <header class="header">
      <div>
        <p class="eyebrow">Flank U very much</p>
        <div class="header-controls">
          <button id="refresh" type="button">Refresh</button>
          <label class="option-toggle">
            <input id="show-hitbox" type="checkbox" />
            Hitboxes
          </label>
          <label class="option-toggle">
            <input id="mounts-can-flank" type="checkbox" />
            Mounts can flank
          </label>
                    <label class="ruleset-control">
            <span>Rules</span>
            <select id="ruleset">
              ${RULESETS.map((ruleset) => {
                return `
                  <option value="${ruleset}" ${ruleset === activeRuleset ? "selected" : ""}>
                    ${RULESET_LABELS[ruleset]}
                  </option>
                `;
              }).join("")}
            </select>
          </label>
        </div>
      </div>
    </header>

    <nav class="team-tabs" aria-label="Team tabs">
      ${TEAMS.map((team, index) => {
        return `
          <button
            type="button"
            class="${index === 0 ? "active" : ""}"
            data-team-tab="${team}"
            style="--team-color: ${TEAM_COLORS[team]}"
          >
            ${TEAM_LABELS[team]}
            <span id="team-count-${team}">0</span>
          </button>
        `;
      }).join("")}
    </nav>

    <section class="token-list" aria-label="Token cell positions">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Team</th>
            <th>Imm.</th>
            <th>Flanked</th>
            <th>Pos.</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody id="token-rows">
          <tr></tr>
        </tbody>
      </table>
    </section>
  </main>
`;

const tokenRowsEl = document.querySelector("#token-rows");
const showHitboxEl = document.querySelector("#show-hitbox");
const rulesetEl = document.querySelector("#ruleset");
const mountsCanFlankEl = document.querySelector("#mounts-can-flank");
const teamTabsEl = document.querySelector(".team-tabs");

document.querySelector("#refresh").addEventListener("click", () => {
  resetSyncSignatures();
  refreshTokenPositions();
});
tokenRowsEl.addEventListener("change", handleTableChange);
teamTabsEl.addEventListener("click", handleTeamTabClick);
showHitboxEl.checked = showHitbox;
showHitboxEl.addEventListener("change", handleShowHitboxChange);
rulesetEl.value = activeRuleset;
rulesetEl.addEventListener("change", handleRulesetChange);
mountsCanFlankEl.checked = activeMountsCanFlank;
mountsCanFlankEl.addEventListener("change", handleMountsCanFlankChange);

if (OBR.isAvailable) {
  OBR.onReady(setup);
}

async function setup() {
  applyTheme(await OBR.theme.getTheme());
  unsubscribeTheme = OBR.theme.onChange(applyTheme);

  if ((await OBR.player.getRole()) !== "GM") {
    renderNoGmMessage();
    return;
  }

  await refreshRoomSettings();
  await registerContextMenus();

  unsubscribeRoomMetadata = OBR.room.onMetadataChange(handleRoomMetadataChange);

  OBR.scene.onReadyChange(handleSceneReady);
  handleSceneReady(await OBR.scene.isReady());
}

function renderNoGmMessage() {
  document.querySelector("#app").innerHTML = `
    <main class="no-gm-panel">
      U NO GM ᕕ( ᐛ )ᕗ
    </main>
  `;
}

async function handleSceneReady(ready) {
  if (!ready) {
    unsubscribeItems?.();
    unsubscribeItems = null;
    unsubscribeGrid?.();
    unsubscribeGrid = null;
    resetSyncSignatures();
    renderTokens([]);
    await clearHitboxes();
    await clearFlankedIcons();
    return;
  }

  unsubscribeItems?.();
  unsubscribeGrid?.();
  await refreshGrid();
  unsubscribeGrid = OBR.scene.grid.onChange(handleGridChange);
  unsubscribeItems = OBR.scene.items.onChange(handleItemsChange);
  await refreshTokenPositions();
}

async function refreshGrid() {
  [gridDpi, gridType] = await Promise.all([
    OBR.scene.grid.getDpi(),
    OBR.scene.grid.getType(),
  ]);
}

function handleGridChange(grid) {
  if (grid.dpi === gridDpi && grid.type === gridType) {
    return;
  }

  gridDpi = grid.dpi;
  gridType = grid.type;
  resetSyncSignatures();
  refreshTokenPositions();
}

async function refreshRoomSettings() {
  handleRoomMetadataChange(await OBR.room.getMetadata(), false);
}

function handleRoomMetadataChange(metadata, refresh = true) {
  const extensionMetadata = metadata?.[METADATA_KEY];
  const nextRuleset = normalizeRuleset(extensionMetadata?.[METADATA_FIELDS.ruleset]);
  const nextMountsCanFlank = extensionMetadata?.[METADATA_FIELDS.mountsCanFlank] === true;

  if (nextRuleset === activeRuleset && nextMountsCanFlank === activeMountsCanFlank) {
    return;
  }

  activeRuleset = nextRuleset;
  activeMountsCanFlank = nextMountsCanFlank;
  rulesetEl.value = activeRuleset;
  mountsCanFlankEl.checked = activeMountsCanFlank;
  resetSyncSignatures();

  if (refresh) {
    refreshTokenPositions();
  }
}

async function refreshTokenPositions() {
  refreshQueued = true;

  if (!refreshPromise) {
    refreshPromise = drainTokenRefreshes();
  }

  return refreshPromise;
}

async function drainTokenRefreshes() {
  try {
    while (refreshQueued) {
      refreshQueued = false;
      await performTokenRefresh();
    }
  } finally {
    refreshPromise = null;
  }
}

async function performTokenRefresh() {
  try {
    if (!(await OBR.scene.isReady())) {
      return;
    }

    await refreshGrid();

    const items = await OBR.scene.items.getItems((item) => {
      return isFlankableImage(item, activeMountsCanFlank);
    });
    lastTokenInputSignature = getTokenInputSignature(items);
    const tokens = await Promise.all(
      items.map((item) => {
        return toTokenCellInfo(item, gridDpi, (...args) => OBR.scene.grid.snapPosition(...args));
      }),
    );
    const tokensWithState = tokens.map((token) => {
      return {
        ...token,
        flanked: isFlanked(token, tokens, activeRuleset),
      };
    });

    const sortedTokens = tokensWithState.sort(compareTokenInfo);
    renderTokens(sortedTokens);
    await syncFlankedMetadata(sortedTokens);
    await syncFlankedIcons(sortedTokens);
    await syncHitboxes(sortedTokens);
  } catch (error) {
    handleObrError(error, "refreshTokenPositions");
  }
}

function handleItemsChange(items) {
  const nextSignature = getTokenInputSignature(items);

  if (nextSignature === lastTokenInputSignature) {
    return;
  }

  lastTokenInputSignature = nextSignature;
  refreshTokenPositions();
}

async function registerContextMenus() {
  await OBR.contextMenu.create({
    id: `${EXTENSION_ID}/context-menu`,
    icons: [
      {
        icon: "/icon.svg",
        label: "Flank U",
        filter: { min: 1, roles: ["GM"] },
      },
    ],
    embed: {
      url: "/context-menu.html",
      height: 150,
    },
  });
}

function handleTeamTabClick(event) {
  const button = event.target.closest("[data-team-tab]");

  if (!button) {
    return;
  }

  activeTeam = normalizeTeam(button.dataset.teamTab);
  localStorage.setItem(`${EXTENSION_ID}/active-team`, activeTeam);
  updateActiveTab();
  refreshTokenPositions();
}

async function handleShowHitboxChange() {
  showHitbox = showHitboxEl.checked;
  localStorage.setItem(`${EXTENSION_ID}/show-hitbox`, String(showHitbox));

  if (showHitbox) {
    await refreshTokenPositions();
  } else {
    await clearHitboxes();
  }
}

async function handleRulesetChange() {
  activeRuleset = normalizeRuleset(rulesetEl.value);
  await setRoomSettings({ [METADATA_FIELDS.ruleset]: activeRuleset });
  resetSyncSignatures();
  await refreshTokenPositions();
}

async function handleMountsCanFlankChange() {
  activeMountsCanFlank = mountsCanFlankEl.checked;
  await setRoomSettings({ [METADATA_FIELDS.mountsCanFlank]: activeMountsCanFlank });
  resetSyncSignatures();
  await refreshTokenPositions();
}

async function handleTableChange(event) {
  try {
    const immuneToggle = event.target.closest("[data-immune-toggle]");
    const teamSelect = event.target.closest("[data-team-toggle]");

    if (immuneToggle && !isUpdatingImmune) {
      await setImmune([immuneToggle.dataset.tokenId], immuneToggle.checked);
      return;
    }

    if (teamSelect && !isUpdatingTeam) {
      await setTeam([teamSelect.dataset.tokenId], teamSelect.value);
    }
  } catch (error) {
    handleObrError(error, "handleTableChange");
  }
}

async function setTeam(ids, team) {
  if (!ids.length || !TEAMS.includes(team) || !(await OBR.scene.isReady())) {
    return;
  }

  isUpdatingTeam = true;

  try {
    await OBR.scene.items.updateItems(
      (item) => ids.includes(item.id) && isFlankableImage(item, activeMountsCanFlank),
      (items) => {
        for (const item of items) {
          const metadata = ensureExtensionMetadata(item);
          metadata[METADATA_FIELDS.team] = team;
        }
      },
    );
    await refreshTokenPositions();
  } finally {
    isUpdatingTeam = false;
  }
}

async function setImmune(ids, immune) {
  if (!ids.length || !(await OBR.scene.isReady())) {
    return;
  }

  isUpdatingImmune = true;

  try {
    await OBR.scene.items.updateItems(
      (item) => ids.includes(item.id) && isFlankableImage(item, activeMountsCanFlank),
      (items) => {
        for (const item of items) {
          const metadata = ensureExtensionMetadata(item);
          if (immune) {
            metadata[METADATA_FIELDS.immune] = true;
          } else {
            delete metadata[METADATA_FIELDS.immune];
          }
        }
      },
    );
    await refreshTokenPositions();
  } finally {
    isUpdatingImmune = false;
  }
}

async function syncHitboxes(tokens) {
  if (isUpdatingHitboxes || !showHitbox || !(await OBR.scene.isReady())) {
    return;
  }

  const nextSignature = getHitboxSignature(tokens);
  if (nextSignature === lastHitboxSignature) {
    return;
  }

  isUpdatingHitboxes = true;

  try {
    await clearHitboxes();
    const shapesToAdd = tokens.map(buildTokenHitbox);

    if (shapesToAdd.length) {
      await OBR.scene.items.addItems(shapesToAdd);
    }

    lastHitboxSignature = nextSignature;
  } finally {
    isUpdatingHitboxes = false;
  }
}

async function syncFlankedIcons(tokens) {
  if (isUpdatingFlankedIcons || !(await OBR.scene.isReady())) {
    return;
  }

  const flankedTokens = tokens.filter((token) => token.flanked);
  const nextSignature = getFlankedIconSignature(flankedTokens);
  if (nextSignature === lastFlankedIconSignature) {
    return;
  }

  isUpdatingFlankedIcons = true;

  try {
    await clearFlankedIcons();
    const iconsToAdd = flankedTokens.map(buildFlankedIcon);

    if (iconsToAdd.length) {
      await OBR.scene.items.addItems(iconsToAdd);
    }

    lastFlankedIconSignature = nextSignature;
  } finally {
    isUpdatingFlankedIcons = false;
  }
}

async function clearFlankedIcons() {
  lastFlankedIconSignature = "";

  if (!OBR.isAvailable || !(await OBR.scene.isReady())) {
    return;
  }

  const icons = await getFlankedIcons();

  if (icons.length) {
    await OBR.scene.items.deleteItems(icons.map((item) => item.id));
  }
}

async function getFlankedIcons() {
  return OBR.scene.items.getItems(isFlankUFlankedIcon);
}

async function syncFlankedMetadata(tokens) {
  const nextSignature = getFlankedMetadataSignature(tokens);
  if (nextSignature === lastFlankedMetadataSignature) {
    return;
  }

  const flankedById = new Map(tokens.map((token) => [token.id, token.flanked]));

  isUpdatingFlankedMetadata = true;

  try {
    await OBR.scene.items.updateItems(
      (item) => {
        const currentValue = item.metadata?.[METADATA_KEY]?.[METADATA_FIELDS.isFlanked];
        const nextValue = flankedById.get(item.id) ?? false;

        return (
          isFlankableImage(item, true) &&
          (flankedById.has(item.id) || currentValue === true) &&
          currentValue !== nextValue
        );
      },
      (items) => {
        for (const item of items) {
          const metadata = ensureExtensionMetadata(item);
          metadata[METADATA_FIELDS.isFlanked] = flankedById.get(item.id) ?? false;
        }
      },
    );
    lastFlankedMetadataSignature = nextSignature;
  } finally {
    isUpdatingFlankedMetadata = false;
  }
}

async function clearHitboxes() {
  lastHitboxSignature = "";

  if (!OBR.isAvailable || !(await OBR.scene.isReady())) {
    return;
  }

  const hitboxes = await OBR.scene.items.getItems(isFlankUHitbox);

  if (hitboxes.length) {
    await OBR.scene.items.deleteItems(hitboxes.map((item) => item.id));
  }
}

function resetSyncSignatures() {
  lastTokenInputSignature = null;
  lastHitboxSignature = null;
  lastFlankedIconSignature = null;
  lastFlankedMetadataSignature = null;
}

function getHitboxSignature(tokens) {
  return tokens
    .map((token) => {
      return [
        token.id,
        token.team,
        token.size.width,
        token.size.height,
        gridDpi,
      ].join(":");
    })
    .sort()
    .join("|");
}

function getFlankedIconSignature(tokens) {
  return tokens
    .map((token) => {
      return [
        token.id,
        token.size.width,
        token.size.height,
        gridDpi,
      ].join(":");
    })
    .sort()
    .join("|");
}

function getFlankedMetadataSignature(tokens) {
  return tokens
    .map((token) => `${token.id}:${token.flanked}`)
    .sort()
    .join("|");
}

function getTokenInputSignature(items) {
  return items
    .filter((item) => isFlankableImage(item, activeMountsCanFlank))
    .map((item) => {
      return JSON.stringify([
        item.id,
        item.name,
        item.position.x,
        item.position.y,
        item.rotation,
        item.scale.x,
        item.scale.y,
        item.image.width,
        item.image.height,
        item.grid.dpi,
        item.grid.offset.x,
        item.grid.offset.y,
        getTeam(item),
        isImmune(item),
      ]);
    })
    .sort()
    .join("|");
}

async function setRoomSettings(settings) {
  const metadata = await OBR.room.getMetadata();

  await OBR.room.setMetadata({
    [METADATA_KEY]: {
      ...(metadata?.[METADATA_KEY] ?? {}),
      ...settings,
    },
  });
}

function buildTokenHitbox(token) {
  const color = TEAM_COLORS[token.team] ?? TEAM_COLORS[TEAM_DEFAULT];
  const width = token.size.width * gridDpi;
  const height = token.size.height * gridDpi;

  return buildShape()
    .name(`Flank U Hitbox: ${token.name}`)
    .layer("DRAWING")
    .position({
      x: token.origin.x - width / 2,
      y: token.origin.y - height / 2,
    })
    .width(width)
    .height(height)
    .fillColor(color)
    .fillOpacity(0.28)
    .strokeColor(color)
    .strokeOpacity(0.9)
    .strokeWidth(3)
    .disableHit(true)
    .locked(true)
    .attachedTo(token.id)
    .metadata({
      [METADATA_KEY]: {
        [METADATA_FIELDS.hitbox]: true,
        [METADATA_FIELDS.hitboxTokenId]: token.id,
      },
    })
    .build();
}

function buildFlankedIcon(token) {
  const tokenWidth = token.size.width * gridDpi;
  const tokenHeight = token.size.height * gridDpi;
  const iconSize = Math.min(tokenWidth, tokenHeight) * 0.35;
  const iconScale = iconSize / gridDpi;
  const tokenLeft = token.origin.x - tokenWidth / 2;
  const tokenTop = token.origin.y - tokenHeight / 2;

  return buildImage(FLANKED_ICON_IMAGE, FLANKED_ICON_GRID)
    .name(`Flank U Icon: ${token.name}`)
    .layer("ATTACHMENT")
    .position({
      x: tokenLeft + tokenWidth - iconSize,
      y: tokenTop,
    })
    .scale({ x: iconScale, y: iconScale })
    .disableHit(true)
    .locked(true)
    .attachedTo(token.id)
    .metadata({
      [METADATA_KEY]: {
        [METADATA_FIELDS.flankedIcon]: true,
        [METADATA_FIELDS.flankedIconTokenId]: token.id,
      },
    })
    .build();
}

function renderTokens(tokens) {
  updateActiveTab();
  updateTeamCounts(tokens);

  const visibleTokens = tokens.filter((token) => token.team === activeTeam);

  if (!visibleTokens.length) {
    tokenRowsEl.innerHTML = `
      <tr>
        <td colspan="6" class="empty">No ${TEAM_LABELS[activeTeam]} tokens found.</td>
      </tr>
    `;
    return;
  }

  tokenRowsEl.innerHTML = visibleTokens.map(renderTokenRow).join("");
}

function renderTokenRow(token) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(token.name)}</strong>
      </td>
      <td>
        <select data-team-toggle data-token-id="${escapeHtml(token.id)}">
          ${TEAMS.map((team) => {
            return `
              <option value="${team}" ${token.team === team ? "selected" : ""}>
                ${TEAM_LABELS[team]}
              </option>
            `;
          }).join("")}
        </select>
      </td>
      <td>
        <label class="immune-toggle">
          <input
            data-immune-toggle
            data-token-id="${escapeHtml(token.id)}"
            type="checkbox"
            ${token.immune ? "checked" : ""}
          />
        </label>
      </td>
      <td>${renderStatus(token.flanked)}</td>
      <td>${formatCell(token.anchor)}</td>
      <td>${token.size.width}x${token.size.height}</td>
    </tr>
  `;
}

function renderStatus(value) {
  return `
    <span class="status ${value ? "yes" : "no"}">
      ${value ? "Y" : "N"}
    </span>
  `;
}

function updateTeamCounts(tokens) {
  for (const team of TEAMS) {
    const countEl = document.querySelector(`#team-count-${team}`);

    if (countEl) {
      countEl.textContent = String(tokens.filter((token) => token.team === team).length);
    }
  }
}

function updateActiveTab() {
  for (const button of teamTabsEl.querySelectorAll("[data-team-tab]")) {
    button.classList.toggle("active", button.dataset.teamTab === activeTeam);
  }
}

function compareTokenInfo(a, b) {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function handleObrError(error, source) {
  if (isTransientObrError(error)) {
    return;
  }

  console.warn(`[Flank U] ${source} failed`, error);
}

function isTransientObrError(error) {
  const name = error?.error?.name ?? error?.name;
  return name === "MissingDataError" || name === "RateLimitHit";
}

window.addEventListener("pagehide", () => {
  unsubscribeItems?.();
  unsubscribeGrid?.();
  unsubscribeRoomMetadata?.();
  unsubscribeTheme?.();
});
