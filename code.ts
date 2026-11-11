// Linked Text Frames (Prototype)
// Independent student concept by Immanuel Mensah. Not affiliated with Figma.

const PLUGIN_NS = "linkedTextFrames";
const OVERLAY_NAME = "LTF Overlay (locked)";
const DEBOUNCE_MS = 1200; // auto-reflow waits until the user has been idle this long
const SAFETY_PX = 2; // fit margin so a sub-pixel metric difference never overflows

type Member = { id: string; order: number };
// Last written content of one frame. Kept in the story record so the text of a
// deleted frame is never lost and can be reflowed into the remaining frames.
type CachedFrame = { id: string; chars: string; sep: string; runs: StyleRun[] };
type RemovedMember = { id: string; index: number };
type Story = {
  id: string;
  name: string;
  members: Member[];
  cache?: CachedFrame[];
  removed?: RemovedMember[];
};

type UiToPlugin =
  | { type: "link-selection"; orderMode: "selection" | "spatial" }
  | { type: "reflow" }
  | { type: "unlink" }
  | { type: "toggle-overlay"; visible: boolean }
  | { type: "set-auto-reflow"; enabled: boolean }
  | { type: "ready" };

type PluginToUi = {
  type: "status";
  message: string;
  tone: "info" | "ok" | "warn" | "error";
  story: null | {
    id: string;
    name: string;
    count: number;
    overflow: boolean;
    missing: number;
  };
  autoReflow: boolean;
  overlayVisible: boolean;
};

const PROBE_NAME = "LTF Probe (tmp)";
const IGNORE_MS = 500;

let autoReflow = false; // OFF by default so recordings stay stable
let overlayVisible = true;
let reflowing = false;
let ignoreChangesUntil = 0;
let debounceTimer: number | null = null;
let activeProbe: TextNode | null = null;
// What the plugin itself last wrote into each member frame. A documentchange
// whose current text and size equal this is our own echo; anything else is a
// real user edit. This replaces the old time-window guess.
const lastWritten = new Map<string, { chars: string; w: number; h: number }>();
const overflowCache = new Map<string, boolean>();

class StaleError extends Error {
  constructor() {
    super("Text changed while reflowing");
  }
}

function recordWritten(node: TextNode): void {
  lastWritten.set(node.id, { chars: node.characters, w: node.width, h: node.height });
}

function getProbe(): TextNode {
  if (activeProbe && !activeProbe.removed) return activeProbe;
  const p = figma.createText();
  // Position and name synchronously, before any await, so a probe can never
  // be left visible at 0,0 if the plugin is closed mid-measure.
  p.name = PROBE_NAME;
  p.x = -20000;
  p.y = -20000;
  activeProbe = p;
  return p;
}

function releaseProbe(): void {
  if (activeProbe) {
    try {
      if (!activeProbe.removed) activeProbe.remove();
    } catch {
      // already gone
    }
    activeProbe = null;
  }
}

function beginPluginMutation(): void {
  reflowing = true;
  ignoreChangesUntil = Date.now() + IGNORE_MS;
}

function endPluginMutation(): void {
  ignoreChangesUntil = Date.now() + IGNORE_MS;
  reflowing = false;
}

function isPluginInternalNode(node: BaseNode | null): boolean {
  let cur: BaseNode | null = node;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    if (cur.name === OVERLAY_NAME || cur.name === PROBE_NAME) return true;
    cur = cur.parent;
  }
  return false;
}

function cleanupOrphanProbes(): void {
  for (const page of figma.root.children) {
    if (page.type !== "PAGE") continue;
    for (const child of [...page.children]) {
      if (child.name === PROBE_NAME) child.remove();
    }
  }
}

figma.showUI(__html__, { width: 320, height: 460, themeColors: true });

function notifyUi(payload: PluginToUi): void {
  figma.ui.postMessage(payload);
}

function readStories(): Story[] {
  const raw = figma.root.getSharedPluginData(PLUGIN_NS, "stories");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Story[];
  } catch {
    return [];
  }
}

function writeStories(stories: Story[]): void {
  figma.root.setSharedPluginData(PLUGIN_NS, "stories", JSON.stringify(stories));
}

