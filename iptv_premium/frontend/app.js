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
let appSettings = {
  playback: {
    autoplay: true,
    muted: false,
    volume: 0.8,
    liveFormat: "m3u8",
    vodFormat: "mp4"
  }
};

const sectionMeta = {
  home: {
    title: "In evidenza",
    description: "Homepage pronta per suggeriti, continue watching e trend."
  },
  live: {
    title: "Canali Live",
    description: "Click su un canale per avviare il player integrato."
  },
  vod: {
    title: "Film",
    description: "Seleziona un film per riprodurlo nel player."
  },
  series: {
    title: "Serie TV",
    description: "Le card aprono il primo episodio disponibile."
  },
  settings: {
    title: "Impostazioni",
    description: "Modifica credenziali Xtream e parametri base di riproduzione."
  }
};

const endpointBySection = {
  live: "api/live",
  vod: "api/vod",
  series: "api/series"
};

function createSkeletonCards() {
  const cards = Array.from({ length: 12 }).map((_, idx) => {
    const glow = idx % 3 === 0 ? "bg-premium-accent/20" : "bg-white/5";
    return `
      <article class="group overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70 transition-all duration-300">
        <div class="aspect-[2/3] ${glow} relative">
          <div class="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent"></div>
          <div class="absolute bottom-3 left-3 right-3 h-2 rounded-full bg-white/20"></div>
        </div>
        <div class="space-y-2 p-3">
          <div class="h-3 w-4/5 rounded-full bg-white/20"></div>
          <div class="h-2 w-2/5 rounded-full bg-white/10"></div>
        </div>
      </article>
    `;
  });
  posterGrid.innerHTML = cards.join("");
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
    btn.classList.toggle("hover:bg-white/5", !active);
  });
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolvePlaybackTarget(section, item) {
  if (section === "series") {
    const firstEpisode = item.seasons?.[0]?.episodes?.[0];
    return {
      url: firstEpisode?.streamUrl || null,
      subtitle: firstEpisode ? `S${item.seasons?.[0]?.seasonNumber || 1}E${firstEpisode.episodeNumber || 1}` : item._categoryName
    };
  }
  return { url: item.streamUrl || null, subtitle: item._categoryName };
}

