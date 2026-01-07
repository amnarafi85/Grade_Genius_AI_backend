// ============================================================
// green_page_map.ts — Types + page mapping helper
// ============================================================

export interface Subpart {
  label?: string;
  marks?: number;
  max_marks?: number;
}

export interface Question {
  number?: number | string;
  marks?: number;
  max_marks?: number;
  topic?: string;
  subparts?: Subpart[];
  remarks?: string;
}

export interface StudentGraded {
  student_name?: string;
  roll_number?: string;
  total_score?: number;
  max_score?: number;
  // Optional precomputed page indices for this student (0-based).
  page_indices?: number[];
  questions?: Question[];
  remarks?: string;
}

/**
 * Sanitize a candidate list of indices to be unique, in-range, sorted numbers.
 */
function normalizeIndices(indices: unknown[], pageCount: number): number[] {
  // ensure numbers
  const nums: number[] = (indices || [])
    .map((v) => (typeof v === "number" ? v : Number.isFinite(v as any) ? Number(v) : NaN))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < pageCount);

  // unique + sort
  return Array.from(new Set(nums)).sort((a: number, b: number) => a - b);
}

/**
 * Fallback: split `pageCount` pages as evenly as possible across `n` students.
 * Each student gets `base` pages, and the first `remainder` students get +1.
 */
function evenSplit(pageCount: number, n: number): number[][] {
  const result: number[][] = [];
  if (n <= 0 || pageCount <= 0) {
    for (let i = 0; i < Math.max(0, n); i++) result.push([]);
    return result;
  }
  const base = Math.floor(pageCount / n);
  let remainder = pageCount - base * n;

  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const take = base + (remainder > 0 ? 1 : 0);
    const slice: number[] = Array.from({ length: take }, (_, k) => cursor + k);
    result.push(slice);
    cursor += take;
    if (remainder > 0) remainder -= 1;
  }
  return result;
}

/**
 * Try to infer boundaries from `page_texts` by detecting the "Name:" header
 * that your OCR pipeline injects for the first page of each student's block.
 * If that pattern isn't reliable/present, we simply return [] to indicate
 * "couldn't infer", letting the caller fall back to even split.
 */
function inferByPageTexts(page_texts?: string[], expectedStudents?: number): number[][] {
  if (!Array.isArray(page_texts) || page_texts.length === 0 || !expectedStudents) return [];

  // Find pages that look like the first page of a student's block.
  // Your OCR prompts prepend:
  //   Name: <value>
  //   Roll: <value>
  //   ----
  const starts: number[] = [];
  for (let i = 0; i < page_texts.length; i++) {
    const t = (page_texts[i] || "").toLowerCase();
    if (t.includes("name:") && t.includes("roll:")) {
      starts.push(i);
    }
  }
  if (starts.length === 0) return [];

  // Build ranges [start_i, start_{i+1}) and last to end
  const ranges: number[][] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : page_texts.length;
    const indices = Array.from({ length: Math.max(0, e - s) }, (_, k) => s + k);
    ranges.push(indices);
  }

  // If we found fewer or more blocks than students, still return what we found;
  // caller will align or fall back to even split when needed.
  return ranges;
}

/**
 * Map pages to students.
 * Priority:
 *  1) If a student already has `page_indices`, sanitize and keep them.
 *  2) Else, try to infer block boundaries from `page_texts` (if they contain
 *     the normalized "Name:/Roll:" header you generate in OCR).
 *  3) Else, do an even split over total `pageCount`.
 */
export function mapPagesToStudents(
  pageCount: number,
  students: StudentGraded[],
  page_texts?: string[]
): StudentGraded[] {
  const totalPages = Math.max(0, pageCount | 0);
  const list = Array.isArray(students) ? students : [];
  const n = Math.max(0, list.length);

  if (n === 0) return [];

  // If everyone already has page_indices, sanitize and return.
  const allProvided = list.every((s) => Array.isArray(s.page_indices) && s.page_indices.length > 0);
  if (allProvided) {
    return list.map((s) => ({
      ...s,
      page_indices: normalizeIndices(s.page_indices as unknown[], totalPages),
    }));
  }

  // Try inference from page_texts (block starts via "Name:"/"Roll:")
  const inferredBlocks = inferByPageTexts(page_texts, n);
  if (inferredBlocks.length >= 1) {
    // If number of inferred blocks == students, map 1:1
    if (inferredBlocks.length === n) {
      return list.map((s, i) => ({
        ...s,
        page_indices: normalizeIndices(inferredBlocks[i], totalPages),
      }));
    }
    // If different counts, assign in order while available, then even split for the rest
    const out: StudentGraded[] = [];
    const min = Math.min(n, inferredBlocks.length);
    for (let i = 0; i < min; i++) {
      out.push({
        ...list[i],
        page_indices: normalizeIndices(inferredBlocks[i], totalPages),
      });
    }
    if (min < n) {
      const remaining = n - min;
      const used = inferredBlocks.flat().length;
      // Pages not covered by inference → spread evenly to remaining students
      const remainingPages: number[] = Array.from({ length: totalPages }, (_, i) => i).filter(
        (p) => !inferredBlocks.some((blk) => blk.includes(p))
      );
      const split = evenSplit(remainingPages.length, remaining);
      let cursor = 0;
      for (let j = 0; j < remaining; j++) {
        const take = split[j] || [];
        const indices = take.map(() => remainingPages[cursor++]).filter((x) => x != null);
        out.push({ ...list[min + j], page_indices: normalizeIndices(indices, totalPages) });
      }
    }
    return out;
  }

  // Even split fallback
  const split = evenSplit(totalPages, n);
  return list.map((s, i) => ({
    ...s,
    page_indices: normalizeIndices(split[i] || [], totalPages),
  }));
}
