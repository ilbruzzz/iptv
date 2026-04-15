const navItems = Array.from(document.querySelectorAll(".nav-item"));
const heroDescription = document.getElementById("heroDescription");
const gridTitle = document.getElementById("gridTitle");
const apiStatus = document.getElementById("apiStatus");
const posterGrid = document.getElementById("posterGrid");
const settingsPanel = document.getElementById("settingsPanel");
const settingsStatus = document.getElementById("settingsStatus");
const settingsForm = document.getElementById("settingsForm");
const playerModal = document.getElementById("playerModal");
const closePlayerBtn = document.getElementById("closePlayer");
const playerTitle = document.getElementById("playerTitle");
const videoPlayer = document.getElementById("videoPlayer");
const epgPanel = document.getElementById("epgPanel");
const epgList = document.getElementById("epgList");

let currentHls = null;
let fallbackTried = false;
let selectedLiveFolder = "all";
let liveManageMode = false;
let currentSection = "home";
let appSettings = { playback: { autoplay: true, muted: false, volume: 0.8, liveFormat: "m3u8", vodFormat: "mp4" } };
let livePreferences = { hiddenChannelIds: [], folders: [], favoriteChannelIds: [] };
let catalogCache = { live: null, vod: null, series: null };
const renderedItems = new Map();

const sectionMeta = {
  home: { title: "Home", description: "Preferiti e guida TV dedicata ai canali che segui." },
  live: { title: "Canali Live", description: "Cartelle laterali e canali disposti in pagina." },
  vod: { title: "Film", description: "Catalogo film in stile streaming." },
  series: { title: "Serie TV", description: "Serie TV organizzate per categoria." },
  settings: { title: "Impostazioni", description: "Configura credenziali e parametri di riproduzione." }
};

const endpointBySection = { live: "api/live", vod: "api/vod", series: "api/series" };

function escapeHtml(text) {
  return String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function apiFetch(url, options = {}) {
  const response = await fetch(new URL(url, window.location.href), options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} - ${body.slice(0, 180)}`);
  }
  return response.json();
}

function setActiveSection(section) {
  navItems.forEach((btn) => {
    const active = btn.dataset.section === section;
    btn.classList.toggle("bg-premium-accent/20", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("border", active);
    btn.classList.toggle("border-premium-accent/40", active);
    btn.classList.toggle("shadow-glass", active);
    btn.classList.toggle("text-slate-300", !active);
  });
}

function setLoading(message = "Caricamento...") {
  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">${escapeHtml(message)}</div>`;
}

function normalizeCategories(section, payload) {
  return (payload?.categories || []).map((category) => ({
    id: category.id,
    name: category.name || "Uncategorized",
    items: (category.items || []).map((item) => {
      let playbackUrl = item.streamUrl || null;
      let subtitle = category.name || "Catalogo";
      if (section === "series") {
        const ep = item.seasons?.[0]?.episodes?.[0];
        playbackUrl = ep?.streamUrl || null;
        subtitle = ep ? `S${item.seasons?.[0]?.seasonNumber || 1}E${ep.episodeNumber || 1}` : subtitle;
      }
      return { ...item, _section: section, _playbackUrl: playbackUrl, _subtitle: subtitle };
    })
  }));
}

function cleanupPlayer() {
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  fallbackTried = false;
}

function closePlayer() {
  playerModal.classList.add("hidden");
  playerModal.classList.remove("flex");
  epgPanel.classList.add("hidden");
  cleanupPlayer();
}

function isHlsUrl(url) {
  return url.includes(".m3u8") || url.includes("ext=m3u8");
}

function buildM3u8Fallback(url) {
  if (!url.includes("ext=ts")) {
    return null;
  }
  return url.replace("ext=ts", "ext=m3u8");
}

function attachNativePlayer(url) {
  videoPlayer.src = url;
  if (videoPlayer.autoplay) {
    videoPlayer.play().catch(() => {});
  }
}

function openPlayer(item) {
  if (!item?._playbackUrl) {
    alert("Nessun flusso disponibile.");
    return;
  }

  cleanupPlayer();
  playerTitle.textContent = item.title || item.name || "Player";
  playerModal.classList.remove("hidden");
  playerModal.classList.add("flex");

  const source = new URL(item._playbackUrl, window.location.href).toString();
  videoPlayer.autoplay = Boolean(appSettings.playback?.autoplay);
  videoPlayer.muted = Boolean(appSettings.playback?.muted);
  videoPlayer.volume = Number(appSettings.playback?.volume ?? 0.8);

  if (isHlsUrl(source) && window.Hls?.isSupported()) {
    currentHls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    currentHls.loadSource(source);
    currentHls.attachMedia(videoPlayer);
    currentHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (videoPlayer.autoplay) {
        videoPlayer.play().catch(() => {});
      }
    });
    currentHls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal && !fallbackTried) {
        const fallback = buildM3u8Fallback(source);
        if (fallback) {
          fallbackTried = true;
          currentHls.destroy();
          currentHls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
          currentHls.loadSource(fallback);
          currentHls.attachMedia(videoPlayer);
        }
      }
    });
  } else {
    attachNativePlayer(source);
  }

  if (item._section === "live" && item.id) {
    loadLiveEpg(item.id);
  } else {
    epgPanel.classList.add("hidden");
  }
}

