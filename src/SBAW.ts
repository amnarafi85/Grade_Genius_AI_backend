// ============================================================
// SWAB.ts — Build a single combined PDF: Solution + Best + Avg + Low
// TRUST graded_json[] ORDER from quizzes table for page ↔ student mapping.
// No OCR is used here. All names/marks/feedback come from graded_json.
// Route: POST /build-sbab/:id  -> { success: true, sbab_pdf: "https://..." }
// ============================================================

import { Express, Request, Response } from "express";
import { PDFDocument, StandardFonts, PDFPage, PDFFont, rgb, degrees } from "pdf-lib";

const QUIZ_BUCKET = "quizzes";
const GRADED_BUCKET = "graded";

// ------------------ Types ------------------
type Subpart = { label?: string; marks?: number; max_marks?: number; remarks?: string };
type Question = {
  number?: number;
  marks?: number;
  max_marks?: number;
  remarks?: string;
  topic?: string;
  subparts?: Subpart[];
};
type StudentGraded = {
  student_name?: string | null;
  roll_number?: string | null;
  total_score?: number;
  max_score?: number;
  remarks?: string;
  questions?: Question[];
};

type Fonts = { bold: PDFFont; regular: PDFFont; hand: PDFFont; handBold: PDFFont };

// ------------------ Colors ------------------
const green = () => rgb(0.05, 0.55, 0.05);
// Keep function name but now WHITE sticky
const pinkSticky = () => rgb(1, 1, 1);
const yellow = () => rgb(1, 1, 0.55);
const purple = () => rgb(0.55, 0.2, 0.85);
const redPen = () => rgb(0.85, 0.05, 0.05);

// ------------------ Small helpers ------------------
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function toWinAnsi(text: string): string {
  if (!text) return "";
  let s: string = text.normalize("NFKD");
  s = s
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[↳↵→⇒➜➔➤⟶⟹]/g, "->")
    .replace(/[←⟵]/g, "<-")
    .replace(/[▲△▴▵]/g, "^")   // <-- fixed: proper .replace(...)
    .replace(/[▼▽▾▿]/g, "v")
    .replace(/[✓✔✅]/g, "v")
    .replace(/[✗✘❌]/g, "x")
    .replace(/[^\u000A\u000D\u0020-\u007E]/g, "")
    .replace(/[ \t]+/g, " ");
  return s.trim();
}

