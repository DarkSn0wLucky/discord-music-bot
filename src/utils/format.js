function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "LIVE";
  }

  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncate(text, maxLength = 60) {
  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeLinkText(text) {
  return String(text || "Без названия").replace(/\[/g, "(").replace(/\]/g, ")");
}

function progressBar(elapsedMs, totalMs, size = 14) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return "● LIVE";
  }

  const ratio = Math.max(0, Math.min(1, elapsedMs / totalMs));
  const markerIndex = Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  const bar = Array.from({ length: size }, (_, index) => {
    if (index === markerIndex) {
      return "●";
    }

    return index < markerIndex ? "━" : "─";
  });

  return bar.join("");
}

function loopLabel(mode) {
  if (mode === "track") {
    return "Трек";
  }

  if (mode === "queue") {
    return "Очередь";
  }

  return "Выкл";
}

module.exports = {
  formatDuration,
  truncate,
  safeLinkText,
  progressBar,
  loopLabel,
};

