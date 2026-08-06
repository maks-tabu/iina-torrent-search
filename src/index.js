const {
  console,
  core,
  event,
  menu,
  mpv,
  standaloneWindow,
  utils,
  preferences,
} = iina;

const DEFAULT_SETTINGS = {
  jackettURL: "http://127.0.0.1:9117",
  apiKey: "",
  indexer: "all",
  limit: 50,
  timeoutSec: 20,
  avcOnly: true,
  sortBy: "relevance",
};

const PREF_KEYS = {
  jackettURL: "jackett_url",
  apiKey: "jackett_api_key",
  indexer: "jackett_indexer",
  limit: "result_limit",
  timeoutSec: "request_timeout_sec",
  avcOnly: "codec_avc_only",
  sortBy: "sort_by",
};

const LIMIT_MIN = 1;
const LIMIT_MAX = 200;
const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 60;

let menuInitialized = false;
let searchInProgress = false;
let state = {
  query: "",
  status: "Configure Jackett and run a search.",
  error: "",
  searching: false,
  results: [],
  summary: {
    total: 0,
    shown: 0,
  },
  settings: loadSettings(),
};

console.log("[torrent-search] plugin loaded");

setupPanel();
setupMenu();

event.on("iina.window-loaded", () => {
  if (!menuInitialized) {
    setupMenu();
    return;
  }
  renderMenu();
});

function setupMenu() {
  if (menuInitialized) {
    return;
  }

  menuInitialized = renderMenu();
}

function renderMenu() {
  try {
    menu.removeAllItems();

    menu.addItem(
      menu.item("Open Torrent Search", () => {
        openPanel();
      }),
    );

    menu.addItem(
      menu.item("Search Current Title", () => {
        const title = String(core.status && core.status.title ? core.status.title : "").trim();
        openPanel();
        if (title) {
          void handleSearch({
            query: title,
            settings: state.settings,
          });
        } else {
          core.osd("Current title is empty");
        }
      }),
    );

    menu.addItem(
      menu.item("Open Jackett Web UI", () => {
        const url = normalizedJackettRoot(state.settings.jackettURL);
        if (!url) {
          core.alert("Jackett URL is empty.");
          return;
        }
        utils.open(url);
      }),
    );

    return true;
  } catch (error) {
    console.error(`[torrent-search] menu render failed: ${formatError(error)}`);
    return false;
  }
}

function setupPanel() {
  if (!standaloneWindow || typeof standaloneWindow.loadFile !== "function") {
    return;
  }

  try {
    standaloneWindow.loadFile("src/panel.html");
    standaloneWindow.setProperty({ title: "Torrent Search" });
  } catch (error) {
    console.error(`[torrent-search] panel init failed: ${formatError(error)}`);
    return;
  }

  standaloneWindow.onMessage("panel-ready", () => {
    postState();
  });

  standaloneWindow.onMessage("panel-request-state", () => {
    postState();
  });

  standaloneWindow.onMessage("panel-search", async (payload) => {
    await handleSearch(payload || {});
  });

  standaloneWindow.onMessage("panel-open", async (payload) => {
    await handleOpenResult(payload || {});
  });

  standaloneWindow.onMessage("panel-open-browser", (payload) => {
    const url = String(payload && payload.url ? payload.url : "").trim();
    if (!url) {
      return;
    }
    utils.open(url);
  });

  standaloneWindow.onMessage("panel-save-settings", (payload) => {
    const settings = sanitizeSettings(payload || {});
    state.settings = settings;
    saveSettings(settings);
    postState();
  });
}

function openPanel() {
  if (!standaloneWindow || typeof standaloneWindow.open !== "function") {
    return;
  }
  standaloneWindow.open();
  postState();
}

function postState() {
  if (!standaloneWindow || typeof standaloneWindow.postMessage !== "function") {
    return;
  }
  standaloneWindow.postMessage("panel-state", state);
}

function setState(patch) {
  state = {
    ...state,
    ...patch,
  };
  postState();
}

