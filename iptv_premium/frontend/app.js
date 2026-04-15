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
let appSettings = { playback: { autoplay: true, muted: false, volume: 0.8, liveFormat: "m3u8", vodFormat: "mp4" } };
let livePreferences = { hiddenChannelIds: [], folders: [] };
let catalogCache = { live: null, vod: null, series: null };
let liveManageMode = false;

const sectionMeta = {
  home: { title: "In evidenza", description: "Naviga librerie live, film e serie in stile streaming." },
  live: { title: "Canali Live", description: "Gestisci visibilità canali, cartelle e riproduzione con EPG." },
  vod: { title: "Film", description: "Catalogo film con card orizzontali stile Netflix." },
  series: { title: "Serie TV", description: "Serie TV organizzate in scaffali per categoria." },
  settings: { title: "Impostazioni", description: "Credenziali Xtream e parametri di riproduzione semplici." }
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

function setLoading(message = "Caricamento contenuti...") {
  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">${escapeHtml(message)}</div>`;
}

function normalizeCategories(section, payload) {
  const categories = payload?.categories || [];
  return categories.map((category) => ({
    id: category.id,
    name: category.name || "Uncategorized",
    items: (category.items || []).map((item) => {
      let playbackUrl = item.streamUrl || null;
      let subtitle = category.name || "Catalogo";
      if (section === "series") {
        const firstEpisode = item.seasons?.[0]?.episodes?.[0];
        playbackUrl = firstEpisode?.streamUrl || null;
        subtitle = firstEpisode ? `S${item.seasons?.[0]?.seasonNumber || 1}E${firstEpisode.episodeNumber || 1}` : subtitle;
      }
      return {
        ...item,
        _section: section,
        _categoryName: category.name || "Uncategorized",
        _playbackUrl: playbackUrl,
        _playbackSubtitle: subtitle
      };
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
}

function closePlayer() {
  playerModal.classList.add("hidden");
  playerModal.classList.remove("flex");
  epgPanel.classList.add("hidden");
  cleanupPlayer();
}

function renderEpgListings(listings) {
  if (!listings?.length) {
    epgList.innerHTML = `<p class="text-slate-400">Nessun dato EPG disponibile.</p>`;
    return;
  }
  epgList.innerHTML = listings.map((item) => {
    const start = item.start ? new Date(item.start.replace(" ", "T")) : null;
    const end = item.end ? new Date(item.end.replace(" ", "T")) : null;
    const range = start && end ? `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Orario N/D";
    return `<div class="rounded-lg border border-white/10 bg-black/30 px-3 py-2"><p class="text-[11px] uppercase tracking-[0.14em] text-slate-400">${escapeHtml(range)}</p><p class="font-medium text-slate-100">${escapeHtml(item.title)}</p>${item.description ? `<p class="mt-1 text-xs text-slate-300">${escapeHtml(item.description)}</p>` : ""}</div>`;
  }).join("");
}

async function loadEpgForLive(streamId) {
  epgPanel.classList.remove("hidden");
  epgList.innerHTML = `<p class="text-slate-400">Caricamento EPG...</p>`;
  try {
    const payload = await apiFetch(`api/live/epg/${streamId}?limit=10`);
    renderEpgListings(payload.listings || []);
  } catch (error) {
    epgList.innerHTML = `<p class="text-rose-300">Errore EPG: ${escapeHtml(error.message)}</p>`;
  }
}

function openPlayer(item) {
  if (!item._playbackUrl) {
    alert("Nessun flusso disponibile per questo contenuto.");
    return;
  }

  cleanupPlayer();
  playerTitle.textContent = item.title || item.name || "Player";
  playerModal.classList.remove("hidden");
  playerModal.classList.add("flex");

  const absoluteUrl = new URL(item._playbackUrl, window.location.href).toString();
  const isHls = absoluteUrl.includes(".m3u8") || absoluteUrl.includes("ext=m3u8");
  videoPlayer.autoplay = Boolean(appSettings.playback?.autoplay);
  videoPlayer.muted = Boolean(appSettings.playback?.muted);
  videoPlayer.volume = Number(appSettings.playback?.volume ?? 0.8);

  if (isHls && window.Hls?.isSupported()) {
    currentHls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    currentHls.loadSource(absoluteUrl);
    currentHls.attachMedia(videoPlayer);
  } else {
    videoPlayer.src = absoluteUrl;
  }

  if (videoPlayer.autoplay) {
    videoPlayer.play().catch(() => {});
  }

  if (item._section === "live" && item.id) {
    loadEpgForLive(item.id);
  } else {
    epgPanel.classList.add("hidden");
  }
}

async function loadLivePreferences() {
  try {
    livePreferences = await apiFetch("api/live/preferences");
  } catch {
    livePreferences = { hiddenChannelIds: [], folders: [] };
  }
}

async function saveLivePreferences() {
  const payload = {
    hiddenChannelIds: livePreferences.hiddenChannelIds || [],
    folders: livePreferences.folders || []
  };
  const saved = await apiFetch("api/live/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  livePreferences = saved.livePreferences || payload;
}

function isChannelHidden(channelId) {
  return (livePreferences.hiddenChannelIds || []).includes(String(channelId));
}

function channelCard(item, idx, folderId = "") {
  const title = item.title || item.name || `Canale ${item.id}`;
  const icon = item.icon || null;
  const hidden = isChannelHidden(item.id);
  const showTools = liveManageMode ? `<div class="mt-2 flex gap-2"><button data-action="toggle-visibility" data-id="${item.id}" class="rounded-md border border-white/20 px-2 py-1 text-[10px]">${hidden ? "Mostra" : "Nascondi"}</button><button data-action="assign-folder" data-id="${item.id}" data-folder="${folderId}" class="rounded-md border border-white/20 px-2 py-1 text-[10px]">Sposta</button></div>` : "";
  return `<button data-item-index="${idx}" data-channel-id="${escapeHtml(item.id)}" class="media-card group relative w-44 shrink-0 overflow-hidden rounded-2xl border ${hidden ? "border-rose-500/50 opacity-60" : "border-white/10"} bg-premium-800/70 text-left transition-all duration-300 hover:-translate-y-1 hover:border-premium-accent/50 hover:shadow-glass"><div class="relative aspect-[2/3]">${icon ? `<img src="api/image?url=${encodeURIComponent(icon)}" alt="${escapeHtml(title)}" class="h-full w-full object-cover" loading="lazy" />` : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-premium-700 to-premium-600 text-xs tracking-[0.22em] text-slate-300">LIVE</div>`}<div class="absolute right-2 top-2 rounded-md bg-rose-600/90 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-white">LIVE</div></div><div class="p-3"><h4 class="line-clamp-2 text-sm font-semibold text-slate-100">${escapeHtml(title)}</h4>${showTools}</div></button>`;
}

function renderLiveWithFolders(payload) {
  const categories = normalizeCategories("live", payload);
  const allChannels = categories.flatMap((cat) => cat.items);
  const byId = new Map(allChannels.map((item) => [String(item.id), item]));
  const hiddenIds = new Set((livePreferences.hiddenChannelIds || []).map(String));

  const folders = livePreferences.folders || [];
  const folderSections = folders.map((folder) => {
    const items = (folder.channelIds || [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .filter((ch) => !hiddenIds.has(String(ch.id)));
    return { id: folder.id, name: folder.name, items };
  }).filter((f) => f.items.length > 0);

  const assigned = new Set(folderSections.flatMap((f) => f.items.map((c) => String(c.id))));
  const unassigned = allChannels.filter((item) => !assigned.has(String(item.id)) && !hiddenIds.has(String(item.id)));

  const toolbar = `<div class="glass rounded-2xl p-4"><div class="flex flex-wrap items-center gap-2"><button id="toggleManageMode" class="rounded-xl border border-white/20 px-3 py-2 text-xs">${liveManageMode ? "Disattiva gestione" : "Gestisci canali"}</button><button id="createFolderBtn" class="rounded-xl border border-white/20 px-3 py-2 text-xs">Nuova cartella</button><span class="text-xs text-slate-400">Canali totali: ${allChannels.length} · nascosti: ${hiddenIds.size}</span></div></div>`;

  const sectionHtml = [];
  for (const folder of folderSections) {
    sectionHtml.push(`<section class="space-y-2"><h4 class="px-1 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">${escapeHtml(folder.name)}</h4><div class="flex gap-3 overflow-x-auto pb-2 pr-2">${folder.items.map((item, idx) => channelCard(item, idx, folder.id)).join("")}</div></section>`);
  }
  sectionHtml.push(`<section class="space-y-2"><h4 class="px-1 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Canali non assegnati</h4><div class="flex gap-3 overflow-x-auto pb-2 pr-2">${unassigned.map((item, idx) => channelCard(item, idx, "")).join("")}</div></section>`);

  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = `${toolbar}${sectionHtml.join("")}`;

  Array.from(document.querySelectorAll(".media-card")).forEach((card) => {
    card.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("button[data-action]");
      if (actionBtn) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const itemId = String(card.dataset.channelId || "");
      const item = allChannels.find((ch) => String(ch.id) === itemId);
      if (item) {
        openPlayer(item);
      }
    });
  });

  const manageBtn = document.getElementById("toggleManageMode");
  const createFolderBtn = document.getElementById("createFolderBtn");
  if (manageBtn) {
    manageBtn.addEventListener("click", () => {
      liveManageMode = !liveManageMode;
      renderLiveWithFolders(payload);
    });
  }
  if (createFolderBtn) {
    createFolderBtn.addEventListener("click", async () => {
      const name = prompt("Nome cartella canali:");
      if (!name) return;
      livePreferences.folders = [...(livePreferences.folders || []), { id: `folder_${Date.now()}`, name: name.trim(), channelIds: [] }];
      await saveLivePreferences();
      renderLiveWithFolders(payload);
    });
  }

  Array.from(document.querySelectorAll("button[data-action='toggle-visibility']")).forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = String(btn.dataset.id);
      const set = new Set((livePreferences.hiddenChannelIds || []).map(String));
      if (set.has(id)) set.delete(id); else set.add(id);
      livePreferences.hiddenChannelIds = Array.from(set);
      await saveLivePreferences();
      renderLiveWithFolders(payload);
    });
  });

  Array.from(document.querySelectorAll("button[data-action='assign-folder']")).forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const channelId = String(btn.dataset.id);
      const name = prompt("Nome cartella destinazione (esistente o nuova):");
      if (!name) return;
      let folder = (livePreferences.folders || []).find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
      if (!folder) {
        folder = { id: `folder_${Date.now()}`, name: name.trim(), channelIds: [] };
        livePreferences.folders.push(folder);
      }
      for (const f of livePreferences.folders) {
        f.channelIds = (f.channelIds || []).filter((id) => String(id) !== channelId);
      }
      folder.channelIds = [...new Set([...(folder.channelIds || []), channelId])];
      await saveLivePreferences();
      renderLiveWithFolders(payload);
    });
  });
}

function renderShelfCards(section, payload) {
  const categories = normalizeCategories(section, payload).filter((c) => c.items.length > 0);
  if (!categories.length) {
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">Nessun contenuto disponibile.</div>`;
    return;
  }
  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = categories.map((category, catIdx) => {
    const cards = category.items.map((item, idx) => {
      const title = item.title || item.name || `Item ${item.id || ""}`;
      const poster = item.poster || item.icon || null;
      const tag = section === "vod" ? "FILM" : "SERIE";
      return `<button data-cat="${catIdx}" data-idx="${idx}" class="shelf-card w-44 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70 text-left transition-all duration-300 hover:-translate-y-1 hover:border-premium-accent/50 hover:shadow-glass"><div class="relative aspect-[2/3]">${poster ? `<img src="api/image?url=${encodeURIComponent(poster)}" alt="${escapeHtml(title)}" class="h-full w-full object-cover" loading="lazy" />` : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-premium-700 to-premium-600 text-xs tracking-[0.22em] text-slate-300">${tag}</div>`}<div class="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent"></div></div><div class="p-3"><h4 class="line-clamp-2 text-sm font-semibold text-slate-100">${escapeHtml(title)}</h4></div></button>`;
    }).join("");
    return `<section class="space-y-2"><h4 class="px-1 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">${escapeHtml(category.name)}</h4><div class="flex gap-3 overflow-x-auto pb-2 pr-2">${cards}</div></section>`;
  }).join("");

  Array.from(document.querySelectorAll(".shelf-card")).forEach((card) => {
    card.addEventListener("click", () => {
      const cat = Number(card.dataset.cat);
      const idx = Number(card.dataset.idx);
      const item = categories[cat].items[idx];
      openPlayer(item);
    });
  });
}

async function fetchSectionData(section) {
  if (!endpointBySection[section]) {
    apiStatus.textContent = "UI ready";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-slate-300">Seleziona una libreria per vedere i contenuti.</div>`;
    return;
  }

  apiStatus.textContent = "Caricamento...";
  apiStatus.className = "mt-1 text-base font-medium text-amber-300";
  setLoading();

  try {
    if (section === "live") {
      await loadLivePreferences();
    }
    const payload = await apiFetch(endpointBySection[section], { headers: { Accept: "application/json" } });
    catalogCache[section] = payload;
    if (section === "live") {
      renderLiveWithFolders(payload);
    } else {
      renderShelfCards(section, payload);
    }
    apiStatus.textContent = "Online";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
  } catch (error) {
    apiStatus.textContent = "Errore API";
    apiStatus.className = "mt-1 text-base font-medium text-rose-300";
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = `<div class="glass rounded-2xl p-6 text-rose-300">Errore caricamento API: ${escapeHtml(error.message)}</div>`;
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
    settingsStatus.textContent = "Salvato con successo";
  } catch (error) {
    settingsStatus.textContent = `Errore salvataggio: ${error.message}`;
  }
}

function handleSection(section) {
  const meta = sectionMeta[section] || sectionMeta.home;
  gridTitle.textContent = meta.title;
  heroDescription.textContent = meta.description;
  setActiveSection(section);
  settingsPanel.classList.toggle("hidden", section !== "settings");

  if (section === "settings") {
    posterGrid.className = "space-y-6";
    posterGrid.innerHTML = "";
    loadSettings();
    return;
  }
  fetchSectionData(section);
}

navItems.forEach((btn) => btn.addEventListener("click", () => handleSection(btn.dataset.section)));
settingsForm.addEventListener("submit", saveSettings);
closePlayerBtn.addEventListener("click", closePlayer);
playerModal.addEventListener("click", (event) => {
  if (event.target === playerModal) closePlayer();
});

handleSection("home");
