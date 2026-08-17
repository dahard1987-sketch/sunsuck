    (() => {
      "use strict";

      const STORAGE_KEY = "canb-b5-worksheet-studio-v2";

      const SAMPLE_PASSAGE = `While I was working inside the house, a garbage truck went down our
street making great noise. The truck stopped at almost every house
to collect and crush the garbage. It was really noisy and broke my
concentration. It was now impossible for me to put up with the noise. I
walked to the window, and stared angrily at the driver of the truck.
But in the yard, my five-year-old son was excited. I watched him climb
up a tree near the street. <From there, it was easy to look inside the huge
truck.> Inside the truck, giant metal teeth chewed up the garbage. The
noise made it more exciting to him. It's a wonderful thing that five-year-olds
can enjoy life by just watching garbage trucks, and that adults can
enjoy life by just watching five-year-olds.`;

      const DEFAULTS = Object.freeze({
        passage: SAMPLE_PASSAGE,
        worksheetTitle: "X2 해석지",
        categoryLabel: "해석지 숙제",
        semesterLabel: "2026 여름학기",
        unitTitle: "Unit 1. Clauses/Phrases Used as Subjects",
        teacherName: "최영진",
        className: "",
        worksheetDate: "",
        footerText: "CANB English",
        accentColor: "#c4171d",
        spaceMode: "balanced",
        fontSize: "standard",
        guideStyle: "subtle",
        showNumbers: true,
        showFooter: true,
        showAnswerHint: false
      });

      const FONT_SIZES = {
        compact: 10.7,
        standard: 11.6,
        large: 12.6
      };

      const SPACE_PROFILES = {
        compact: { base: 9.5, word: 0.31, line: 1.5, cap: 25 },
        balanced: { base: 11.5, word: 0.47, line: 2.2, cap: 32 },
        generous: { base: 13.5, word: 0.62, line: 2.8, cap: 39 }
      };

      const FIT_LEVELS = [
        { name: "normal", fontScale: 1, minAnswerMm: 9.5, leading: 1.42 },
        { name: "adjusted", fontScale: 0.91, minAnswerMm: 6.5, leading: 1.35 },
        { name: "compressed", fontScale: 0.82, minAnswerMm: 3.8, leading: 1.28 }
      ];

      const form = document.getElementById("worksheetForm");
      const pages = document.getElementById("pages");
      const previewWorkspace = document.getElementById("previewWorkspace");
      const previewMeta = document.getElementById("previewMeta");
      const sentenceCount = document.getElementById("sentenceCount");
      const liveSummary = document.getElementById("liveSummary");
      const summaryText = document.getElementById("summaryText");
      const summaryCount = document.getElementById("summaryCount");
      const accentColorValue = document.getElementById("accentColorValue");
      const passageInput = document.getElementById("passage");
      const formatButtons = document.querySelectorAll("[data-wrap-prefix]");
      const refreshButton = document.getElementById("refreshButton");
      const printButton = document.getElementById("printButton");
      const downloadPdfButton = document.getElementById("downloadPdfButton");
      const resetButton = document.getElementById("resetButton");
      const librarySelect = document.getElementById("worksheetLibrarySelect");
      const librarySaveButton = document.getElementById("librarySaveButton");
      const libraryLoadButton = document.getElementById("libraryLoadButton");
      const libraryDeleteButton = document.getElementById("libraryDeleteButton");
      const pdfDropZone = document.getElementById("pdfDropZone");
      const pdfFileInput = document.getElementById("pdfFileInput");
      const pdfOptimizerStatus = document.getElementById("pdfOptimizerStatus");
      const optimizedDownloadButton = document.getElementById("optimizedDownloadButton");
      const pdfDiagnostics = document.getElementById("pdfDiagnostics");

      let renderTimer = 0;
      let resizeTimer = 0;
      let renderVersion = 0;
      let millimeterInPixels = 96 / 25.4;
      let currentLayout = null;
      let optimizedPdf = null;

      function normalizePassage(text) {
        return String(text ?? "")
          .replace(/\r\n?/g, "\n")
          .replace(/\s+/g, " ")
          .trim();
      }

      function isMeaningfulSentence(text) {
        return /[\p{L}\p{N}]/u.test(text);
      }

      function fallbackSentenceSplit(text) {
        const protectedText = text
          .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\./gi, "$1\u0001")
          .replace(/\b(e\.g|i\.e|etc)\./gi, match => match.replace(/\./g, "\u0001"));

        return (protectedText.match(/.+?(?:[.!?]+(?:["'’”)\]}>*_]+)?(?=\s+|$)|$)/g) || [])
          .map(part => part.replace(/\u0001/g, ".").trim())
          .filter(isMeaningfulSentence);
      }

      function splitPlainSentences(text) {
        const plain = text.trim();
        if (!plain) return [];

        if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
          try {
            const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
            return Array.from(segmenter.segment(plain), item => item.segment.trim())
              .filter(isMeaningfulSentence);
          } catch (error) {
            return fallbackSentenceSplit(plain);
          }
        }

        return fallbackSentenceSplit(plain);
      }

      function splitIntoSentences(text) {
        const normalized = normalizePassage(text);
        if (!normalized) return [];

        const sentences = [];
        const bracketGroupPattern = /<[^<>]*>/g;
        let cursor = 0;
        let match;

        while ((match = bracketGroupPattern.exec(normalized)) !== null) {
          sentences.push(...splitPlainSentences(normalized.slice(cursor, match.index)));

          const mergedGroup = match[0].replace(/\s+/g, " ").trim();
          if (isMeaningfulSentence(mergedGroup)) sentences.push(mergedGroup);
          cursor = match.index + match[0].length;
        }

        sentences.push(...splitPlainSentences(normalized.slice(cursor)));
        return sentences;
      }

      function stripMergeMarkers(text) {
        const sentence = String(text ?? "").trim();
        return sentence.startsWith("<") && sentence.endsWith(">")
          ? sentence.slice(1, -1).trim()
          : sentence;
      }

      function safeString(value, fallback = "") {
        return typeof value === "string" ? value : fallback;
      }

      function validChoice(value, options, fallback) {
        return options.includes(value) ? value : fallback;
      }

      function normalizeHexColor(value, fallback = DEFAULTS.accentColor) {
        return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : fallback;
      }

      function hexToRgb(hex) {
        const value = normalizeHexColor(hex).slice(1);
        return {
          r: parseInt(value.slice(0, 2), 16),
          g: parseInt(value.slice(2, 4), 16),
          b: parseInt(value.slice(4, 6), 16)
        };
      }

      function rgbToHex({ r, g, b }) {
        return `#${[r, g, b]
          .map(value => Math.round(value).toString(16).padStart(2, "0"))
          .join("")}`;
      }

      function mixColor(source, target, amount) {
        return rgbToHex({
          r: source.r + (target.r - source.r) * amount,
          g: source.g + (target.g - source.g) * amount,
          b: source.b + (target.b - source.b) * amount
        });
      }

      function applyAccentColor(value) {
        const color = normalizeHexColor(value);
        const rgb = hexToRgb(color);
        const luminance = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
        const root = document.documentElement;

        root.style.setProperty("--accent", color);
        root.style.setProperty("--accent-dark", mixColor(rgb, { r: 0, g: 0, b: 0 }, 0.25));
        root.style.setProperty("--accent-soft", mixColor(rgb, { r: 255, g: 255, b: 255 }, 0.9));
        root.style.setProperty("--accent-faint", mixColor(rgb, { r: 255, g: 255, b: 255 }, 0.955));
        root.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        root.style.setProperty("--accent-contrast", luminance > 168 ? "#15171b" : "#ffffff");
        accentColorValue.value = color.toUpperCase();
        accentColorValue.textContent = color.toUpperCase();
      }

      function sanitizeSettings(input = {}) {
        return {
          passage: safeString(input.passage, DEFAULTS.passage),
          worksheetTitle: safeString(input.worksheetTitle, DEFAULTS.worksheetTitle),
          categoryLabel: safeString(input.categoryLabel, DEFAULTS.categoryLabel),
          semesterLabel: safeString(input.semesterLabel, DEFAULTS.semesterLabel),
          unitTitle: safeString(input.unitTitle, DEFAULTS.unitTitle),
          teacherName: safeString(input.teacherName, DEFAULTS.teacherName),
          className: safeString(input.className),
          worksheetDate: safeString(input.worksheetDate),
          footerText: safeString(input.footerText, DEFAULTS.footerText),
          accentColor: normalizeHexColor(input.accentColor),
          spaceMode: validChoice(input.spaceMode, Object.keys(SPACE_PROFILES), DEFAULTS.spaceMode),
          fontSize: validChoice(input.fontSize, Object.keys(FONT_SIZES), DEFAULTS.fontSize),
          guideStyle: validChoice(input.guideStyle, ["subtle", "boundary"], DEFAULTS.guideStyle),
          showNumbers: typeof input.showNumbers === "boolean" ? input.showNumbers : DEFAULTS.showNumbers,
          showFooter: typeof input.showFooter === "boolean" ? input.showFooter : DEFAULTS.showFooter,
          showAnswerHint: typeof input.showAnswerHint === "boolean" ? input.showAnswerHint : DEFAULTS.showAnswerHint
        };
      }

      function setFormValue(name, value) {
        const control = form.elements[name];
        if (!control) return;

        if (control instanceof RadioNodeList) {
          control.value = String(value);
        } else if (control.type === "checkbox") {
          control.checked = Boolean(value);
        } else {
          control.value = String(value ?? "");
        }
      }

      function applySettingsToForm(settings) {
        Object.entries(settings).forEach(([name, value]) => setFormValue(name, value));
      }

      function readSettings() {
        const data = new FormData(form);
        return sanitizeSettings({
          passage: data.get("passage"),
          worksheetTitle: data.get("worksheetTitle"),
          categoryLabel: data.get("categoryLabel"),
          semesterLabel: data.get("semesterLabel"),
          unitTitle: data.get("unitTitle"),
          teacherName: data.get("teacherName"),
          className: data.get("className"),
          worksheetDate: data.get("worksheetDate"),
          footerText: data.get("footerText"),
          accentColor: data.get("accentColor"),
          spaceMode: data.get("spaceMode"),
          fontSize: data.get("fontSize"),
          guideStyle: data.get("guideStyle"),
          showNumbers: form.elements.showNumbers.checked,
          showFooter: form.elements.showFooter.checked,
          showAnswerHint: form.elements.showAnswerHint.checked
        });
      }

      function saveSettings(settings = readSettings()) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (error) {
          // Private browsing can disable storage; rendering remains available.
        }
      }

      function loadSettings() {
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          return saved ? sanitizeSettings(JSON.parse(saved)) : { ...DEFAULTS };
        } catch (error) {
          return { ...DEFAULTS };
        }
      }

      const LIBRARY_KEY = "canb-b5-worksheet-studio-library-v1";

      function createLibraryId() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
        return `worksheet-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }

      function loadLibrary() {
        try {
          const saved = localStorage.getItem(LIBRARY_KEY);
          const parsed = saved ? JSON.parse(saved) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
          return [];
        }
      }

      function persistLibrary(list) {
        try {
          localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
        } catch (error) {
          // Private browsing can disable storage; the in-memory list still renders.
        }
      }

      function saveToLibrary(id, name, settings) {
        const list = loadLibrary();
        const entry = { id, name, updatedAt: new Date().toISOString(), settings };
        const index = list.findIndex(item => item.id === id);
        if (index === -1) list.unshift(entry);
        else list[index] = entry;
        persistLibrary(list);
        return list;
      }

      function deleteFromLibrary(id) {
        const list = loadLibrary().filter(item => item.id !== id);
        persistLibrary(list);
        return list;
      }

      function formatLibraryTimestamp(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return "";
        const pad = value => String(value).padStart(2, "0");
        return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
      }

      function renderLibrarySelect(list, selectedId) {
        libraryLoadButton.disabled = true;
        libraryDeleteButton.disabled = true;
        if (!list.length) {
          librarySelect.replaceChildren(new Option("저장된 학습지 없음", ""));
          librarySelect.value = "";
          return;
        }
        const options = list
          .slice()
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .map(entry => new Option(`${entry.name} · ${formatLibraryTimestamp(entry.updatedAt)}`, entry.id));
        librarySelect.replaceChildren(...options);
        librarySelect.value = list.some(entry => entry.id === selectedId) ? selectedId : "";
        const hasSelection = Boolean(librarySelect.value);
        libraryLoadButton.disabled = !hasSelection;
        libraryDeleteButton.disabled = !hasSelection;
      }

      function saveCurrentToLibrary() {
        const list = loadLibrary();
        const selectedId = librarySelect.value;
        const existing = list.find(entry => entry.id === selectedId);
        const suggestedName = (existing && existing.name) || readSettings().worksheetTitle || "새 학습지";
        const input = window.prompt("학습지 이름을 입력하세요.", suggestedName);
        if (input === null) return;
        const name = input.trim();
        if (!name) {
          window.alert("이름을 입력해야 저장할 수 있습니다.");
          return;
        }
        const id = existing ? existing.id : createLibraryId();
        const updated = saveToLibrary(id, name, readSettings());
        renderLibrarySelect(updated, id);
      }

      function loadSelectedFromLibrary() {
        const selectedId = librarySelect.value;
        if (!selectedId) return;
        const entry = loadLibrary().find(item => item.id === selectedId);
        if (!entry) return;
        applySettingsToForm(entry.settings);
        saveSettings(entry.settings);
        renderWorksheet();
      }

      function deleteSelectedFromLibrary() {
        const selectedId = librarySelect.value;
        if (!selectedId) return;
        const entry = loadLibrary().find(item => item.id === selectedId);
        if (!entry) return;
        if (!window.confirm(`"${entry.name}"을(를) 삭제할까요?`)) return;
        const updated = deleteFromLibrary(selectedId);
        renderLibrarySelect(updated);
      }

      function appendText(parent, tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
      }

      const MARKUP_RULES = [
        { delimiter: "**", tag: "strong" },
        { delimiter: "__", tag: "u" },
        { delimiter: "*", tag: "em" }
      ];

      function findDelimiter(text, delimiter, fromIndex) {
        let index = text.indexOf(delimiter, fromIndex);

        while (index !== -1 && delimiter === "*") {
          const touchesAnotherAsterisk =
            text[index - 1] === "*" || text[index + 1] === "*";
          if (!touchesAnotherAsterisk) break;
          index = text.indexOf(delimiter, index + 1);
        }

        return index;
      }

      function findNextMarkup(text, fromIndex) {
        let next = null;

        MARKUP_RULES.forEach(rule => {
          const start = findDelimiter(text, rule.delimiter, fromIndex);
          if (start === -1) return;

          const contentStart = start + rule.delimiter.length;
          const end = findDelimiter(text, rule.delimiter, contentStart);
          if (end <= contentStart) return;

          if (
            !next ||
            start < next.start ||
            (start === next.start && rule.delimiter.length > next.rule.delimiter.length)
          ) {
            next = { rule, start, contentStart, end };
          }
        });

        return next;
      }

      function appendFormattedText(parent, source) {
        const text = String(source ?? "");
        let cursor = 0;

        while (cursor < text.length) {
          const token = findNextMarkup(text, cursor);
          if (!token) {
            parent.appendChild(document.createTextNode(text.slice(cursor)));
            break;
          }

          if (token.start > cursor) {
            parent.appendChild(document.createTextNode(text.slice(cursor, token.start)));
          }

          const element = document.createElement(token.rule.tag);
          appendFormattedText(element, text.slice(token.contentStart, token.end));
          parent.appendChild(element);
          cursor = token.end + token.rule.delimiter.length;
        }
      }

      function createFirstHeader(settings) {
        const header = document.createElement("header");
        header.className = "sheet-header";

        const grid = document.createElement("div");
        grid.className = "header-grid";

        const left = document.createElement("div");
        left.className = "header-left";
        appendText(left, "div", "category", settings.categoryLabel);
        appendText(left, "div", "semester", settings.semesterLabel);

        const titleWrap = document.createElement("div");
        titleWrap.className = "header-title-wrap";
        appendText(titleWrap, "h2", "sheet-title", settings.worksheetTitle);

        const identity = document.createElement("div");
        identity.className = "identity";

        const nameLine = document.createElement("div");
        nameLine.className = "identity-line";
        appendText(nameLine, "span", "", "Name:");
        appendText(nameLine, "span", "identity-value", "");

        const teacherLine = document.createElement("div");
        teacherLine.className = "identity-line";
        appendText(teacherLine, "span", "", "Teacher:");
        appendText(teacherLine, "span", "identity-value", settings.teacherName);
        identity.append(nameLine, teacherLine);

        if (settings.className || settings.worksheetDate) {
          const meta = document.createElement("div");
          meta.className = "identity-meta";
          if (settings.className) appendText(meta, "span", "", `Class · ${settings.className}`);
          if (settings.worksheetDate) appendText(meta, "span", "", `Date · ${settings.worksheetDate}`);
          identity.appendChild(meta);
        }

        grid.append(left, titleWrap, identity);

        const strip = document.createElement("div");
        strip.className = "unit-strip";
        appendText(strip, "span", "unit-title", settings.unitTitle);

        header.append(grid, strip);
        return header;
      }

      function createContinuationHeader(settings, pageNumber) {
        const header = document.createElement("header");
        header.className = "continuation-header";

        const copy = document.createElement("div");
        copy.className = "continuation-copy";
        appendText(copy, "div", "continuation-title", settings.worksheetTitle);
        appendText(copy, "div", "continuation-unit", settings.unitTitle);

        appendText(header, "div", "continuation-page", `${pageNumber} / 2`);
        header.insertBefore(copy, header.firstChild);
        return header;
      }

      function createFooter(settings, pageNumber, totalPages) {
        const footer = document.createElement("footer");
        footer.className = `page-footer${settings.showFooter ? "" : " hidden"}`;
        appendText(footer, "span", "footer-brand", settings.footerText);
        appendText(footer, "span", "footer-page", `${pageNumber} / ${totalPages}`);
        return footer;
      }

      function createPageShell(settings, pageNumber, totalPages) {
        const page = document.createElement("article");
        page.className = "worksheet-page";
        page.dataset.page = String(pageNumber);
        page.setAttribute("aria-label", `Worksheet page ${pageNumber}`);

        page.appendChild(pageNumber === 1
          ? createFirstHeader(settings)
          : createContinuationHeader(settings, pageNumber));

        const body = document.createElement("div");
        body.className = "page-body";
        page.appendChild(body);
        page.appendChild(createFooter(settings, pageNumber, totalPages));
        pages.appendChild(page);
        return { page, body };
      }

      function createSentenceItem(sentence, index, settings, answerHeightPx, measurement = false) {
        const item = document.createElement("section");
        item.className = `worksheet-item${measurement ? " measurement" : ""}`;
        item.setAttribute("aria-label", `Sentence ${index + 1}`);

        const row = document.createElement("div");
        row.className = `english-row${settings.showNumbers ? "" : " no-number"}`;
        if (settings.showNumbers) appendText(row, "span", "item-number", String(index + 1).padStart(2, "0"));
        const sentenceCopy = document.createElement("span");
        sentenceCopy.className = "sentence-copy";
        appendFormattedText(sentenceCopy, stripMergeMarkers(sentence));
        row.appendChild(sentenceCopy);

        const answer = document.createElement("div");
        answer.className = `answer-zone${settings.guideStyle === "subtle" ? " has-guides" : ""}`;
        answer.style.setProperty("--item-answer-height", `${Math.max(0, answerHeightPx)}px`);
        answer.setAttribute("aria-hidden", "true");
        if (settings.showAnswerHint && !measurement) appendText(answer, "span", "answer-hint", "해석");

        item.append(row, answer);
        return item;
      }

      function setFitTypography(settings, fitLevel) {
        const requested = FONT_SIZES[settings.fontSize];
        const size = Math.max(8.8, requested * fitLevel.fontScale);
        document.documentElement.style.setProperty("--english-size", `${size.toFixed(2)}pt`);
        document.documentElement.style.setProperty("--english-leading", String(fitLevel.leading));
      }

      function measureMillimeter() {
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;width:100mm;height:1px;pointer-events:none";
        document.body.appendChild(probe);
        millimeterInPixels = probe.getBoundingClientRect().width / 100;
        probe.remove();
      }

      function measureLayout(sentences, settings, fitLevel) {
        pages.replaceChildren();
        const first = createPageShell(settings, 1, 2);
        const second = createPageShell(settings, 2, 2);
        const capacities = [
          Math.max(0, first.body.clientHeight - 2),
          Math.max(0, second.body.clientHeight - 2)
        ];

        const metrics = sentences.map((sentence, index) => {
          const item = createSentenceItem(sentence, index, settings, 0, true);
          first.body.appendChild(item);
          const row = item.querySelector(".english-row");
          const copy = item.querySelector(".sentence-copy");
          const rowHeight = row.getBoundingClientRect().height;
          const copyStyle = getComputedStyle(copy);
          const lineHeight = parseFloat(copyStyle.lineHeight) || 20;
          const copyHeight = copy.getBoundingClientRect().height;
          const lineCount = Math.max(1, Math.round(copyHeight / lineHeight));
          const wordCount = (sentence.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu) || []).length;
          item.remove();
          return { sentence, index, rowHeight, lineCount, wordCount };
        });

        pages.replaceChildren();
        return { capacities, metrics, fitLevel };
      }

      function desiredAnswerPixels(metric, settings) {
        const profile = SPACE_PROFILES[settings.spaceMode];
        const mm = Math.min(
          profile.cap,
          profile.base + metric.wordCount * profile.word + Math.max(0, metric.lineCount - 1) * profile.line
        );
        return mm * millimeterInPixels;
      }

      function groupStats(metrics, indices, capacity, settings, minAnswerPx) {
        const fixed = indices.reduce((sum, index) => sum + metrics[index].rowHeight, 0);
        const available = Math.max(0, capacity - fixed - 1);
        const targets = indices.map(index => desiredAnswerPixels(metrics[index], settings));
        const minimum = minAnswerPx * indices.length;
        const targetTotal = targets.reduce((sum, value) => sum + value, 0);
        const ratio = targetTotal > 0 ? Math.min(1, available / targetTotal) : 1;
        return { indices, fixed, available, targets, minimum, targetTotal, ratio };
      }

      function distributeAnswerSpace(group, minAnswerPx) {
        const count = group.indices.length;
        if (!count) return [];

        const minimumTotal = minAnswerPx * count;
        const budget = Math.max(minimumTotal, group.available);
        const targets = group.targets.map(target => Math.max(minAnswerPx, target));
        const targetTotal = targets.reduce((sum, value) => sum + value, 0);

        let heights;
        if (budget <= targetTotal) {
          const needs = targets.map(target => Math.max(0, target - minAnswerPx));
          const needTotal = needs.reduce((sum, value) => sum + value, 0);
          const remainder = Math.max(0, budget - minimumTotal);
          heights = needs.map(need =>
            minAnswerPx + (needTotal ? remainder * (need / needTotal) : remainder / count)
          );
        } else {
          const maximums = targets.map(target =>
            Math.min(42 * millimeterInPixels, target * 1.36 + 4 * millimeterInPixels)
          );
          const possibleExtra = maximums.map((max, index) => Math.max(0, max - targets[index]));
          const possibleTotal = possibleExtra.reduce((sum, value) => sum + value, 0);
          const extraBudget = Math.min(budget - targetTotal, possibleTotal);
          heights = targets.map((target, index) =>
            target + (possibleTotal ? extraBudget * (possibleExtra[index] / possibleTotal) : 0)
          );
        }

        return heights.map(value => Math.max(minAnswerPx, Math.floor(value * 2) / 2));
      }

      function buildPlan(measurement, settings) {
        const { metrics, capacities, fitLevel } = measurement;
        const count = metrics.length;
        const minAnswerPx = fitLevel.minAnswerMm * millimeterInPixels;
        if (!count) return { pageGroups: [[]], fitLevel, overflow: false };

        const all = Array.from({ length: count }, (_, index) => index);
        const one = groupStats(metrics, all, capacities[0], settings, minAnswerPx);
        if (one.available >= one.targetTotal) {
          return {
            pageGroups: [{ ...one, heights: distributeAnswerSpace(one, minAnswerPx) }],
            fitLevel,
            overflow: false
          };
        }

        let best = null;
        for (let split = 1; split < count; split += 1) {
          const firstIndices = all.slice(0, split);
          const secondIndices = all.slice(split);
          const first = groupStats(metrics, firstIndices, capacities[0], settings, minAnswerPx);
          const second = groupStats(metrics, secondIndices, capacities[1], settings, minAnswerPx);

          if (first.available < first.minimum || second.available < second.minimum) continue;

          const capacityShare = capacities[0] / (capacities[0] + capacities[1]);
          const splitShare = split / count;
          const satisfaction = Math.min(first.ratio, second.ratio);
          const ratioBalance = Math.abs(first.ratio - second.ratio);
          const splitBalance = Math.abs(splitShare - capacityShare);
          const score = satisfaction * 100 - ratioBalance * 12 - splitBalance * 9;

          if (!best || score > best.score) best = { score, first, second };
        }

        if (!best) return null;

        return {
          pageGroups: [
            { ...best.first, heights: distributeAnswerSpace(best.first, minAnswerPx) },
            { ...best.second, heights: distributeAnswerSpace(best.second, minAnswerPx) }
          ],
          fitLevel,
          overflow: false
        };
      }

      function findLayoutPlan(sentences, settings) {
        for (const fitLevel of FIT_LEVELS) {
          setFitTypography(settings, fitLevel);
          const measurement = measureLayout(sentences, settings, fitLevel);
          const plan = buildPlan(measurement, settings);
          if (plan) return { plan, measurement };
        }

        const fitLevel = FIT_LEVELS[FIT_LEVELS.length - 1];
        setFitTypography(settings, fitLevel);
        const measurement = measureLayout(sentences, settings, fitLevel);
        const count = sentences.length;
        const all = Array.from({ length: count }, (_, index) => index);
        const split = Math.max(1, Math.ceil(count * 0.48));
        const groups = [all.slice(0, split), all.slice(split)];
        const minAnswerPx = 1.8 * millimeterInPixels;
        const pageGroups = groups.map((indices, pageIndex) => {
          const group = groupStats(
            measurement.metrics,
            indices,
            measurement.capacities[pageIndex],
            settings,
            minAnswerPx
          );
          return { ...group, heights: distributeAnswerSpace(group, minAnswerPx) };
        });

        return {
          plan: { pageGroups, fitLevel, overflow: true },
          measurement
        };
      }

      function renderPlan(sentences, settings, result) {
        pages.replaceChildren();
        const { plan, measurement } = result;
        const totalPages = Math.min(2, Math.max(1, plan.pageGroups.length));

        plan.pageGroups.slice(0, 2).forEach((group, pageIndex) => {
          const shell = createPageShell(settings, pageIndex + 1, totalPages);
          group.indices.forEach((sentenceIndex, localIndex) => {
            shell.body.appendChild(
              createSentenceItem(
                sentences[sentenceIndex],
                sentenceIndex,
                settings,
                group.heights[localIndex]
              )
            );
          });
        });

        if (!sentences.length) {
          const shell = pages.querySelector(".worksheet-page")
            ? { body: pages.querySelector(".page-body") }
            : createPageShell(settings, 1, 1);
          const empty = document.createElement("div");
          empty.className = "empty-sheet screen-only";
          appendText(empty, "div", "", "영어 지문을 입력하면 문장별 해석 공간이 자동으로 만들어집니다.");
          shell.body.appendChild(empty);
        }

        if (plan.overflow) {
          const lastPage = pages.lastElementChild;
          if (lastPage) {
            appendText(
              lastPage,
              "div",
              "fit-note screen-only",
              "현재 지문은 두 면의 안전한 인쇄 범위를 넘습니다. 문장을 줄이거나 영문 크기를 낮춰 주세요."
            );
          }
        }

        const ratios = plan.pageGroups.map((group, index) => {
          const used = group.fixed + group.heights.reduce((sum, value) => sum + value, 0);
          return measurement.capacities[index] ? used / measurement.capacities[index] : 0;
        });

        return {
          totalPages,
          fitLevel: plan.fitLevel.name,
          overflow: plan.overflow,
          maxUsage: ratios.length ? Math.max(...ratios) : 0
        };
      }

      function updateStatus(sentences, renderInfo) {
        const count = sentences.length;
        sentenceCount.textContent = `${count} sentence${count === 1 ? "" : "s"}`;
        summaryCount.textContent = `${count}문장`;
        liveSummary.classList.remove("is-warning", "is-error");
        printButton.disabled = renderInfo.overflow;
        downloadPdfButton.disabled = renderInfo.overflow;

        if (!count) {
          summaryText.textContent = "지문을 입력해 주세요";
          previewMeta.textContent = "빈 B5 서식 · 1면";
          return;
        }

        if (renderInfo.overflow) {
          liveSummary.classList.add("is-error");
          summaryText.textContent = "2면 수용량 초과";
          previewMeta.textContent = `${count}문장 · 인쇄 전 지문 조정 필요`;
          return;
        }

        if (renderInfo.fitLevel !== "normal") {
          liveSummary.classList.add("is-warning");
          summaryText.textContent = "2면 맞춤 밀도 적용";
        } else {
          summaryText.textContent = "가변 필기 공간 적용";
        }

        const zoom = Math.round(parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue("--preview-zoom")) * 100);
        previewMeta.textContent = `${count}문장 · B5 ${renderInfo.totalPages}면 · 미리보기 ${zoom}%`;
      }

      function updatePreviewScale(settings, sentences, renderInfo) {
        const page = pages.querySelector(".worksheet-page");
        if (!page || window.matchMedia("print").matches) return;

        document.documentElement.style.setProperty("--preview-zoom", "1");
        const available = Math.max(270, previewWorkspace.clientWidth - 38);
        const naturalWidth = page.getBoundingClientRect().width;
        const scale = Math.min(1, available / naturalWidth);
        document.documentElement.style.setProperty("--preview-zoom", scale.toFixed(4));
        updateStatus(sentences, renderInfo);
      }

      function renderWorksheet() {
        const version = ++renderVersion;
        const settings = readSettings();
        const sentences = splitIntoSentences(settings.passage);
        applyAccentColor(settings.accentColor);
        saveSettings(settings);
        measureMillimeter();

        const result = findLayoutPlan(sentences, settings);
        const renderInfo = renderPlan(sentences, settings, result);
        currentLayout = { settings, sentences, result, renderInfo, millimeterInPixels };
        updateStatus(sentences, renderInfo);

        requestAnimationFrame(() => {
          if (version !== renderVersion) return;
          updatePreviewScale(settings, sentences, renderInfo);
        });
      }

      function scheduleRender() {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(renderWorksheet, 230);
      }

      function wrapPassageSelection(prefix, suffix, placeholder) {
        const start = passageInput.selectionStart;
        const end = passageInput.selectionEnd;
        const selected = passageInput.value.slice(start, end);
        const content = selected || placeholder;
        const replacement = `${prefix}${content}${suffix}`;

        passageInput.setRangeText(replacement, start, end, "select");
        passageInput.selectionStart = start + prefix.length;
        passageInput.selectionEnd = start + prefix.length + content.length;
        passageInput.focus();
        passageInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      function resetSample() {
        applySettingsToForm({ ...DEFAULTS });
        saveSettings({ ...DEFAULTS });
        renderWorksheet();
        form.elements.passage.focus();
      }

      function printWorksheet() {
        window.clearTimeout(renderTimer);
        renderWorksheet();
        if (printButton.disabled) return;
        requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
      }

      function setOptimizerStatus(message, state = "") {
        pdfOptimizerStatus.textContent = message;
        pdfOptimizerStatus.classList.toggle("is-error", state === "error");
        pdfOptimizerStatus.classList.toggle("is-success", state === "success");
      }

      function appendDiagnosticRow(table, label, before, after) {
        const row = document.createElement("tr");
        appendText(row, "th", "", label);
        appendText(row, "td", "", String(before));
        appendText(row, "td", "", String(after));
        table.appendChild(row);
      }

      function renderDiagnostics(before, after, warnings) {
        pdfDiagnostics.replaceChildren();
        const table = document.createElement("table");
        const head = document.createElement("tr");
        appendText(head, "th", "", "진단");
        appendText(head, "th", "", "입력");
        appendText(head, "th", "", "출력");
        table.appendChild(head);
        appendDiagnosticRow(table, "파일 크기", PdfWorkflow.formatBytes(before.bytes), PdfWorkflow.formatBytes(after.bytes));
        appendDiagnosticRow(table, "페이지", before.pages, after.pages);
        appendDiagnosticRow(table, "PDF 객체", before.objects, after.objects);
        appendDiagnosticRow(table, "폰트 리소스", before.fonts, after.fonts);
        appendDiagnosticRow(table, "임베드 폰트", before.embeddedFonts, after.embeddedFonts);
        appendDiagnosticRow(table, "Unicode 글자맵", before.unicodeMaps, after.unicodeMaps);
        appendDiagnosticRow(table, "이미지", before.images, after.images);
        appendDiagnosticRow(table, "콘텐츠 스트림", before.contentStreams, after.contentStreams);
        appendDiagnosticRow(table, "전체 스트림", before.streams, after.streams);
        appendDiagnosticRow(table, "주석", before.annotations, after.annotations);
        appendDiagnosticRow(table, "양식 필드", before.formFields, after.formFields);
        pdfDiagnostics.appendChild(table);

        if (warnings.length) {
          const list = document.createElement("ul");
          list.className = "pdf-warnings";
          warnings.forEach(warning => appendText(list, "li", "", warning));
          pdfDiagnostics.appendChild(list);
        }
        pdfDiagnostics.classList.add("is-visible");
      }

      async function downloadWorksheetPdf() {
        window.clearTimeout(renderTimer);
        renderWorksheet();
        if (!currentLayout || downloadPdfButton.disabled) return;
        const originalLabel = downloadPdfButton.textContent;
        downloadPdfButton.disabled = true;
        downloadPdfButton.textContent = "PDF 생성 중…";
        try {
          const result = await PdfWorkflow.createWorksheetPdf(currentLayout);
          PdfWorkflow.downloadBytes(result.bytes, result.filename);
        } catch (error) {
          window.alert(error.message || "PDF 생성에 실패했습니다.");
        } finally {
          downloadPdfButton.textContent = originalLabel;
          downloadPdfButton.disabled = Boolean(currentLayout && currentLayout.renderInfo.overflow);
        }
      }

      async function processPdfFile(file) {
        optimizedPdf = null;
        optimizedDownloadButton.disabled = true;
        pdfDiagnostics.classList.remove("is-visible");
        pdfDiagnostics.replaceChildren();
        if (!file) return;
        if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
          setOptimizerStatus("PDF 파일만 선택할 수 있습니다.", "error");
          return;
        }
        if (file.size > PdfWorkflow.MAX_PDF_BYTES) {
          setOptimizerStatus("PDF는 50 MB 이하여야 합니다.", "error");
          return;
        }

        setOptimizerStatus(`${file.name} 구조 분석 및 재작성 중…`);
        pdfDropZone.setAttribute("aria-busy", "true");
        try {
          const result = await PdfWorkflow.optimizePdf(await file.arrayBuffer());
          optimizedPdf = {
            bytes: result.bytes,
            filename: PdfWorkflow.safeFilename(file.name.replace(/\.pdf$/i, ""), "-optimized.pdf")
          };
          optimizedDownloadButton.disabled = false;
          renderDiagnostics(result.before, result.after, result.warnings);
          setOptimizerStatus(`완료 · ${result.before.objects}개 객체를 ${result.after.objects}개로 재작성했습니다.`, "success");
        } catch (error) {
          setOptimizerStatus(error.message || "PDF 처리에 실패했습니다.", "error");
        } finally {
          pdfDropZone.removeAttribute("aria-busy");
        }
      }

      form.addEventListener("input", event => {
        if (event.target === form.elements.accentColor) {
          applyAccentColor(event.target.value);
        }
        scheduleRender();
      });
      form.addEventListener("change", scheduleRender);
      refreshButton.addEventListener("click", renderWorksheet);
      printButton.addEventListener("click", printWorksheet);
      downloadPdfButton.addEventListener("click", downloadWorksheetPdf);
      resetButton.addEventListener("click", resetSample);
      librarySaveButton.addEventListener("click", saveCurrentToLibrary);
      libraryLoadButton.addEventListener("click", loadSelectedFromLibrary);
      libraryDeleteButton.addEventListener("click", deleteSelectedFromLibrary);
      librarySelect.addEventListener("change", () => {
        const hasSelection = Boolean(librarySelect.value);
        libraryLoadButton.disabled = !hasSelection;
        libraryDeleteButton.disabled = !hasSelection;
      });
      pdfFileInput.addEventListener("change", () => processPdfFile(pdfFileInput.files[0]));
      optimizedDownloadButton.addEventListener("click", () => {
        if (optimizedPdf) PdfWorkflow.downloadBytes(optimizedPdf.bytes, optimizedPdf.filename);
      });
      pdfDropZone.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pdfFileInput.click();
        }
      });
      ["dragenter", "dragover"].forEach(type => {
        pdfDropZone.addEventListener(type, event => {
          event.preventDefault();
          pdfDropZone.classList.add("is-dragging");
        });
      });
      ["dragleave", "drop"].forEach(type => {
        pdfDropZone.addEventListener(type, event => {
          event.preventDefault();
          pdfDropZone.classList.remove("is-dragging");
        });
      });
      pdfDropZone.addEventListener("drop", event => processPdfFile(event.dataTransfer.files[0]));
      formatButtons.forEach(button => {
        button.addEventListener("click", () => {
          wrapPassageSelection(
            button.dataset.wrapPrefix || "",
            button.dataset.wrapSuffix || "",
            button.dataset.placeholder || ""
          );
        });
      });

      window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(renderWorksheet, 180);
      });

      window.addEventListener("beforeprint", () => {
        document.documentElement.style.setProperty("--preview-zoom", "1");
      });

      window.addEventListener("afterprint", renderWorksheet);

      applySettingsToForm(loadSettings());
      renderLibrarySelect(loadLibrary());
      renderWorksheet();

      window.WorksheetGenerator = Object.freeze({
        normalizePassage,
        splitIntoSentences,
        stripMergeMarkers,
        appendFormattedText,
        renderWorksheet,
        saveSettings,
        loadSettings,
        resetSample,
        printWorksheet,
        downloadWorksheetPdf,
        processPdfFile,
        getCurrentLayout: () => currentLayout
      });
    })();
