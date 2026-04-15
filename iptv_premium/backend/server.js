const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 8099);
const OPTIONS_PATH = "/data/options.json";
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

let optionsCache = null;
let sessionCache = {
  checkedAt: 0,
  profile: null
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

function loadOptions() {
  if (optionsCache) {
    return optionsCache;
  }

  const envOptions = {
    xtream_url: process.env.XTREAM_URL || "",
    xtream_username: process.env.XTREAM_USERNAME || "",
    xtream_password: process.env.XTREAM_PASSWORD || "",
    stream_format: process.env.STREAM_FORMAT || "m3u8"
  };

  if (!fs.existsSync(OPTIONS_PATH)) {
    optionsCache = {
      ...envOptions,
      xtream_url: parseBaseUrl(envOptions.xtream_url),
      stream_format: envOptions.stream_format || "m3u8"
    };
    return optionsCache;
  }

  const raw = fs.readFileSync(OPTIONS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  optionsCache = {
    xtream_url: parseBaseUrl(parsed.xtream_url || envOptions.xtream_url),
    xtream_username: parsed.xtream_username || envOptions.xtream_username,
    xtream_password: parsed.xtream_password || envOptions.xtream_password,
    stream_format: parsed.stream_format || envOptions.stream_format || "m3u8"
  };
  return optionsCache;
}

function requireConfig() {
  const cfg = loadOptions();
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

function mapLiveChannel(channel) {
  return {
    id: String(channel.stream_id),
    name: channel.name,
    number: channel.num ?? null,
    categoryId: String(channel.category_id || "0"),
    icon: channel.stream_icon || null,
    epgChannelId: channel.epg_channel_id || null,
    addedAt: channel.added || null,
    customSid: channel.custom_sid || null
  };
}

function mapVodMovie(movie) {
  return {
    id: String(movie.stream_id),
    title: movie.name,
    categoryId: String(movie.category_id || "0"),
    poster: movie.stream_icon || null,
    rating: movie.rating || null,
    year: movie.year || null,
    duration: movie.duration || null,
    addedAt: movie.added || null
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
  const { cfg } = xtreamClient();
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
                streamUrl: `${cfg.xtream_url}/series/${cfg.xtream_username}/${cfg.xtream_password}/${ep.id}.${ep.container_extension || "mp4"}`
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
    await ensureAuthenticated();
    const [categoriesRaw, streamsRaw] = await Promise.all([
      xtreamPlayerApi("get_live_categories"),
      xtreamPlayerApi("get_live_streams")
    ]);

    const channels = (streamsRaw || []).map(mapLiveChannel);
    const categories = groupByCategory(channels, categoriesRaw, "categoryId");

    res.json({
      categories,
      totalChannels: channels.length
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/vod", async (_req, res, next) => {
  try {
    await ensureAuthenticated();
    const [categoriesRaw, vodRaw] = await Promise.all([
      xtreamPlayerApi("get_vod_categories"),
      xtreamPlayerApi("get_vod_streams")
    ]);

    const movies = (vodRaw || []).map(mapVodMovie);
    const categories = groupByCategory(movies, categoriesRaw, "categoryId");

    res.json({
      categories,
      totalMovies: movies.length
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/series", async (_req, res, next) => {
  try {
    await ensureAuthenticated();
    const [categoriesRaw, seriesRaw] = await Promise.all([
      xtreamPlayerApi("get_series_categories"),
      xtreamPlayerApi("get_series")
    ]);

    const mappedSeries = (seriesRaw || []).map(mapSeries);
    const hydrated = await hydrateSeriesStructure(mappedSeries);
    const categories = groupByCategory(hydrated, categoriesRaw, "categoryId");

    res.json({
      categories,
      totalSeries: hydrated.length
    });
  } catch (error) {
    next(error);
  }
});

app.get("/live/:streamId", async (req, res, next) => {
  try {
    const { cfg } = xtreamClient();
    const streamId = req.params.streamId;
    const extension = req.query.ext || cfg.stream_format || "m3u8";
    const sourceUrl = `${cfg.xtream_url}/live/${cfg.xtream_username}/${cfg.xtream_password}/${streamId}.${extension}`;

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
