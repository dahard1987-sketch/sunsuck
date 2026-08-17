(function attachPdfExport(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vendor/pdf-lib.min.js"),
      require("./vendor/fontkit.umd.min.js"),
      require("./pdf-shared.js")
    );
  } else {
    root.PdfExport = factory(root.PDFLib, root.fontkit, root.PdfShared);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfExport(PDFLib, fontkit, PdfShared) {
  "use strict";

  const { requireLibraries, mm, cleanText, safeFilename, inspectPdf, PT_PER_MM, B5_WIDTH, B5_HEIGHT } = PdfShared;

  // pdf-lib/fontkit emits full CJK fonts with 1000-unit PDF advances while
  // Noto Sans KR reports 920-unit Hangul advances. Account for the renderer's
  // actual width so wrapping and right-edge checks match the finished PDF.
  const CJK_RENDER_WIDTH_SCALE = 1000 / 920;
  const FONT_URLS = Object.freeze({
    korean: "assets/NotoSansKR-Regular.ttf",
    koreanBold: "assets/NotoSansKR-Bold.ttf",
    regular: "assets/NotoSans-Regular.ttf",
    bold: "assets/NotoSans-Bold.ttf",
    italic: "assets/NotoSans-Italic.ttf",
    boldItalic: "assets/NotoSans-BoldItalic.ttf"
  });
  const cachedFontBytes = Object.create(null);

  async function loadFontFile(role, override) {
    if (override) return override instanceof Uint8Array ? override : new Uint8Array(override);
    if (cachedFontBytes[role]) return cachedFontBytes[role];
    if (typeof fetch !== "function") throw new Error("Noto Sans PDF 폰트를 불러올 수 없습니다.");
    const response = await fetch(FONT_URLS[role]);
    if (!response.ok) throw new Error(`Noto Sans PDF 폰트 로드 실패 (${response.status})`);
    cachedFontBytes[role] = new Uint8Array(await response.arrayBuffer());
    return cachedFontBytes[role];
  }

  async function loadFontBytes(overrides) {
    const supplied = overrides || {};
    const entries = await Promise.all(Object.keys(FONT_URLS).map(async role => [
      role,
      await loadFontFile(role, supplied[role])
    ]));
    return Object.fromEntries(entries);
  }

  function hexColor(value) {
    const normalized = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#c4171d";
    return PDFLib.rgb(
      parseInt(normalized.slice(1, 3), 16) / 255,
      parseInt(normalized.slice(3, 5), 16) / 255,
      parseInt(normalized.slice(5, 7), 16) / 255
    );
  }

  const MARKUP_RULES = [
    { delimiter: "**", style: "bold" },
    { delimiter: "__", style: "underline" },
    { delimiter: "*", style: "italic" }
  ];

  function findMarkupDelimiter(text, delimiter, fromIndex) {
    let index = text.indexOf(delimiter, fromIndex);
    while (index !== -1 && delimiter === "*" && (text[index - 1] === "*" || text[index + 1] === "*")) {
      index = text.indexOf(delimiter, index + 1);
    }
    return index;
  }

  function findNextMarkupToken(text, fromIndex) {
    let next = null;
    MARKUP_RULES.forEach(rule => {
      const start = findMarkupDelimiter(text, rule.delimiter, fromIndex);
      if (start === -1) return;
      const contentStart = start + rule.delimiter.length;
      const end = findMarkupDelimiter(text, rule.delimiter, contentStart);
      if (end <= contentStart) return;
      if (!next || start < next.start || (start === next.start && rule.delimiter.length > next.rule.delimiter.length)) {
        next = { rule, start, contentStart, end };
      }
    });
    return next;
  }

  function parseMarkupRuns(text, baseStyle) {
    const runs = [];
    let cursor = 0;
    while (cursor < text.length) {
      const token = findNextMarkupToken(text, cursor);
      if (!token) {
        runs.push({ text: text.slice(cursor), ...baseStyle });
        break;
      }
      if (token.start > cursor) {
        runs.push({ text: text.slice(cursor, token.start), ...baseStyle });
      }
      const innerStyle = { ...baseStyle, [token.rule.style]: true };
      const innerText = text.slice(token.contentStart, token.end);
      runs.push(...parseMarkupRuns(innerText, innerStyle));
      cursor = token.end + token.rule.delimiter.length;
    }
    return runs;
  }

  // Recurses into each matched span so nested markers (e.g. italic selected
  // inside an already-bold sentence) combine styles, matching how the DOM
  // preview nests <strong>/<em>/<u> elements instead of flattening to one style.
  function parseMarkup(source) {
    const text = String(source == null ? "" : source);
    const runs = parseMarkupRuns(text, { bold: false, italic: false, underline: false });
    return runs.filter(run => run.text);
  }

  function isLatinCharCode(code) {
    if (code <= 0xff) return true;
    if (code === 0x2018 || code === 0x2019) return true;
    if (code === 0x201c || code === 0x201d) return true;
    if (code === 0x2013 || code === 0x2014) return true;
    return false;
  }

  function isLatinText(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (!isLatinCharCode(text.charCodeAt(index))) return false;
    }
    return true;
  }

  function fontForRun(run, fonts) {
    if (!isLatinText(run.text)) return run.bold ? fonts.koreanBold : fonts.korean;
    if (run.bold && run.italic) return fonts.boldItalic;
    if (run.bold) return fonts.bold;
    if (run.italic) return fonts.italic;
    return fonts.regular;
  }

  function splitRunByAlphabet(run) {
    const pieces = [];
    let buffer = "";
    let latin = null;
    for (const character of Array.from(run.text)) {
      const nextLatin = isLatinText(character);
      if (latin !== null && latin !== nextLatin) {
        pieces.push({ ...run, text: buffer });
        buffer = "";
      }
      buffer += character;
      latin = nextLatin;
    }
    if (buffer) pieces.push({ ...run, text: buffer });
    return pieces;
  }

  function appendLineRun(line, run) {
    const previous = line[line.length - 1];
    const sameFontGroup = previous && isLatinText(previous.text) === isLatinText(run.text);
    if (sameFontGroup && previous.bold === run.bold && previous.italic === run.italic && previous.underline === run.underline) {
      previous.text += run.text;
    } else {
      line.push({ ...run });
    }
  }

  function runWidth(run, size, fonts) {
    const measured = fontForRun(run, fonts).widthOfTextAtSize(run.text, size);
    return isLatinText(run.text) ? measured : measured * CJK_RENDER_WIDTH_SCALE;
  }

  function lineWidth(line, size, fonts) {
    return line.reduce((sum, run) => sum + runWidth(run, size, fonts), 0);
  }

  function wrapStyledText(source, size, maxWidth, fonts) {
    const tokens = [];
    parseMarkup(source).forEach(run => {
      splitRunByAlphabet(run).forEach(piece => {
        const parts = piece.text.split(/(\s+)/).filter(Boolean);
        parts.forEach(text => tokens.push({ ...piece, text }));
      });
    });

    const lines = [[]];
    let width = 0;
    const newLine = () => {
      if (lines[lines.length - 1].length) lines.push([]);
      width = 0;
    };

    tokens.forEach(token => {
      const whitespace = /^\s+$/.test(token.text);
      let tokenWidth = runWidth(token, size, fonts);
      if (whitespace && width === 0) return;
      if (!whitespace && width > 0 && width + tokenWidth > maxWidth) newLine();

      if (!whitespace && tokenWidth > maxWidth) {
        Array.from(token.text).forEach(character => {
          const fragment = { ...token, text: character };
          const characterWidth = runWidth(fragment, size, fonts);
          if (width > 0 && width + characterWidth > maxWidth) newLine();
          appendLineRun(lines[lines.length - 1], fragment);
          width += characterWidth;
        });
        return;
      }

      if (whitespace && width + tokenWidth > maxWidth) {
        newLine();
        return;
      }
      appendLineRun(lines[lines.length - 1], token);
      width += tokenWidth;
    });

    return lines.filter(line => line.length);
  }

  function drawStyledLines(page, lines, options) {
    const { x, top, size, lineHeight, fonts, color } = options;
    lines.forEach((line, lineIndex) => {
      let cursorX = x;
      const y = top - size - lineIndex * lineHeight;
      line.forEach(run => {
        const font = fontForRun(run, fonts);
        page.drawText(run.text, { x: cursorX, y, size, font, color });
        const width = runWidth(run, size, fonts);
        if (run.underline && run.text.trim()) {
          page.drawLine({
            start: { x: cursorX, y: y - 1.2 },
            end: { x: cursorX + width, y: y - 1.2 },
            thickness: 0.55,
            color
          });
        }
        cursorX += width;
      });
    });
  }

  function plainMixedRuns(text, bold = false) {
    const runs = [];
    splitRunByAlphabet({ text, bold, italic: false, underline: false })
      .forEach(run => appendLineRun(runs, run));
    return runs;
  }

  function drawMixedSingleLine(page, text, options) {
    const value = cleanText(text);
    if (!value) return { size: options.size, width: 0 };
    const runs = plainMixedRuns(value, Boolean(options.bold));
    const minimumSize = options.minimumSize || 5.5;
    let size = options.size;
    while (size > minimumSize && lineWidth(runs, size, options.fonts) > options.width) size -= 0.25;
    const textWidth = lineWidth(runs, size, options.fonts);
    let cursorX = options.x;
    if (options.align === "center") cursorX += Math.max(0, (options.width - textWidth) / 2);
    if (options.align === "right") cursorX += Math.max(0, options.width - textWidth);
    runs.forEach(run => {
      page.drawText(run.text, {
        x: cursorX,
        y: options.y,
        size,
        font: fontForRun(run, options.fonts),
        color: options.color
      });
      cursorX += runWidth(run, size, options.fonts);
    });
    return { size, width: textWidth };
  }

  function drawCenteredText(page, text, options) {
    return drawMixedSingleLine(page, text, { ...options, align: "center" });
  }

  function drawFirstHeader(page, settings, fonts, accent, contrast) {
    const left = mm(9);
    const top = B5_HEIGHT - mm(8.5);
    const categoryWidth = mm(42);
    const titleX = left + categoryWidth + mm(3);
    const identityWidth = mm(45);
    const identityX = B5_WIDTH - mm(9) - identityWidth;
    const titleWidth = identityX - mm(3) - titleX;

    page.drawRectangle({ x: left, y: top - mm(6.6), width: categoryWidth, height: mm(6.6), color: accent });
    drawCenteredText(page, settings.categoryLabel, {
      x: left + mm(1.5), width: categoryWidth - mm(3), y: top - mm(4.7), size: 9.2,
      fonts, color: contrast, minimumSize: 6
    });
    drawCenteredText(page, settings.semesterLabel, {
      x: left + mm(1), width: categoryWidth - mm(2), y: top - mm(11.5), size: 8.4,
      fonts, color: PDFLib.rgb(0.08, 0.08, 0.08), minimumSize: 6
    });
    page.drawLine({
      start: { x: left, y: top - mm(13.1) }, end: { x: left + categoryWidth, y: top - mm(13.1) },
      thickness: 1, color: PDFLib.rgb(0.08, 0.08, 0.08)
    });

    drawCenteredText(page, settings.worksheetTitle, {
      x: titleX, width: titleWidth, y: top - mm(10.3), size: 18,
      fonts, color: accent, minimumSize: 9, bold: true
    });

    const labelColor = PDFLib.rgb(0.08, 0.08, 0.08);
    page.drawText("Name:", { x: identityX, y: top - mm(4), size: 7.8, font: fonts.regular, color: labelColor });
    page.drawLine({ start: { x: identityX, y: top - mm(5.2) }, end: { x: identityX + identityWidth, y: top - mm(5.2) }, thickness: 0.9, color: labelColor });
    page.drawText("Teacher:", { x: identityX, y: top - mm(9.5), size: 7.8, font: fonts.regular, color: labelColor });
    const teacher = cleanText(settings.teacherName);
    if (teacher) {
      drawMixedSingleLine(page, teacher, {
        x: identityX + mm(17), width: identityWidth - mm(17), y: top - mm(9.5),
        size: 7.8, minimumSize: 5.5, fonts, color: labelColor
      });
    }
    page.drawLine({ start: { x: identityX, y: top - mm(10.7) }, end: { x: identityX + identityWidth, y: top - mm(10.7) }, thickness: 0.9, color: labelColor });

    const meta = [settings.className ? `Class · ${settings.className}` : "", settings.worksheetDate ? `Date · ${settings.worksheetDate}` : ""]
      .filter(Boolean).join("   ");
    if (meta) {
      drawMixedSingleLine(page, meta, {
        x: identityX, width: identityWidth, y: top - mm(14.2), size: 6.2,
        minimumSize: 4.8, fonts, color: PDFLib.rgb(0.3, 0.3, 0.3)
      });
    }

    const stripTop = top - mm(19.2);
    page.drawRectangle({ x: left, y: stripTop - mm(7.5), width: B5_WIDTH - mm(18), height: mm(7.5), color: accent });
    const unit = cleanText(settings.unitTitle);
    drawMixedSingleLine(page, unit, {
      x: left + mm(2.4), width: B5_WIDTH - mm(23), y: stripTop - mm(5),
      size: 10.2, minimumSize: 6.5, fonts, color: contrast
    });
    return stripTop - mm(9);
  }

  function drawContinuationHeader(page, settings, pageNumber, totalPages, fonts, accent) {
    const left = mm(9);
    const right = B5_WIDTH - mm(9);
    const top = B5_HEIGHT - mm(8.5);
    const title = cleanText(settings.worksheetTitle);
    drawMixedSingleLine(page, title, {
      x: left, width: mm(115), y: top - mm(4), size: 10.5,
      minimumSize: 7, fonts, color: accent, bold: true
    });
    const unit = cleanText(settings.unitTitle);
    drawMixedSingleLine(page, unit, {
      x: left, width: mm(125), y: top - mm(7.2), size: 6.6,
      minimumSize: 5, fonts, color: PDFLib.rgb(0.3, 0.3, 0.3)
    });
    const pageText = `${pageNumber} / ${totalPages}`;
    const pageWidth = fonts.bold.widthOfTextAtSize(pageText, 7);
    page.drawText(pageText, { x: right - pageWidth, y: top - mm(7.2), size: 7, font: fonts.bold, color: PDFLib.rgb(0.4, 0.4, 0.4) });
    page.drawLine({ start: { x: left, y: top - mm(9.5) }, end: { x: right, y: top - mm(9.5) }, thickness: mm(0.75), color: accent });
    return top - mm(11);
  }

  function drawFooter(page, settings, pageNumber, totalPages, fonts) {
    if (!settings.showFooter) return;
    const y = mm(8.7);
    const color = PDFLib.rgb(0.62, 0.62, 0.62);
    const footer = cleanText(settings.footerText);
    drawMixedSingleLine(page, footer, {
      x: (B5_WIDTH - mm(90)) / 2, width: mm(90), y, size: 6.4,
      minimumSize: 5, fonts, color, align: "center"
    });
    const pageText = `${pageNumber} / ${totalPages}`;
    page.drawText(pageText, {
      x: B5_WIDTH - mm(9) - fonts.regular.widthOfTextAtSize(pageText, 6.4), y,
      size: 6.4, font: fonts.regular, color
    });
  }

  function preparePageItems(group, sentences, settings, fitLevel, fonts, maxWidth, mmPerPixel, bodyCapacity) {
    let fontSize = Math.max(8.8, (settings.fontPointSize || 12.4) * fitLevel.fontScale);
    let items;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lineHeight = fontSize * fitLevel.leading;
      items = group.indices.map((sentenceIndex, localIndex) => {
        const source = cleanText(sentences[sentenceIndex]).replace(/^<|>$/g, "");
        const textWidth = maxWidth - (settings.showNumbers ? mm(7.5) : 0);
        const lines = wrapStyledText(source, fontSize, textWidth, fonts);
        const rowHeight = Math.max(mm(7.6), mm(2.75) + lines.length * lineHeight);
        return {
          sentenceIndex,
          source,
          lines,
          fontSize,
          lineHeight,
          textWidth,
          maxLineWidth: lines.reduce((maximum, line) => Math.max(maximum, lineWidth(line, fontSize, fonts)), 0),
          rowHeight,
          answerHeight: Math.max(mm(1.8), (group.heights[localIndex] || 0) * mmPerPixel * PT_PER_MM)
        };
      });
      const used = items.reduce((sum, item) => sum + item.rowHeight + item.answerHeight, 0);
      if (used <= bodyCapacity || fontSize <= 8.1) break;
      fontSize -= 0.45;
    }

    const rows = items.reduce((sum, item) => sum + item.rowHeight, 0);
    const answers = items.reduce((sum, item) => sum + item.answerHeight, 0);
    if (rows + answers > bodyCapacity && answers > 0) {
      const available = Math.max(0, bodyCapacity - rows);
      const scale = Math.min(1, available / answers);
      items.forEach(item => { item.answerHeight = Math.max(mm(1.4), item.answerHeight * scale); });
    }
    return items;
  }

  async function createWorksheetPdf(layout, options) {
    requireLibraries();
    const settings = layout.settings || {};
    const sentences = layout.sentences || [];
    const plan = layout.result && layout.result.plan;
    if (!plan || plan.overflow) throw new Error("현재 지문이 두 면의 안전한 범위를 넘습니다. 내용을 조정한 뒤 다시 시도해 주세요.");

    const pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontBytes = await loadFontBytes(options && options.fontBytes);
    const fonts = {
      // fontkit's CJK subsetting corrupts glyph maps in several PDF renderers.
      // Keep Korean complete, while safely subsetting the much smaller Latin faces.
      korean: await pdfDoc.embedFont(fontBytes.korean, { subset: false }),
      koreanBold: await pdfDoc.embedFont(fontBytes.koreanBold, { subset: false }),
      regular: await pdfDoc.embedFont(fontBytes.regular, { subset: true }),
      bold: await pdfDoc.embedFont(fontBytes.bold, { subset: true }),
      italic: await pdfDoc.embedFont(fontBytes.italic, { subset: true }),
      boldItalic: await pdfDoc.embedFont(fontBytes.boldItalic, { subset: true })
    };
    const accent = hexColor(settings.accentColor);
    const rgbSource = /^#[0-9a-f]{6}$/i.test(settings.accentColor || "") ? settings.accentColor : "#c4171d";
    const luminance = (parseInt(rgbSource.slice(1, 3), 16) * 299 + parseInt(rgbSource.slice(3, 5), 16) * 587 + parseInt(rgbSource.slice(5, 7), 16) * 114) / 1000;
    const contrast = luminance > 168 ? PDFLib.rgb(0.08, 0.09, 0.11) : PDFLib.rgb(1, 1, 1);
    const totalPages = Math.max(1, Math.min(2, plan.pageGroups.length));
    const mmPerPixel = 1 / (layout.millimeterInPixels || (96 / 25.4));

    pdfDoc.setTitle(cleanText(settings.worksheetTitle) || "B5 Worksheet");
    pdfDoc.setAuthor(cleanText(settings.teacherName));
    pdfDoc.setSubject("Structurally simple B5 worksheet PDF");
    pdfDoc.setCreator("CANB B5 Worksheet Studio");
    pdfDoc.setProducer("pdf-lib 1.17.1");

    const pageLayouts = [];
    plan.pageGroups.slice(0, 2).forEach((group, pageIndex) => {
      const page = pdfDoc.addPage([B5_WIDTH, B5_HEIGHT]);
      const bodyTop = pageIndex === 0
        ? drawFirstHeader(page, settings, fonts, accent, contrast)
        : drawContinuationHeader(page, settings, pageIndex + 1, totalPages, fonts, accent);
      drawFooter(page, settings, pageIndex + 1, totalPages, fonts);

      const bodyBottom = mm(15);
      const left = mm(9);
      const width = B5_WIDTH - mm(18);
      const fitLevel = plan.fitLevel || { fontScale: 1, leading: 1.42 };
      const normalizedSettings = { ...settings, fontPointSize: ({ compact: 10.7, standard: 11.6, large: 12.6 })[settings.fontSize] || 11.6 };
      const items = preparePageItems(
        group, sentences, normalizedSettings, fitLevel, fonts, width, mmPerPixel, bodyTop - bodyBottom
      );
      let cursorTop = bodyTop;

      items.forEach(item => {
        const textX = left + (settings.showNumbers ? mm(7.5) : 0);
        if (settings.showNumbers) {
          const number = String(item.sentenceIndex + 1).padStart(2, "0");
          const numberWidth = fonts.bold.widthOfTextAtSize(number, item.fontSize * 0.72);
          page.drawText(number, {
            x: left + mm(5.3) - numberWidth,
            y: cursorTop - item.fontSize - mm(1.2),
            size: item.fontSize * 0.72,
            font: fonts.bold,
            color: accent
          });
        }
        drawStyledLines(page, item.lines, {
          x: textX,
          top: cursorTop - mm(1.15),
          size: item.fontSize,
          lineHeight: item.lineHeight,
          fonts,
          color: PDFLib.rgb(0.05, 0.05, 0.06)
        });
        cursorTop -= item.rowHeight;
        page.drawLine({ start: { x: left, y: cursorTop }, end: { x: left + width, y: cursorTop }, thickness: mm(0.32), color: PDFLib.rgb(0.07, 0.07, 0.07) });

        const answerBottom = cursorTop - item.answerHeight;
        if (settings.guideStyle === "subtle") {
          for (let guideY = cursorTop - mm(8.5); guideY > answerBottom + mm(1); guideY -= mm(8.5)) {
            page.drawLine({
              start: { x: left, y: guideY }, end: { x: left + width, y: guideY },
              thickness: mm(0.18), color: PDFLib.rgb(0.88, 0.88, 0.88)
            });
          }
        }
        if (settings.showAnswerHint) {
          const hint = "해석";
          drawMixedSingleLine(page, hint, {
            x: left, width, y: cursorTop - mm(3.2), size: 5.6,
            minimumSize: 5.6, fonts, color: PDFLib.rgb(0.72, 0.72, 0.72), align: "right"
          });
        }
        page.drawLine({ start: { x: left, y: answerBottom }, end: { x: left + width, y: answerBottom }, thickness: mm(0.32), color: PDFLib.rgb(0.12, 0.12, 0.12) });
        cursorTop = answerBottom;
      });

      const widestLine = items.reduce((maximum, item) => Math.max(maximum, item.maxLineWidth), 0);
      const narrowestTextArea = items.reduce((minimum, item) => Math.min(minimum, item.textWidth), Infinity);
      const horizontalOverflow = widestLine > narrowestTextArea + 0.1;
      const verticalOverflow = cursorTop < bodyBottom - 0.1;
      if (horizontalOverflow || verticalOverflow) {
        throw new Error("Noto Sans 기준으로 PDF 안전 영역을 벗어납니다. 지문 길이나 글자 크기를 조정해 주세요.");
      }
      pageLayouts.push({
        page: pageIndex + 1,
        bodyTop,
        bodyBottom,
        finalBottom: cursorTop,
        widestLine,
        textWidth: Number.isFinite(narrowestTextArea) ? narrowestTextArea : width,
        horizontalOverflow,
        verticalOverflow
      });
    });

    const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 30 });
    const metrics = await inspectPdf(bytes);
    return {
      bytes,
      filename: safeFilename(settings.worksheetTitle, ".pdf"),
      metrics,
      layout: { pages: pageLayouts }
    };
  }

  return Object.freeze({
    createWorksheetPdf,
    parseMarkup,
    wrapStyledText
  });
});