function normalizeCategories(section, payload) {
  const categories = payload?.categories || [];
  return categories
    .map((category) => ({
      id: category.id,
      name: category.name || "Uncategorized",
      items: (category.items || []).map((item) => {
        const playback = resolvePlaybackTarget(section, item);
        return {
          ...item,
          _categoryName: category.name || "Uncategorized",
          _playbackUrl: playback.url,
          _playbackSubtitle: playback.subtitle || category.name || "Catalogo"
        };
      })
    }))
    .filter((category) => category.items.length > 0);
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

function renderEpgListings(listings) {
  if (!listings?.length) {
    epgList.innerHTML = `<p class="text-slate-400">Nessun dato EPG disponibile.</p>`;
    return;
  }
  epgList.innerHTML = listings
    .map((item) => {
      const start = item.start ? new Date(item.start.replace(" ", "T")) : null;
      const end = item.end ? new Date(item.end.replace(" ", "T")) : null;
      const range = start && end ? `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Orario N/D";
      return `
        <div class="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <p class="text-[11px] uppercase tracking-[0.14em] text-slate-400">${escapeHtml(range)}</p>
          <p class="font-medium text-slate-100">${escapeHtml(item.title)}</p>
          ${item.description ? `<p class="mt-1 text-xs text-slate-300">${escapeHtml(item.description)}</p>` : ""}
        </div>
      `;
    })
    .join("");
}

async function loadEpgForLive(streamId) {
  epgPanel.classList.remove("hidden");
  epgList.innerHTML = `<p class="text-slate-400">Caricamento EPG...</p>`;
  try {
    const response = await fetch(new URL(`api/live/epg/${streamId}?limit=10`, window.location.href), {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    renderEpgListings(payload.listings || []);
  } catch (error) {
    epgList.innerHTML = `<p class="text-rose-300">Errore EPG: ${escapeHtml(error.message)}</p>`;
  }
}

function closePlayer() {
  playerModal.classList.add("hidden");
  playerModal.classList.remove("flex");
  epgPanel.classList.add("hidden");
  cleanupPlayer();
}

function openPlayer(item) {
  const streamUrl = item._playbackUrl;
  if (!streamUrl) {
    alert("Nessun flusso disponibile per questo contenuto.");
    return;
  }

  cleanupPlayer();
  playerTitle.textContent = item.title || item.name || "Player";
  playerModal.classList.remove("hidden");
  playerModal.classList.add("flex");

  const absoluteUrl = new URL(streamUrl, window.location.href).toString();
  const isHls = absoluteUrl.includes(".m3u8") || absoluteUrl.includes("ext=m3u8");
  videoPlayer.autoplay = Boolean(appSettings.playback?.autoplay);
  videoPlayer.muted = Boolean(appSettings.playback?.muted);
  videoPlayer.volume = Number(appSettings.playback?.volume ?? 0.8);

  if (isHls && window.Hls?.isSupported()) {
    currentHls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    currentHls.loadSource(absoluteUrl);
    currentHls.attachMedia(videoPlayer);
    currentHls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        console.error("HLS fatal error:", data);
      }
    });
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

function renderMediaCards(section, payload) {
  const categories = normalizeCategories(section, payload);
  if (!categories.length) {
    posterGrid.innerHTML = `
      <div class="col-span-full glass rounded-2xl p-6 text-center text-slate-300">
        Nessun contenuto disponibile per questa sezione.
      </div>
    `;
    return;
  }

  posterGrid.className = "space-y-6";
  posterGrid.innerHTML = categories
    .map((category, catIndex) => {
      const cards = category.items
        .map((rawItem, itemIndex) => {
          const item = { ...rawItem, _section: section };
          const title = item.title || item.name || `Item ${item.id || ""}`;
          const subtitle = item._playbackSubtitle || item._categoryName || "Catalogo";
          const poster = item.poster || item.icon || null;
          const fallbackTag = section === "live" ? "LIVE" : section === "vod" ? "FILM" : "SERIE";
          const isLive = section === "live";
          return `
            <button data-cat-index="${catIndex}" data-item-index="${itemIndex}" class="media-card group relative w-44 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70 text-left transition-all duration-300 hover:-translate-y-1 hover:border-premium-accent/50 hover:shadow-glass">
              <div class="relative aspect-[2/3]">
                ${
                  poster
                    ? `<img src="api/image?url=${encodeURIComponent(poster)}" alt="${escapeHtml(title)}" class="h-full w-full object-cover" loading="lazy" />`
                    : `<div class="flex h-full w-full items-center justify-center bg-gradient-to-br from-premium-700 to-premium-600 text-xs tracking-[0.22em] text-slate-300">${fallbackTag}</div>`
                }
                <div class="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent opacity-90"></div>
                <div class="absolute bottom-2 left-2 rounded-md border border-white/15 bg-black/45 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-200">
                  ${escapeHtml(subtitle)}
                </div>
                ${isLive ? `<div class="absolute right-2 top-2 rounded-md bg-rose-600/90 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-white">LIVE</div>` : ""}
              </div>
              <div class="space-y-1 p-3">
                <h4 class="line-clamp-2 text-sm font-semibold text-slate-100">${escapeHtml(title)}</h4>
                <p class="text-xs text-slate-400">${escapeHtml(item.year || item.releaseDate || "")}</p>
              </div>
            </button>
          `;
        })
        .join("");
      return `
        <section class="space-y-2">
          <h4 class="px-1 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">${escapeHtml(category.name)}</h4>
          <div class="flex gap-3 overflow-x-auto pb-2 pr-2">${cards}</div>
        </section>
      `;
    })
    .join("");

  const clickItems = Array.from(document.querySelectorAll(".media-card"));
  clickItems.forEach((card) => {
    card.addEventListener("click", () => {
      const catIdx = Number(card.dataset.catIndex);
      const itemIdx = Number(card.dataset.itemIndex);
      const item = { ...categories[catIdx].items[itemIdx], _section: section };
      openPlayer(item);
    });
  });
}

async function fetchSectionData(section) {
  const endpoint = endpointBySection[section];
  if (!endpoint) {
    apiStatus.textContent = "UI ready";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
    posterGrid.className = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";
    posterGrid.innerHTML = `
      <div class="col-span-full glass rounded-2xl p-6 text-center text-slate-300">
        Seleziona una libreria per vedere i contenuti e iniziare la riproduzione.
      </div>
    `;
    return;
  }

  apiStatus.textContent = "Caricamento...";
  apiStatus.className = "mt-1 text-base font-medium text-amber-300";

  try {
    const response = await fetch(new URL(endpoint, window.location.href), {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`HTTP ${response.status} - ${bodyText.slice(0, 180)}`);
    }

    const data = await response.json();
    console.log(`[${section.toUpperCase()}] payload:`, data);
    renderMediaCards(section, data);

    apiStatus.textContent = "Online";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
  } catch (error) {
    console.error(`[${section.toUpperCase()}] fetch error:`, error);
    apiStatus.textContent = "Errore API";
    apiStatus.className = "mt-1 text-base font-medium text-rose-300";
    posterGrid.innerHTML = `
      <div class="col-span-full glass rounded-2xl p-6 text-center text-rose-300">
        Errore caricamento API: ${escapeHtml(error.message)}
      </div>
    `;
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
    const response = await fetch(new URL("api/settings", window.location.href), {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const settings = await response.json();
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
    const response = await fetch(new URL("api/settings", window.location.href), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    appSettings = body.settings;
    fillSettingsForm(body.settings);
    settingsStatus.textContent = "Salvato con successo";
    apiStatus.textContent = "Online";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
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
    posterGrid.className = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";
    posterGrid.innerHTML = "";
    loadSettings();
    return;
  }

  posterGrid.className = "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";
  createSkeletonCards();
  fetchSectionData(section);
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => handleSection(btn.dataset.section));
});
settingsForm.addEventListener("submit", saveSettings);
closePlayerBtn.addEventListener("click", closePlayer);
playerModal.addEventListener("click", (event) => {
  if (event.target === playerModal) {
    closePlayer();
  }
});

handleSection("home");
