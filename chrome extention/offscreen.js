let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(["rus", "eng"], 1, {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
      corePath: chrome.runtime.getURL("lib/"),
      langPath: chrome.runtime.getURL("lang"),
      workerBlobURL: false,
      gzip: false,
      logger: () => {},
    });
  }
  return workerPromise;
}

function analyze(data) {
  const words = [];
  let score = 0;
  for (const word of data.words || []) {
    const text = String(word.text || "").replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    const confidence = Number(word.confidence) || 0;
    if (text.length < 3 || confidence <= 60) continue;
    score += confidence * Math.min(text.length, 8);
    words.push({ text, confidence: Math.round(confidence) });
  }
  words.sort((a, b) => b.confidence - a.confidence);
  return {
    score: Math.round(score),
    words: words.slice(0, 12),
    text: String(data.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180),
  };
}

async function flipDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.translate(bitmap.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const flipped = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return URL.createObjectURL(flipped);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen" || msg.type !== "ocr") return false;

  (async () => {
    const started = Date.now();
    const worker = await getWorker();
    const flippedUrl = await flipDataUrl(msg.image);
    try {
      const normalResult = await worker.recognize(msg.image);
      const flippedResult = await worker.recognize(flippedUrl);
      const normal = analyze(normalResult.data);
      const flipped = analyze(flippedResult.data);
      sendResponse({
        normal,
        flipped,
        durationMs: Date.now() - started,
      });
    } finally {
      URL.revokeObjectURL(flippedUrl);
    }
  })().catch((error) => {
    sendResponse({ error: String(error && error.message ? error.message : error) });
  });

  return true;
});
