// ============================================================
// green_graded.ts — ONE merged, green-stamped PDF (index order + graded_json)
// Route: POST /build-green-graded/:id
// Source of truth: quizzes.graded_json (JSON array). No grades table, no OCR for identity.
// ============================================================

import { Express, Request, Response } from "express";
import { PDFDocument, StandardFonts, rgb, PDFPage, degrees } from "pdf-lib";

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
  student_name?: string;
  roll_number?: string;
  total_score?: number;
  max_score?: number;
  remarks?: string;
  questions?: Question[];
};

// ------------------ WinAnsi-safe helper ------------------
function toWinAnsi(text: string): string {
  if (!text) return "";
  let s = text.normalize("NFKD");
  s = s
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/\u2026/g, "...");
  s = s
    .replace(/[↳↵→⇒➜➔➤⟶⟹]/g, "->")
    .replace(/[←⟵]/g, "<-")
    .replace(/[▲△▴▵]/g, "^")
    .replace(/[▼▽▾▿]/g, "v")
    .replace(/[✓✔✅]/g, "v")
    .replace(/[✗✘❌]/g, "x");
  s = s.replace(/[^\u000A\u000D\u0020-\u007E]/g, "");
  return s.replace(/[ \t]+/g, " ").trim();
}

// ------------------ Tiny utils ------------------
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

