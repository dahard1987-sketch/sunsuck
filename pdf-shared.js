(function attachPdfShared(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vendor/pdf-lib.min.js"),
      require("./vendor/fontkit.umd.min.js")
    );
  } else {
    root.PdfShared = factory(root.PDFLib, root.fontkit);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfShared(PDFLib, fontkit) {
  "use strict";

  const PT_PER_MM = 72 / 25.4;
  const B5_WIDTH = 182 * PT_PER_MM;
  const B5_HEIGHT = 257 * PT_PER_MM;

  function requireLibraries() {
    if (!PDFLib || !fontkit) {
      throw new Error("PDF 엔진을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    }
  }

  function mm(value) {
    return value * PT_PER_MM;
  }

  function isStrippedControlCode(code) {
    if (code <= 0x08) return true;
    if (code === 0x0b || code === 0x0c) return true;
    if (code >= 0x0e && code <= 0x1f) return true;
    return false;
  }

  function cleanText(value) {
    const text = String(value == null ? "" : value);
    let result = "";
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (isStrippedControlCode(code)) continue;
      result += text[index];
    }
    return result.trim();
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
    const fontNames = new Set();

    objects.forEach(([, object]) => {
      const dict = object instanceof PDFLib.PDFStream ? object.dict : object;
      if (object instanceof PDFLib.PDFStream) streams += 1;
      const type = pdfName(getDictValue(dict, "Type"));
      const subtype = pdfName(getDictValue(dict, "Subtype"));
      if (type === "/Font") fonts += 1;
      if (type === "/Font" && getDictValue(dict, "BaseFont")) fontNames.add(pdfName(getDictValue(dict, "BaseFont")));
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
      transparency,
      fontNames: Array.from(fontNames).sort()
    };
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
    PT_PER_MM,
    B5_WIDTH,
    B5_HEIGHT,
    requireLibraries,
    mm,
    cleanText,
    safeFilename,
    formatBytes,
    pdfName,
    getDictValue,
    inspectPdf,
    downloadBytes
  });
});