function renderPlayerEpg(listings) {
  if (!listings?.length) {
    epgList.innerHTML = `<p class="text-slate-400">Nessun dato EPG disponibile.</p>`;
    return;
  }
  epgList.innerHTML = listings.map((entry) => {
    const start = entry.start ? new Date(entry.start.replace(" ", "T")) : null;
    const end = entry.end ? new Date(entry.end.replace(" ", "T")) : null;
    const range = start && end ? `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Orario N/D";
    return `<div class="rounded-lg border border-white/10 bg-black/30 px-3 py-2"><p class="text-[11px] uppercase tracking-[0.14em] text-slate-400">${escapeHtml(range)}</p><p class="font-medium text-slate-100">${escapeHtml(entry.title)}</p></div>`;
  }).join("");
}

async function loadLiveEpg(streamId) {
  epgPanel.classList.remove("hidden");
  epgList.innerHTML = `<p class="text-slate-400">Caricamento EPG...</p>`;
  try {
    const payload = await apiFetch(`api/live/epg/${streamId}?limit=8`);
    renderPlayerEpg(payload.listings || []);
  } catch (error) {
    epgList.innerHTML = `<p class="text-rose-300">Errore EPG: ${escapeHtml(error.message)}</p>`;
  }
}

async function loadLivePreferences() {
  try {
    livePreferences = await apiFetch("api/live/preferences");
  } catch {
    livePreferences = { hiddenChannelIds: [], folders: [], favoriteChannelIds: [] };
  }
}

async function saveLivePreferences() {
  const payload = {
    hiddenChannelIds: livePreferences.hiddenChannelIds || [],
    folders: livePreferences.folders || [],
    favoriteChannelIds: livePreferences.favoriteChannelIds || []
  };
  const result = await apiFetch("api/live/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  livePreferences = result.livePreferences || payload;
}

function isHidden(channelId) {
  return (livePreferences.hiddenChannelIds || []).includes(String(channelId));
}

function isFavorite(channelId) {
  return (livePreferences.favoriteChannelIds || []).includes(String(channelId));
}

function allLiveChannels(payload) {
  const categories = normalizeCategories("live", payload);
  return categories.flatMap((cat) => cat.items);
}

function getFolderedLiveChannels(payload) {
  const channels = allLiveChannels(payload);
  const channelById = new Map(channels.map((ch) => [String(ch.id), ch]));
  const visibleChannels = channels.filter((ch) => !isHidden(ch.id));
  const favorites = visibleChannels.filter((ch) => isFavorite(ch.id));
  const customFolders = (livePreferences.folders || []).map((folder) => ({
    id: String(folder.id),
    name: folder.name,
    channels: (folder.channelIds || []).map((id) => channelById.get(String(id))).filter(Boolean).filter((ch) => !isHidden(ch.id))
  }));
  const assignedIds = new Set(customFolders.flatMap((f) => f.channels.map((ch) => String(ch.id))));
  const uncategorized = visibleChannels.filter((ch) => !assignedIds.has(String(ch.id)));
  const hidden = channels.filter((ch) => isHidden(ch.id));
  return { channels, favorites, customFolders, uncategorized, hidden };
}

function liveCard(item) {
  const title = item.title || item.name || `Canale ${item.id}`;
  const icon = item.icon || null;
  const key = `live_${item.id}`;
  renderedItems.set(key, item);
  return `<article class="overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70"><div class="relative aspect-[16/10]">${icon ? `<img src="api/image?url=${encodeURIComponent(icon)}" alt="${escapeHtml(title)}" class="h-full w-full object-cover" loading="lazy" />` : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-premium-700 to-premium-600 text-xs tracking-[0.22em] text-slate-300">LIVE</div>`}<div class="absolute right-2 top-2 rounded-md bg-rose-600/90 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-white">LIVE</div></div><div class="space-y-2 p-3"><h4 class="line-clamp-2 text-sm font-semibold text-slate-100">${escapeHtml(title)}</h4><div class="flex flex-wrap gap-2"><button data-action="play" data-key="${key}" class="rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10">Guarda</button><button data-action="favorite" data-id="${item.id}" class="rounded-md border border-white/15 px-2 py-1 text-xs ${isFavorite(item.id) ? "text-amber-300" : ""}">★ Preferito</button>${liveManageMode ? `<button data-action="visibility" data-id="${item.id}" class="rounded-md border border-white/15 px-2 py-1 text-xs">${isHidden(item.id) ? "Mostra" : "Nascondi"}</button><button data-action="move" data-id="${item.id}" class="rounded-md border border-white/15 px-2 py-1 text-xs">Cartella</button>` : ""}</div></div></article>`;
}

function bindDynamicActions(reRenderFn) {
  Array.from(document.querySelectorAll("[data-action='play']")).forEach((btn) => {
    btn.addEventListener("click", () => openPlayer(renderedItems.get(btn.dataset.key)));
  });
  Array.from(document.querySelectorAll("[data-action='favorite']")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.dataset.id);
      const set = new Set((livePreferences.favoriteChannelIds || []).map(String));
      if (set.has(id)) set.delete(id); else set.add(id);
      livePreferences.favoriteChannelIds = Array.from(set);
      await saveLivePreferences();
      reRenderFn();
    });
  });
  Array.from(document.querySelectorAll("[data-action='visibility']")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.dataset.id);
      const set = new Set((livePreferences.hiddenChannelIds || []).map(String));
      if (set.has(id)) set.delete(id); else set.add(id);
      livePreferences.hiddenChannelIds = Array.from(set);
      await saveLivePreferences();
      reRenderFn();
    });
  });
  Array.from(document.querySelectorAll("[data-action='move']")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = String(btn.dataset.id);
      const folderName = prompt("Nome cartella (esistente o nuova):");
      if (!folderName) return;
      let folder = (livePreferences.folders || []).find((f) => f.name.toLowerCase() === folderName.trim().toLowerCase());
      if (!folder) {
        folder = { id: `folder_${Date.now()}`, name: folderName.trim(), channelIds: [] };
        livePreferences.folders.push(folder);
      }
      for (const f of livePreferences.folders) {
        f.channelIds = (f.channelIds || []).filter((cid) => String(cid) !== id);
      }
      folder.channelIds = [...new Set([...(folder.channelIds || []), id])];
      await saveLivePreferences();
      reRenderFn();
    });
  });
}