function wrapLines(text: string, maxChars = 90): string[] {
  const t = toWinAnsi(text || "");
  if (!t) return [];
  const words = t.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const tryLine = cur ? cur + " " + w : w;
    if (tryLine.length > maxChars) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = tryLine;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------ formatted_text helpers (kept for compatibility; not used) ------------------
function stripFence(s: string) {
  return s.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
}
function parseFormatted(val: any): StudentGraded[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as StudentGraded[];
  if (typeof val === "string") {
    try {
      return JSON.parse(stripFence(val)) as StudentGraded[];
    } catch {
      return [];
    }
  }
  return [];
}

// ------------------ Visuals: centered, WinAnsi-safe purple CHECKED stamp ------------------
function drawCheckedStamp(p: PDFPage, fonts: Fonts) {
  const { width, height } = p.getSize();
  const cx = width / 2;
  const cy = height / 2;
  const R = 90;

  // light fill + triple rings
  p.drawEllipse({ x: cx, y: cy, xScale: R, yScale: R, color: purple(), opacity: 0.12 });
  p.drawEllipse({ x: cx, y: cy, xScale: R, yScale: R, borderColor: purple(), borderWidth: 3, opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy, xScale: R - 8, yScale: R - 8, borderColor: purple(), borderWidth: 2, opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy, xScale: R - 16, yScale: R - 16, borderColor: purple(), borderWidth: 1.5, opacity: 0.9 });

  // word
  const text = "CHECKED";
  const fs = 22;
  const tw = fonts.bold.widthOfTextAtSize(text, fs);
  p.drawText(text, {
    x: cx - tw / 2,
    y: cy - fs / 2 + 4,
    size: fs,
    color: purple(),
    font: fonts.bold,
    rotate: degrees(-18),
    opacity: 0.9,
  });

  // decorative dots (vector; no Unicode)
  const dotR = 3.2;
  p.drawEllipse({ x: cx, y: cy + R - 16, xScale: dotR, yScale: dotR, color: purple(), opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy - R + 16, xScale: dotR, yScale: dotR, color: purple(), opacity: 0.9 });
}

// ------------------ Drawing helpers ------------------
async function drawGreenCircleAndSticky(
  p: PDFPage,
  fonts: Fonts,
  student: StudentGraded,
  options?: {
    circle?: { x?: number; y?: number; r?: number };
    sticky?: {
      x?: number; y?: number; w?: number; h?: number;
      fontSize?: number; smallSize?: number;
      // Optional prefix (e.g., "Solution Paper") — only used when provided
      titlePrefix?: string;
    };
  }
) {
  const { width, height } = p.getSize();

  // Centered purple CHECKED stamp
  drawCheckedStamp(p, fonts);

  // Green circle (top-right)
  const r = options?.circle?.r ?? 48;
  const cx = options?.circle?.x ?? (width - r - 36);
  const cy = options?.circle?.y ?? (height - r - 36);
  p.drawEllipse({ x: cx, y: cy, xScale: r, yScale: r, borderColor: green(), borderWidth: 4 });

  const obtained = student.total_score ?? 0;
  const total = student.max_score ?? 0;
  const scoreText = toWinAnsi(`${obtained}/${total}`);
  const label = toWinAnsi("Marks");

  const scoreSize = 16;
  const labelSize = 9;
  const scoreW = fonts.bold.widthOfTextAtSize(scoreText, scoreSize);
  const labelW = fonts.regular.widthOfTextAtSize(label, labelSize);

  p.drawText(scoreText, { x: cx - scoreW / 2, y: cy - 6, size: scoreSize, color: green(), font: fonts.bold });
  p.drawText(label, { x: cx - labelW / 2, y: cy - 22, size: labelSize, color: green(), font: fonts.regular });

  // White sticky (bottom)
  const margin = 36;
  const stickyW = options?.sticky?.w ?? Math.min(460, width - margin * 2);
  const stickyH = options?.sticky?.h ?? 200;
  const stickyX = options?.sticky?.x ?? margin;
  const stickyY = options?.sticky?.y ?? margin;
  const fs = options?.sticky?.fontSize ?? 11;
  const fsSmall = options?.sticky?.smallSize ?? 9;

  p.drawRectangle({
    x: stickyX,
    y: stickyY,
    width: stickyW,
    height: stickyH,
    color: pinkSticky(),
    borderColor: green(),
    borderWidth: 2,
    opacity: 0.98,
  });

  // Header with optional prefix (e.g., "Solution Paper")
  const headerCore = toWinAnsi(
    `${student.student_name || "Student"} (${student.roll_number || "-"}) — ${obtained} / ${total}`
  );
  const header = options?.sticky?.titlePrefix
    ? toWinAnsi(`${options.sticky.titlePrefix} ${headerCore}`)
    : headerCore;

  // Header in red, handwritten-style font (straight)
  p.drawText(header, {
    x: stickyX + 10,
    y: stickyY + stickyH - 20,
    size: 13,
    color: redPen(),
    font: fonts.handBold,
    maxWidth: stickyW - 20,
  });

  type L = { text: string; small?: boolean };
  const lines: L[] = [];
  if (Array.isArray(student.questions)) {
    for (const q of student.questions as Question[]) {
      const qn = q.number ?? "?";
      const mm = q.max_marks ?? "-";
      lines.push({ text: toWinAnsi(`Q${qn}: ${q.marks ?? 0}/${mm}` + (q.topic ? ` — ${q.topic}` : "")) });
      if (Array.isArray(q.subparts) && q.subparts.length) {
        const subs = (q.subparts as Subpart[])
          .map((s) => `${s.label ?? "?"}:${s.marks ?? 0}/${s.max_marks ?? "-"}`)
          .join("   ");
        lines.push({ text: toWinAnsi(`   • ${subs}`), small: true });
      }
      if (q.remarks) for (const w of wrapLines(q.remarks, 90)) lines.push({ text: toWinAnsi(`   -> ${w}`), small: true });
    }
  }
  if (student.remarks) {
    lines.push({ text: "" });
    lines.push({ text: toWinAnsi("Feedback:") });
    for (const w of wrapLines(student.remarks, 90)) lines.push({ text: toWinAnsi(w), small: true });
  }

  // Straight, aligned text in red "handwritten" font
  let cursorY = stickyY + stickyH - 38;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const size = line.small ? fsSmall : fs;
    const lineH = size + 3;
    if (cursorY < stickyY + 12) break;
    p.drawText(line.text, {
      x: stickyX + 10,
      y: cursorY,
      size,
      color: redPen(),
      font: fonts.hand,
      maxWidth: stickyW - 20,
      rotate: degrees(0),
    });
    cursorY -= lineH;
  }

  // Footer
  const footer = toWinAnsi(`${student.student_name || "Student"} (${student.roll_number || "-"})`);
  const fsFooter = 9;
  const w = fonts.regular.widthOfTextAtSize(footer, fsFooter);
  p.drawText(footer, { x: width - w - 36, y: 24, size: fsFooter, color: rgb(0.15, 0.15, 0.15), font: fonts.regular });
}

