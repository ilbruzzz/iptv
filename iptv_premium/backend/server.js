const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 8099);
const OPTIONS_PATH = "/data/options.json";
const RUNTIME_SETTINGS_PATH = "/data/runtime-settings.json";
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");
const DEFAULT_PLAYBACK_SETTINGS = {
  autoplay: true,
  muted: false,
  volume: 0.8,
  liveFormat: "m3u8",
  vodFormat: "mp4"
};
const DEFAULT_LIVE_PREFERENCES = {
  hiddenChannelIds: [],
  folders: [],
  favoriteChannelIds: []
};

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// Home Assistant Ingress can forward requests with a path prefix.
// Normalize URLs so static files and routes work both with and without ingress.
app.use((req, _res, next) => {
  const ingressPath = req.header("x-ingress-path");
  if (ingressPath && req.url.startsWith(ingressPath)) {
    req.url = req.url.slice(ingressPath.length) || "/";
  }
  next();
});

let sessionCache = {
  checkedAt: 0,
  profile: null
};
const responseCache = new Map();
const CACHE_TTL_MS = {
  live: 90_000,
  vod: 180_000,
  series: 300_000,
  epg: 30_000
};

function parseBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  const normalized = rawUrl.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    return `http://${normalized}`;
  }
  return normalized;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value, ttlMs) {
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function clearResponseCache() {
  responseCache.clear();
}

function loadOptions() {
  const envOptions = {
    xtream_url: process.env.XTREAM_URL || "",
    xtream_username: process.env.XTREAM_USERNAME || "",
    xtream_password: process.env.XTREAM_PASSWORD || "",
    stream_format: process.env.STREAM_FORMAT || "m3u8",
    playback_autoplay: process.env.PLAYBACK_AUTOPLAY === "true",
    playback_muted: process.env.PLAYBACK_MUTED === "true",
    playback_volume: Number(process.env.PLAYBACK_VOLUME || 0.8),
    playback_live_format: process.env.PLAYBACK_LIVE_FORMAT || "m3u8",
    playback_vod_format: process.env.PLAYBACK_VOD_FORMAT || "mp4"
  };

  try {
    if (!fs.existsSync(OPTIONS_PATH)) {
      return {
        ...envOptions,
        xtream_url: parseBaseUrl(envOptions.xtream_url),
        stream_format: envOptions.stream_format || "m3u8",
        playback: {
          autoplay: envOptions.playback_autoplay,
          muted: envOptions.playback_muted,
          volume: envOptions.playback_volume,
          liveFormat: envOptions.playback_live_format,
          vodFormat: envOptions.playback_vod_format
        }
      };
    }

    const raw = fs.readFileSync(OPTIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      xtream_url: parseBaseUrl(parsed.xtream_url || envOptions.xtream_url),
      xtream_username: parsed.xtream_username || envOptions.xtream_username,
      xtream_password: parsed.xtream_password || envOptions.xtream_password,
      stream_format: parsed.stream_format || envOptions.stream_format || "m3u8",
      playback: {
        autoplay: parsed.playback_autoplay ?? envOptions.playback_autoplay,
        muted: parsed.playback_muted ?? envOptions.playback_muted,
        volume: parsed.playback_volume ?? envOptions.playback_volume,
        liveFormat: parsed.playback_live_format || envOptions.playback_live_format,
        vodFormat: parsed.playback_vod_format || envOptions.playback_vod_format
      }
    };
  } catch (_err) {
    return {
      ...envOptions,
      xtream_url: parseBaseUrl(envOptions.xtream_url),
      stream_format: envOptions.stream_format || "m3u8",
      playback: {
        autoplay: envOptions.playback_autoplay,
        muted: envOptions.playback_muted,
        volume: envOptions.playback_volume,
        liveFormat: envOptions.playback_live_format,
        vodFormat: envOptions.playback_vod_format
      }
    };
  }
}

function loadRuntimeSettings() {
  try {
    if (!fs.existsSync(RUNTIME_SETTINGS_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(RUNTIME_SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function normalizePlaybackSettings(input = {}) {
  const liveFormat = ["m3u8", "ts"].includes(String(input.liveFormat)) ? String(input.liveFormat) : DEFAULT_PLAYBACK_SETTINGS.liveFormat;
  const vodFormat = ["mp4", "mkv", "m3u8"].includes(String(input.vodFormat)) ? String(input.vodFormat) : DEFAULT_PLAYBACK_SETTINGS.vodFormat;
  return {
    autoplay: Boolean(input.autoplay ?? DEFAULT_PLAYBACK_SETTINGS.autoplay),
    muted: Boolean(input.muted ?? DEFAULT_PLAYBACK_SETTINGS.muted),
    volume: Math.max(0, Math.min(1, Number(input.volume ?? DEFAULT_PLAYBACK_SETTINGS.volume))),
    liveFormat,
    vodFormat
  };
}

function normalizeLivePreferences(input = {}) {
  const hiddenChannelIds = Array.isArray(input.hiddenChannelIds)
    ? [...new Set(input.hiddenChannelIds.map((id) => String(id)))]
    : [];
  const favoriteChannelIds = Array.isArray(input.favoriteChannelIds)
    ? [...new Set(input.favoriteChannelIds.map((id) => String(id)))]
    : [];
  const folders = Array.isArray(input.folders)
    ? input
        .map((folder) => ({
          id: String(folder.id || `folder_${Date.now()}`),
          name: String(folder.name || "Cartella"),
          channelIds: Array.isArray(folder.channelIds)
            ? [...new Set(folder.channelIds.map((id) => String(id)))]
            : []
        }))
        .filter((folder) => folder.name.trim().length > 0)
    : [];

  return {
    hiddenChannelIds,
    folders,
    favoriteChannelIds
  };
}

function getEffectiveConfig() {
  const cfg = loadOptions();
  const runtime = loadRuntimeSettings();
  return {
    xtream_url: parseBaseUrl(runtime.xtream_url || cfg.xtream_url),
    xtream_username: runtime.xtream_username || cfg.xtream_username,
    xtream_password: runtime.xtream_password || cfg.xtream_password,
    stream_format: runtime.stream_format || cfg.stream_format || "m3u8",
    playback: normalizePlaybackSettings(runtime.playback || cfg.playback || {}),
    livePreferences: normalizeLivePreferences(runtime.livePreferences || DEFAULT_LIVE_PREFERENCES)
  };
}

function saveRuntimeSettings(nextSettings) {
  const payload = {
    xtream_url: parseBaseUrl(nextSettings.xtream_url || ""),
    xtream_username: nextSettings.xtream_username || "",
    xtream_password: nextSettings.xtream_password || "",
    stream_format: nextSettings.stream_format || "m3u8",
    playback: normalizePlaybackSettings(nextSettings.playback || {}),
    livePreferences: normalizeLivePreferences(nextSettings.livePreferences || DEFAULT_LIVE_PREFERENCES)
  };
  fs.writeFileSync(RUNTIME_SETTINGS_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

function requireConfig() {
  const cfg = getEffectiveConfig();
  if (!cfg.xtream_url || !cfg.xtream_username || !cfg.xtream_password) {
    const err = new Error("Missing Xtream credentials in add-on options.");
    err.statusCode = 400;
    throw err;
  }
  return cfg;
}

function xtreamClient() {
  const cfg = requireConfig();
  return {
    cfg,
    http: axios.create({
      baseURL: cfg.xtream_url,
      timeout: 30000
    })
  };
}

function publicSettingsFromConfig(cfg) {
  return {
    xtream_url: cfg.xtream_url,
    xtream_username: cfg.xtream_username,
    xtream_password: cfg.xtream_password ? "********" : "",
    stream_format: cfg.stream_format,
    playback: cfg.playback,
    livePreferences: cfg.livePreferences
  };
}

async function xtreamPlayerApi(action, extraParams = {}) {
  const { cfg, http } = xtreamClient();
  const params = {
    username: cfg.xtream_username,
    password: cfg.xtream_password,
    ...extraParams
  };
  if (action) {
    params.action = action;
  }
  const { data } = await http.get("/player_api.php", { params });
  return data;
}

async function ensureAuthenticated(force = false) {
  const cacheAgeMs = Date.now() - sessionCache.checkedAt;
  if (!force && sessionCache.profile && cacheAgeMs < 60_000) {
    return sessionCache.profile;
  }

  const data = await xtreamPlayerApi(null);
  if (!data || data.user_info?.auth !== 1) {
    const err = new Error("Xtream authentication failed.");
    err.statusCode = 401;
    throw err;
  }

  sessionCache = {
    checkedAt: Date.now(),
    profile: {
      user: data.user_info,
      server: data.server_info
    }
  };
  return sessionCache.profile;
}

function groupByCategory(items, categories, categoryIdKey) {
  const categoryById = new Map(
    (categories || []).map((cat) => [
      String(cat.category_id),
      {
        id: String(cat.category_id),
        name: cat.category_name || "Uncategorized",
        parentId: cat.parent_id ? String(cat.parent_id) : null,
        items: []
      }
    ])
  );

  for (const item of items || []) {
    const categoryId = String(item[categoryIdKey] || "0");
    if (!categoryById.has(categoryId)) {
      categoryById.set(categoryId, {
        id: categoryId,
        name: "Uncategorized",
        parentId: null,
        items: []
      });
    }
    categoryById.get(categoryId).items.push(item);
  }

  return Array.from(categoryById.values()).filter((cat) => cat.items.length > 0);
}

function mapLiveChannel(channel, cfg) {
  return {
    id: String(channel.stream_id),
    name: channel.name,
    number: channel.num ?? null,
    categoryId: String(channel.category_id || "0"),
    icon: channel.stream_icon || null,
    epgChannelId: channel.epg_channel_id || null,
    addedAt: channel.added || null,
    customSid: channel.custom_sid || null,
    streamUrl: `/live/${channel.stream_id}?ext=${encodeURIComponent(cfg.playback.liveFormat || cfg.stream_format || "m3u8")}`
  };
}

function mapVodMovie(movie, cfg) {
  const extension = movie.container_extension || cfg.playback.vodFormat || "mp4";
  return {
    id: String(movie.stream_id),
    title: movie.name,
    categoryId: String(movie.category_id || "0"),
    poster: movie.stream_icon || null,
    rating: movie.rating || null,
    year: movie.year || null,
    duration: movie.duration || null,
    addedAt: movie.added || null,
    containerExtension: extension,
    streamUrl: `/vod/${movie.stream_id}?ext=${encodeURIComponent(extension)}`
  };
}

function mapSeries(series) {
  return {
    id: String(series.series_id),
    title: series.name,
    categoryId: String(series.category_id || "0"),
    poster: series.cover || null,
    plot: series.plot || null,
    cast: series.cast || null,
    releaseDate: series.releaseDate || null,
    rating: series.rating || null,
    youtubeTrailer: series.youtube_trailer || null
  };
}

async function hydrateSeriesStructure(seriesBaseList) {
  const limit = 6;
  const detailedSeries = [];

  for (let i = 0; i < seriesBaseList.length; i += limit) {
    const batch = seriesBaseList.slice(i, i + limit);
    const responses = await Promise.all(
      batch.map(async (series) => {
        try {
          const info = await xtreamPlayerApi("get_series_info", { series_id: series.id });
          const episodesBySeason = info.episodes || {};
          const seasons = Object.keys(episodesBySeason)
            .sort((a, b) => Number(a) - Number(b))
            .map((seasonKey) => ({
              seasonNumber: Number(seasonKey),
              episodes: (episodesBySeason[seasonKey] || []).map((ep) => ({
                id: String(ep.id || ep.episode_num || ep.title),
                title: ep.title,
                episodeNumber: ep.episode_num || null,
                containerExtension: ep.container_extension || null,
                duration: ep.duration || null,
                plot: ep.info?.plot || null,
                streamUrl: `/series/${ep.id}?ext=${encodeURIComponent(ep.container_extension || "mp4")}`
              }))
            }));

          return {
            ...series,
            backdrop: info.info?.backdrop_path || null,
            genre: info.info?.genre || null,
            seasons
          };
        } catch (err) {
          return {
            ...series,
            seasons: []
          };
        }
      })
    );

    detailedSeries.push(...responses);
  }

  return detailedSeries;
}

app.get("/api/health", async (_req, res, next) => {
  try {
    const profile = await ensureAuthenticated();
    res.json({
      ok: true,
      authenticated: true,
      user: {
        username: profile.user.username,
        status: profile.user.status,
        expDate: profile.user.exp_date || null
      },
      server: {
        url: profile.server.url,
        timezone: profile.server.timezone
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/live", async (_req, res, next) => {
  try {
    const cached = getCached("api_live");
    if (cached) {
      return res.json(cached);
    }
    const cfg = requireConfig();
    await ensureAuthenticated();
    const [categoriesRaw, streamsRaw] = await Promise.all([
      xtreamPlayerApi("get_live_categories"),
      xtreamPlayerApi("get_live_streams")
    ]);

    const channels = (streamsRaw || []).map((channel) => mapLiveChannel(channel, cfg));
    const categories = groupByCategory(channels, categoriesRaw, "categoryId");

    const payload = {
      categories,
      totalChannels: channels.length
    };
    setCached("api_live", payload, CACHE_TTL_MS.live);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/preferences", (_req, res) => {
  const cfg = getEffectiveConfig();
  res.json(cfg.livePreferences || DEFAULT_LIVE_PREFERENCES);
});

app.put("/api/live/preferences", (req, res, next) => {
  try {
    const cfg = getEffectiveConfig();
    const incoming = normalizeLivePreferences(req.body || {});
    saveRuntimeSettings({
      ...cfg,
      livePreferences: incoming
    });
    clearResponseCache();
    res.json({ ok: true, livePreferences: incoming });
  } catch (error) {
    next(error);
  }
});

app.get("/api/live/epg/:streamId", async (req, res, next) => {
  try {
    await ensureAuthenticated();
    const streamId = req.params.streamId;
    const limit = Number(req.query.limit || 8);
    const cacheKey = `api_live_epg_${streamId}_${limit}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const raw = await xtreamPlayerApi("get_short_epg", {
      stream_id: streamId,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 24) : 8
    });

    const listings = (raw?.epg_listings || []).map((entry) => {
      const titleDecoded = entry.title ? Buffer.from(entry.title, "base64").toString("utf-8") : "";
      const descriptionDecoded = entry.description ? Buffer.from(entry.description, "base64").toString("utf-8") : "";
      return {
        id: entry.id || null,
        title: titleDecoded || "Programma",
        description: descriptionDecoded || "",
        start: entry.start || null,
        end: entry.end || null,
        hasArchive: entry.has_archive || 0
      };
    });

    const payload = {
      streamId: String(streamId),
      listings
    };
    setCached(cacheKey, payload, CACHE_TTL_MS.epg);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/vod", async (_req, res, next) => {
  try {
    const cached = getCached("api_vod");
    if (cached) {
      return res.json(cached);
    }
    const cfg = requireConfig();
    await ensureAuthenticated();
    const [categoriesRaw, vodRaw] = await Promise.all([
      xtreamPlayerApi("get_vod_categories"),
      xtreamPlayerApi("get_vod_streams")
    ]);

    const movies = (vodRaw || []).map((movie) => mapVodMovie(movie, cfg));
    const categories = groupByCategory(movies, categoriesRaw, "categoryId");

    const payload = {
      categories,
      totalMovies: movies.length
    };
    setCached("api_vod", payload, CACHE_TTL_MS.vod);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/series", async (_req, res, next) => {
  try {
    const cached = getCached("api_series");
    if (cached) {
      return res.json(cached);
    }
    await ensureAuthenticated();
    const [categoriesRaw, seriesRaw] = await Promise.all([
      xtreamPlayerApi("get_series_categories"),
      xtreamPlayerApi("get_series")
    ]);

    const mappedSeries = (seriesRaw || []).map(mapSeries);
    const hydrated = await hydrateSeriesStructure(mappedSeries);
    const categories = groupByCategory(hydrated, categoriesRaw, "categoryId");

    const payload = {
      categories,
      totalSeries: hydrated.length
    };
    setCached("api_series", payload, CACHE_TTL_MS.series);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", (_req, res) => {
  const cfg = getEffectiveConfig();
  res.json(publicSettingsFromConfig(cfg));
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const current = getEffectiveConfig();
    const incoming = req.body || {};
    const merged = {
      xtream_url: incoming.xtream_url ?? current.xtream_url,
      xtream_username: incoming.xtream_username ?? current.xtream_username,
      xtream_password:
        incoming.xtream_password && incoming.xtream_password !== "********"
          ? incoming.xtream_password
          : current.xtream_password,
      stream_format: incoming.stream_format ?? current.stream_format,
      playback: {
        ...current.playback,
        ...(incoming.playback || {})
      }
    };
    saveRuntimeSettings(merged);
    sessionCache = { checkedAt: 0, profile: null };
    clearResponseCache();
    await ensureAuthenticated(true);
    res.json({ ok: true, settings: publicSettingsFromConfig(getEffectiveConfig()) });
  } catch (error) {
    next(error);
  }
});

async function pipeStreamFromProvider(req, res, next, sourceUrl) {
  const cfg = requireConfig();
  try {
    const upstream = await axios.get(sourceUrl, {
      responseType: "stream",
      timeout: 30000,
      headers: {
        "User-Agent": req.get("user-agent") || "IPTVPremium/1.0",
        Referer: cfg.xtream_url
      }
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");
    if (upstream.headers["content-type"]) {
      res.setHeader("Content-Type", upstream.headers["content-type"]);
    }
    upstream.data.on("error", next);
    upstream.data.pipe(res);
  } catch (error) {
    next(error);
  }
}

app.get("/live/:streamId", async (req, res, next) => {
  try {
    const { cfg } = xtreamClient();
    const streamId = req.params.streamId;
    const extension = req.query.ext || cfg.playback.liveFormat || cfg.stream_format || "m3u8";
    const sourceUrl = `${cfg.xtream_url}/live/${cfg.xtream_username}/${cfg.xtream_password}/${streamId}.${extension}`;
    await pipeStreamFromProvider(req, res, next, sourceUrl);
  } catch (error) {
    next(error);
  }
});

app.get("/vod/:streamId", async (req, res, next) => {
  try {
    const { cfg } = xtreamClient();
    const streamId = req.params.streamId;
    const extension = req.query.ext || cfg.playback.vodFormat || "mp4";
    const sourceUrl = `${cfg.xtream_url}/movie/${cfg.xtream_username}/${cfg.xtream_password}/${streamId}.${extension}`;
    await pipeStreamFromProvider(req, res, next, sourceUrl);
  } catch (error) {
    next(error);
  }
});

app.get("/series/:episodeId", async (req, res, next) => {
  try {
    const { cfg } = xtreamClient();
    const episodeId = req.params.episodeId;
    const extension = req.query.ext || "mp4";
    const sourceUrl = `${cfg.xtream_url}/series/${cfg.xtream_username}/${cfg.xtream_password}/${episodeId}.${extension}`;
    await pipeStreamFromProvider(req, res, next, sourceUrl);
  } catch (error) {
    next(error);
  }
});

app.get("/api/image", async (req, res, next) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({ error: "Query param 'url' is required." });
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 30000
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(response.data));
  } catch (error) {
    next(error);
  }
});

app.use(express.static(FRONTEND_DIR));
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/live/")) {
    return next();
  }
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || error.response?.status || 500;
  const details = error.response?.data || null;
  res.status(statusCode).json({
    error: error.message || "Unexpected server error.",
    details
  });
});

app.listen(PORT, async () => {
  // Optional early auth probe to fail fast at startup if credentials are wrong.
  try {
    await ensureAuthenticated(true);
    console.log(`IPTV Premium backend running on port ${PORT} (auth ok).`);
  } catch (err) {
    console.warn(`IPTV Premium backend running on port ${PORT} (auth pending): ${err.message}`);
  }
});