function renderLiveSection(payload) {
  renderedItems.clear();
  const structured = getFolderedLiveChannels(payload);
  const leftFolders = [
    { id: "all", name: "Tutti", count: structured.uncategorized.length + structured.customFolders.reduce((sum, f) => sum + f.channels.length, 0) },
    { id: "favorites", name: "Preferiti", count: structured.favorites.length },
    ...structured.customFolders.map((f) => ({ id: f.id, name: f.name, count: f.channels.length })),
    { id: "hidden", name: "Nascosti", count: structured.hidden.length }
  ];
  if (!leftFolders.some((f) => f.id === selectedLiveFolder)) {
    selectedLiveFolder = "all";
  }

  let channelsToShow = [];
  if (selectedLiveFolder === "all") {
    channelsToShow = [...structured.customFolders.flatMap((f) => f.channels), ...structured.uncategorized];
  } else if (selectedLiveFolder === "favorites") {
    channelsToShow = structured.favorites;
  } else if (selectedLiveFolder === "hidden") {
    channelsToShow = structured.hidden;
  } else {
    channelsToShow = structured.customFolders.find((f) => f.id === selectedLiveFolder)?.channels || [];
  }

  posterGrid.className = "space-y-4";
  posterGrid.innerHTML = `<div class="glass rounded-2xl p-4"><div class="flex flex-wrap items-center gap-2"><button id="toggleManageMode" class="rounded-xl border border-white/20 px-3 py-2 text-xs">${liveManageMode ? "Fine gestione" : "Gestisci canali"}</button><button id="newFolderBtn" class="rounded-xl border border-white/20 px-3 py-2 text-xs">Nuova cartella</button><span class="text-xs text-slate-400">Canali visualizzati: ${channelsToShow.length}</span></div></div><div class="grid gap-4 lg:grid-cols-[240px_1fr]"><aside class="glass rounded-2xl p-3"><div class="space-y-2">${leftFolders.map((folder) => `<button data-folder-id="${folder.id}" class="folder-btn w-full rounded-xl border px-3 py-2 text-left text-sm ${folder.id === selectedLiveFolder ? "border-premium-accent/60 bg-premium-accent/20" : "border-white/10 bg-white/5"}">${escapeHtml(folder.name)} <span class="float-right text-xs text-slate-400">${folder.count}</span></button>`).join("")}</div></aside><section class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">${channelsToShow.length ? channelsToShow.map((ch) => liveCard(ch)).join("") : `<div class="col-span-full glass rounded-2xl p-6 text-slate-300">Nessun canale in questa cartella.</div>`}</section></div>`;

  Array.from(document.querySelectorAll(".folder-btn")).forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedLiveFolder = btn.dataset.folderId;
      renderLiveSection(payload);
    });
  });
  const manage = document.getElementById("toggleManageMode");
  const newFolder = document.getElementById("newFolderBtn");
  if (manage) {
    manage.addEventListener("click", () => {
      liveManageMode = !liveManageMode;
      renderLiveSection(payload);
    });
  }
  if (newFolder) {
    newFolder.addEventListener("click", async () => {
      const name = prompt("Nome nuova cartella:");
      if (!name) return;
      livePreferences.folders = [...(livePreferences.folders || []), { id: `folder_${Date.now()}`, name: name.trim(), channelIds: [] }];
      await saveLivePreferences();
      renderLiveSection(payload);
    });
  }
  bindDynamicActions(() => renderLiveSection(payload));
}