async function handleSearch(payload) {
  const query = String(payload && payload.query ? payload.query : "").trim();
  const season = optionalPositiveInt(payload && payload.season, 99);
  const episode = optionalPositiveInt(payload && payload.episode, 999);
  const settings = sanitizeSettings(payload && payload.settings ? payload.settings : state.settings);

  state.settings = settings;
  state.query = query;
  saveSettings(settings);

  if (!query) {
    setState({
      error: "Enter a query.",
      status: "Query is empty.",
      results: [],
      summary: { total: 0, shown: 0 },
      searching: false,
    });
    return;
  }

  if (episode !== null && season === null) {
    setState({
      error: "Select a season before selecting an episode.",
      status: "Season is required for episode search.",
      results: [],
      summary: { total: 0, shown: 0 },
      searching: false,
    });
    return;
  }

  const searchQuery = buildSeriesQuery(query, season, episode);

  if (!settings.apiKey) {
    setState({
      error: "Jackett API key is empty.",
      status: "Set API key in the panel and retry.",
      results: [],
      summary: { total: 0, shown: 0 },
      searching: false,
    });
    return;
  }

  if (searchInProgress) {
    core.osd("Search is already running");
    return;
  }

  searchInProgress = true;
  setState({
    searching: true,
    error: "",
    status: `Searching for: ${searchQuery}`,
  });

  try {
    const result = await searchJackett(searchQuery, settings);
    const filterNote = settings.avcOnly
      ? ` AVC/x264 filter: ${result.codecShown}/${result.codecInput} shown.`
      : "";
    setState({
      searching: false,
      error: "",
      results: result.items,
      summary: {
        total: result.total,
        shown: result.items.length,
      },
      status: result.items.length
        ? `Found ${result.items.length} result(s), showing top ${result.items.length}.${filterNote}`
        : "No matching torrents.",
    });
  } catch (error) {
    setState({
      searching: false,
      results: [],
      summary: { total: 0, shown: 0 },
      error: formatError(error),
      status: "Search failed.",
    });
  } finally {
    searchInProgress = false;
  }
}

async function handleOpenResult(payload) {
  const url = String(payload && payload.url ? payload.url : "").trim();
  const title = String(payload && payload.title ? payload.title : "").trim();

  if (!url) {
    core.alert("Selected result has no playable URL.");
    return;
  }

  try {
    let openTarget = url;
    if (!isMagnetURL(url) && !looksLikeTorrentURL(url)) {
      const redirected = await tryResolveRedirectTarget(url, state.settings.timeoutSec);
      if (isMagnetURL(redirected)) {
        openTarget = redirected;
      } else {
      // Jackett /dl/... links often do not contain ".torrent" in URL.
      // Downloading to a local .torrent path makes mpv/IINA treat it as torrent input.
        openTarget = await downloadTorrentToTemp(url, title || "jackett-result", state.settings.timeoutSec);
      }
    }

    mpv.command("loadfile", [openTarget, "replace"]);
    core.osd(title ? `Opening: ${shortName(title, 72)}` : "Opening torrent result");
  } catch (error) {
    core.alert(`Failed to open result:\n${formatError(error)}`);
  }
}

async function searchJackett(query, settings) {
  const root = normalizedJackettRoot(settings.jackettURL);
  if (!root) {
    throw new Error("Jackett URL is empty.");
  }

  const endpoint = buildJackettSearchURL(root, settings.indexer, settings.apiKey, query);
  const res = await utils.exec("/usr/bin/curl", [
    "-sS",
    "--fail",
    "--connect-timeout",
    "5",
    "--max-time",
    String(settings.timeoutSec),
    endpoint,
  ]);

  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || "").trim();
    if (res.status === 28) {
      throw new Error(
        `Jackett request timed out after ${settings.timeoutSec}s. `
        + "Increase Timeout or check slow/failing indexers in Jackett.",
      );
    }
    if (res.status === 7) {
      throw new Error(`Cannot connect to Jackett at ${root}. Check that Jackett is running and the URL is correct.`);
    }
    throw new Error(detail ? `Jackett request failed: ${detail}` : `Jackett request failed with code ${res.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON from Jackett: ${formatError(error)}`);
  }

  const rows = Array.isArray(parsed.Results) ? parsed.Results : [];
  const indexers = Array.isArray(parsed.Indexers) ? parsed.Indexers : [];
  if (rows.length === 0 && indexers.length === 0) {
    throw new Error("No indexers are configured in Jackett. Add indexers in Jackett Web UI first.");
  }

  const mapped = rows
    .map((row, i) => mapResult(row, i))
    .filter((item) => Boolean(item.openURL));
  const deduped = dedupeResultsPreferMagnet(mapped);
  const codecFiltered = settings.avcOnly
    ? deduped.filter((item) => isAVCX264Title(item.title))
    : deduped;

  sortResults(codecFiltered, query, settings.sortBy);

  return {
    total: rows.length,
    codecInput: deduped.length,
    codecShown: codecFiltered.length,
    items: codecFiltered.slice(0, settings.limit),
  };
}

