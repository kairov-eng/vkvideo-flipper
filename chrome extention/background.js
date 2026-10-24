const BADGE = {
  on: { text: "ВКЛ", color: "#0077FF" },
  off: { text: "ВЫКЛ", color: "#5C6570" },
};

const POSTHOG = {
  // Проект на us.posthog.com — события должны идти на US ingest.
  host: "https://us.i.posthog.com",
  apiKey: "phc_wqPn7sJntd7fuwzrvCYkvkxmxGoi5iN7C7ehP75UieiE",
  event: "video_mirrored",
};

async function getAnalyticsDistinctId() {
  const items = await chrome.storage.local.get({ analyticsDistinctId: null });
  if (items.analyticsDistinctId) return items.analyticsDistinctId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ analyticsDistinctId: id });
  return id;
}

async function trackVideoMirrored(properties = {}) {
  try {
    const distinct_id = await getAnalyticsDistinctId();
    const version = chrome.runtime.getManifest().version;
    await fetch(`${POSTHOG.host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG.apiKey,
        event: POSTHOG.event,
        distinct_id,
        properties: {
          ...properties,
          extension_version: version,
          $lib: "vkvideo-flipper-extension",
        },
      }),
    });
  } catch (_) {
    // Ошибки аналитики игнорируем.
  }
}

async function isEnabled() {
  const items = await chrome.storage.local.get({ enabled: false });
  return items.enabled === true;
}

async function setBadge(enabled) {
  const state = enabled ? BADGE.on : BADGE.off;
  await chrome.action.setBadgeBackgroundColor({ color: state.color });
  await chrome.action.setBadgeText({ text: state.text });
  await chrome.action.setTitle({
    title: enabled ? "Отражение видео включено" : "Отражение видео выключено",
  });
}

async function ensureDefault() {
  const items = await chrome.storage.local.get(["enabled", "autoAnalyze"]);
  const patch = {};
  if (typeof items.enabled !== "boolean") patch.enabled = false;
  if (typeof items.autoAnalyze !== "boolean") patch.autoAnalyze = false;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "OCR для определения зеркальности текста в кадре видео",
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefault();
  await setBadge(await isEnabled());
  try {
    await ensureOffscreen();
  } catch (_) {}
});

chrome.runtime.onStartup.addListener(async () => {
  await setBadge(await isEnabled());
  try {
    await ensureOffscreen();
  } catch (_) {}
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-flip") return;
  const enabled = !(await isEnabled());
  await chrome.storage.local.set({ enabled });
  await setBadge(enabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, "enabled")) return;
  setBadge(changes.enabled.newValue === true);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return false;

  if (msg?.type === "ocr") {
    (async () => {
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        type: "ocr",
        target: "offscreen",
        image: msg.image,
      });
      sendResponse(result);
    })().catch((error) => {
      sendResponse({ error: String(error && error.message ? error.message : error) });
    });
    return true;
  }

  if (msg?.type === "ensure-offscreen") {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  }

  if (msg?.type === "analytics-mirrored") {
    // Fire-and-forget: не ждём ответа и не пробрасываем ошибки.
    trackVideoMirrored({
      url: msg.url || "",
      time_sec: msg.timeSec,
      time_label: msg.timeLabel || "",
      analysis_pass: msg.pass,
      normal_sum: msg.normalSum,
      flipped_sum: msg.flippedSum,
      samples: msg.samples,
    }).catch(() => {});
    return false;
  }

  return false;
});
