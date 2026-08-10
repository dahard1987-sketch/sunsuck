const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PDFLib = require("../vendor/pdf-lib.min.js");
const PdfWorkflow = require("../pdf-workflow.js");

const fontBytes = fs.readFileSync(path.join(__dirname, "../assets/NanumGothic-Regular.ttf"));

function settings(overrides = {}) {
  return {
    worksheetTitle: "한글 English 해석지",
    categoryLabel: "해석지 숙제",
    semesterLabel: "2026 여름학기",
    unitTitle: "Unit 1. Clauses / Phrases",
    teacherName: "최영진",
    className: "X2-A",
    worksheetDate: "2026. 08. 10.",
    footerText: "CANB English",
    accentColor: "#c4171d",
    fontSize: "standard",
    guideStyle: "subtle",
    showNumbers: true,
    showFooter: true,
    showAnswerHint: true,
    ...overrides
  };
}

function layout(pageCount = 1) {
  const sentences = [
    "This is **bold**, *italic*, and __underlined__ English text.",
    "Korean fallback 테스트와 English text가 함께 있는 문장입니다.",
    "A deliberately long comment-like sentence verifies wrapping across multiple lines without turning selectable text into a screenshot."
  ];
  const groups = pageCount === 1
    ? [{ indices: [0, 1, 2], heights: [68, 72, 90] }]
    : [{ indices: [0, 1], heights: [95, 110] }, { indices: [2], heights: [210] }];
  return {
    settings: settings(),
    sentences,
    millimeterInPixels: 96 / 25.4,
    result: {
      plan: {
        overflow: false,
        fitLevel: { name: "normal", fontScale: 1, leading: 1.42 },
        pageGroups: groups
      }
    }
  };
}

test("markup parser keeps supported inline styles", () => {
  const runs = PdfWorkflow.parseMarkup("plain **bold** *italic* __underlined__");
  assert.equal(runs.map(run => run.text).join(""), "plain bold italic underlined");
  assert.equal(runs.find(run => run.text === "bold").bold, true);
  assert.equal(runs.find(run => run.text === "italic").italic, true);
  assert.equal(runs.find(run => run.text === "underlined").underline, true);
});

test("one-page export is a simple vector/text B5 PDF with one Korean font", async () => {
  const result = await PdfWorkflow.createWorksheetPdf(layout(1), { fontBytes });
  assert.equal(Buffer.from(result.bytes).subarray(0, 5).toString(), "%PDF-");
  assert.equal(result.metrics.pages, 1);
  assert.equal(result.metrics.images, 0, "whole-page rasterization must never occur");
  assert.equal(result.metrics.contentStreams, 1);
  assert.equal(result.metrics.embeddedFonts, 1);
  assert.ok(result.metrics.unicodeMaps >= 1, "Korean text must retain a searchable Unicode map");
  assert.ok(result.metrics.objects < 30, `unexpected object count: ${result.metrics.objects}`);
  assert.ok(result.bytes.length < 1_000_000, `unexpected file size: ${result.bytes.length}`);
});

test("multi-page export keeps one content stream per page and reuses resources", async () => {
  const result = await PdfWorkflow.createWorksheetPdf(layout(2), { fontBytes });
  assert.equal(result.metrics.pages, 2);
  assert.equal(result.metrics.contentStreams, 2);
  assert.equal(result.metrics.embeddedFonts, 1);
  assert.equal(result.metrics.images, 0);
  assert.equal(result.metrics.transparency, 0);
});

test("optimizer flattens forms and drops unreachable document objects", async () => {
  const source = await PDFLib.PDFDocument.create();
  const page = source.addPage([400, 500]);
  const font = await source.embedFont(PDFLib.StandardFonts.Helvetica);
  page.drawText("Browser-like vector PDF", { x: 40, y: 450, size: 16, font });
  for (let index = 0; index < 60; index += 1) {
    source.context.register(source.context.obj({ UnusedDiagnosticObject: index }));
  }
  const form = source.getForm();
  const field = form.createTextField("student-name");
  field.setText("Selectable text");
  field.addToPage(page, { x: 40, y: 390, width: 180, height: 24, font });
  const input = await source.save({ useObjectStreams: false });

  const result = await PdfWorkflow.optimizePdf(input);
  assert.equal(result.before.pages, result.after.pages);
  assert.equal(result.after.formFields, 0);
  assert.equal(result.after.annotations, 0);
  assert.ok(result.after.objects < result.before.objects, `${result.before.objects} -> ${result.after.objects}`);
  assert.notDeepEqual(Buffer.from(result.bytes), Buffer.from(input), "optimizer must rewrite rather than copy bytes");
});

test("optimizer rejects invalid and oversized inputs with explicit errors", async () => {
  await assert.rejects(() => PdfWorkflow.optimizePdf(new Uint8Array([1, 2, 3])), /PDF|파일/);
  await assert.rejects(
    () => PdfWorkflow.optimizePdf(new Uint8Array(Buffer.from("%PDF-123456")), { maxBytes: 5 }),
    /이하여야/
  );
});