async function drawYellowTag(page: PDFPage, fonts: Fonts, label: "Solution" | "Best" | "Avg" | "Low") {
  const { width, height } = page.getSize();
  const tagW = 110;
  const tagH = 28;
  const x = width - tagW - 36;
  const y = height - tagH - 36;

  page.drawRectangle({
    x,
    y,
    width: tagW,
    height: tagH,
    color: yellow(),
    opacity: 0.95,
    borderColor: rgb(0.2, 0.2, 0.2),
    borderWidth: 1.5,
  });
  const text = `${label}`;
  const fs = 12;
  const tw = fonts.bold.widthOfTextAtSize(text, fs);
  page.drawText(text, {
    x: x + (tagW - tw) / 2,
    y: y + (tagH - fs) / 2 + 3,
    size: fs,
    color: rgb(0.15, 0.15, 0.15),
    font: fonts.bold,
  });
}

// ------------------ Selection logic (graded_json order) ------------------
type Mapped = { index: number; pageIndex: number; student: StudentGraded };

function pickSolutionIndex(arr: Mapped[]): number {
  const cand = arr.find((m) => {
    const n = (m.student?.student_name || "").toLowerCase();
    return /^unknown_/.test(n) || /^solution_paper_/.test(n);
  });
  if (cand) return cand.pageIndex;
  return arr[0]?.pageIndex ?? 0;
}

// ------------------ Core: select pages & build ------------------
async function selectFromFormattedAndBuild(
  supabase: any,
  quizId: string
): Promise<{ mapped: Mapped[]; srcBytes: Uint8Array; solutionIdx: number | null; bestIdx: number; avgIdx: number; lowIdx: number }> {
  const { data: quiz, error: qErr } = await supabase
    .from("quizzes")
    .select("id, original_pdf, graded_json, no_of_pages, read_first_paper_is_solution")
    .eq("id", quizId)
    .single();
  if (qErr || !quiz?.original_pdf) throw new Error("Quiz or original PDF not found");

  const { data: file, error: dErr } = await supabase.storage.from(QUIZ_BUCKET).download(quiz.original_pdf);
  if (dErr || !file) throw new Error("Failed to download original quiz PDF");
  const srcBytes = new Uint8Array(await (file as any).arrayBuffer());
  const srcDoc = await PDFDocument.load(srcBytes);
  const pageCount = srcDoc.getPageCount();

  // ✅ Take marks/feedback directly from graded_json
  const graded: StudentGraded[] = Array.isArray((quiz as any).graded_json)
    ? ((quiz as any).graded_json as StudentGraded[])
    : [];

  // pages per student (defaults to 1 if null/invalid)
  const pagesPerStudent = Math.max(1, Number((quiz as any).no_of_pages || 1));

  // We map ONLY the FIRST page of each student's block (0, p, 2p, ...)
  const maxStudentsByPages = Math.floor(pageCount / pagesPerStudent);
  const useStudents = Math.min(graded.length, maxStudentsByPages);

  const mapped: Mapped[] = [];
  for (let i = 0; i < useStudents; i++) {
    const firstPageOfBlock = i * pagesPerStudent;
    mapped.push({ index: i, pageIndex: firstPageOfBlock, student: graded[i] || {} });
  }

  // Decide using DB column (default true if null/undefined)
  const readFirstPaperIsSolution = (quiz as any).read_first_paper_is_solution !== false;

  // If we treat the first paper as a dedicated solution, exclude it from rankings.
  // Otherwise, include ALL mapped when computing Best/Avg/Low.
  let solutionIdx: number | null = null;
  let pool: Mapped[] = mapped;

  if (readFirstPaperIsSolution) {
    solutionIdx = pickSolutionIndex(mapped);
    pool = mapped.filter((m) => m.pageIndex !== solutionIdx);
  }

  // Rank by score
  const sorted = [...pool].sort(
    (a, b) => (b.student.total_score ?? 0) - (a.student.total_score ?? 0)
  );

  const bestIdx = sorted[0]?.pageIndex ?? (pool[0]?.pageIndex ?? (mapped[0]?.pageIndex ?? 0));
  const lowIdx  = sorted[sorted.length - 1]?.pageIndex ?? (pool[0]?.pageIndex ?? (mapped[0]?.pageIndex ?? 0));
  const avgIdx  = sorted[Math.floor(sorted.length / 2)]?.pageIndex ?? (pool[0]?.pageIndex ?? (mapped[0]?.pageIndex ?? 0));

  return { mapped, srcBytes, solutionIdx, bestIdx, avgIdx, lowIdx };
}

