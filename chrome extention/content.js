(() => {
  const PLAYER_VIDEO_CLASSES = ["player-media", "videoplayer_media"];
  const MIN_SCORE = 600;
  const MIN_TEXT_SCORE = 300; // минимум «реального» текста, чтобы вообще решать
  const RATIO = 2.5;
  const MAX_SAMPLES = 15;
  const CAPTURE_GAP_MS = 1000;
  const FLIPPED_BANNER_MS = 20000;
  // Если в начале «не зеркало» — повторяем анализ с этих меток (сек).
  const RETRY_SEEK_SEC = [10 * 60 + 15, 20 * 60];
  const TOTAL_PASSES = 1 + RETRY_SEEK_SEC.length;

  const flipped = new WeakSet();
  const hookedVideos = new WeakSet();
  const watchedRoots = [];

  let enabled = false;
  let autoAnalyze = false;
  let ready = false;

  let pageUrl = location.href;
  let autoDecided = false;
  let autoFlip = false;
  let analyzing = false;
  let analyzeLoopActive = false;
  let analysisPass = 0;
  let normalSum = 0;
  let flippedSum = 0;
  let samples = 0;
  let normalTextFrames = 0;
  let flippedTextFrames = 0;
  let lastReport = null;
  let lastFrameImage = null;
  let lastFrameTimeSec = 0;
  let overlayHideTimer = 0;
  let overlayEl = null;
  let cornerEl = null;
  let dragState = null;
  // Окно анализа показывается только по кнопке из меню.
  let overlayForcedVisible = false;

  function isTopFrame() {
    return window === window.top;
  }

  function isVkHost(hostname) {
    const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
    return (
      host === "vkvideo.ru" ||
      host.endsWith(".vkvideo.ru") ||
      host === "vk.com" ||
      host.endsWith(".vk.com") ||
      host === "vk.ru" ||
      host.endsWith(".vk.ru")
    );
  }

  function isYandexHost(hostname) {
    const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
    return host === "yandex.ru" || host.endsWith(".yandex.ru") || host === "ya.ru" || host.endsWith(".ya.ru");
  }

  // Страница/фрейм, где должен работать автоанализ:
  // - vkvideo.ru/video-…, vk.com/video-… (открытие с сайта)
  // - video_ext.php (встраивание из Яндекса и других сайтов)
  function isAutoAnalyzeUrl(href = location.href) {
    try {
      const url = new URL(href);
      if (!isVkHost(url.hostname)) return false;
      const path = url.pathname || "";
      if (/video_ext\.php$/i.test(path)) return true;
      if (/^\/video-/i.test(path)) return true;
      if (/^\/clip-/i.test(path)) return true;
      if (/^\/video\/?/i.test(path) && path !== "/video" && path !== "/video/") return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function isAnalyzeContext() {
    return isAutoAnalyzeUrl();
  }

  function canShowOverlay() {
    return isAnalyzeContext() || (isTopFrame() && isYandexHost(location.hostname));
  }

  function classText(node) {
    if (!node || node.nodeType !== 1) return "";
    const value = node.className;
    if (typeof value === "string") return value;
    if (value && typeof value.baseVal === "string") return value.baseVal;
    return "";
  }

  function eachAncestor(node, visit) {
    let current = node;
    for (let depth = 0; current && depth < 30; depth += 1) {
      if (visit(current)) return true;
      const root = typeof current.getRootNode === "function" ? current.getRootNode() : null;
      current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  }

  function isAdNode(node) {
    const text = classText(node);
    return /(^|[\s_-])(ads?|advert|preroll|promo)([\s_-]|$)|ads-container|videoplayer_advert/i.test(text);
  }

  function isPlayerHost(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === "VK-VIDEO-PLAYER") return true;
    const text = classText(node);
    return /\bvideo-container\b|\bvideo-wrapper\b|\bvideoplayer\b|\bVideoPage__player|\bVideoPlayer__player/.test(
      text
    );
  }

  function shouldFlipCandidate(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    if (eachAncestor(video, isAdNode)) return false;
    if (PLAYER_VIDEO_CLASSES.some((name) => video.classList.contains(name))) return true;
    return eachAncestor(video, isPlayerHost);
  }

  function wantFlip(video) {
    if (!ready || !shouldFlipCandidate(video)) return false;
    // Автоанализ на этой странице: решение OCR важнее старого ручного флага.
    if (autoAnalyze && isAnalyzeContext()) {
      if (!autoDecided) return false;
      return autoFlip === true;
    }
    return enabled === true;
  }

  function hasAppliedFlipToPlayer() {
    const video = findPlayerVideo();
    if (!video) return false;
    return scaleValue(video) === "-11" || video.dataset.vkFlip === "1";
  }

  function isEffectivelyFlipped() {
    return hasAppliedFlipToPlayer();
  }

  function scaleValue(video) {
    return video.style.getPropertyValue("scale").replace(/\s+/g, "");
  }

  function syncVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    const want = wantFlip(video);
    if (want) {
      if (scaleValue(video) !== "-11") {
        video.style.setProperty("scale", "-1 1", "important");
      }
      video.dataset.vkFlip = "1";
      flipped.add(video);
      return;
    }
    if (flipped.has(video) || video.dataset.vkFlip === "1") {
      video.style.removeProperty("scale");
      delete video.dataset.vkFlip;
      flipped.delete(video);
    }
  }

  function watchVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (hookedVideos.has(video)) {
      syncVideo(video);
      return;
    }
    hookedVideos.add(video);
    syncVideo(video);
    const observer = new MutationObserver(() => syncVideo(video));
    observer.observe(video, { attributes: true, attributeFilter: ["style", "class"] });
  }

  function visit(node) {
    if (!node || node.nodeType !== 1) return;
    watchVideo(node);
    if (node.shadowRoot) watchRoot(node.shadowRoot);
    if (typeof node.querySelectorAll !== "function") return;
    node.querySelectorAll("video").forEach(watchVideo);
    node.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) watchRoot(element.shadowRoot);
    });
  }

  function watchRoot(root) {
    if (!root || watchedRoots.includes(root)) return;
    watchedRoots.push(root);
    if (typeof root.querySelectorAll === "function") {
      root.querySelectorAll("video").forEach(watchVideo);
      root.querySelectorAll("*").forEach((element) => {
        if (element.shadowRoot) watchRoot(element.shadowRoot);
      });
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) visit(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function resyncAll() {
    for (const root of watchedRoots) {
      if (typeof root.querySelectorAll !== "function") continue;
      root.querySelectorAll("video").forEach(syncVideo);
    }
    updateCornerBadge();
  }

  function fullScan() {
    watchRoot(document);
    if (document.documentElement) visit(document.documentElement);
    resyncAll();
  }

  function findPlayerVideo() {
    const found = [];
    function walk(node) {
      if (!node) return;
      if (node.shadowRoot) walk(node.shadowRoot);
      const kids = node.children ? [...node.children] : [];
      for (const el of kids) {
        if (el.tagName === "VIDEO" && shouldFlipCandidate(el)) found.push(el);
        walk(el);
      }
    }
    walk(document.documentElement);
    return (
      found.find((v) => v.classList.contains("player-media") && v.videoWidth > 0) ||
      found.find((v) => v.videoWidth > 0) ||
      found[0] ||
      null
    );
  }

  function ensureStyles() {
    if (document.getElementById("vkflip-overlay-style")) return;
    const style = document.createElement("style");
    style.id = "vkflip-overlay-style";
    style.textContent = `
      #vkflip-status-overlay {
        position: fixed;
        right: 16px;
        bottom: 16px;
        left: auto;
        z-index: 2147483646;
        max-width: min(420px, calc(100vw - 32px));
        border-radius: 12px;
        background: rgba(12, 14, 18, 0.9);
        color: #f4f6f8;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(8px);
        overflow: hidden;
        pointer-events: none;
      }
      #vkflip-status-overlay .vkflip-caption {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 8px 8px 14px;
        font-size: 13px;
        font-weight: 650;
        cursor: grab;
        user-select: none;
        pointer-events: auto;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      }
      #vkflip-status-overlay .vkflip-caption:active {
        cursor: grabbing;
      }
      #vkflip-status-overlay .vkflip-title {
        flex: 1;
        min-width: 0;
        padding-top: 2px;
      }
      #vkflip-status-overlay .vkflip-close {
        flex: none;
        width: 28px;
        height: 28px;
        margin: -2px 0 0;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: 700 20px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        opacity: 0.75;
        pointer-events: auto;
      }
      #vkflip-status-overlay .vkflip-close:hover {
        opacity: 1;
        background: rgba(255, 255, 255, 0.12);
      }
      #vkflip-status-overlay .vkflip-thumb {
        display: block;
        width: 100%;
        max-height: 180px;
        object-fit: cover;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        pointer-events: none;
        background: #000;
      }
      #vkflip-status-overlay .vkflip-body {
        padding: 10px 14px 12px;
        white-space: pre-wrap;
        pointer-events: none;
      }
      #vkflip-status-overlay.vkflip-success {
        background: rgba(0, 90, 200, 0.94);
      }
      #vkflip-corner-badge {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483646;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(0, 90, 200, 0.92);
        color: #fff;
        font: 650 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
        pointer-events: none;
      }
    `;
    (document.documentElement || document.head || document.body).appendChild(style);
  }

  function ensureOverlay() {
    ensureStyles();
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.id = "vkflip-status-overlay";
    overlayEl.hidden = true;
    overlayEl.innerHTML =
      `<div class="vkflip-caption"><span class="vkflip-title"></span><button type="button" class="vkflip-close" aria-label="Закрыть" title="Закрыть">×</button></div><img class="vkflip-thumb" alt="" hidden /><div class="vkflip-body"></div>`;
    (document.documentElement || document.body).appendChild(overlayEl);
    bindOverlayDrag(overlayEl);
    const closeBtn = overlayEl.querySelector(".vkflip-close");
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideOverlay();
    });
    closeBtn.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    return overlayEl;
  }

  function ensureCornerBadge() {
    ensureStyles();
    if (cornerEl && cornerEl.isConnected) return cornerEl;
    cornerEl = document.createElement("div");
    cornerEl.id = "vkflip-corner-badge";
    cornerEl.textContent = "Видео зеркалировано";
    cornerEl.hidden = true;
    (document.documentElement || document.body).appendChild(cornerEl);
    return cornerEl;
  }

  function updateCornerBadge() {
    if (!canShowOverlay()) {
      if (cornerEl) cornerEl.hidden = true;
      return;
    }
    const badge = ensureCornerBadge();
    // Надпись только когда flip реально применён к <video>, а не «по задумке».
    badge.hidden = !hasAppliedFlipToPlayer();
  }

  function bindOverlayDrag(el) {
    const caption = el.querySelector(".vkflip-caption");
    if (!caption || caption.dataset.dragBound === "1") return;
    caption.dataset.dragBound = "1";

    caption.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".vkflip-close")) return;
      const rect = el.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      };
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      caption.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    caption.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const maxLeft = Math.max(8, window.innerWidth - dragState.width - 8);
      const maxTop = Math.max(8, window.innerHeight - dragState.height - 8);
      const left = Math.min(maxLeft, Math.max(8, event.clientX - dragState.offsetX));
      const top = Math.min(maxTop, Math.max(8, event.clientY - dragState.offsetY));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    });

    const endDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState = null;
      try {
        caption.releasePointerCapture(event.pointerId);
      } catch (_) {}
    };
    caption.addEventListener("pointerup", endDrag);
    caption.addEventListener("pointercancel", endDrag);
  }

  function showOverlay(title, body, { success = false, hideAfterMs = 0, thumbnail = null } = {}) {
    // По умолчанию молчим: окно только после «Показать окно анализа» в меню.
    if (!overlayForcedVisible || !canShowOverlay()) return;
    const el = ensureOverlay();
    el.classList.toggle("vkflip-success", success);
    el.querySelector(".vkflip-title").textContent = title;
    el.querySelector(".vkflip-body").textContent = body;
    const thumb = el.querySelector(".vkflip-thumb");
    if (thumbnail) {
      thumb.src = thumbnail;
      thumb.hidden = false;
    } else {
      thumb.hidden = true;
      thumb.removeAttribute("src");
    }
    el.hidden = false;
    if (overlayHideTimer) clearTimeout(overlayHideTimer);
    overlayHideTimer = 0;
    if (hideAfterMs > 0) {
      overlayHideTimer = setTimeout(() => {
        el.hidden = true;
        overlayForcedVisible = false;
      }, hideAfterMs);
    }
  }

  async function persistAnalysisSnapshot(title, report, extra = {}) {
    const thumbnail = lastFrameImage ? await makeThumbnail(lastFrameImage, 320) : null;
    const snapshot = {
      title,
      body: techBody(report),
      thumbnail,
      timeSec: lastFrameTimeSec,
      timeLabel: formatTime(lastFrameTimeSec),
      url: location.href,
      updatedAt: Date.now(),
      ...extra,
    };
    await chrome.storage.local.set({ analysisSnapshot: snapshot });
    // Если пользователь уже открыл окно — обновляем его живьём.
    if (overlayForcedVisible) {
      showOverlay(snapshot.title, snapshot.body, { thumbnail: snapshot.thumbnail });
    }
    return snapshot;
  }

  async function showAnalysisWindowFromSnapshot(snapshot, options = {}) {
    overlayForcedVisible = true;
    if (!snapshot) {
      showOverlay(
        "Окно анализа",
        "Пока нет данных анализа.\nВключите автоанализ на странице с видео VK."
      );
      return;
    }
    showOverlay(snapshot.title || "Окно анализа", snapshot.body || "", {
      thumbnail: snapshot.thumbnail || null,
      ...options,
    });
  }

  function hideOverlay() {
    if (overlayHideTimer) clearTimeout(overlayHideTimer);
    overlayHideTimer = 0;
    overlayForcedVisible = false;
    if (overlayEl) overlayEl.hidden = true;
  }

  function formatWords(side) {
    if (!side || !side.words || !side.words.length) return "—";
    return side.words
      .slice(0, 6)
      .map((w) => `${w.text}(${w.confidence}%)`)
      .join(", ");
  }

  function formatTime(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function passLabel() {
    return `Проход ${analysisPass + 1}/${TOTAL_PASSES}`;
  }

  function sideHasText(side) {
    return Boolean(side && Array.isArray(side.words) && side.words.length > 0 && (side.score || 0) > 0);
  }

  function hasNormalTextEvidence() {
    return normalSum >= MIN_TEXT_SCORE && normalTextFrames > 0;
  }

  function hasFlippedTextEvidence() {
    return flippedSum >= MIN_TEXT_SCORE && flippedTextFrames > 0;
  }

  // flip только если текст в ролике уже зеркальный (OCR лучше на отражённом кадре).
  // если текст читается нормально — flip не нужен.
  function verdictFromScores({ soft = false } = {}) {
    const normalOk = hasNormalTextEvidence();
    const flippedOk = hasFlippedTextEvidence();
    const flipWins = soft
      ? flippedOk && flippedSum > normalSum
      : flippedOk && flippedSum >= MIN_SCORE && flippedSum > normalSum * RATIO;

    if (flipWins) {
      // Явный перевес отражённого OCR → в исходнике текст зеркальный.
      if (normalOk && normalSum >= flippedSum) return "unknown";
      return "flip";
    }

    if (normalOk && normalSum >= flippedSum) return "no-flip";
    if (normalOk && !flippedOk) return "no-flip";
    return "unknown";
  }

  async function clearEnabledFlip() {
    enabled = false;
    autoFlip = false;
    await chrome.storage.local.set({ enabled: false });
  }

  function techBody(report) {
    const lines = [
      passLabel(),
      `Кадр: ${report.samples || 0}`,
      `Длительность OCR: ${report.durationMs || 0} мс`,
      `Счёт обычный: ${report.normalScore ?? 0} (сумма ${report.normalSum ?? 0}, кадров с текстом ${normalTextFrames})`,
      `Счёт отражённый: ${report.flippedScore ?? 0} (сумма ${report.flippedSum ?? 0}, кадров с текстом ${flippedTextFrames})`,
      `Слова обычные: ${formatWords(report.normal)}`,
      `Слова отражённые: ${formatWords(report.flipped)}`,
    ];
    if (report.note) lines.push(report.note);
    if (report.error) lines.push(`Ошибка: ${report.error}`);
    return lines.join("\n");
  }

  function grabFrame(video) {
    const maxW = 960;
    const w = Math.min(video.videoWidth || 640, maxW);
    const h = Math.max(1, Math.round(((video.videoHeight || 360) * w) / (video.videoWidth || 640)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  function makeThumbnail(dataUrl, maxW = 240) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function clearDecisionInfo() {
    await chrome.storage.local.remove(["decisionInfo", "analysisSnapshot"]);
  }

  async function saveDecisionInfo({ flippedAtSec, thumbnail, flipped }) {
    await chrome.storage.local.set({
      decisionInfo: {
        url: location.href,
        flippedAtSec,
        timeLabel: formatTime(flippedAtSec),
        thumbnail,
        flipped: !!flipped,
        updatedAt: Date.now(),
      },
    });
  }

  function resetPassCounters() {
    normalSum = 0;
    flippedSum = 0;
    samples = 0;
    normalTextFrames = 0;
    flippedTextFrames = 0;
    lastReport = null;
  }

  function resetAutoState({ keepOverlay = false } = {}) {
    autoDecided = false;
    autoFlip = false;
    analyzing = false;
    analysisPass = 0;
    resetPassCounters();
    lastFrameImage = null;
    lastFrameTimeSec = 0;
    // При смене состояния анализа окно само не показываем.
    if (!keepOverlay) hideOverlay();
    resyncAll();
  }

  async function onUrlMaybeChanged() {
    if (location.href === pageUrl) return;
    pageUrl = location.href;
    // Новая URL: закрыть окно анализа и убрать историю из меню.
    hideOverlay();
    resetAutoState({ keepOverlay: true });
    if (isTopFrame() || isAnalyzeContext()) {
      enabled = false;
      await chrome.storage.local.set({ enabled: false });
      await clearDecisionInfo();
    }
    resyncAll();
    startAutoIfNeeded();
  }

  async function waitUntilVideoTime(sec) {
    const video = findPlayerVideo();
    if (!video) return { ok: false, reason: "плеер не найден" };

    const duration = Number(video.duration);
    if (Number.isFinite(duration) && duration > 0 && sec >= duration - 0.5) {
      return {
        ok: false,
        reason: `ролик короче ${formatTime(sec)} (длина ${formatTime(duration)})`,
      };
    }

    // Уже дошли / перескочили метку (без нашей перемотки) — сразу продолжаем.
    if ((video.currentTime || 0) + 0.25 >= sec) {
      return { ok: true, target: video.currentTime || sec };
    }

    const thumb = lastFrameImage ? await makeThumbnail(lastFrameImage) : null;
    while (autoAnalyze && isAnalyzeContext() && location.href === pageUrl) {
      const current = findPlayerVideo();
      if (!current) return { ok: false, reason: "плеер пропал" };

      const now = current.currentTime || 0;
      const length = Number(current.duration);
      if (Number.isFinite(length) && length > 0 && sec >= length - 0.5) {
        return {
          ok: false,
          reason: `ролик короче ${formatTime(sec)} (длина ${formatTime(length)})`,
        };
      }

      if (now + 0.25 >= sec) {
        await sleep(300);
        return { ok: true, target: current.currentTime || now };
      }

      const left = Math.max(0, Math.ceil(sec - now));
      showOverlay(
        `Ожидание — ${passLabel()}`,
        `В начале зеркалирование не найдено.\nЖду ${formatTime(sec)} без перемотки.\nСейчас: ${formatTime(now)} · осталось ~${formatTime(left)}${current.paused ? "\nВидео на паузе — продолжите воспроизведение." : ""}`,
        { thumbnail: thumb }
      );
      await sleep(1000);
    }

    return { ok: false, reason: "ожидание прервано" };
  }

  async function finalizeNoFlip(report, { confirmedWithText = true } = {}) {
    autoDecided = true;
    analyzing = false;
    await clearEnabledFlip();
    await clearDecisionInfo();
    const doneReport = {
      ...report,
      note: confirmedWithText
        ? `Решение: зеркалирование не нужно — текст распознан нормально, без отражения.`
        : `Не удалось определить зеркальность: в кадрах не было уверенно распознанного текста. Анализ остановлен до смены URL.`,
    };
    const snap = await persistAnalysisSnapshot("Результат анализа", doneReport, { flipped: false });
    resyncAll();
    showOverlay("Результат анализа", techBody(doneReport), {
      hideAfterMs: 12000,
      thumbnail: snap.thumbnail,
    });
  }

  async function startNextPassOrFinish(report, { reason = "no-flip" } = {}) {
    while (analysisPass < RETRY_SEEK_SEC.length) {
      const nextMark = RETRY_SEEK_SEC[analysisPass];
      analysisPass += 1;
      const waitNote =
        reason === "no-text"
          ? `На этом участке нет распознанного текста — зеркальность неизвестна.\nЖду отметку ${formatTime(nextMark)} без перемотки…`
          : `Текст читается без зеркала — на этом участке flip не нужен.\nДля проверки позже жду ${formatTime(nextMark)}…`;
      showOverlay(`Повторный анализ — ${passLabel()}`, waitNote, {
        thumbnail: lastFrameImage ? await makeThumbnail(lastFrameImage) : null,
      });

      const waitResult = await waitUntilVideoTime(nextMark);
      if (!waitResult.ok) {
        if (waitResult.reason === "ожидание прервано") {
          autoDecided = true;
          autoFlip = false;
          analyzing = false;
          return "done";
        }
        showOverlay(
          `Пропуск ${passLabel()}`,
          `${waitResult.reason}.\nПробую следующий участок…`
        );
        await sleep(800);
        continue;
      }

      autoDecided = false;
      autoFlip = false;
      analyzing = false;
      resetPassCounters();
      const note = `Видео дошло до ${formatTime(waitResult.target)}. Начинаю повторный OCR.`;
      await persistAnalysisSnapshot(`Автоанализ — ${passLabel()}`, {
        samples: 0,
        normalSum: 0,
        flippedSum: 0,
        note,
      });
      showOverlay(`Автоанализ — ${passLabel()}`, note);
      return "retry";
    }

    await finalizeNoFlip(report, { confirmedWithText: reason !== "no-text" });
    return "done";
  }

  async function decide(needFlip, report) {
    analyzing = false;

    if (needFlip) {
      // Защита: если текст уже читается нормально — не зеркалируем.
      if (hasNormalTextEvidence() && normalSum >= flippedSum) {
        needFlip = false;
        report = {
          ...report,
          note: "Текст читается нормально — зеркалирование не включаю.",
        };
      }
    }

    if (needFlip) {
      autoDecided = true;
      autoFlip = true;
      enabled = true;
      await chrome.storage.local.set({ enabled: true });
      const thumb = lastFrameImage ? await makeThumbnail(lastFrameImage) : null;
      await saveDecisionInfo({
        flippedAtSec: lastFrameTimeSec,
        thumbnail: thumb,
        flipped: true,
      });
      const body = `${passLabel()}\nСекунда: ${formatTime(lastFrameTimeSec)}\nКадров: ${samples}\nСчёт обычный: ${normalSum}\nСчёт отражённый: ${flippedSum}\nПричина: текст был зеркальным`;
      await persistAnalysisSnapshot("приложение chrome зеркалировало видео", {
        ...report,
        samples,
        normalSum,
        flippedSum,
        note: body,
      }, { flipped: true });
      resyncAll();
      showOverlay("приложение chrome зеркалировало видео", body, {
        success: true,
        hideAfterMs: FLIPPED_BANNER_MS,
        thumbnail: thumb,
      });
      // Логирование — самым последним шагом; любые ошибки глотаем.
      try {
        chrome.runtime
          .sendMessage({
            type: "analytics-mirrored",
            url: location.href,
            timeSec: lastFrameTimeSec,
            timeLabel: formatTime(lastFrameTimeSec),
            pass: analysisPass,
            normalSum,
            flippedSum,
            samples,
          })
          .catch(() => {});
      } catch (_) {}
      return "done";
    }

    // «Не нужно зеркало» — только если на обычном кадре реально был текст.
    if (!hasNormalTextEvidence()) {
      return startNextPassOrFinish(
        {
          ...report,
          note: "Нет уверенно распознанного текста на обычном кадре — решение «без зеркала» не принимаю.",
        },
        { reason: "no-text" }
      );
    }

    await clearEnabledFlip();
    resyncAll();
    return startNextPassOrFinish(
      {
        ...report,
        note: report.note || "Текст распознан нормально — зеркалирование не нужно.",
      },
      { reason: "no-flip" }
    );
  }

  async function analyzeOneFrame() {
    const video = findPlayerVideo();
    if (!video || video.readyState < 2 || !video.videoWidth) {
      showOverlay(
        "Автоанализ кадра…",
        techBody({
          samples,
          normalSum,
          flippedSum,
          note: "Жду готовый кадр плеера…",
        })
      );
      return false;
    }

    analyzing = true;
    showOverlay(
      `Автоанализ — ${passLabel()}`,
      techBody({
        samples,
        normalSum,
        flippedSum,
        note: "Снимаю кадр и отправляю в OCR…",
      })
    );

    let image;
    try {
      lastFrameTimeSec = video.currentTime || 0;
      image = grabFrame(video);
      lastFrameImage = image;
    } catch (error) {
      lastReport = {
        samples,
        normalSum,
        flippedSum,
        error: `canvas: ${error && error.message ? error.message : error}`,
        note: "Кадр недоступен (возможно CORS). Анализ остановлен.",
      };
      showOverlay("Результат анализа", techBody(lastReport), { hideAfterMs: 12000 });
      autoDecided = true;
      autoFlip = false;
      analyzing = false;
      return true;
    }

    const result = await chrome.runtime.sendMessage({ type: "ocr", image });
    if (!result || result.error) {
      lastReport = {
        samples,
        normalSum,
        flippedSum,
        durationMs: result && result.durationMs,
        error: (result && result.error) || "пустой ответ OCR",
        note: "Повторю на следующем кадре.",
      };
      showOverlay("Автоанализ кадра…", techBody(lastReport));
      analyzing = false;
      return false;
    }

    const normalScore = result.normal?.score || 0;
    const flippedScore = result.flipped?.score || 0;
    normalSum += normalScore;
    flippedSum += flippedScore;
    samples += 1;
    if (sideHasText(result.normal)) normalTextFrames += 1;
    if (sideHasText(result.flipped)) flippedTextFrames += 1;

    const noTextYet = !hasNormalTextEvidence() && !hasFlippedTextEvidence();
    lastReport = {
      samples,
      durationMs: result.durationMs,
      normalScore,
      flippedScore,
      normalSum,
      flippedSum,
      normal: result.normal,
      flipped: result.flipped,
      note: noTextYet
        ? "В кадре нет уверенного текста (только картинка?) — зеркальность пока неизвестна."
        : "Жду следующий кадр…",
    };
    const snap = await persistAnalysisSnapshot(`Автоанализ — ${passLabel()}`, lastReport);
    showOverlay(`Автоанализ — ${passLabel()}`, techBody(lastReport), { thumbnail: snap.thumbnail });

    const verdict = verdictFromScores();
    if (verdict === "flip") {
      await decide(true, {
        ...lastReport,
        note: "Текст читается только/лучше после отражения кадра → в ролике он зеркальный.",
      });
      return true;
    }
    if (verdict === "no-flip") {
      await decide(false, {
        ...lastReport,
        note: "Текст распознан нормально → зеркалирование не нужно.",
      });
      return true;
    }

    if (samples >= MAX_SAMPLES) {
      const soft = verdictFromScores({ soft: true });
      if (soft === "flip") {
        await decide(true, {
          ...lastReport,
          note: "Лимит кадров: текст лучше на отражённом кадре → включаю зеркалирование.",
        });
        return true;
      }
      if (soft === "no-flip") {
        await decide(false, {
          ...lastReport,
          note: "Лимит кадров: текст распознан нормально → зеркалирование не нужно.",
        });
        return true;
      }
      await startNextPassOrFinish(
        {
          ...lastReport,
          note: "Лимит кадров без уверенного текста — зеркальность на этом участке неизвестна.",
        },
        { reason: "no-text" }
      );
      return true;
    }

    analyzing = false;
    return false;
  }

  async function analyzeLoop() {
    if (analyzeLoopActive) return;
    analyzeLoopActive = true;
    try {
      while (autoAnalyze && isAnalyzeContext() && !autoDecided) {
        await analyzeOneFrame();
        if (autoDecided || !autoAnalyze || !isAnalyzeContext()) break;
        await sleep(CAPTURE_GAP_MS);
      }
    } finally {
      analyzeLoopActive = false;
      analyzing = false;
    }
  }

  function startAutoIfNeeded() {
    if (!autoAnalyze || !isAnalyzeContext() || autoDecided) return;
    chrome.runtime.sendMessage({ type: "ensure-offscreen" }).catch(() => {});
    showOverlay(
      `Автоанализ — ${passLabel()}`,
      techBody({
        samples,
        normalSum,
        flippedSum,
        note: isTopFrame()
          ? "Автоанализ включён. Сначала проверяю начало ролика…"
          : "Автоанализ встройки (Яндекс/iframe). Сначала проверяю начало ролика…",
      })
    );
    analyzeLoop();
  }

  document.addEventListener(
    "vkflip-shadow-open",
    (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const host = path[0] || event.target;
      if (host && host.shadowRoot) watchRoot(host.shadowRoot);
    },
    true
  );

  chrome.storage.local.get({ enabled: false, autoAnalyze: false }, (items) => {
    enabled = items.enabled === true;
    autoAnalyze = items.autoAnalyze === true;
    ready = true;
    fullScan();
    startAutoIfNeeded();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let needResync = false;

    if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
      enabled = changes.enabled.newValue === true;
      needResync = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "autoAnalyze")) {
      autoAnalyze = changes.autoAnalyze.newValue === true;
      if (autoAnalyze) {
        resetAutoState();
        startAutoIfNeeded();
      } else {
        resetAutoState();
      }
      needResync = true;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "showAnalysisRequest") && canShowOverlay()) {
      chrome.storage.local.get({ analysisSnapshot: null }, (items) => {
        // В iframe показываем только если это контекст анализа; на Яндексе — в top-frame.
        if (isAnalyzeContext() || isTopFrame()) {
          showAnalysisWindowFromSnapshot(items.analysisSnapshot);
        }
      });
    }

    if (needResync) {
      ready = true;
      resyncAll();
    }
  });

  fullScan();
  [1000, 3000, 8000, 20000].forEach((delay) => setTimeout(fullScan, delay));

  setInterval(() => {
    onUrlMaybeChanged().catch(() => {});
  }, 1000);
  setInterval(() => {
    if (autoAnalyze && isAnalyzeContext() && !autoDecided && !analyzeLoopActive) {
      startAutoIfNeeded();
    }
    if (canShowOverlay()) updateCornerBadge();
  }, 2000);
})();
