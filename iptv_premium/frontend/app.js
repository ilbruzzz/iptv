const navItems = Array.from(document.querySelectorAll(".nav-item"));
const heroDescription = document.getElementById("heroDescription");
const gridTitle = document.getElementById("gridTitle");
const apiStatus = document.getElementById("apiStatus");
const posterGrid = document.getElementById("posterGrid");

const sectionMeta = {
  home: {
    title: "In evidenza",
    description: "Homepage pronta per suggeriti, continue watching e trend."
  },
  live: {
    title: "Canali Live",
    description: "Caricamento categorie live e canali dal backend Xtream."
  },
  vod: {
    title: "Film",
    description: "Caricamento catalogo film VOD con metadati e locandine."
  },
  series: {
    title: "Serie TV",
    description: "Caricamento serie con struttura stagioni ed episodi."
  }
};

const endpointBySection = {
  live: "/api/live",
  vod: "/api/vod",
  series: "/api/series"
};

function createSkeletonCards() {
  const cards = Array.from({ length: 12 }).map((_, idx) => {
    const glow = idx % 3 === 0 ? "bg-premium-accent/20" : "bg-white/5";
    return `
      <article class="group overflow-hidden rounded-2xl border border-white/10 bg-premium-800/70 transition-all duration-300 hover:-translate-y-1 hover:border-premium-accent/50 hover:shadow-glass">
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

async function fetchSectionData(section) {
  const endpoint = endpointBySection[section];
  if (!endpoint) {
    apiStatus.textContent = "UI ready";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
    return;
  }

  apiStatus.textContent = "Caricamento...";
  apiStatus.className = "mt-1 text-base font-medium text-amber-300";

  try {
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`[${section.toUpperCase()}] payload:`, data);

    apiStatus.textContent = "Online";
    apiStatus.className = "mt-1 text-base font-medium text-emerald-300";
  } catch (error) {
    console.error(`[${section.toUpperCase()}] fetch error:`, error);
    apiStatus.textContent = "Errore API";
    apiStatus.className = "mt-1 text-base font-medium text-rose-300";
  }
}

function handleSection(section) {
  const meta = sectionMeta[section] || sectionMeta.home;
  gridTitle.textContent = meta.title;
  heroDescription.textContent = meta.description;
  setActiveSection(section);
  createSkeletonCards();
  fetchSectionData(section);
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => handleSection(btn.dataset.section));
});

createSkeletonCards();
handleSection("home");