// ------------------ Public builder ------------------
export async function buildSBABSingle(
  supabase: any,
  quizId: string
): Promise<{ sbab_pdf: string }> {
  const { mapped, srcBytes, solutionIdx, bestIdx, avgIdx, lowIdx } =
    await selectFromFormattedAndBuild(supabase, quizId);

  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();
  const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const hand = await out.embedFont(StandardFonts.HelveticaOblique);
  const handBold = await out.embedFont(StandardFonts.HelveticaBoldOblique);
  const fonts: Fonts = { bold: fontBold, regular: font, hand, handBold };

  // Build the output order depending on whether we include Solution or not
  const order: Array<{ label: "Solution" | "Best" | "Avg" | "Low"; page: number; student: StudentGraded }> = [];

  if (solutionIdx !== null) {
    order.push({
      label: "Solution",
      page: solutionIdx,
      student: (mapped.find(m => m.pageIndex === solutionIdx) || mapped[0]).student
    });
  }

  order.push(
    { label: "Best", page: bestIdx, student: (mapped.find(m => m.pageIndex === bestIdx) || mapped[0]).student },
    { label: "Avg",  page: avgIdx,  student: (mapped.find(m => m.pageIndex === avgIdx)  || mapped[0]).student },
    { label: "Low",  page: lowIdx,  student: (mapped.find(m => m.pageIndex === lowIdx)  || mapped[0]).student },
  );

  for (const item of order) {
    const [page] = await out.copyPages(src, [item.page]);
    out.addPage(page);

    const student: StudentGraded = {
      student_name: item.student.student_name ?? "",
      roll_number:  item.student.roll_number ?? "",
      total_score:  item.student.total_score ?? 0,
      max_score:    item.student.max_score ?? 0,
      remarks:      item.student.remarks ?? "",
      questions:    Array.isArray(item.student.questions) ? item.student.questions : [],
    };

    // Only prefix sticky title with "Solution Paper" when we truly have a Solution page
    await drawGreenCircleAndSticky(page, fonts, student, {
      sticky: {
        titlePrefix: item.label === "Solution" ? "Solution Paper" : undefined
      }
    });

    await drawYellowTag(page, fonts, item.label);
  }

  const bytes = await out.save();
  const ab = toArrayBuffer(bytes);
  const key = `sbaw/${quizId}-SBAB-${Date.now()}.pdf`;

  const { error } = await supabase.storage
    .from(GRADED_BUCKET)
    .upload(key, ab as any, { contentType: "application/pdf", upsert: true });
  if (error) throw error;

  const sbab_pdf = `${process.env.SUPABASE_URL}/storage/v1/object/public/${GRADED_BUCKET}/${key}`;
  return { sbab_pdf };
}

// ------------------ Route ------------------
export function setupSBABRoute(app: Express, supabase: any) {
  app.post("/build-sbab/:id", async (req: Request, res: Response) => {
    try {
      const quizId = req.params.id;
      const urls = await buildSBABSingle(supabase, quizId);
      res.json({ success: true, ...urls });
    } catch (e: any) {
      console.error("❌ Build SBAB Error:", e.message);
      res.status(500).json({ success: false, error: `Build SBAB Error: ${e.message}` });
    }
  });
}
