function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) {
    return "--:--";
  }

  const safeTotalSeconds = Math.max(0, Math.floor(totalSeconds));

  const seconds = safeTotalSeconds % 60;
  const minutes = Math.floor((safeTotalSeconds / 60) % 60);
  const hours = Math.floor(safeTotalSeconds / 3600);

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncate(text, maxLength = 60) {
  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function safeLinkText(text) {
  return String(text || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f").replace(/\[/g, "(").replace(/\]/g, ")");
}

function progressBar(elapsedMs, totalMs, size = 14) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    const safeSize = Math.max(2, Number(size) || 14);
    return `o${"-".repeat(safeSize - 1)}`;
  }

  const ratio = Math.max(0, Math.min(1, elapsedMs / totalMs));
  const markerIndex = Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  const bar = Array.from({ length: size }, (_, index) => {
    if (index === markerIndex) {
      return "o";
    }

    return index < markerIndex ? "=" : "-";
  });

  return bar.join("");
}

function loopLabel(mode) {
  if (mode === "track") {
    return "\u0422\u0440\u0435\u043a";
  }

  if (mode === "queue") {
    return "\u041e\u0447\u0435\u0440\u0435\u0434\u044c";
  }

  return "\u0412\u044b\u043a\u043b";
}

module.exports = {
  formatDuration,
  truncate,
  safeLinkText,
  progressBar,
  loopLabel,
};

