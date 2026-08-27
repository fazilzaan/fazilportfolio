/**
 * Renders portfolio work cards from Firestore project data.
 * Usage on a page:
 *   <div class="grid" data-projects-grid data-specialty="editor" data-category="Recent Cuts"></div>
 *   <div class="video-grid" data-projects-grid="recent"></div>
 */
(function (global) {
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cardHtml(project, options) {
    const video = project.video || "";
    const title = escapeHtml(project.title);
    const credits = escapeHtml(project.credits);
    const useSlate = options && options.variant === "slate";

    if (useSlate) {
      return `
        <div class="work-card reveal" ${video ? `data-video="${escapeHtml(video)}"` : ""}>
          <div class="work-card-media">
            ${
              video
                ? `<video src="${escapeHtml(video)}" loop muted playsinline class="work-card-video"></video>
                   <div class="play-indicator"><div class="play-icon"></div></div>`
                : `<div class="slate-indicator">🎬</div>`
            }
          </div>
          <div class="work-card-info">
            <h3>${title}</h3>
            <p>${credits}</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="work-card reveal" ${video ? `data-video="${escapeHtml(video)}"` : ""}>
        <div class="work-card-media">
          ${
            video
              ? `<video src="${escapeHtml(video)}" loop muted playsinline class="work-card-video"></video>`
              : ""
          }
          <div class="play-indicator">
            <div class="play-icon"></div>
          </div>
        </div>
        <div class="work-card-info">
          <h3>${title}</h3>
          <p>${credits}</p>
        </div>
      </div>
    `;
  }

  function emptyHtml(message) {
    return `<p class="projects-empty" style="color:#888; padding:12px 0;">${escapeHtml(message)}</p>`;
  }

  function filterProjects(projects, specialty, category, recentOnly) {
    return (projects || []).filter((p) => {
      if (p.isDeleted) return false;
      if (recentOnly) {
        // Prefer featured/recent items; if none are marked, show all so admin adds appear
        const anyRecent = (projects || []).some((item) => !item.isDeleted && item.isRecent);
        if (anyRecent) return Boolean(p.isRecent);
        return true;
      }
      if (!specialty) return true;
      const specs = Array.isArray(p.specialties) ? p.specialties : [];
      if (!specs.includes(specialty)) return false;
      if (!category) return true;
      const cats = p.categories || {};
      return cats[specialty] === category;
    });
  }

  function bindLightboxAndHover(root) {
    const scope = root || document;
    const lightbox = document.getElementById("video-lightbox");
    const lightboxPlayer = document.getElementById("lightbox-player");
    const closeBtn = lightbox && lightbox.querySelector(".lightbox-close");

    scope.querySelectorAll(".work-card").forEach((card) => {
      const video = card.querySelector(".work-card-video");
      if (video) {
        card.addEventListener("mouseenter", () => {
          video.play().catch(() => {});
        });
        card.addEventListener("mouseleave", () => {
          video.pause();
          video.currentTime = 0;
        });
      }

      card.addEventListener("click", () => {
        const videoSrc = card.getAttribute("data-video");
        if (!videoSrc || !lightbox || !lightboxPlayer) return;
        lightboxPlayer.src = videoSrc;
        lightbox.classList.add("active");
        lightboxPlayer.play().catch(() => {});
      });
    });

    if (lightbox && !lightbox.dataset.bound) {
      lightbox.dataset.bound = "1";
      const close = () => {
        lightbox.classList.remove("active");
        if (lightboxPlayer) {
          lightboxPlayer.pause();
          lightboxPlayer.removeAttribute("src");
          lightboxPlayer.load();
        }
      };
      if (closeBtn) closeBtn.addEventListener("click", close);
      lightbox.addEventListener("click", (e) => {
        if (e.target === lightbox) close();
      });
    }
  }

  function activateReveals(root) {
    const reveals = (root || document).querySelectorAll(".reveal");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("active");
        });
      },
      { threshold: 0.1 }
    );
    reveals.forEach((el) => observer.observe(el));
  }

  async function renderPortfolioGrids() {
    const targets = Array.from(document.querySelectorAll("[data-projects-grid]"));
    if (!targets.length) return;

    let projects = [];
    let loadError = null;
    try {
      if (typeof initFirebase === "function") await initFirebase();
      projects = await getCombinedProjects();
    } catch (err) {
      loadError = err;
      console.warn("Could not load projects from Firestore:", err);
      projects = (window.DEFAULT_PROJECTS || []).slice();
    }

    targets.forEach((el) => {
      const mode = el.getAttribute("data-projects-grid");
      const specialty = el.getAttribute("data-specialty") || "";
      const category = el.getAttribute("data-category") || "";
      const variant = el.getAttribute("data-card-variant") || "";
      // "all" = every project (roles showcase). Otherwise filter by specialty/category.
      // "recent" = featured items (fallback to all if none marked recent).
      const showAll = mode === "all";
      const recentOnly = mode === "recent";

      if (loadError && !(projects && projects.length)) {
        el.innerHTML = emptyHtml(
          "Could not load projects from the database. Check Firestore rules and firebase-config.js."
        );
        return;
      }

      const filtered = showAll
        ? filterProjects(projects, "", "", false)
        : filterProjects(projects, specialty, category, recentOnly);
      if (!filtered.length) {
        el.innerHTML = emptyHtml("No projects yet. Add some in Admin.");
        return;
      }

      // Featured items first when showing the full list / recent showcase
      const sorted =
        showAll || recentOnly
          ? [...filtered].sort((a, b) => Number(Boolean(b.isRecent)) - Number(Boolean(a.isRecent)))
          : filtered;

      el.innerHTML = sorted.map((p) => cardHtml(p, { variant })).join("");
    });

    bindLightboxAndHover(document);
    activateReveals(document);
  }

  global.renderPortfolioGrids = renderPortfolioGrids;
  global.filterPortfolioProjects = filterProjects;

  document.addEventListener("DOMContentLoaded", () => {
    if (document.querySelector("[data-projects-grid]")) {
      renderPortfolioGrids();
    }
  });
})(window);
