(function attachPdfOptimize(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vendor/pdf-lib.min.js"),
      require("./pdf-shared.js")
    );
  } else {
    root.PdfOptimize = factory(root.PDFLib, root.PdfShared);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfOptimize(PDFLib, PdfShared) {
  "use strict";

  const { requireLibraries, formatBytes, inspectPdf, pdfName, getDictValue } = PdfShared;
  const MAX_PDF_BYTES = 50 * 1024 * 1024;

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

  return Object.freeze({
    MAX_PDF_BYTES,
    optimizePdf
  });
});