function newStoryId(): string {
  return `story_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function isText(node: BaseNode | null): node is TextNode {
  return !!node && node.type === "TEXT";
}

async function ensureBaseFonts(): Promise<void> {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
}

async function loadFontsForText(node: TextNode): Promise<void> {
  await ensureBaseFonts();
  if (!node.characters || node.characters.length === 0) {
    return;
  }
  try {
    const fonts = node.getRangeAllFontNames(0, node.characters.length);
    for (const font of fonts) {
      await figma.loadFontAsync(font);
    }
  } catch {
    try {
      if (node.fontName !== figma.mixed) {
        await figma.loadFontAsync(node.fontName as FontName);
      }
    } catch {
      // Inter already loaded
    }
  }
}

function spatialSort(nodes: TextNode[]): TextNode[] {
  return [...nodes].sort((a, b) => {
    const dy = a.absoluteTransform[1][2] - b.absoluteTransform[1][2];
    if (Math.abs(dy) > 8) return dy;
    return a.absoluteTransform[0][2] - b.absoluteTransform[0][2];
  });
}

function isLabelName(name: string): boolean {
  return /^Label [ABC]$/.test(name);
}

function isBoxFrameName(name: string): boolean {
  return /^Box [ABC]$/.test(name);
}

function isBoxTextName(name: string): boolean {
  // Test-file layers are named "Box A text". Older files may still use "Box A".
  return /^Box [ABC]( text)?$/.test(name) && !isLabelName(name);
}

function addText(node: TextNode, out: TextNode[], seen: Set<string>): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  out.push(node);
}

function textFromBoxFrame(node: BaseNode): TextNode | null {
  if (isText(node) && isBoxTextName(node.name)) return node;
  if (node.type === "FRAME" && isBoxFrameName(node.name) && "children" in node) {
    const texts = node.children.filter((c): c is TextNode => c.type === "TEXT");
    if (texts.length === 1) return texts[0];
    const named = texts.find((c) => isBoxTextName(c.name));
    if (named) return named;
  }
  return null;
}

function collectBoxTexts(node: BaseNode, out: TextNode[], seen: Set<string>): void {
  const found = textFromBoxFrame(node);
  if (found) {
    addText(found, out, seen);
    return;
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children) {
      if (isText(child) && isLabelName(child.name)) continue;
      const inner = textFromBoxFrame(child);
      if (inner) {
        addText(inner, out, seen);
      } else if (child.type === "FRAME" || child.type === "GROUP" || child.type === "SECTION") {
        collectBoxTexts(child, out, seen);
      }
    }
  }
}

function getSelectedTextNodes(): TextNode[] {
  // Selecting a "Box A" frame uses its single TEXT child ("Box A text").
  // Selecting that text layer directly also works. Labels named "Label A"
  // are ignored so they cannot be linked by accident.
  const out: TextNode[] = [];
  const seen = new Set<string>();
  for (const node of figma.currentPage.selection) {
    if (isText(node)) {
      if (isLabelName(node.name)) continue;
      addText(node, out, seen);
    } else {
      collectBoxTexts(node, out, seen);
    }
  }
  return out;
}

function findStoryForNode(nodeId: string): Story | null {
  for (const story of readStories()) {
    if (story.members.some((m) => m.id === nodeId)) return story;
  }
  return null;
}

async function resolveMembers(
  story: Story
): Promise<{ nodes: TextNode[]; missing: string[] }> {
  const nodes: TextNode[] = [];
  const missing: string[] = [];
  const ordered = [...story.members].sort((a, b) => a.order - b.order);
  for (const m of ordered) {
    const n = await figma.getNodeByIdAsync(m.id);
    if (isText(n)) nodes.push(n);
    else missing.push(m.id);
  }
  return { nodes, missing };
}

// ---------------------------------------------------------------------------
// Style model
//
// A story has one BODY style (the style most of its characters use) plus a
// list of per-character RUNS (size, fill, line height, letter spacing, case,
// font). Reflow rebuilds each frame as: body style on everything, then the
// runs that differ from the body re-applied by offset. This is why a styled
// first letter (a raised initial cap) stays styled and never spreads to the
// rest of the text, and why measuring uses the real body leading.
// ---------------------------------------------------------------------------

type Layout = {
  paragraphIndent: number;
  listSpacing: number;
  leadingTrim: TextNode["leadingTrim"];
  hangingPunctuation: boolean;
  hangingList: boolean;
  textAlignHorizontal: TextNode["textAlignHorizontal"];
};

type BodyStyle = Layout & {
  fontName: FontName;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textCase: TextCase;
  fills: Paint[];
  paragraphSpacing: number;
};

type StyleRun = {
  start: number;
  end: number;
  fontName: FontName;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textCase: TextCase;
  fills: Paint[];
};

const RUN_FIELDS = [
  "fontName",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textCase",
  "fills",
] as unknown as Parameters<TextNode["getStyledTextSegments"]>[0];

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

function clonePaints(fills: readonly Paint[] | typeof figma.mixed): Paint[] {
  if (fills === figma.mixed) return [];
  return JSON.parse(JSON.stringify(fills)) as Paint[];
}

function collectRuns(source: TextNode): StyleRun[] {
  if (!source.characters.length) return [];
  try {
    const segs = source.getStyledTextSegments(RUN_FIELDS);
    return segs.map((s) => ({
      start: s.start,
      end: s.end,
      fontName: s.fontName as FontName,
      fontSize: s.fontSize as number,
      lineHeight: s.lineHeight as LineHeight,
      letterSpacing: s.letterSpacing as LetterSpacing,
      textCase: s.textCase as TextCase,
      fills: clonePaints(s.fills as readonly Paint[]),
    }));
  } catch {
    return [];
  }
}

function num(v: number | typeof figma.mixed, d = 0): number {
  return v === figma.mixed ? d : (v as number);
}

function layoutOf(n: TextNode): Layout {
  return {
    paragraphIndent: num(n.paragraphIndent),
    listSpacing: num(n.listSpacing),
    leadingTrim: n.leadingTrim,
    hangingPunctuation: n.hangingPunctuation,
    hangingList: n.hangingList,
    textAlignHorizontal: n.textAlignHorizontal,
  };
}

function runBody(run: StyleRun, paragraphSpacing: number, layout: Layout): BodyStyle {
  return {
    ...layout,
    fontName: run.fontName,
    fontSize: run.fontSize,
    lineHeight: run.lineHeight,
    letterSpacing: run.letterSpacing,
    textCase: run.textCase,
    fills: run.fills,
    paragraphSpacing,
  };
}

// The body style is the style covering the most characters. Never char 0:
// that is often a styled initial cap.
function dominantBody(runs: StyleRun[], fallbackNode: TextNode): BodyStyle {
  const ps = fallbackNode.paragraphSpacing === figma.mixed ? 0 : (fallbackNode.paragraphSpacing as number);
  if (runs.length) {
    const tally = new Map<string, { len: number; run: StyleRun }>();
    for (const r of runs) {
      const key = JSON.stringify([r.fontName, r.fontSize, r.lineHeight, r.letterSpacing, r.textCase, r.fills]);
      const e = tally.get(key);
      const len = r.end - r.start;
      if (e) e.len += len;
      else tally.set(key, { len, run: r });
    }
    let best: { len: number; run: StyleRun } | null = null;
    for (const e of tally.values()) if (!best || e.len > best.len) best = e;
    if (best) return runBody(best.run, ps, layoutOf(fallbackNode));
  }
  return {
    ...layoutOf(fallbackNode),
    fontName: fallbackNode.fontName === figma.mixed ? FALLBACK_FONT : (fallbackNode.fontName as FontName),
    fontSize: fallbackNode.fontSize === figma.mixed ? 12 : (fallbackNode.fontSize as number),
    lineHeight: fallbackNode.lineHeight === figma.mixed ? { unit: "AUTO" } : fallbackNode.lineHeight,
    letterSpacing:
      fallbackNode.letterSpacing === figma.mixed ? { unit: "PERCENT", value: 0 } : fallbackNode.letterSpacing,
    textCase: fallbackNode.textCase === figma.mixed ? "ORIGINAL" : fallbackNode.textCase,
    fills: clonePaints(fallbackNode.fills),
    paragraphSpacing: ps,
  };
}

function styleKey(a: StyleRun | BodyStyle): string {
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  const fills = (a.fills || []).map((f) =>
    f.type === "SOLID"
      ? ["S", r3(f.color.r), r3(f.color.g), r3(f.color.b), r3(f.opacity === undefined ? 1 : f.opacity)]
      : [f.type]
  );
  const lh = a.lineHeight.unit === "AUTO" ? ["AUTO"] : [a.lineHeight.unit, r3(a.lineHeight.value)];
  const ls = [a.letterSpacing.unit, r3(a.letterSpacing.value)];
  return JSON.stringify([a.fontName.family, a.fontName.style, r3(a.fontSize), lh, ls, a.textCase, fills]);
}

function sameStyle(a: StyleRun, b: BodyStyle): boolean {
  return styleKey(a) === styleKey(b);
}

// The per-character style layout a frame should have for this text and these runs.
function expectedSegments(
  n: number,
  body: BodyStyle,
  runs: StyleRun[],
  offset: number
): Array<{ a: number; b: number; key: string }> {
  const rel = runs
    .filter((r) => !sameStyle(r, body))
    .map((r) => ({ a: Math.max(0, r.start - offset), b: Math.min(n, r.end - offset), key: styleKey(r) }))
    .filter((x) => x.b > x.a);
  const pts = new Set<number>([0, n]);
  rel.forEach((x) => {
    pts.add(x.a);
    pts.add(x.b);
  });
  const sorted = [...pts].sort((x, y) => x - y);
  const out: Array<{ a: number; b: number; key: string }> = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    let key = styleKey(body);
    for (const x of rel) if (x.a <= a && x.b >= b) key = x.key;
    const prev = out[out.length - 1];
    if (prev && prev.key === key) prev.b = b;
    else out.push({ a, b, key });
  }
  return out;
}

function nodeMatches(node: TextNode, text: string, body: BodyStyle, runs: StyleRun[], offset: number): boolean {
  if (node.characters !== text) return false;
  if (num(node.paragraphSpacing) !== body.paragraphSpacing) return false;
  if (!text.length) return true;
  const have: Array<{ a: number; b: number; key: string }> = [];
  for (const r of collectRuns(node)) {
    const key = styleKey(r);
    const prev = have[have.length - 1];
    if (prev && prev.key === key) prev.b = r.end;
    else have.push({ a: r.start, b: r.end, key });
  }
  return JSON.stringify(have) === JSON.stringify(expectedSegments(text.length, body, runs, offset));
}

async function loadBodyFonts(body: BodyStyle, runs: StyleRun[] = []): Promise<void> {
  await ensureBaseFonts();
  const seen = new Set<string>();
  const fonts: FontName[] = [body.fontName, ...runs.map((r) => r.fontName)];
  for (const f of fonts) {
    const k = f.family + "|" + f.style;
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      await figma.loadFontAsync(f);
    } catch {
      // Falls back to Inter when a font is missing
    }
  }
}

async function measureHeight(
  body: BodyStyle,
  text: string,
  width: number,
  runs: StyleRun[] = [],
  offset = 0
): Promise<number> {
  // One shared off-canvas probe per reflow, released in a finally by the caller
  // (releaseProbe) and on plugin close. It mirrors how the real frame renders:
  // same width, same node-level text settings, same per-run styles, height hugs.
  await loadBodyFonts(body, runs);
  const probe = getProbe();
  probe.textAutoResize = "NONE";
  probe.fontName = body.fontName;
  probe.fontSize = body.fontSize;
  probe.lineHeight = body.lineHeight;
  probe.letterSpacing = body.letterSpacing;
  probe.textCase = body.textCase;
  probe.paragraphSpacing = body.paragraphSpacing;
  probe.paragraphIndent = body.paragraphIndent;
  probe.listSpacing = body.listSpacing;
  probe.leadingTrim = body.leadingTrim;
  probe.hangingPunctuation = body.hangingPunctuation;
  probe.hangingList = body.hangingList;
  probe.textAlignHorizontal = body.textAlignHorizontal;
  probe.resize(Math.max(1, width), 8);
  probe.textAutoResize = "HEIGHT";
  probe.characters = text.length ? text : " ";
  const n = text.length;
  if (n > 0) {
    probe.setRangeFontName(0, n, body.fontName);
    probe.setRangeFontSize(0, n, body.fontSize);
    probe.setRangeLineHeight(0, n, body.lineHeight);
    probe.setRangeLetterSpacing(0, n, body.letterSpacing);
    probe.setRangeTextCase(0, n, body.textCase);
    for (const run of runs) {
      if (sameStyle(run, body)) continue;
      const a = Math.max(0, run.start - offset);
      const b = Math.min(n, run.end - offset);
      if (b <= a) continue;
      try {
        probe.setRangeFontName(a, b, run.fontName);
        probe.setRangeFontSize(a, b, run.fontSize);
        probe.setRangeLineHeight(a, b, run.lineHeight);
        probe.setRangeLetterSpacing(a, b, run.letterSpacing);
        probe.setRangeTextCase(a, b, run.textCase);
      } catch {
        // ignore runs that cannot be applied
      }
    }
  }
  return probe.height;
}

async function fitTextToBox(
  body: BodyStyle,
  text: string,
  width: number,
  boxHeight: number,
  runs: StyleRun[] = [],
  offset = 0
): Promise<{ fitted: string; rest: string; cut: number; sep: string }> {
  if (!text) return { fitted: "", rest: "", cut: 0, sep: "" };
  const maxHeight = boxHeight - SAFETY_PX;
  const fullH = await measureHeight(body, text, width, runs, offset);
  if (fullH <= maxHeight + 0.5) return { fitted: text, rest: "", cut: text.length, sep: "" };

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const h = await measureHeight(body, text.slice(0, mid), width, runs, offset);
    if (h <= maxHeight + 0.5) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  if (cut <= 0) {
    const firstSpace = text.indexOf(" ");
    cut = firstSpace > 0 ? firstSpace : Math.min(1, text.length);
  } else if (cut < text.length) {
    // Never split inside a word: back up to the previous space or newline.
    const windowStart = Math.max(0, cut - 40);
    const chunk = text.slice(windowStart, cut + 1);
    const sp = Math.max(chunk.lastIndexOf(" "), chunk.lastIndexOf("\n"));
    if (sp > 0 && text[cut] !== " " && text[cut] !== "\n") cut = windowStart + sp;
  }
  while (cut > 0 && (text[cut - 1] === " " || text[cut - 1] === "\n")) cut--;
  let next = cut;
  while (next < text.length && (text[next] === " " || text[next] === "\n" || text[next] === "\t")) {
    next++;
  }

  return finishSplit(body, text, width, maxHeight, runs, offset, cut, next);
}

// Compute the whitespace swallowed by a split, and apply the orphan guard.
async function finishSplit(
  body: BodyStyle,
  text: string,
  width: number,
  maxHeight: number,
  runs: StyleRun[],
  offset: number,
  cut: number,
  next: number
): Promise<{ fitted: string; rest: string; cut: number; sep: string }> {
  // Orphan guard: if the next frame would open with a tiny paragraph tail
  // (one or two words, then a paragraph break), pull it back into this frame
  // when it still fits. A lone word at the top of a column looks broken.
  const tail = text.slice(next).match(/^([^\n]*)\n/);
  if (tail) {
    const words = tail[1].split(/\s+/).filter(Boolean).length;
    if (words > 0 && words < 3) {
      const joined = text.slice(0, next) + tail[1];
      const h = await measureHeight(body, joined, width, runs, offset);
      if (h <= maxHeight + 0.5) {
        const after = next + tail[1].length;
        let n2 = after;
        while (n2 < text.length && (text[n2] === " " || text[n2] === "\n" || text[n2] === "\t")) n2++;
        const skipped2 = text.slice(after, n2);
        return {
          fitted: joined,
          rest: text.slice(n2),
          cut: n2,
          sep: skipped2.includes("\n") ? "\n" : " ",
        };
      }
    }
  }

  // Remember what whitespace the split swallowed so a later gather can restore
  // a space or a paragraph break instead of guessing (a guessed newline would
  // inject a false paragraph break in the middle of a sentence).
  const skipped = text.slice(cut, next);
  const sep = skipped.length === 0 ? "" : skipped.includes("\n") ? "\n" : " ";
  return { fitted: text.slice(0, cut), rest: text.slice(next), cut: next, sep };
}

async function applyStyleFrom(
  body: BodyStyle,
  target: TextNode,
  text: string,
  storyRuns: StyleRun[],
  storyOffset: number
): Promise<void> {
  await loadBodyFonts(body, storyRuns);
  // The target may still hold old text in other fonts; they must be loaded before any write.
  await loadFontsForText(target);

  // Nothing to change: do not touch the node at all (no write, no event, and
  // no risk of fighting a user who is typing in it).
  if (nodeMatches(target, text, body, storyRuns, storyOffset)) {
    recordWritten(target);
    return;
  }

  const w = Math.max(1, target.width);
  const h = Math.max(1, target.height);

  // Fixed box: keep NONE so height stays under our control for later measure/fit.
  target.textAutoResize = "NONE";
  target.resize(w, h);

  // 1) Node-level body style. On a node that already has mixed styles this
  //    overwrites every character, so nothing old can leak into the new text.
  target.fontName = body.fontName;
  target.fontSize = body.fontSize;
  target.lineHeight = body.lineHeight;
  target.letterSpacing = body.letterSpacing;
  target.textCase = body.textCase;
  target.fills = body.fills;
  target.paragraphSpacing = body.paragraphSpacing;
  target.paragraphIndent = body.paragraphIndent;
  target.listSpacing = body.listSpacing;
  target.leadingTrim = body.leadingTrim;
  target.hangingPunctuation = body.hangingPunctuation;
  target.hangingList = body.hangingList;
  target.textAlignHorizontal = body.textAlignHorizontal;

  target.characters = text;

  // 2) Re-apply only the runs that differ from the body (initial cap, bold,
  //    italic, colored words), mapped by story offset.
  const n = text.length;
  if (n > 0) {
    target.setRangeFontName(0, n, body.fontName);
    target.setRangeFontSize(0, n, body.fontSize);
    target.setRangeLineHeight(0, n, body.lineHeight);
    target.setRangeLetterSpacing(0, n, body.letterSpacing);
    target.setRangeTextCase(0, n, body.textCase);
    target.setRangeFills(0, n, body.fills);
    for (const run of storyRuns) {
      if (sameStyle(run, body)) continue;
      const a = Math.max(0, run.start - storyOffset);
      const b = Math.min(n, run.end - storyOffset);
      if (b <= a) continue;
      try {
        await figma.loadFontAsync(run.fontName);
        target.setRangeFontName(a, b, run.fontName);
        target.setRangeFontSize(a, b, run.fontSize);
        target.setRangeLineHeight(a, b, run.lineHeight);
        target.setRangeLetterSpacing(a, b, run.letterSpacing);
        target.setRangeTextCase(a, b, run.textCase);
        target.setRangeFills(a, b, run.fills);
      } catch {
        // Skip runs that cannot load
      }
    }
  }

  target.textAutoResize = "NONE";
  target.resize(w, h);
  recordWritten(target);
}

// Height the text really needs inside this frame, measured on the frame itself
// (not a probe), then restored. This is the ground truth the probe is checked against.
function realContentHeight(node: TextNode): number {
  const w = node.width;
  const h = node.height;
  try {
    node.textAutoResize = "HEIGHT";
    return node.height;
  } finally {
    node.textAutoResize = "NONE";
    node.resize(w, h);
  }
}

function gatherStory(
  story: Story,
  nodes: TextNode[],
  stale: Set<string>
): { text: string; runs: StyleRun[]; body: BodyStyle } {
  const byId = new Map<string, TextNode>(nodes.map((n) => [n.id, n]));
  const cached = new Map<string, CachedFrame>((story.cache || []).map((f) => [f.id, f]));
  const removedIds = new Set<string>((story.removed || []).map((r) => r.id));
  const fallbackSep = nodes.some((n) => n.characters.includes("\n")) ? "\n" : " ";

  // Chain order: the last written order (so a deleted frame keeps its place),
  // then any frames that are not cached yet.
  const orderIds: string[] = [];
  for (const f of story.cache || []) {
    if (stale.has(f.id)) continue;
    if (byId.has(f.id) || removedIds.has(f.id)) orderIds.push(f.id);
  }
  for (const n of nodes) if (orderIds.indexOf(n.id) < 0 && !stale.has(n.id)) orderIds.push(n.id);

  type Entry = { chars: string; sep: string; runs: StyleRun[] };
  const entries: Entry[] = [];
  for (const id of orderIds) {
    const node = byId.get(id);
    if (node) {
      const stored = node.getPluginData("sepAfter");
      entries.push({
        chars: node.characters,
        sep: stored === "\n" || stored === " " ? stored : fallbackSep,
        runs: collectRuns(node),
      });
    } else {
      const c = cached.get(id);
      if (c) entries.push({ chars: c.chars, sep: c.sep === "\n" || c.sep === " " ? c.sep : fallbackSep, runs: c.runs });
    }
  }
  const filled = entries.filter((e) => e.chars.length > 0);
  let text = "";
  const runs: StyleRun[] = [];
  let offset = 0;
  filled.forEach((e, idx) => {
    for (const run of e.runs) runs.push({ ...run, start: run.start + offset, end: run.end + offset });
    text += e.chars;
    offset += e.chars.length;
    if (idx < filled.length - 1) {
      text += e.sep;
      offset += e.sep.length;
    }
  });
  return { text, runs, body: dominantBody(runs, nodes[0]) };
}

function splitWhitespace(full: string, cutIdx: number): { fitted: string; rest: string; cut: number; sep: string } {
  let cut = cutIdx;
  while (cut > 0 && (full[cut - 1] === " " || full[cut - 1] === "\n")) cut--;
  let next = cut;
  while (next < full.length && (full[next] === " " || full[next] === "\n" || full[next] === "\t")) next++;
  const skipped = full.slice(cut, next);
  const sep = skipped.length === 0 ? "" : skipped.includes("\n") ? "\n" : " ";
  return { fitted: full.slice(0, cut), rest: full.slice(next), cut: next, sep };
}

async function reflowStory(story: Story): Promise<{ overflow: boolean; missing: number }> {
  if (!activeProbe) cleanupOrphanProbes();
  try {
    return await reflowStoryInner(story);
  } finally {
    releaseProbe();
  }
}

async function reflowStoryInner(story: Story): Promise<{ overflow: boolean; missing: number }> {
  // Undo of a delete: a removed frame that exists again goes back to its
  // original position. Its own text is stale (the story already lives in the
  // other frames), so it contributes nothing and is rewritten by this reflow.
  const stale = new Set<string>();
  if (story.removed && story.removed.length) {
    const stillGone: RemovedMember[] = [];
    for (const r of [...story.removed].sort((a, b) => a.index - b.index)) {
      const n = await figma.getNodeByIdAsync(r.id);
      if (isText(n) && !n.removed) {
        if (!story.members.some((m) => m.id === r.id)) {
          const ordered = [...story.members].sort((a, b) => a.order - b.order);
          ordered.splice(Math.min(r.index, ordered.length), 0, { id: r.id, order: 0 });
          story.members = ordered.map((m, i) => ({ id: m.id, order: i + 1 }));
          stale.add(r.id);
        }
      } else {
        stillGone.push(r);
      }
    }
    story.removed = stillGone;
  }

  const { nodes, missing } = await resolveMembers(story);
  if (nodes.length === 0) return { overflow: false, missing: missing.length };

  if (missing.length) {
    // A linked frame was deleted: drop it from the chain but remember where it
    // sat (for undo). Its text stays in story.cache and is reflowed below.
    const before = [...story.members].sort((a, b) => a.order - b.order);
    const removed = (story.removed || []).filter((r) => missing.indexOf(r.id) < 0);
    for (const id of missing) removed.push({ id, index: before.findIndex((m) => m.id === id) });
    story.removed = removed.slice(-20);
    story.members = nodes.map((n, i) => ({ id: n.id, order: i + 1 }));
    const stories = readStories().map((s) => (s.id === story.id ? story : s));
    writeStories(stories);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].setPluginData("order", String(i + 1));
      nodes[i].setPluginData("storyId", story.id);
    }
  }

  // Snapshot every frame's text. Before each write we check nothing changed
  // underneath us (the user typing while we measure). If it did, abort and let
  // the caller retry from fresh text instead of overwriting the edit.
  const snap = new Map<string, string>(nodes.map((n) => [n.id, n.characters]));
  const assertFresh = (): void => {
    for (const n of nodes) {
      if (n.removed || n.characters !== snap.get(n.id)) throw new StaleError();
    }
  };

  const gathered = gatherStory(story, nodes, stale);
  const body = gathered.body;
  let remaining = gathered.text;
  let cursor = 0;
  let overflowLeft = false;
  const sepList: string[] = nodes.map(() => "");

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    if (isLast) {
      assertFresh();
      await applyStyleFrom(body, node, remaining, gathered.runs, cursor);
      snap.set(node.id, node.characters);
      node.setPluginData("sepAfter", "");
      overflowLeft = realContentHeight(node) > node.height + 0.5;
      remaining = "";
    } else {
      const full = remaining;
      let split = await fitTextToBox(body, full, node.width, node.height, gathered.runs, cursor);
      assertFresh();
      await applyStyleFrom(body, node, split.fitted, gathered.runs, cursor);
      // Ground truth check on the real frame. If the probe was optimistic, pull
      // the last word back into the next frame until it really fits.
      let guard = 0;
      while (realContentHeight(node) > node.height + 0.5 && guard++ < 12) {
        const idx = Math.max(split.fitted.lastIndexOf(" "), split.fitted.lastIndexOf("\n"));
        if (idx <= 0) break;
        split = splitWhitespace(full, idx);
        await applyStyleFrom(body, node, split.fitted, gathered.runs, cursor);
      }
      snap.set(node.id, node.characters);
      node.setPluginData("sepAfter", split.sep);
      sepList[i] = split.sep;
      cursor += split.cut;
      remaining = split.rest;
    }
  }

  const overflow = overflowLeft || remaining.length > 0;
  overflowCache.set(story.id, overflow);
  assertFresh();
  // Cache what each frame now holds, so a later delete cannot lose text.
  let frames: CachedFrame[] = nodes.map((n, i) => ({
    id: n.id,
    chars: n.characters,
    sep: sepList[i],
    runs: collectRuns(n),
  }));
  if (JSON.stringify(frames).length > 80000) frames = frames.map((f) => ({ ...f, runs: [] }));
  story.cache = frames;
  writeStories(readStories().map((s) => (s.id === story.id ? story : s)));
  await drawOverlay(story, overflow);
  return { overflow, missing: missing.length };
}

// Reflow with automatic retry when the user typed while we were working.
async function runReflow(story: Story): Promise<{ overflow: boolean; missing: number; stale: boolean }> {
  let current = story;
  for (let attempt = 0; attempt < 3; attempt++) {
    beginPluginMutation();
    try {
      const r = await reflowStory(current);
      return { ...r, stale: false };
    } catch (err) {
      if (!(err instanceof StaleError)) throw err;
      const fresh = readStories().find((s) => s.id === story.id);
      if (fresh) current = fresh;
    } finally {
      releaseProbe();
      endPluginMutation();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { overflow: !!overflowCache.get(story.id), missing: 0, stale: true };
}

function removeOverlay(): void {
  for (const page of figma.root.children) {
    if (page.type !== "PAGE") continue;
    for (const child of [...page.children]) {
      if (child.name === OVERLAY_NAME) child.remove();
    }
  }
}

async function drawOverlay(story: Story, overflow = false): Promise<void> {
  removeOverlay();
  if (!overlayVisible) return;
  const { nodes } = await resolveMembers(story);
  if (nodes.length < 2) return;

  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  const targetPage = figma.currentPage;
  const parts: SceneNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const abs = n.absoluteTransform;
    const x = abs[0][2];
    const y = abs[1][2];
    const badge = figma.createEllipse();
    badge.resize(18, 18);
    badge.fills = [{ type: "SOLID", color: { r: 0.05, g: 0.6, b: 1 } }];
    badge.x = x - 6;
    badge.y = y - 10;
    badge.name = `badge-${i + 1}`;
    const label = figma.createText();
    label.fontName = { family: "Inter", style: "Bold" };
    label.fontSize = 10;
    label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    label.characters = String(i + 1);
    label.x = badge.x + (i + 1 > 9 ? 3 : 5);
    label.y = badge.y + 3;
    label.name = `badge-label-${i + 1}`;
    targetPage.appendChild(badge);
    targetPage.appendChild(label);
    parts.push(badge, label);

    if (i < nodes.length - 1) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const ax = a.absoluteTransform[0][2] + a.width;
      const ay = a.absoluteTransform[1][2] + a.height / 2;
      const bx = b.absoluteTransform[0][2];
      const by = b.absoluteTransform[1][2] + b.height / 2;
      const line = figma.createRectangle();
      const dx = bx - ax;
      const dy = by - ay;
      line.fills = [{ type: "SOLID", color: { r: 0.05, g: 0.6, b: 1 } }];
      if (Math.abs(dy) < 12) {
        line.resize(Math.max(2, bx - ax), 2);
        line.x = ax;
        line.y = ay - 1;
      } else {
        line.resize(Math.max(2, Math.abs(dx) || 2), 2);
        line.x = Math.min(ax, bx);
        line.y = ay - 1;
        const v = figma.createRectangle();
        v.resize(2, Math.max(2, Math.abs(by - ay)));
        v.fills = [{ type: "SOLID", color: { r: 0.05, g: 0.6, b: 1 } }];
        v.x = bx - 1;
        v.y = Math.min(ay, by);
        v.name = `elbow-${i}`;
        targetPage.appendChild(v);
        parts.push(v);
      }
      line.name = `thread-${i}`;
      targetPage.appendChild(line);
      parts.push(line);
    }
  }

  if (overflow && nodes.length) {
    const last = nodes[nodes.length - 1];
    const lx = last.absoluteTransform[0][2] + last.width - 8;
    const ly = last.absoluteTransform[1][2] + last.height - 8;
    const mark = figma.createEllipse();
    mark.resize(16, 16);
    mark.fills = [{ type: "SOLID", color: { r: 0.86, g: 0.15, b: 0.15 } }];
    mark.x = lx;
    mark.y = ly;
    mark.name = "overflow-mark";
    const markLabel = figma.createText();
    markLabel.fontName = { family: "Inter", style: "Bold" };
    markLabel.fontSize = 10;
    markLabel.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    markLabel.characters = "+";
    markLabel.x = lx + 3;
    markLabel.y = ly + 2;
    markLabel.name = "overflow-mark-label";
    targetPage.appendChild(mark);
    targetPage.appendChild(markLabel);
    parts.push(mark, markLabel);
  }

  if (parts.length) {
    const group = figma.group(parts, targetPage);
    group.name = OVERLAY_NAME;
    group.locked = true;
  }
}

async function pushStatus(message: string, tone: PluginToUi["tone"] = "info"): Promise<void> {
  const sel = getSelectedTextNodes();
  let story: Story | null = null;
  for (const n of sel) {
    story = findStoryForNode(n.id);
    if (story) break;
  }
  if (!story) {
    const stories = readStories();
    story = stories[stories.length - 1] || null;
  }
  let overflow = false;
  let missing = 0;
  let count = 0;
  if (story) {
    const resolved = await resolveMembers(story);
    count = resolved.nodes.length;
    missing = resolved.missing.length;
    // Cached from the last reflow. Status must never create or measure nodes:
    // doing so on every selection change is what made the old version flicker.
    overflow = !!overflowCache.get(story.id);
  }
  notifyUi({
    type: "status",
    message,
    tone,
    story: story
      ? { id: story.id, name: story.name, count, overflow, missing }
      : null,
    autoReflow,
    overlayVisible,
  });
}

async function linkSelection(orderMode: "selection" | "spatial"): Promise<void> {
  let nodes = getSelectedTextNodes();
  if (nodes.length < 2) {
    await pushStatus("Select 2 or more text layers, then Link.", "warn");
    return;
  }
  if (orderMode === "spatial") nodes = spatialSort(nodes);

  let stories = readStories();
  const ids = new Set(nodes.map((n) => n.id));
  stories = stories
    .map((s) => ({ ...s, members: s.members.filter((m) => !ids.has(m.id)) }))
    .filter((s) => s.members.length >= 2);

  const story: Story = {
    id: newStoryId(),
    name: "Story",
    members: nodes.map((n, i) => ({ id: n.id, order: i + 1 })),
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.setPluginData("storyId", story.id);
    n.setPluginData("order", String(i + 1));
  }
  stories.push(story);
  writeStories(stories);

  const result = await runReflow(story);
  await pushStatus(
    result.stale
      ? "Linked, but the text kept changing. Click Reflow."
      : result.overflow
        ? `Linked ${nodes.length} frames. Last frame still overflows.`
        : `Linked ${nodes.length} frames and reflowed.`,
    result.stale || result.overflow ? "warn" : "ok"
  );
}

async function unlinkSelection(): Promise<void> {
  const sel = getSelectedTextNodes();
  let story: Story | null = null;
  if (sel.length) story = findStoryForNode(sel[0].id);
  if (!story) {
    await pushStatus("Select a linked text layer to unlink.", "warn");
    return;
  }
  const { nodes } = await resolveMembers(story);
  for (const n of nodes) {
    n.setPluginData("storyId", "");
    n.setPluginData("order", "");
  }
  beginPluginMutation();
  try {
    writeStories(readStories().filter((s) => s.id !== story!.id));
    removeOverlay();
    await pushStatus("Unlinked story.", "ok");
  } finally {
    endPluginMutation();
  }
}

async function reflowSelection(): Promise<void> {
  const sel = getSelectedTextNodes();
  let story: Story | null = null;
  if (sel.length) story = findStoryForNode(sel[0].id);
  if (!story) {
    const stories = readStories();
    story = stories[stories.length - 1] || null;
  }
  if (!story) {
    await pushStatus("No linked story found.", "warn");
    return;
  }
  // Cancel any pending auto-reflow so the two never run at the same time.
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const result = await runReflow(story);
  await pushStatus(
    result.stale
      ? "Text kept changing while reflowing. Stop typing and click Reflow again."
      : result.overflow
        ? "Reflow done. Last frame still overflows."
        : result.missing
          ? `Reflow done. Removed ${result.missing} missing frame(s).`
          : "Reflow done.",
    result.stale || result.overflow ? "warn" : "ok"
  );
}

// Auto-reflow: every user edit restarts the timer, so reflow only runs once
// the user has been idle for DEBOUNCE_MS. It never runs while Reflow is running.
function scheduleReflowForStory(storyId: string): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (!autoReflow) return;
    if (reflowing) {
      scheduleReflowForStory(storyId);
      return;
    }
    const fresh = readStories().find((s) => s.id === storyId);
    if (!fresh) return;
    runReflow(fresh)
      .then((result) =>
        pushStatus(
          result.stale
            ? "Auto-reflow paused, text kept changing."
            : result.overflow
              ? "Auto-reflow: last frame overflows."
              : "Auto-reflow complete.",
          result.stale || result.overflow ? "warn" : "ok"
        )
      )
      .catch((err) =>
        pushStatus(`Auto-reflow failed: ${err instanceof Error ? err.message : String(err)}`, "error")
      );
  }, DEBOUNCE_MS) as unknown as number;
}

figma.ui.onmessage = async (msg: UiToPlugin) => {
  try {
    if (msg.type === "ready") {
      await pushStatus("Select text layers to link, or reflow an existing story.", "info");
      return;
    }
    if (msg.type === "link-selection") {
      await linkSelection(msg.orderMode);
      return;
    }
    if (msg.type === "reflow") {
      await reflowSelection();
      return;
    }
    if (msg.type === "unlink") {
      await unlinkSelection();
      return;
    }
    if (msg.type === "toggle-overlay") {
      overlayVisible = msg.visible;
      const sel = getSelectedTextNodes();
      const story = sel.length
        ? findStoryForNode(sel[0].id)
        : readStories()[readStories().length - 1] || null;
      beginPluginMutation();
      try {
        if (!overlayVisible) removeOverlay();
        else if (story) {
          const resolved = await resolveMembers(story);
          await drawOverlay(story, resolved.nodes.length > 0 && !!overflowCache.get(story.id));
        }
      } finally {
        endPluginMutation();
      }
      await pushStatus(overlayVisible ? "Overlay shown." : "Overlay hidden.", "info");
      return;
    }
    if (msg.type === "set-auto-reflow") {
      autoReflow = msg.enabled;
      await pushStatus(autoReflow ? "Auto-reflow on." : "Auto-reflow off.", "info");
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pushStatus(`Error: ${message}`, "error");
  }
};

figma.loadAllPagesAsync().then(() => {
  cleanupOrphanProbes();
  figma.on("documentchange", (event) => {
    if (!autoReflow) return;
    const stories = readStories();
    if (!stories.length) return;
    const memberStory = new Map<string, string>();
    const removedStory = new Map<string, string>();
    for (const st of stories) {
      for (const m of st.members) memberStory.set(m.id, st.id);
      for (const r of st.removed || []) removedStory.set(r.id, st.id);
    }

    let storyId: string | null = null;
    for (const change of event.documentChanges) {
      const id = (change as { id?: string }).id;
      if (id && change.type === "CREATE" && removedStory.has(id)) {
        storyId = removedStory.get(id) as string; // undo brought a deleted frame back
        break;
      }
      if (!id || !memberStory.has(id)) continue; // probe, overlay, other layers: ignore
      if (change.type === "DELETE") {
        storyId = memberStory.get(id) as string;
        break;
      }
      if (change.type !== "PROPERTY_CHANGE") continue;
      const node = (change as { node?: BaseNode }).node;
      if (!node || (node as { removed?: boolean }).removed || node.type !== "TEXT") continue;
      const props = (change as { properties?: string[] }).properties || [];
      const rec = lastWritten.get(id);
      // Our own writes are recognised by content, not by a time window.
      const textEdited = props.indexOf("characters") >= 0 && (!rec || node.characters !== rec.chars);
      const resized =
        (props.indexOf("width") >= 0 || props.indexOf("height") >= 0) &&
        (!rec || Math.abs(node.width - rec.w) > 0.5 || Math.abs(node.height - rec.h) > 0.5);
      if (textEdited || resized) {
        storyId = memberStory.get(id) as string;
        break;
      }
    }
    if (storyId) scheduleReflowForStory(storyId);
  });
}).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  pushStatus(`Auto-reflow unavailable: ${message}`, "error");
});

figma.on("close", () => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  releaseProbe();
  cleanupOrphanProbes();
});

figma.on("selectionchange", () => {
  pushStatus("Selection updated.", "info");
});
