// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every change
// or none, printing what it changed or why it failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit applies itself to the tree, or throws Fail; a move edit returns [old, new]. */
type Move = [string, string];
type Edit = (tree: Tree) => Move | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- files as lines (SPEC.md section 3) ----

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

// ---- matching lines at three tiers (SPEC.md section 5) ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2) at which o occurs, with its positions; null when it never occurs. */
function findOccurrences(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the new side: a context line (written as the file's own matched line) or a fresh line. */
interface NewPart {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Resolve the new side at a match: context lines come from the file, other lines are
 * re-indented at tier 2 and written as they are at tiers 0 and 1. */
function resolveNew(parts: NewPart[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  return parts.map((p) => {
    if (p.ctx) return fileLines[pos + p.oIdx]!;
    if (tier !== 2 || o.length === 0) return p.text;
    if (p.text === '' || p.text.trim() === '') return p.text;
    const P = leadWs(o[0]!);
    if (!p.text.startsWith(P)) return p.text;
    return leadWs(fileLines[pos]!) + p.text.slice(P.length);
  });
}

/** A body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

/** Split a body into its old lines O and its new side (with context positions in O). */
function splitBody(body: BodyLine[]): { o: string[]; n: NewPart[] } {
  const o: string[] = [];
  const n: NewPart[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: true, oIdx: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function bodyNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'mark';
}

/** True when a `\` line follows the last `+` line of any of the hunks. */
function lastPlusNoEol(hunks: { body: BodyLine[] }[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k]!.kind === 'new') lastPlus = k;
    }
    if (lastPlus >= 0) return body[lastPlus + 1]?.kind === 'mark';
  }
  return false;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NewPart[];
  noEol: boolean;
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a leading a/ or b/ removed. */
function headerPath(rest: string): string | null {
  let p = rest;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(hm[1]);
      i++;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
        } else if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('\\')) {
          body.push({ kind: 'mark', text: bl.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      const { o, n } = splitBody(body);
      cur.hunks.push({ a, body, o, n, noEol: bodyNoEol(body) });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.gitOld;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.gitNew;
  return (tree) => {
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.deletedFile);
    if (isCreate) {
      const np = newP;
      if (np === undefined || np === null) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol(s.hunks) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === undefined || op === null) return;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const np = newP as string;
    if (op === undefined || np === undefined) return;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const isMove = op !== np;
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const st = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const oldLen = st.lines.length;
        const ins = Math.min(h.a + d, oldLen);
        const add = h.n.map((p) => p.text);
        st.lines.splice(ins, 0, ...add);
        if (ins === oldLen) st.final = !h.noEol;
        d += add.length;
      } else {
        const found = findOccurrences(st.lines, h.o, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const atEnd = best + h.o.length === st.lines.length;
        const rep = resolveNew(h.n, st.lines, best, h.o, found.tier);
        st.lines.splice(best, h.o.length, ...rep);
        if (atEnd) st.final = !h.noEol;
        d += rep.length - h.o.length;
      }
    }
    const out = joinFile(st);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      return [op, np];
    }
    tree.now.set(op, out);
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, o, n): Edit => {
      return (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (o.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
          return;
        }
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const st = splitFile(before);
        const found = findOccurrences(st.lines, o, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.pos.length > 1) throw new Fail('ambiguous', p);
        const pos = found.pos[0]!;
        const parts: NewPart[] = n.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
        const repLines = resolveNew(parts, st.lines, pos, o, found.tier);
        st.lines.splice(pos, o.length, ...repLines);
        tree.now.set(p, joinFile(st));
      };
    })(path, oldLines, newLines));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewPart[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerIdx = i;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(((p, fl): Edit => {
        return (tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
        };
      })(path, fileLines));
    } else if (kind === 'del') {
      for (const r of raw) throw new Exit2(`error: parse ${r.idx + 1}`);
      edits.push(((p): Edit => {
        return (tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        };
      })(path));
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: Chunk[] = [];
      let curChunk: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
      const closeChunk = (): void => {
        if (curChunk) {
          const { o, n } = splitBody(curChunk.body);
          chunks.push({ anchor: curChunk.anchor, eof: curChunk.eof, o, n });
          curChunk = null;
        }
      };
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          closeChunk();
          const a = t.slice(2).trim();
          curChunk = { anchor: a === '' ? null : a, eof: false, body: [] };
        } else if (t === '*** End of File') {
          if (!curChunk) throw new Exit2(`error: parse ${r.idx + 1}`);
          curChunk.eof = true;
          closeChunk();
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (!curChunk) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
          }
          if (t === '') curChunk.body.push({ kind: 'ctx', text: '' });
          else if (t.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: t.slice(1) });
          else if (t.startsWith('-')) curChunk.body.push({ kind: 'old', text: t.slice(1) });
          else curChunk.body.push({ kind: 'new', text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
      edits.push(((p, m, cs): Edit => {
        return (tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (m !== null && !safe(m)) throw new Fail('unsafe', m);
          const before = tree.get(p);
          if (before === null) throw new Fail('missing', p);
          if (m !== null && tree.get(m) !== null) throw new Fail('exists', m);
          const st = splitFile(before);
          let cursor = 0;
          for (const c of cs) {
            if (c.anchor !== null) {
              let foundIdx = -1;
              const top = strict ? 1 : 3;
              for (let t = 0; t < top && foundIdx < 0; t++) {
                for (let k = cursor; k < st.lines.length; k++) {
                  if (lineEq(st.lines[k]!, c.anchor, t)) {
                    foundIdx = k;
                    break;
                  }
                }
              }
              if (foundIdx < 0) throw new Fail('no-match', p);
              cursor = foundIdx + 1;
            }
            if (c.o.length === 0) {
              const ins = c.eof ? st.lines.length : cursor;
              const add = c.n.map((x) => x.text);
              st.lines.splice(ins, 0, ...add);
              cursor = ins + add.length;
            } else {
              let found: { tier: number; pos: number } | null = null;
              const top = strict ? 1 : 3;
              for (let t = 0; t < top && !found; t++) {
                const occ = occurrences(st.lines, c.o, t).filter((q) => q >= cursor && (!c.eof || q + c.o.length === st.lines.length));
                if (occ.length > 0) found = { tier: t, pos: occ[0]! };
              }
              if (!found) throw new Fail('no-match', p);
              const rep = resolveNew(c.n, st.lines, found.pos, c.o, found.tier);
              st.lines.splice(found.pos, c.o.length, ...rep);
              cursor = found.pos + rep.length;
            }
          }
          const out = joinFile(st);
          if (m !== null) {
            tree.now.set(p, null);
            tree.now.set(m, out);
            return [p, m];
          }
          tree.now.set(p, out);
        };
      })(path, moveTo, chunks));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- command line, output and exit codes (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  // Successful moves, resolved to their original path: orig -> final new path.
  const moves = new Map<string, string>();
  const revMoves = new Map<string, string>();
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv) {
        const [o, n] = mv;
        const orig = revMoves.get(o) ?? o;
        if (revMoves.has(o)) revMoves.delete(o);
        moves.set(orig, n);
        revMoves.set(n, orig);
      }
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const rCovered = new Set<string>();
  for (const [orig, fin] of moves) {
    if (tree.original(orig) !== null && tree.get(orig) === null && tree.original(fin) === null && tree.get(fin) !== null) {
      rows.push({ key: fin, line: `R ${orig} -> ${fin}` });
      rCovered.add(orig);
      rCovered.add(fin);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rCovered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
