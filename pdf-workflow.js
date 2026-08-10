(function attachPdfWorkflow(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vendor/pdf-lib.min.js"),
      require("./vendor/fontkit.umd.min.js")
    );
  } else {
    root.PdfWorkflow = factory(root.PDFLib, root.fontkit);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfWorkflow(PDFLib, fontkit) {
  "use strict";

  const PT_PER_MM = 72 / 25.4;
  const B5_WIDTH = 182 * PT_PER_MM;
  const B5_HEIGHT = 257 * PT_PER_MM;
  const MAX_PDF_BYTES = 50 * 1024 * 1024;
  const FONT_URL = "assets/NanumGothic-Regular.ttf";
  let cachedFontBytes = null;

  function requireLibraries() {
    if (!PDFLib || !fontkit) {
      throw new Error("PDF 엔진을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    }
  }

  function mm(value) {
    return value * PT_PER_MM;
  }

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .trim();
  }

  function safeFilename(value, suffix) {
    const base = cleanText(value || "worksheet")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .slice(0, 80)
      .trim() || "worksheet";
    return `${base}${suffix}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function parseMarkup(source) {
    const text = String(source == null ? "" : source);
    const rules = [
      { delimiter: "**", style: "bold" },
      { delimiter: "__", style: "underline" },
      { delimiter: "*", style: "italic" }
    ];

    function findDelimiter(delimiter, fromIndex) {
      let index = text.indexOf(delimiter, fromIndex);
      while (index !== -1 && delimiter === "*" && (text[index - 1] === "*" || text[index + 1] === "*")) {
        index = text.indexOf(delimiter, index + 1);
      }
      return index;
    }

    const runs = [];
    let cursor = 0;
    while (cursor < text.length) {
      let next = null;
      rules.forEach(rule => {
        const start = findDelimiter(rule.delimiter, cursor);
        if (start === -1) return;
        const contentStart = start + rule.delimiter.length;
        const end = findDelimiter(rule.delimiter, contentStart);
        if (end <= contentStart) return;
        if (!next || start < next.start || (start === next.start && rule.delimiter.length > next.rule.delimiter.length)) {
          next = { rule, start, contentStart, end };
        }
      });

      if (!next) {
        runs.push({ text: text.slice(cursor), bold: false, italic: false, underline: false });
        break;
      }
      if (next.start > cursor) {
        runs.push({ text: text.slice(cursor, next.start), bold: false, italic: false, underline: false });
      }
      runs.push({
        text: text.slice(next.contentStart, next.end),
        bold: next.rule.style === "bold",
        italic: next.rule.style === "italic",
        underline: next.rule.style === "underline"
      });
      cursor = next.end + next.rule.delimiter.length;
    }
    return runs.filter(run => run.text);
  }

  async function loadFontBytes(override) {
    if (override) return override instanceof Uint8Array ? override : new Uint8Array(override);
    if (cachedFontBytes) return cachedFontBytes;
    if (typeof fetch !== "function") throw new Error("한글 PDF 폰트를 불러올 수 없습니다.");
    const response = await fetch(FONT_URL);
    if (!response.ok) throw new Error(`한글 PDF 폰트 로드 실패 (${response.status})`);
    cachedFontBytes = new Uint8Array(await response.arrayBuffer());
    return cachedFontBytes;
  }

  function hexColor(value) {
    const normalized = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#c4171d";
    return PDFLib.rgb(
      parseInt(normalized.slice(1, 3), 16) / 255,
      parseInt(normalized.slice(3, 5), 16) / 255,
      parseInt(normalized.slice(5, 7), 16) / 255
    );
  }

  function isLatinText(text) {
    return /^[\u0000-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014]*$/.test(text);
  }

  function fontForRun(run, fonts) {
    if (!isLatinText(run.text)) return fonts.korean;
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
    if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.underline === run.underline) {
      previous.text += run.text;
    } else {
      line.push({ ...run });
    }
  }

  function runWidth(run, size, fonts) {
    return fontForRun(run, fonts).widthOfTextAtSize(run.text, size);
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
        const width = font.widthOfTextAtSize(run.text, size);
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

  function fitSingleLine(text, font, preferredSize, maxWidth, minimumSize) {
    let size = preferredSize;
    while (size > minimumSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
    return size;
  }

  function drawCenteredText(page, text, options) {
    const value = cleanText(text);
    if (!value) return;
    const size = fitSingleLine(value, options.font, options.size, options.width, options.minimumSize || 5.5);
    const textWidth = options.font.widthOfTextAtSize(value, size);
    page.drawText(value, {
      x: options.x + Math.max(0, (options.width - textWidth) / 2),
      y: options.y,
      size,
      font: options.font,
      color: options.color
    });
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
      font: fonts.korean, color: contrast, minimumSize: 6
    });
    drawCenteredText(page, settings.semesterLabel, {
      x: left + mm(1), width: categoryWidth - mm(2), y: top - mm(11.5), size: 8.4,
      font: fonts.korean, color: PDFLib.rgb(0.08, 0.08, 0.08), minimumSize: 6
    });
    page.drawLine({
      start: { x: left, y: top - mm(13.1) }, end: { x: left + categoryWidth, y: top - mm(13.1) },
      thickness: 1, color: PDFLib.rgb(0.08, 0.08, 0.08)
    });

    drawCenteredText(page, settings.worksheetTitle, {
      x: titleX, width: titleWidth, y: top - mm(10.3), size: 18,
      font: fonts.korean, color: accent, minimumSize: 9
    });

    const labelColor = PDFLib.rgb(0.08, 0.08, 0.08);
    page.drawText("Name:", { x: identityX, y: top - mm(4), size: 7.8, font: fonts.regular, color: labelColor });
    page.drawLine({ start: { x: identityX, y: top - mm(5.2) }, end: { x: identityX + identityWidth, y: top - mm(5.2) }, thickness: 0.9, color: labelColor });
    page.drawText("Teacher:", { x: identityX, y: top - mm(9.5), size: 7.8, font: fonts.regular, color: labelColor });
    const teacher = cleanText(settings.teacherName);
    if (teacher) {
      const teacherSize = fitSingleLine(teacher, fonts.korean, 7.8, identityWidth - mm(17), 5.5);
      page.drawText(teacher, { x: identityX + mm(17), y: top - mm(9.5), size: teacherSize, font: fonts.korean, color: labelColor });
    }
    page.drawLine({ start: { x: identityX, y: top - mm(10.7) }, end: { x: identityX + identityWidth, y: top - mm(10.7) }, thickness: 0.9, color: labelColor });

    const meta = [settings.className ? `Class · ${settings.className}` : "", settings.worksheetDate ? `Date · ${settings.worksheetDate}` : ""]
      .filter(Boolean).join("   ");
    if (meta) {
      const metaSize = fitSingleLine(meta, fonts.korean, 6.2, identityWidth, 4.8);
      page.drawText(meta, { x: identityX, y: top - mm(14.2), size: metaSize, font: fonts.korean, color: PDFLib.rgb(0.3, 0.3, 0.3) });
    }

    const stripTop = top - mm(19.2);
    page.drawRectangle({ x: left, y: stripTop - mm(7.5), width: B5_WIDTH - mm(18), height: mm(7.5), color: accent });
    const unit = cleanText(settings.unitTitle);
    const unitSize = fitSingleLine(unit, fonts.korean, 10.2, B5_WIDTH - mm(23), 6.5);
    page.drawText(unit, { x: left + mm(2.4), y: stripTop - mm(5), size: unitSize, font: fonts.korean, color: contrast });
    return stripTop - mm(9);
  }

  function drawContinuationHeader(page, settings, pageNumber, totalPages, fonts, accent) {
    const left = mm(9);
    const right = B5_WIDTH - mm(9);
    const top = B5_HEIGHT - mm(8.5);
    const title = cleanText(settings.worksheetTitle);
    const titleSize = fitSingleLine(title, fonts.korean, 10.5, mm(115), 7);
    page.drawText(title, { x: left, y: top - mm(4), size: titleSize, font: fonts.korean, color: accent });
    const unit = cleanText(settings.unitTitle);
    const unitSize = fitSingleLine(unit, fonts.korean, 6.6, mm(125), 5);
    page.drawText(unit, { x: left, y: top - mm(7.2), size: unitSize, font: fonts.korean, color: PDFLib.rgb(0.3, 0.3, 0.3) });
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
    const footerSize = fitSingleLine(footer, fonts.korean, 6.4, mm(90), 5);
    const footerWidth = fonts.korean.widthOfTextAtSize(footer, footerSize);
    page.drawText(footer, { x: (B5_WIDTH - footerWidth) / 2, y, size: footerSize, font: fonts.korean, color });
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
      // One complete Korean font is safer and still keeps the document graph simple.
      korean: await pdfDoc.embedFont(fontBytes, { subset: false }),
      regular: await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold),
      italic: await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBoldOblique)
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
      const normalizedSettings = { ...settings, fontPointSize: ({ compact: 11.4, standard: 12.4, large: 13.5 })[settings.fontSize] || 12.4 };
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
          const hintWidth = fonts.korean.widthOfTextAtSize(hint, 5.6);
          page.drawText(hint, { x: left + width - hintWidth, y: cursorTop - mm(3.2), size: 5.6, font: fonts.korean, color: PDFLib.rgb(0.72, 0.72, 0.72) });
        }
        page.drawLine({ start: { x: left, y: answerBottom }, end: { x: left + width, y: answerBottom }, thickness: mm(0.32), color: PDFLib.rgb(0.12, 0.12, 0.12) });
        cursorTop = answerBottom;
      });
    });

    const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 30 });
    const metrics = await inspectPdf(bytes);
    return {
      bytes,
      filename: safeFilename(settings.worksheetTitle, ".pdf"),
      metrics
    };
  }

  function pdfName(value) {
    return value && typeof value.asString === "function" ? value.asString() : String(value || "");
  }

  function getDictValue(dict, name) {
    if (!dict || typeof dict.get !== "function") return undefined;
    return dict.get(PDFLib.PDFName.of(name));
  }

  async function inspectPdf(bytes, loadedDocument) {
    requireLibraries();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = loadedDocument || await PDFLib.PDFDocument.load(data, { updateMetadata: false });
    const objects = doc.context.enumerateIndirectObjects();
    let fonts = 0;
    let embeddedFonts = 0;
    let unicodeMaps = 0;
    let images = 0;
    let streams = 0;
    let transparency = 0;

    objects.forEach(([, object]) => {
      const dict = object instanceof PDFLib.PDFStream ? object.dict : object;
      if (object instanceof PDFLib.PDFStream) streams += 1;
      const type = pdfName(getDictValue(dict, "Type"));
      const subtype = pdfName(getDictValue(dict, "Subtype"));
      if (type === "/Font") fonts += 1;
      if (type === "/Font" && getDictValue(dict, "ToUnicode")) unicodeMaps += 1;
      if (subtype === "/Image") images += 1;
      if (getDictValue(dict, "FontFile") || getDictValue(dict, "FontFile2") || getDictValue(dict, "FontFile3")) embeddedFonts += 1;
      if (getDictValue(dict, "SMask") || getDictValue(dict, "Group")) transparency += 1;
    });

    let contentStreams = 0;
    let annotations = 0;
    doc.getPages().forEach(page => {
      const rawContents = page.node.get(PDFLib.PDFName.of("Contents"));
      const contents = rawContents ? doc.context.lookup(rawContents) : null;
      contentStreams += contents instanceof PDFLib.PDFArray ? contents.size() : (contents ? 1 : 0);
      const rawAnnots = page.node.get(PDFLib.PDFName.of("Annots"));
      const annots = rawAnnots ? doc.context.lookup(rawAnnots) : null;
      annotations += annots instanceof PDFLib.PDFArray ? annots.size() : 0;
    });

    let formFields = 0;
    try { formFields = doc.getForm().getFields().length; } catch (error) { formFields = 0; }
    return {
      bytes: data.byteLength,
      pages: doc.getPageCount(),
      objects: objects.length,
      fonts,
      embeddedFonts,
      unicodeMaps,
      images,
      streams,
      contentStreams,
      annotations,
      formFields,
      transparency
    };
  }

  function classifyPdfError(error) {
    const message = String(error && error.message ? error.message : error);
    if (/encrypted|password/i.test(message)) return new Error("암호화되었거나 비밀번호로 보호된 PDF는 안전하게 최적화할 수 없습니다.");
    if (/header|parse|object|catalog|invalid|xref|trailer/i.test(message)) return new Error("손상되었거나 지원하지 않는 PDF 구조입니다.");
    return new Error(`PDF 처리에 실패했습니다: ${message}`);
  }

  function removeFlattenedWidgetAnnotations(doc) {
    doc.getPages().forEach(page => {
      const rawAnnots = page.node.get(PDFLib.PDFName.of("Annots"));
      const annots = rawAnnots ? doc.context.lookup(rawAnnots) : null;
      if (!(annots instanceof PDFLib.PDFArray)) return;
      for (let index = annots.size() - 1; index >= 0; index -= 1) {
        const annotation = doc.context.lookup(annots.get(index));
        if (!annotation || pdfName(getDictValue(annotation, "Subtype")) === "/Widget") annots.remove(index);
      }
    });
  }

  async function optimizePdf(input, options) {
    requireLibraries();
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const maximum = options && options.maxBytes ? options.maxBytes : MAX_PDF_BYTES;
    if (!data.byteLength) throw new Error("빈 파일은 처리할 수 없습니다.");
    if (data.byteLength > maximum) throw new Error(`PDF는 ${formatBytes(maximum)} 이하여야 합니다.`);
    if (data[0] !== 0x25 || data[1] !== 0x50 || data[2] !== 0x44 || data[3] !== 0x46) {
      throw new Error("유효한 PDF 파일이 아닙니다.");
    }

    try {
      const source = await PDFLib.PDFDocument.load(data, {
        updateMetadata: false,
        ignoreEncryption: false,
        throwOnInvalidObject: false
      });
      if (source.isEncrypted) throw new Error("encrypted PDF");
      const before = await inspectPdf(data, source);
      const warnings = [];

      try {
        const form = source.getForm();
        if (form.getFields().length) {
          form.flatten({ updateFieldAppearances: false });
          removeFlattenedWidgetAnnotations(source);
        }
      } catch (error) {
        warnings.push("일부 양식 필드는 외형을 안전하게 고정할 수 없어 원본 상태로 유지했습니다.");
      }

      const output = await PDFLib.PDFDocument.create();
      const copiedPages = await output.copyPages(source, source.getPageIndices());
      copiedPages.forEach(page => output.addPage(page));
      removeFlattenedWidgetAnnotations(output);
      output.setTitle("Optimized PDF");
      output.setCreator("CANB PDF Optimizer");
      output.setProducer("pdf-lib 1.17.1 clean object graph rewrite");
      output.setSubject("Structurally rewritten PDF for simpler parsing");
      const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 25 });
      const after = await inspectPdf(bytes);
      if (after.objects >= before.objects) {
        warnings.push("이 문서는 이미 단순하거나 페이지 내부 콘텐츠 자체가 복잡해 객체 수가 줄지 않았습니다.");
      }
      if (bytes.byteLength > data.byteLength) {
        warnings.push("구조 재작성 결과 파일 크기는 증가했지만, 원본의 미사용 문서 그래프와 문서 수준 부가 구조는 제거되었습니다.");
      }
      return { bytes, before, after, warnings };
    } catch (error) {
      if (/PDF는|유효한|빈 파일/.test(String(error && error.message))) throw error;
      throw classifyPdfError(error);
    }
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return Object.freeze({
    MAX_PDF_BYTES,
    analyzePdf: inspectPdf,
    createWorksheetPdf,
    downloadBytes,
    formatBytes,
    optimizePdf,
    parseMarkup,
    safeFilename,
    wrapStyledText
  });
});