function mediaCard(item, section, key) {
  const title = item.title || item.name || "Contenuto";
  const poster = item.poster || item.icon || null;
  renderedItems.set(key, item);
  return `<article class="overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70"><div class="relative aspect-[2/3]">${poster ? `<img src="api/image?url=${encodeURIComponent(poster)}" alt="${escapeHtml(title)}" class="h-full w-full object-cover" loading="lazy" />` : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-premium-700 to-premium-600 text-xs tracking-[0.2em]">${section === "vod" ? "FILM" : "SERIE"}</div>`}</div><div class="space-y-2 p-3"><h4 class="line-clamp-2 text-sm font-semibold text-slate-100">${escapeHtml(title)}</h4><button data-action="play" data-key="${key}" class="rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10">Guarda</button></div></article>`;
}

function renderVodSeries(section, payload) {
  renderedItems.clear();
  const categories = normalizeCategories(section, payload).filter((c) => c.items.length > 0);
  if (!categories.length) {
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">Nessun contenuto disponibile.</div>`;
    return;
  }
  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = categories.map((category) => {
    const cards = category.items.map((item) => mediaCard(item, section, `${section}_${item.id}`)).join("");
    return `<section class="space-y-2"><h4 class="px-1 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">${escapeHtml(category.name)}</h4><div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">${cards}</div></section>`;
  }).join("");
  bindDynamicActions(() => {});
}

async function renderHome() {
  setLoading("Caricamento preferiti...");
  await loadLivePreferences();
  if (!catalogCache.live) {
    catalogCache.live = await apiFetch("api/live", { headers: { Accept: "application/json" } });
  }
  const channels = allLiveChannels(catalogCache.live);
  const favorites = channels.filter((ch) => isFavorite(ch.id) && !isHidden(ch.id)).slice(0, 12);
  renderedItems.clear();

  let epgHtml = `<div class="glass rounded-2xl p-4 text-slate-300">Nessun preferito selezionato.</div>`;
  if (favorites.length) {
    const epgRows = await Promise.all(
      favorites.slice(0, 8).map(async (ch) => {
        try {
          const epg = await apiFetch(`api/live/epg/${ch.id}?limit=2`);
          const now = epg.listings?.[0]?.title || "N/D";
          const next = epg.listings?.[1]?.title || "N/D";
          return `<div class="rounded-xl border border-white/10 bg-black/25 px-3 py-2"><p class="text-xs text-slate-400">${escapeHtml(ch.name || ch.title)}</p><p class="text-sm text-slate-100">Ora: ${escapeHtml(now)}</p><p class="text-xs text-slate-300">Dopo: ${escapeHtml(next)}</p></div>`;
        } catch {
          return `<div class="rounded-xl border border-white/10 bg-black/25 px-3 py-2"><p class="text-xs text-slate-400">${escapeHtml(ch.name || ch.title)}</p><p class="text-sm text-rose-300">EPG non disponibile</p></div>`;
        }
      })
    );
    epgHtml = `<section class="space-y-2"><h4 class="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">EPG Preferiti</h4><div class="grid gap-2 md:grid-cols-2">${epgRows.join("")}</div></section>`;
  }

  const favoriteCards = favorites.length
    ? favorites.map((ch) => liveCard({ ...ch, _section: "live", _playbackUrl: ch.streamUrl })).join("")
    : `<div class="glass rounded-2xl p-4 text-slate-300">Aggiungi canali ai preferiti dalla sezione Live.</div>`;

  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = `<section class="space-y-2"><h4 class="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Preferiti</h4><div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">${favoriteCards}</div></section>${epgHtml}`;
  bindDynamicActions(() => renderHome().catch(() => {}));
}