const green = () => rgb(0.05, 0.55, 0.05);
// Keep function name for compatibility; now returns WHITE sticky color
const pinkSticky = () => rgb(1, 1, 1);
const purple = () => rgb(0.55, 0.2, 0.85);
const redPen = () => rgb(0.85, 0.05, 0.05);

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
    } else {
      cur = tryLine;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------ Robust formatted_text loader (kept for compatibility) ------------------
function stripCodeFence(s: string): string {
  return s.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
}
function parseMaybeArray(val: any): StudentGraded[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as StudentGraded[];
  if (typeof val === "string") {
    let raw = val.trim();
    raw = stripCodeFence(raw);
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StudentGraded[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ------------------ Visuals: centered, WinAnsi-safe purple CHECKED stamp ------------------
function drawCheckedStamp(p: PDFPage, fonts: { bold: any }) {
  const { width, height } = p.getSize();
  const cx = width / 2;
  const cy = height / 2;
  const R = 90;

  // soft fill
  p.drawEllipse({ x: cx, y: cy, xScale: R, yScale: R, color: purple(), opacity: 0.12 });

  // triple rings
  p.drawEllipse({ x: cx, y: cy, xScale: R, yScale: R, borderColor: purple(), borderWidth: 3, opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy, xScale: R - 8, yScale: R - 8, borderColor: purple(), borderWidth: 2, opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy, xScale: R - 16, yScale: R - 16, borderColor: purple(), borderWidth: 1.5, opacity: 0.9 });

  // word
  const word = "CHECKED";
  const fs = 22;
  const tw = fonts.bold.widthOfTextAtSize(word, fs);
  p.drawText(word, {
    x: cx - tw / 2,
    y: cy - fs / 2 + 4,
    size: fs,
    color: purple(),
    font: fonts.bold,
    rotate: degrees(-18),
    opacity: 0.9,
  });

  // decorative dots (vector, WinAnsi-safe)
  const dotR = 3.2;
  p.drawEllipse({ x: cx, y: cy + R - 16, xScale: dotR, yScale: dotR, color: purple(), opacity: 0.9 });
  p.drawEllipse({ x: cx, y: cy - R + 16, xScale: dotR, yScale: dotR, color: purple(), opacity: 0.9 });
}

// ------------------ Drawing ------------------
async function drawGreenCircleAndSticky(
  p: PDFPage,
  fonts: { bold: any; regular: any; hand: any; handBold: any },
  student: StudentGraded,
  options?: {
    circle?: { x?: number; y?: number; r?: number };
    sticky?: { x?: number; y?: number; w?: number; h?: number; fontSize?: number; smallSize?: number };
  }
) {
  const { width, height } = p.getSize();

  // Centered stamp
  drawCheckedStamp(p, { bold: fonts.bold });

  // Circle (top-right)
  const r = options?.circle?.r ?? 48;
  const cx = options?.circle?.x ?? (width - r - 36);
  const cy = options?.circle?.y ?? (height - r - 36);

  p.drawEllipse({
    x: cx,
    y: cy,
    xScale: r,
    yScale: r,
    borderColor: green(),
    borderWidth: 4,
  });

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

  // Sticky at bottom (WHITE)
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

  const header = toWinAnsi(
    `${student.student_name || "Student"} (${student.roll_number || "-"}) — ${obtained} / ${total}`
  );

  // Header in red, handwritten-looking font (straight)
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
    for (const q of (student.questions as Question[])) {
      const qn = q.number ?? "?";
      const mm = q.max_marks ?? "-";
      lines.push({ text: toWinAnsi(`Q${qn}: ${q.marks ?? 0}/${mm}` + (q.topic ? ` — ${q.topic}` : "")) });
      if (Array.isArray(q.subparts) && q.subparts.length) {
        const subs = (q.subparts as Subpart[])
          .map((s) => `${s.label ?? "?"}:${s.marks ?? 0}/${s.max_marks ?? "-"}`)
          .join("   ");
        lines.push({ text: toWinAnsi(`   • ${subs}`), small: true });
      }
      if (q.remarks) {
        for (const w of wrapLines(q.remarks, 90)) {
          lines.push({ text: toWinAnsi(`   -> ${w}`), small: true });
        }
      }
    }
  }
  if (student.remarks) {
    lines.push({ text: "" });
    lines.push({ text: toWinAnsi("Feedback:") });
    for (const w of wrapLines(student.remarks, 90)) {
      lines.push({ text: toWinAnsi(w), small: true });
    }
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
}

async function annotateStudentPage(outDoc: PDFDocument, page: PDFPage, student: StudentGraded) {
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  // Handwritten-looking fonts
  const hand = await outDoc.embedFont(StandardFonts.HelveticaOblique);
  const handBold = await outDoc.embedFont(StandardFonts.HelveticaBoldOblique);

  await drawGreenCircleAndSticky(page, { bold: fontBold, regular: font, hand, handBold }, student);

  const footerText = toWinAnsi(`${student.student_name || "Student"} (${student.roll_number || "-"})`);
  const fs = 9;
  const { width } = page.getSize();
  const w = font.widthOfTextAtSize(footerText, fs);
  page.drawText(footerText, {
    x: width - w - 36,
    y: 24,
    size: fs,
    color: rgb(0.15, 0.15, 0.15),
    font,
  });
}

// ------------------ Main builder ------------------
export async function buildGreenMergedPdf(supabase: any, quizId: string): Promise<string> {
  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, original_pdf, graded_json, no_of_pages")
    .eq("id", quizId)
    .single();
  if (quizError || !quiz?.original_pdf) {
    throw new Error("Quiz or original PDF not found");
  }

  // Use ONLY graded_json for marks/feedback
  const gradedArray: StudentGraded[] = Array.isArray((quiz as any)?.graded_json)
    ? ((quiz as any).graded_json as StudentGraded[])
    : [];

  const { data: file, error: dErr } = await supabase.storage
    .from(QUIZ_BUCKET)
    .download(quiz.original_pdf);
  if (dErr || !file) throw new Error("Failed to download original quiz PDF");
  const originalBuf = Buffer.from(await (file as any).arrayBuffer());

  const src = await PDFDocument.load(originalBuf);
  const out = await PDFDocument.create();

  const pageCount = src.getPageCount();

  // NEW: pages per student (defaults to 1 if null/invalid)
  const pagesPerStudent = Math.max(1, Number((quiz as any).no_of_pages || 1));

  // Copy every page, but only annotate the FIRST page of each student's block.
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const [copied] = await out.copyPages(src, [pageIdx]);
    out.addPage(copied);

    if (pageIdx % pagesPerStudent === 0) {
      const studentIdx = Math.floor(pageIdx / pagesPerStudent);
      const g = gradedArray[studentIdx] || {};
      const student: StudentGraded = {
        student_name: g.student_name || "",
        roll_number: g.roll_number || "",
        total_score: g.total_score ?? 0,
        max_score: g.max_score ?? 0,
        remarks: g.remarks || "",
        questions: Array.isArray(g.questions) ? g.questions : [],
      };
      await annotateStudentPage(out, copied, student);
    }
    // Otherwise: leave middle pages of the block un-annotated (only mapping shift changes).
  }

  const bytes = await out.save();
  const ab = toArrayBuffer(bytes);
  const objectName = `green/${quizId}-green-merged-${Date.now()}.pdf`;

  const { error: upErr } = await supabase.storage
    .from(GRADED_BUCKET)
    .upload(objectName, ab as any, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (upErr) throw upErr;

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${GRADED_BUCKET}/${objectName}`;
  return publicUrl;
}

// ------------------ Express route ------------------
export function setupGreenGradedRoutes(app: Express, supabase: any) {
  app.post("/build-green-graded/:id", async (req: Request, res: Response) => {
    try {
      const quizId = req.params.id;
      const url = await buildGreenMergedPdf(supabase, quizId);
      res.json({ success: true, url });
    } catch (e: any) {
      console.error("❌ Build Green Merged Error:", e.message);
      res.status(500).json({ success: false, error: `Build Green Merged Error: ${e.message}` });
    }
  });
}
