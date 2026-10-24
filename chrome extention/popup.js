const toggle = document.querySelector("#toggle");
const state = document.querySelector("#state");
const autoToggle = document.querySelector("#auto-toggle");
const autoState = document.querySelector("#auto-state");
const showAnalysis = document.querySelector("#show-analysis");
const shortcut = document.querySelector("#shortcut");
const decisionBox = document.querySelector("#decision");
const decisionTime = document.querySelector("#decision-time");
const decisionThumb = document.querySelector("#decision-thumb");

const BADGE = {
  on: { text: "ВКЛ", color: "#0077FF", title: "VKVideo flipper: отражение включено" },
  off: { text: "ВЫКЛ", color: "#5C6570", title: "VKVideo flipper: отражение выключено" },
};

function isOn(value) {
  return value === true;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return String(url || "").split("?")[0].split("#")[0];
  }
}

function renderEnabled(enabled) {
  const on = isOn(enabled);
  toggle.classList.toggle("is-on", on);
  toggle.setAttribute("aria-checked", on ? "true" : "false");
  state.textContent = on ? "Отражение включено" : "Отражение выключено";
  const badge = on ? BADGE.on : BADGE.off;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setTitle({ title: badge.title });
}

function renderAuto(autoAnalyze) {
  const on = autoAnalyze === true;
  autoToggle.classList.toggle("is-on", on);
  autoToggle.setAttribute("aria-checked", on ? "true" : "false");
  autoState.textContent = on ? "Автоанализ включён" : "Автоанализ выключен";
}

function hideDecision() {
  decisionBox.hidden = true;
  decisionThumb.hidden = true;
  decisionThumb.removeAttribute("src");
}

function renderDecision(info, activeTabUrl) {
  if (!info || !info.flipped) {
    hideDecision();
    return;
  }
  if (activeTabUrl && info.url && normalizeUrl(info.url) !== normalizeUrl(activeTabUrl)) {
    hideDecision();
    return;
  }
  decisionBox.hidden = false;
  decisionTime.textContent = `На секунде ${info.timeLabel || "0:00"} видео было зеркалировано`;
  if (info.thumbnail) {
    decisionThumb.src = info.thumbnail;
    decisionThumb.hidden = false;
  } else {
    decisionThumb.hidden = true;
    decisionThumb.removeAttribute("src");
  }
}

function shortcutLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  if (/mac/i.test(platform)) return "<kbd>⌥</kbd><kbd>⇧</kbd><kbd>F</kbd>";
  return "<kbd>Alt</kbd><kbd>Shift</kbd><kbd>F</kbd>";
}

shortcut.innerHTML = `Переключить отражение: ${shortcutLabel()}. Сочетание меняется в chrome://extensions/shortcuts`;

function refreshFromStorage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabUrl = tabs[0] && tabs[0].url;
    chrome.storage.local.get({ enabled: false, autoAnalyze: false, decisionInfo: null }, (items) => {
      renderEnabled(items.enabled);
      renderAuto(items.autoAnalyze);
      renderDecision(items.decisionInfo, tabUrl);
    });
  });
}

refreshFromStorage();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
    renderEnabled(changes.enabled.newValue);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "autoAnalyze")) {
    renderAuto(changes.autoAnalyze.newValue);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "decisionInfo")) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      renderDecision(changes.decisionInfo.newValue, tabs[0] && tabs[0].url);
    });
  }
});

async function toggleEnabled() {
  const items = await chrome.storage.local.get({ enabled: false });
  const next = !isOn(items.enabled);
  renderEnabled(next);
  await chrome.storage.local.set({ enabled: next });
}

async function toggleAuto() {
  const items = await chrome.storage.local.get({ autoAnalyze: false });
  const next = items.autoAnalyze !== true;
  renderAuto(next);
  await chrome.storage.local.set({ autoAnalyze: next });
}

async function requestAnalysisWindow() {
  await chrome.storage.local.set({ showAnalysisRequest: Date.now() });
  showAnalysis.textContent = "Окно анализа открыто";
  setTimeout(() => {
    showAnalysis.textContent = "Показать окно анализа";
  }, 1500);
}

toggle.addEventListener("click", toggleEnabled);
autoToggle.addEventListener("click", toggleAuto);
showAnalysis.addEventListener("click", requestAnalysisWindow);

document.querySelector('[data-key="enabled"]').addEventListener("click", (event) => {
  if (event.target.closest("#toggle")) return;
  toggleEnabled();
});

document.querySelector('[data-key="autoAnalyze"]').addEventListener("click", (event) => {
  if (event.target.closest("#auto-toggle")) return;
  toggleAuto();
});