function isAVCX264Title(title) {
  const text = String(title || "").toLowerCase();
  return /\b(x264|h[\s._-]?264|avc)\b/.test(text);
}

function sortResults(items, query, sortBy) {
  const mode = ["relevance", "popularity", "newest"].includes(sortBy)
    ? sortBy
    : DEFAULT_SETTINGS.sortBy;

  items.sort((a, b) => {
    if (mode === "relevance") {
      const relevanceDiff = relevanceScore(b.title, query) - relevanceScore(a.title, query);
      if (relevanceDiff !== 0) return relevanceDiff;
    } else if (mode === "newest") {
      const dateDiff = b.publishTimestamp - a.publishTimestamp;
      if (dateDiff !== 0) return dateDiff;
    }

    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    if (b.peers !== a.peers) return b.peers - a.peers;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
}

function relevanceScore(title, query) {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedTitle || !normalizedQuery) {
    return 0;
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const titleTokens = new Set(normalizedTitle.split(" ").filter(Boolean));
  let score = 0;

  if (normalizedTitle === normalizedQuery) score += 1000;
  if (normalizedTitle.startsWith(`${normalizedQuery} `)) score += 500;
  else if (normalizedTitle.includes(` ${normalizedQuery} `)) score += 250;

  for (const token of tokens) {
    if (!titleTokens.has(token)) continue;
    score += /^s\d{1,2}(?:e\d{1,3})?$/.test(token) || /^\d{4}$/.test(token) ? 120 : 40;
  }

  if (tokens.length > 1 && tokens.every((token) => titleTokens.has(token))) {
    score += 150;
  }
  return score;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function dedupeResultsPreferMagnet(items) {
  const map = new Map();
  for (const item of items) {
    const key = String(item.title || "").trim().toLowerCase() || `id:${item.id}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }

    const merged = {
      ...existing,
      ...item,
      title: existing.title || item.title,
      // Keep richer fields from either side.
      detailsURL: existing.detailsURL || item.detailsURL,
      tracker: existing.tracker || item.tracker,
      category: existing.category || item.category,
      ageLabel: existing.ageLabel || item.ageLabel,
      sizeLabel: existing.sizeLabel || item.sizeLabel,
      sizeBytes: existing.sizeBytes > 0 ? existing.sizeBytes : item.sizeBytes,
      publishDate: existing.publishDate || item.publishDate,
      seeders: Math.max(existing.seeders, item.seeders),
      peers: Math.max(existing.peers, item.peers),
      // Prefer magnet because it is the most reliable input for torrent-stream.
      magnet: existing.magnet || item.magnet,
      link: existing.link || item.link,
    };
    merged.openURL = merged.magnet || merged.link || existing.openURL || item.openURL;
    merged.isMagnet = Boolean(merged.magnet);
    map.set(key, merged);
  }
  return Array.from(map.values());
}

function mapResult(row, index) {
  const magnet = pickString(row.MagnetUri, row.magnetUri, row.magnet);
  const link = pickString(row.Link, row.link, row.Guid, row.guid);
  const openURL = magnet || link;

  const sizeBytes = toNumber(row.Size, 0);
  const seeders = toNumber(row.Seeders, -1);
  const peers = toNumber(row.Peers, -1);

  const publishRaw = pickString(row.PublishDate, row.PublishDateUTC, row.PubDate, row.publishDate, row.date);

  return {
    id: index + 1,
    title: pickString(row.Title, row.title) || `Result ${index + 1}`,
    tracker: pickString(row.Tracker, row.tracker, row.Site, row.site, row.JackettIndexer, row.indexer),
    category: categoryText(row),
    detailsURL: pickString(row.Details, row.details, row.Guid, row.guid),
    magnet,
    link,
    openURL,
    isMagnet: Boolean(magnet),
    seeders,
    peers,
    sizeBytes,
    sizeLabel: formatBytes(sizeBytes),
    publishDate: publishRaw,
    publishTimestamp: Number.isFinite(Date.parse(publishRaw)) ? Date.parse(publishRaw) : 0,
    ageLabel: formatAge(publishRaw),
  };
}

function loadSettings() {
  const raw = {
    jackettURL: getPref(PREF_KEYS.jackettURL, DEFAULT_SETTINGS.jackettURL),
    apiKey: getPref(PREF_KEYS.apiKey, DEFAULT_SETTINGS.apiKey),
    indexer: getPref(PREF_KEYS.indexer, DEFAULT_SETTINGS.indexer),
    limit: getPref(PREF_KEYS.limit, String(DEFAULT_SETTINGS.limit)),
    timeoutSec: getPref(PREF_KEYS.timeoutSec, String(DEFAULT_SETTINGS.timeoutSec)),
    avcOnly: getPref(PREF_KEYS.avcOnly, DEFAULT_SETTINGS.avcOnly ? "1" : "0"),
    sortBy: getPref(PREF_KEYS.sortBy, DEFAULT_SETTINGS.sortBy),
  };
  return sanitizeSettings(raw);
}

function saveSettings(settings) {
  preferences.set(PREF_KEYS.jackettURL, settings.jackettURL);
  preferences.set(PREF_KEYS.apiKey, settings.apiKey);
  preferences.set(PREF_KEYS.indexer, settings.indexer);
  preferences.set(PREF_KEYS.limit, String(settings.limit));
  preferences.set(PREF_KEYS.timeoutSec, String(settings.timeoutSec));
  preferences.set(PREF_KEYS.avcOnly, settings.avcOnly ? "1" : "0");
  preferences.set(PREF_KEYS.sortBy, settings.sortBy);
  preferences.sync();
}

function getPref(key, fallback) {
  const value = preferences.get(key);
  return typeof value === "string" ? value : fallback;
}

function sanitizeSettings(input) {
  const jackettURL = String(input.jackettURL || "").trim() || DEFAULT_SETTINGS.jackettURL;
  const apiKey = String(input.apiKey || "").trim();
  const indexer = String(input.indexer || "").trim() || DEFAULT_SETTINGS.indexer;

  return {
    jackettURL,
    apiKey,
    indexer,
    limit: clampInt(input.limit, DEFAULT_SETTINGS.limit, LIMIT_MIN, LIMIT_MAX),
    timeoutSec: clampInt(input.timeoutSec, DEFAULT_SETTINGS.timeoutSec, TIMEOUT_MIN, TIMEOUT_MAX),
    avcOnly: parseBool(input.avcOnly, DEFAULT_SETTINGS.avcOnly),
    sortBy: ["relevance", "popularity", "newest"].includes(input.sortBy)
      ? input.sortBy
      : DEFAULT_SETTINGS.sortBy,
  };
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  return Boolean(fallback);
}

function optionalPositiveInt(value, max) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  const integer = Math.floor(number);
  return integer >= 1 && integer <= max ? integer : null;
}

function buildSeriesQuery(query, season, episode) {
  if (season === null) {
    return query;
  }
  const base = String(query)
    .replace(/\bs\d{1,2}(?:e\d{1,3})?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const seasonCode = `S${String(season).padStart(2, "0")}`;
  const episodeCode = episode === null ? "" : `E${String(episode).padStart(2, "0")}`;
  return `${base} ${seasonCode}${episodeCode}`.trim();
}

function buildJackettSearchURL(root, indexer, apiKey, query) {
  const base = root.replace(/\/+$/, "");
  const idx = encodeURIComponent(indexer || "all");
  const qs = [
    `apikey=${encodeURIComponent(apiKey)}`,
    `Query=${encodeURIComponent(query)}`,
  ];
  return `${base}/api/v2.0/indexers/${idx}/results?${qs.join("&")}`;
}

function normalizedJackettRoot(url) {
  let value = String(url || "").trim();
  if (!value) {
    return "";
  }

  value = value.replace(/\/+$/, "");
  value = value.replace(/\/api\/v2\.0$/i, "");
  return value;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickString(...args) {
  for (const arg of args) {
    if (typeof arg === "string" && arg.trim()) {
      return arg.trim();
    }
  }
  return "";
}

function categoryText(row) {
  if (typeof row.CategoryDesc === "string" && row.CategoryDesc.trim()) {
    return row.CategoryDesc.trim();
  }
  if (Array.isArray(row.CategoryDesc)) {
    return row.CategoryDesc.filter((v) => typeof v === "string" && v.trim()).join(", ");
  }
  if (Array.isArray(row.Category)) {
    return row.Category.map((v) => String(v)).join(", ");
  }
  if (row.Category != null) {
    return String(row.Category);
  }
  return "";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / (1024 ** 3)).toFixed(1)} GB`;
  return `${(value / (1024 ** 4)).toFixed(1)} TB`;
}

function formatAge(dateText) {
  if (!dateText) {
    return "";
  }

  const t = Date.parse(dateText);
  if (!Number.isFinite(t)) {
    return "";
  }

  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 0) {
    return "";
  }
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function shortName(name, limit) {
  const text = String(name || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}...`;
}

function isMagnetURL(value) {
  return /^magnet:/i.test(String(value || ""));
}

function looksLikeTorrentURL(value) {
  return /\.torrent(?:\?|$)/i.test(String(value || ""));
}

async function downloadTorrentToTemp(sourceURL, title, timeoutSec) {
  const safeTitle = String(title || "torrent")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "torrent";
  const outPath = `/tmp/iina-torrent-search-${Date.now()}-${safeTitle}.torrent`;
  const timeout = clampInt(timeoutSec, DEFAULT_SETTINGS.timeoutSec, TIMEOUT_MIN, TIMEOUT_MAX);
  const res = await utils.exec("/usr/bin/curl", [
    "-L",
    "-sS",
    "--fail",
    "--connect-timeout",
    "5",
    "--max-time",
    String(timeout),
    "-o",
    outPath,
    sourceURL,
  ]);
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || "").trim();
    throw new Error(detail ? `Failed to download .torrent: ${detail}` : `Failed to download .torrent (code ${res.status})`);
  }

  const test = await utils.exec("/usr/bin/test", ["-s", outPath]);
  if (test.status !== 0) {
    throw new Error("Downloaded torrent file is empty.");
  }
  return outPath;
}

async function tryResolveRedirectTarget(sourceURL, timeoutSec) {
  const timeout = clampInt(timeoutSec, DEFAULT_SETTINGS.timeoutSec, TIMEOUT_MIN, TIMEOUT_MAX);
  const res = await utils.exec("/usr/bin/curl", [
    "-sS",
    "-D",
    "-",
    "-o",
    "/dev/null",
    "--connect-timeout",
    "5",
    "--max-time",
    String(timeout),
    sourceURL,
  ]);
  if (res.status !== 0) {
    return "";
  }

  const headers = String(res.stdout || "").split(/\r?\n/);
  for (const line of headers) {
    const m = line.match(/^location:\s*(.+)$/i);
    if (!m) continue;
    const location = String(m[1] || "").trim();
    if (!location) continue;
    if (isMagnetURL(location) || looksLikeTorrentURL(location)) {
      return location;
    }
  }
  return "";
}

function formatError(error) {
  if (!error) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return String(error.message);
  }
  return String(error);
}