async function getCatalog(section) {
  if (catalogCache[section]) {
    return catalogCache[section];
  }
  const payload = await apiFetch(endpointBySection[section], { headers: { Accept: "application/json" } });
  catalogCache[section] = payload;
  return payload;
}

async function fetchSectionData(section) {
  if (section === "home") {
    await renderHome();
    return;
  }
  if (!endpointBySection[section]) {
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">Sezione non disponibile.</div>`;
    return;
  }
  setLoading();
  if (section === "live") {
    await loadLivePreferences();
  }
  const payload = await getCatalog(section);
  if (section === "live") {
    renderLiveSection(payload);
  } else {
    renderVodSeries(section, payload);
  }
}

function fillSettingsForm(settings) {
  document.getElementById("xtreamUrl").value = settings.xtream_url || "";
  document.getElementById("xtreamUsername").value = settings.xtream_username || "";
  document.getElementById("xtreamPassword").value = settings.xtream_password || "********";
  document.getElementById("playbackLiveFormat").value = settings.playback?.liveFormat || "m3u8";
  document.getElementById("playbackVodFormat").value = settings.playback?.vodFormat || "mp4";
  document.getElementById("playbackVolume").value = Number(settings.playback?.volume ?? 0.8);
  document.getElementById("playbackAutoplay").checked = Boolean(settings.playback?.autoplay);
  document.getElementById("playbackMuted").checked = Boolean(settings.playback?.muted);
}

async function loadSettings() {
  settingsStatus.textContent = "Caricamento...";
  try {
    const settings = await apiFetch("api/settings", { headers: { Accept: "application/json" } });
    appSettings = settings;
    fillSettingsForm(settings);
    settingsStatus.textContent = "Impostazioni pronte";
  } catch (error) {
    settingsStatus.textContent = `Errore: ${error.message}`;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  settingsStatus.textContent = "Salvataggio...";
  const payload = {
    xtream_url: document.getElementById("xtreamUrl").value.trim(),
    xtream_username: document.getElementById("xtreamUsername").value.trim(),
    xtream_password: document.getElementById("xtreamPassword").value,
    playback: {
      liveFormat: document.getElementById("playbackLiveFormat").value,
      vodFormat: document.getElementById("playbackVodFormat").value,
      volume: Number(document.getElementById("playbackVolume").value),
      autoplay: document.getElementById("playbackAutoplay").checked,
      muted: document.getElementById("playbackMuted").checked
    }
  };
  try {
    const body = await apiFetch("api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });
    appSettings = body.settings;
    fillSettingsForm(body.settings);
    catalogCache = { live: null, vod: null, series: null };
    settingsStatus.textContent = "Salvato con successo";
  } catch (error) {
    settingsStatus.textContent = `Errore salvataggio: ${error.message}`;
  }
}

async function handleSection(section) {
  currentSection = section;
  const meta = sectionMeta[section] || sectionMeta.home;
  gridTitle.textContent = meta.title;
  heroDescription.textContent = meta.description;
  setActiveSection(section);
  settingsPanel.classList.toggle("hidden", section !== "settings");
  apiStatus.textContent = "Caricamento...";
  apiStatus.className = "mt-1 text-base font-medium text-amber-300";

  try {
    if (section === "settings") {
      posterGrid.className = "space-y-6";
      posterGrid.innerHTML = "";
      await loadSettings();
    } else {
      await fetchSectionData(section);
    }
    apiStatus.textContent = "Online";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
  } catch (error) {
    apiStatus.textContent = "Errore API";
    apiStatus.className = "mt-1 text-base font-medium text-rose-300";
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-rose-300">Errore: ${escapeHtml(error.message)}</div>`;
  }
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    handleSection(btn.dataset.section);
  });
});
settingsForm.addEventListener("submit", saveSettings);
closePlayerBtn.addEventListener("click", closePlayer);
playerModal.addEventListener("click", (event) => {
  if (event.target === playerModal) {
    closePlayer();
  }
});
videoPlayer.addEventListener("error", () => {
  if (!fallbackTried && currentSection === "live") {
    const src = videoPlayer.currentSrc || "";
    const fallback = buildM3u8Fallback(src);
    if (fallback) {
      fallbackTried = true;
      attachNativePlayer(fallback);
    }
  }
});

handleSection("home");
