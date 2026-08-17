(function attachPdfWorkflow(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./pdf-shared.js"),
      require("./pdf-export.js"),
      require("./pdf-optimize.js")
    );
  } else {
    root.PdfWorkflow = factory(root.PdfShared, root.PdfExport, root.PdfOptimize);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfWorkflow(PdfShared, PdfExport, PdfOptimize) {
  "use strict";

  return Object.freeze({
    MAX_PDF_BYTES: PdfOptimize.MAX_PDF_BYTES,
    analyzePdf: PdfShared.inspectPdf,
    createWorksheetPdf: PdfExport.createWorksheetPdf,
    downloadBytes: PdfShared.downloadBytes,
    formatBytes: PdfShared.formatBytes,
    optimizePdf: PdfOptimize.optimizePdf,
    parseMarkup: PdfExport.parseMarkup,
    safeFilename: PdfShared.safeFilename,
    wrapStyledText: PdfExport.wrapStyledText
  });
});
