import type { GitChangedPath } from "@scaflow/git";
import type { VerificationFailure } from "@scaflow/schemas";

import { matchesPathPattern } from "./scope.js";
import type { VerificationContext, Verifier, VerifierOutput } from "./index.js";

export const TEST_INTEGRITY_VERIFIER_ID = "test-integrity";

export type SourceContent =
  | { readonly kind: "absent" }
  | { readonly kind: "non_text" }
  | { readonly kind: "text"; readonly content: string };

export interface SourceObservation {
  readonly path: string;
  readonly baseline: SourceContent;
  readonly current: SourceContent;
}

export interface FrozenValueObservation {
  readonly path: string;
  readonly baseline: unknown;
  readonly current: unknown;
}

export interface CoverageThresholdObservation {
  readonly path: string;
  readonly name: string;
  readonly baseline: number;
  readonly current: number;
}

export interface ConfigurationSourceObservation {
  readonly path: string;
  /** Bounded MVP extraction format. The complete frozen/current text is read from `sources`. */
  readonly format: "json" | "task_contract_yaml" | "typescript";
}

export interface TestIntegrityEvidence {
  readonly authority: "engine_observed";
  readonly sources: readonly SourceObservation[];
  readonly configurationSources: readonly ConfigurationSourceObservation[];
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly changes: readonly GitChangedPath[];
  readonly testPathPatterns: readonly string[];
  readonly protectedTestPathPatterns: readonly string[];
  readonly verificationCommands: readonly FrozenValueObservation[];
  readonly qualityGates: readonly FrozenValueObservation[];
  readonly coverageThresholds: readonly CoverageThresholdObservation[];
}

export interface TestIntegrityVerifierOptions {
  readonly evidence: TestIntegrityEvidence;
}

export function createTestIntegrityVerifier(options: TestIntegrityVerifierOptions): Verifier {
  return {
    id: TEST_INTEGRITY_VERIFIER_ID,
    async verify(context) {
      return verifyTestIntegrity(options.evidence, context);
    },
  };
}

export function verifyTestIntegrity(
  evidence: TestIntegrityEvidence,
  _context: VerificationContext,
): VerifierOutput {
  const canonicalEvidence = validateEvidence(evidence);
  const failures: VerificationFailure[] = [];

  for (const change of canonicalEvidence.changes) {
    const deletedPath = deletionPath(change, canonicalEvidence.testPathPatterns);
    if (deletedPath !== undefined && matchesAny(deletedPath, canonicalEvidence.testPathPatterns)) {
      failures.push(failure("TEST_DELETED", `Test file ${deletedPath} was deleted`, deletedPath));
    }

    for (const path of changePaths(change)) {
      if (matchesAny(path, canonicalEvidence.protectedTestPathPatterns)) {
        failures.push(failure(
          "PROTECTED_TEST_PATH_CHANGED",
          `Protected test path ${path} was changed`,
          path,
        ));
      }
    }
  }

  for (const added of deriveAddedSkipOrOnly(canonicalEvidence)) {
    for (let index = 0; index < added.count; index += 1) {
      failures.push(failure(
        "TEST_SKIP_OR_ONLY_ADDED",
        `A new skip/only test construct was added in ${added.path}`,
        added.path,
      ));
    }
  }

  compareFrozenValues(evidence.verificationCommands, "VERIFICATION_COMMANDS_MODIFIED",
    "Verification commands", failures);
  compareFrozenValues(evidence.qualityGates, "QUALITY_GATE_MODIFIED",
    "Quality gate", failures);

  for (const threshold of evidence.coverageThresholds) {
    if (threshold.current < threshold.baseline) {
      failures.push(failure(
        "COVERAGE_THRESHOLD_LOWERED",
        `Coverage threshold ${threshold.name} in ${threshold.path} was lowered`,
        threshold.path,
        { name: threshold.name, baseline: threshold.baseline, current: threshold.current },
      ));
    }
  }

  const normalized = deduplicateFailures(failures);
  return {
    status: normalized.length === 0 ? "passed" : "failed",
    summary: normalized.length === 0
      ? "Test integrity evidence passed all MVP rules"
      : `Test integrity found ${normalized.length} violation(s)`,
    failures: normalized,
    artifacts: [],
  };
}

function validateEvidence(evidence: TestIntegrityEvidence): TestIntegrityEvidence {
  if (evidence.authority !== "engine_observed") {
    throw new TypeError("Test integrity requires Engine-observed evidence");
  }
  if (evidence.repositoryId.trim().length === 0 || !/^[0-9a-f]{40}$/.test(evidence.baseCommit)) {
    throw new TypeError("Test integrity requires a repository ID and full frozen-base commit");
  }
  if (evidence.testPathPatterns.length === 0) {
    throw new TypeError("Test integrity requires explicit test path patterns");
  }
  for (const path of [
    ...evidence.changes.flatMap(changePaths),
    ...evidence.sources.map(({ path }) => path),
    ...evidence.verificationCommands.map(({ path }) => path),
    ...evidence.qualityGates.map(({ path }) => path),
    ...evidence.coverageThresholds.map(({ path }) => path),
    ...evidence.configurationSources.map(({ path }) => path),
  ]) {
    validatePath(path);
  }
  for (const change of evidence.changes) {
    if (!/^(?:[ACDMRTUXB?]|[RC]\d{1,3})$/.test(change.status) ||
        !["committed", "staged", "unstaged", "untracked"].includes(change.source)) {
      throw new TypeError("Test integrity received malformed changed-path evidence");
    }
  }
  const canonicalEvidence = { ...evidence, changes: canonicalizeChanges(evidence) };
  reconcileSourceInventory(canonicalEvidence);
  for (const pattern of [...evidence.testPathPatterns, ...evidence.protectedTestPathPatterns]) {
    if (pattern.trim().length === 0) throw new TypeError("Test path patterns must not be empty");
  }
  for (const threshold of evidence.coverageThresholds) {
    if (threshold.name.trim().length === 0 || !Number.isFinite(threshold.baseline) ||
        !Number.isFinite(threshold.current)) {
      throw new TypeError("Coverage threshold evidence must contain finite paired values");
    }
  }
  reconcileConfigurationInventory(canonicalEvidence);
  return canonicalEvidence;
}

function canonicalizeChanges(evidence: TestIntegrityEvidence): readonly GitChangedPath[] {
  const sources = new Map(evidence.sources.map(source => [source.path, source]));
  if (sources.size !== evidence.sources.length) {
    throw new TypeError("Observed frozen/current source evidence contains duplicate paths");
  }
  const structural = new Map<string, GitChangedPath>();
  const structuralEndpoint = new Map<string, string>();
  const simple = new Map<string, GitChangedPath[]>();

  for (const change of evidence.changes) {
    if (change.status.startsWith("R") || change.status.startsWith("C")) {
      const originalPath = requiredOriginalPath(change);
      const key = JSON.stringify([change.status[0], originalPath, change.path]);
      for (const endpoint of [originalPath, change.path]) {
        const existing = structuralEndpoint.get(endpoint);
        if (existing !== undefined && existing !== key) {
          throw new TypeError("Layered Git evidence contains conflicting rename/copy mappings");
        }
        structuralEndpoint.set(endpoint, key);
      }
      structural.set(key, change);
    } else {
      simple.set(change.path, [...(simple.get(change.path) ?? []), change]);
    }
  }

  const canonical: GitChangedPath[] = [...structural.values()];
  for (const [path, observations] of simple) {
    const structuralKey = structuralEndpoint.get(path);
    if (structuralKey !== undefined) {
      const mapping = structural.get(structuralKey)!;
      if (mapping.path !== path || observations.some(({ status }) => status !== "M")) {
        throw new TypeError("Layered Git evidence is ambiguous at a rename/copy endpoint");
      }
      continue;
    }
    const source = requiredSource(sources, path);
    const baseline = source.baseline.kind !== "absent";
    const current = source.current.kind !== "absent";
    if (!baseline && !current) {
      throw new TypeError(`Layered Git evidence has no frozen or current endpoint for ${path}`);
    }
    const status = !baseline ? "A" : !current ? "D" : "M";
    if (observations.some(item => item.originalPath !== undefined ||
        !["?", "A", "D", "M"].includes(item.status))) {
      throw new TypeError("Layered Git evidence contains an unsupported or contradictory status");
    }
    canonical.push({ source: observations[0]!.source, status, path });
  }
  return canonical.sort((left, right) =>
    JSON.stringify(changePaths(left)).localeCompare(JSON.stringify(changePaths(right))));
}

function reconcileSourceInventory(evidence: TestIntegrityEvidence): void {
  reconcileInventory(
    evidence.changes.flatMap(changePaths).map(locationKey),
    evidence.sources.map(({ path }) => locationKey(path)),
    "frozen/current sources for changed paths",
  );
  const sources = new Map(evidence.sources.map(source => [source.path, source]));
  for (const source of evidence.sources) validateSourceContent(source);
  for (const change of evidence.changes) {
    const destination = requiredSource(sources, change.path);
    const original = change.originalPath === undefined
      ? undefined
      : requiredSource(sources, change.originalPath);
    if (change.status === "?" || change.status.startsWith("A")) {
      requirePresence(destination, false, true);
    } else if (change.status.startsWith("D")) {
      requirePresence(destination, true, false);
    } else if (change.status.startsWith("R")) {
      requirePresence(requiredOriginal(original), true, false);
      requirePresence(destination, false, true);
    } else if (change.status.startsWith("C")) {
      requirePresence(requiredOriginal(original), true, true);
      requirePresence(destination, false, true);
    } else {
      requirePresence(destination, true, true);
      if (original !== undefined) throw new TypeError("Non-rename source evidence has an unexpected original path");
    }
  }
}

function validateSourceContent(source: SourceObservation): void {
  for (const value of [source.baseline, source.current]) {
    if (value.kind === "text" && typeof value.content !== "string") {
      throw new TypeError("Text source evidence requires string content");
    }
    if (value.kind !== "text" && "content" in value) {
      throw new TypeError("Absent and non-text source evidence cannot contain content");
    }
  }
}

function requirePresence(source: SourceObservation, baseline: boolean, current: boolean): void {
  if ((source.baseline.kind !== "absent") !== baseline ||
      (source.current.kind !== "absent") !== current) {
    throw new TypeError(`Source evidence contradicts changed-path status for ${source.path}`);
  }
}

function requiredSource(
  sources: ReadonlyMap<string, SourceObservation>,
  path: string,
): SourceObservation {
  const source = sources.get(path);
  if (source === undefined) throw new TypeError(`Missing source evidence for ${path}`);
  return source;
}

function requiredOriginal(source: SourceObservation | undefined): SourceObservation {
  if (source === undefined) throw new TypeError("Rename/copy evidence requires an original path source");
  return source;
}

function deriveAddedSkipOrOnly(
  evidence: TestIntegrityEvidence,
): Array<{ path: string; count: number }> {
  const sources = new Map(evidence.sources.map(source => [source.path, source]));
  const added: Array<{ path: string; count: number }> = [];
  for (const change of evidence.changes) {
    if (!matchesAny(change.path, evidence.testPathPatterns) || change.status.startsWith("D")) continue;
    const current = textContent(requiredSource(sources, change.path).current, change.path, "current");
    let baseline = "";
    if (change.status.startsWith("R") || change.status.startsWith("C")) {
      baseline = textContent(requiredSource(sources, requiredOriginalPath(change)).baseline,
        requiredOriginalPath(change), "baseline");
    } else {
      const value = requiredSource(sources, change.path).baseline;
      baseline = value.kind === "absent" ? "" : textContent(value, change.path, "baseline");
    }
    const currentConstructs = findSkipOrOnlyConstructs(current);
    const constructLines = new Set(currentConstructs.flatMap(({ lines }) => lines));
    const addedLines = addedCurrentLineIndexes(baseline, current, constructLines);
    for (const construct of currentConstructs) {
      if (construct.lines.some(line => addedLines.has(line))) {
        const existing = added.find(item => item.path === change.path);
        if (existing === undefined) added.push({ path: change.path, count: 1 });
        else existing.count += 1;
      }
    }
  }
  return added;
}

function requiredOriginalPath(change: GitChangedPath): string {
  if (change.originalPath === undefined) throw new TypeError("Rename/copy evidence requires an original path");
  return change.originalPath;
}

function textContent(value: SourceContent, path: string, side: string): string {
  if (value.kind !== "text") {
    throw new TypeError(`Changed test ${path} requires ${side} text source evidence`);
  }
  return value.content;
}

function validatePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("Test integrity paths must be normalized relative POSIX paths");
  }
}

function deletionPath(change: GitChangedPath, testPathPatterns: readonly string[]): string | undefined {
  if (change.status.startsWith("D")) return change.path;
  if (change.status.startsWith("R") && change.originalPath !== undefined &&
      !matchesAny(change.path, testPathPatterns)) return change.originalPath;
  return undefined;
}

function changePaths(change: GitChangedPath): string[] {
  return change.originalPath === undefined ? [change.path] : [change.originalPath, change.path];
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesPathPattern(path, pattern));
}

interface SkipOrOnlyConstruct {
  readonly lines: readonly number[];
}

function findSkipOrOnlyConstructs(content: string): SkipOrOnlyConstruct[] {
  const source = maskCommentsAndStrings(normalizeNewlines(content));
  const constructs: SkipOrOnlyConstruct[] = [];
  const apiPattern = /(?<![\w$.])(?:describe|it|test|suite)\b/g;
  for (const match of source.matchAll(apiPattern)) {
    let offset = skipWhitespace(source, match.index + match[0].length);
    const members: string[] = [];
    let hasSkipOrOnly = false;
    while (source[offset] === ".") {
      offset = skipWhitespace(source, offset + 1);
      const member = /^(?:each|concurrent|skip|only)\b/.exec(source.slice(offset));
      if (member === null) break;
      const name = member[0];
      members.push(name);
      hasSkipOrOnly ||= name === "skip" || name === "only";
      offset = skipWhitespace(source, offset + name.length);
      if ((name === "each" || name === "concurrent") && source[offset] === "(") {
        const end = balancedCallEnd(source, offset);
        if (end === undefined) break;
        offset = skipWhitespace(source, end);
      }
    }
    if (hasSkipOrOnly && source[offset] === "(") {
      constructs.push({ lines: intersectedLines(source, match.index, offset + 1) });
    }
  }
  return constructs;
}

function addedCurrentLineIndexes(
  baseline: string,
  current: string,
  constructLines: ReadonlySet<number>,
): ReadonlySet<number> {
  const before = normalizedLines(baseline);
  const after = normalizedLines(current);
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > 4_000_000) {
    throw new TypeError("Changed test source exceeds the bounded line-diff analysis limit");
  }
  const width = after.length + 1;
  const lengths = new Uint32Array(cells);
  for (let beforeIndex = 1; beforeIndex <= before.length; beforeIndex += 1) {
    for (let afterIndex = 1; afterIndex <= after.length; afterIndex += 1) {
      const index = beforeIndex * width + afterIndex;
      lengths[index] = before[beforeIndex - 1] === after[afterIndex - 1]
        ? lengths[index - width - 1]! + 1
        : Math.max(lengths[index - width]!, lengths[index - 1]!);
    }
  }

  const added = new Set<number>();
  let beforeIndex = before.length;
  let afterIndex = after.length;
  while (afterIndex > 0) {
    if (beforeIndex > 0 && before[beforeIndex - 1] === after[afterIndex - 1]) {
      beforeIndex -= 1;
      afterIndex -= 1;
    } else {
      const deletionLength = beforeIndex > 0
        ? lengths[(beforeIndex - 1) * width + afterIndex]!
        : -1;
      const additionLength = lengths[beforeIndex * width + afterIndex - 1]!;
      if (deletionLength > additionLength ||
          (deletionLength === additionLength && !constructLines.has(afterIndex - 1))) {
        beforeIndex -= 1;
      } else {
        added.add(afterIndex - 1);
        afterIndex -= 1;
      }
    }
  }
  return added;
}

function intersectedLines(source: string, start: number, end: number): number[] {
  let line = 0;
  for (let offset = 0; offset < start; offset += 1) {
    if (source[offset] === "\n") line += 1;
  }
  const lines = [line];
  for (let offset = start; offset < end; offset += 1) {
    if (source[offset] === "\n") lines.push(++line);
  }
  return lines;
}

function normalizedLines(content: string): string[] {
  return normalizeNewlines(content).split("\n");
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function maskCommentsAndStrings(content: string): string {
  const masked = content.split("");
  const stack: LexicalFrame[] = [codeLexicalFrame()];
  for (let index = 0; index < content.length;) {
    const frame = stack.at(-1)!;
    const character = content[index]!;
    const next = content[index + 1];

    if (frame.kind === "template") {
      if (character === "\\" && next !== undefined) {
        maskCharacter(masked, index);
        maskCharacter(masked, index + 1);
        index += 2;
      } else if (character === "`" ) {
        maskCharacter(masked, index++);
        stack.pop();
        const parent = stack.at(-1);
        if (parent?.kind !== "code") throw new TypeError("Malformed template lexical state");
        parent.regexAllowed = false;
      } else if (character === "$" && next === "{") {
        maskCharacter(masked, index);
        maskCharacter(masked, index + 1);
        index += 2;
        stack.push(codeLexicalFrame(0));
      } else {
        maskCharacter(masked, index++);
      }
      continue;
    }

    if (frame.interpolationBraceDepth === 0 && character === "}") {
      maskCharacter(masked, index++);
      stack.pop();
      if (stack.at(-1)?.kind !== "template") throw new TypeError("Malformed interpolation lexical state");
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = maskLineComment(content, masked, index);
      continue;
    }
    if (character === "/" && next === "*") {
      index = maskBlockComment(content, masked, index);
      continue;
    }
    if (character === "'" || character === '"') {
      index = maskQuotedLiteral(content, masked, index, character);
      frame.regexAllowed = false;
      clearPendingControl(frame);
      continue;
    }
    if (character === "`") {
      maskCharacter(masked, index++);
      stack.push({ kind: "template" });
      continue;
    }
    if (character === "/" && frame.regexAllowed) {
      const regexEnd = regularExpressionEnd(content, index);
      if (regexEnd !== undefined) {
        maskRange(masked, index, regexEnd);
        index = regexEnd;
        frame.regexAllowed = false;
        clearPendingControl(frame);
        continue;
      }
    }
    if (isIdentifierStart(character)) {
      const mayStartControlHeader = frame.regexAllowed;
      const start = index++;
      while (isIdentifierPart(content[index])) index += 1;
      const identifier = content.slice(start, index);
      frame.regexAllowed = REGEX_PREFIX_KEYWORDS.has(identifier);
      frame.pendingControlHeader = mayStartControlHeader && CONTROL_HEADER_KEYWORDS.has(identifier);
      if (!frame.pendingControlHeader) frame.pendingControlBody = false;
      continue;
    }
    if (/\d/.test(character)) {
      index += 1;
      while (/[\w.]/.test(content[index] ?? "")) index += 1;
      frame.regexAllowed = false;
      clearPendingControl(frame);
      continue;
    }
    if (character === "(") {
      frame.parentheses.push(frame.pendingControlHeader ? "control_header" : "expression");
      frame.regexAllowed = true;
      clearPendingControl(frame);
      index += 1;
      continue;
    }
    if (character === ")") {
      const parenthesis = frame.parentheses.pop();
      frame.regexAllowed = parenthesis === "control_header";
      frame.pendingControlHeader = false;
      frame.pendingControlBody = parenthesis === "control_header";
      index += 1;
      continue;
    }
    if (character === "{") {
      if (frame.interpolationBraceDepth !== undefined) frame.interpolationBraceDepth += 1;
      frame.braces.push(frame.pendingControlBody ? "control_body" : "expression");
      frame.regexAllowed = true;
      clearPendingControl(frame);
      index += 1;
      continue;
    }
    if (character === "}") {
      if (frame.interpolationBraceDepth !== undefined) frame.interpolationBraceDepth -= 1;
      frame.regexAllowed = frame.braces.pop() === "control_body";
      clearPendingControl(frame);
      index += 1;
      continue;
    }
    frame.regexAllowed = regexAllowedAfterPunctuation(content, index, frame.regexAllowed);
    clearPendingControl(frame);
    index += 1;
  }
  return masked.join("");
}

interface CodeLexicalFrame {
  readonly kind: "code";
  regexAllowed: boolean;
  interpolationBraceDepth?: number;
  pendingControlHeader: boolean;
  pendingControlBody: boolean;
  readonly parentheses: Array<"control_header" | "expression">;
  readonly braces: Array<"control_body" | "expression">;
}

interface TemplateLexicalFrame {
  readonly kind: "template";
}

type LexicalFrame = CodeLexicalFrame | TemplateLexicalFrame;

const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return",
  "throw", "typeof", "void", "yield",
]);

const CONTROL_HEADER_KEYWORDS = new Set(["if", "while", "for"]);

function codeLexicalFrame(interpolationBraceDepth?: number): CodeLexicalFrame {
  return {
    kind: "code",
    regexAllowed: true,
    ...(interpolationBraceDepth === undefined ? {} : { interpolationBraceDepth }),
    pendingControlHeader: false,
    pendingControlBody: false,
    parentheses: [],
    braces: [],
  };
}

function clearPendingControl(frame: CodeLexicalFrame): void {
  frame.pendingControlHeader = false;
  frame.pendingControlBody = false;
}

function maskCharacter(masked: string[], index: number): void {
  if (masked[index] !== "\n") masked[index] = " ";
}

function maskRange(masked: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) maskCharacter(masked, index);
}

function maskLineComment(content: string, masked: string[], start: number): number {
  let index = start;
  while (index < content.length && content[index] !== "\n") maskCharacter(masked, index++);
  return index;
}

function maskBlockComment(content: string, masked: string[], start: number): number {
  let index = start;
  while (index < content.length) {
    maskCharacter(masked, index);
    if (content[index] === "*" && content[index + 1] === "/") {
      maskCharacter(masked, index + 1);
      return index + 2;
    }
    index += 1;
  }
  return index;
}

function maskQuotedLiteral(
  content: string,
  masked: string[],
  start: number,
  quote: "'" | '"',
): number {
  maskCharacter(masked, start);
  let index = start + 1;
  while (index < content.length) {
    const character = content[index]!;
    maskCharacter(masked, index++);
    if (character === "\\" && index < content.length) {
      maskCharacter(masked, index++);
    } else if (character === quote) {
      return index;
    }
  }
  return index;
}

function regularExpressionEnd(content: string, start: number): number | undefined {
  let inCharacterClass = false;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index]!;
    if (character === "\n" || character === "\r") return undefined;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/.test(content[index] ?? "")) index += 1;
      return index;
    }
  }
  return undefined;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function regexAllowedAfterPunctuation(
  content: string,
  index: number,
  previous: boolean,
): boolean {
  const character = content[index]!;
  if (character === ")" || character === "]" || character === ".") return false;
  if ((character === "+" || character === "-") && content[index + 1] === character) return false;
  if (character === "/" && !previous) return true;
  return /[([{,:;?=!*%&|^~<>+\-]/.test(character);
}

function skipWhitespace(source: string, start: number): number {
  let offset = start;
  while (/\s/.test(source[offset] ?? "")) offset += 1;
  return offset;
}

function balancedCallEnd(source: string, start: number): number | undefined {
  let depth = 0;
  for (let offset = start; offset < source.length; offset += 1) {
    if (source[offset] === "(") depth += 1;
    else if (source[offset] === ")" && --depth === 0) return offset + 1;
  }
  return undefined;
}

function reconcileConfigurationInventory(evidence: TestIntegrityEvidence): void {
  const changedPaths = new Set(evidence.changes.flatMap(changePaths));
  if (new Set(evidence.configurationSources.map(({ path }) => path)).size !==
      evidence.configurationSources.length) {
    throw new TypeError("Configuration locations contain duplicate paths");
  }
  if (evidence.configurationSources.some(({ path }) => !changedPaths.has(path))) {
    throw new TypeError("Configuration locations must identify changed paths");
  }

  const sources = new Map(evidence.sources.map(source => [source.path, source]));
  const configuredFormats = new Map(evidence.configurationSources.map(source =>
    [source.path, source.format] as const));
  for (const source of evidence.configurationSources) {
    const nativeFormat = inferNativeConfigurationFormat(source.path);
    if (nativeFormat !== undefined && source.format !== nativeFormat) {
      throw new TypeError("Configuration location format contradicts its canonical native path");
    }
  }
  const configurationPaths = new Set(evidence.configurationSources.map(({ path }) => path));
  for (const path of changedPaths) {
    const source = requiredSource(sources, path);
    if (inferNativeConfigurationFormat(path) !== undefined ||
        containsProtectedJsonConfiguration(source.baseline) ||
        containsProtectedJsonConfiguration(source.current)) configurationPaths.add(path);
  }
  const extracted = [...configurationPaths].map(path => {
    const source = requiredSource(sources, path);
    const format = configuredFormats.get(path) ?? inferNativeConfigurationFormat(path) ?? "json";
    const location: ConfigurationSourceObservation = {
      path,
      format,
    };
    return {
      path,
      baseline: extractConfiguration(source.baseline, location),
      current: extractConfiguration(source.current, location),
    };
  });

  reconcileInventory(
    extracted.flatMap(({ path, baseline, current }) =>
      baseline.verificationCommands === undefined && current.verificationCommands === undefined
        ? [] : [locationKey(path)]),
    evidence.verificationCommands.map(({ path }) => locationKey(path)),
    "verification commands",
  );
  reconcileInventory(
    extracted.flatMap(({ path, baseline, current }) =>
      baseline.qualityGates === undefined && current.qualityGates === undefined
        ? [] : [locationKey(path)]),
    evidence.qualityGates.map(({ path }) => locationKey(path)),
    "quality gates",
  );
  reconcileInventory(
    extracted.flatMap(({ path, baseline, current }) => {
      const names = new Set([
        ...Object.keys(baseline.coverageThresholds ?? {}),
        ...Object.keys(current.coverageThresholds ?? {}),
      ]);
      return [...names].map(name => thresholdKey(path, name));
    }),
    evidence.coverageThresholds.map(({ path, name }) => thresholdKey(path, name)),
    "coverage thresholds",
  );

  for (const source of extracted) {
    const command = evidence.verificationCommands.find(({ path }) => path === source.path);
    if (command !== undefined &&
        (stableValue(command.baseline) !== stableValue(source.baseline.verificationCommands) ||
         stableValue(command.current) !== stableValue(source.current.verificationCommands))) {
      throw new TypeError("Verification-command observations contradict configuration sources");
    }
    const gate = evidence.qualityGates.find(({ path }) => path === source.path);
    if (gate !== undefined &&
        (stableValue(gate.baseline) !== stableValue(source.baseline.qualityGates) ||
         stableValue(gate.current) !== stableValue(source.current.qualityGates))) {
      throw new TypeError("Quality-gate observations contradict configuration sources");
    }
    for (const name of new Set([
      ...Object.keys(source.baseline.coverageThresholds ?? {}),
      ...Object.keys(source.current.coverageThresholds ?? {}),
    ])) {
      const threshold = evidence.coverageThresholds.find(item =>
        item.path === source.path && item.name === name);
      if (threshold === undefined ||
          threshold.baseline !== source.baseline.coverageThresholds?.[name] ||
          threshold.current !== source.current.coverageThresholds?.[name]) {
        throw new TypeError("Coverage-threshold observations contradict configuration sources");
      }
    }
  }
}

function containsProtectedJsonConfiguration(content: SourceContent): boolean {
  if (content.kind !== "text") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.content) as unknown;
  } catch {
    return false;
  }
  if (!isPlainJsonObject(parsed)) return false;
  return ["verificationCommands", "qualityGates", "coverageThresholds"]
    .some(field => Object.hasOwn(parsed, field));
}

interface ExtractedConfiguration {
  readonly verificationCommands?: unknown;
  readonly qualityGates?: unknown;
  readonly coverageThresholds?: Readonly<Record<string, number>>;
}

function extractConfiguration(
  content: SourceContent,
  location: ConfigurationSourceObservation,
): ExtractedConfiguration {
  if (content.kind === "absent") return {};
  if (content.kind !== "text") {
    throw new TypeError(`Configuration source ${location.path} must be textual`);
  }
  if (location.format === "task_contract_yaml") {
    return { verificationCommands: extractTaskContractCommands(content.content, location.path) };
  }
  if (location.format === "typescript") {
    return extractTypeScriptConfiguration(content.content, location.path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.content) as unknown;
  } catch {
    throw new TypeError(`Configuration source ${location.path} is malformed JSON`);
  }
  if (!isPlainJsonObject(parsed)) {
    throw new TypeError(`Configuration source ${location.path} must be a JSON object`);
  }
  const record = parsed;
  const value: ExtractedConfiguration = {
    ...(Object.hasOwn(record, "verificationCommands")
      ? { verificationCommands: record.verificationCommands } : {}),
    ...(Object.hasOwn(record, "qualityGates") ? { qualityGates: record.qualityGates } : {}),
    ...(Object.hasOwn(record, "coverageThresholds")
      ? { coverageThresholds: asCoverageThresholds(record.coverageThresholds, location.path) } : {}),
  };
  stableValue(value);
  return value;
}

function inferNativeConfigurationFormat(
  path: string,
): ConfigurationSourceObservation["format"] | undefined {
  if (/^tasks\/[^/]+\/contract\.ya?ml$/.test(path)) return "task_contract_yaml";
  if (/(?:^|\/)vitest\.config\.ts$/.test(path)) return "typescript";
  return undefined;
}

function extractTaskContractCommands(content: string, path: string): unknown {
  const lines = normalizeNewlines(content).split("\n")
    .map((text, index) => ({ text, index: index + 1 }))
    .filter(({ text }) => text.trim().length > 0 && !text.trimStart().startsWith("#"));
  if (lines.some(({ text }) => text.includes("\t") || /[&*!>|]/.test(text))) {
    throw new TypeError(`Configuration source ${path} contains unsupported YAML constructs`);
  }
  const verificationIndexes = lines.flatMap(({ text }, index) =>
    /^verification:\s*(?:#.*)?$/.test(text) ? [index] : []);
  if (verificationIndexes.length !== 1) {
    throw new TypeError(`Configuration source ${path} must contain one verification mapping`);
  }
  const verificationIndex = verificationIndexes[0]!;
  let end = lines.length;
  for (let index = verificationIndex + 1; index < lines.length; index += 1) {
    if (indentation(lines[index]!.text) === 0) {
      end = index;
      break;
    }
  }
  const commandIndexes = lines.slice(verificationIndex + 1, end).flatMap(({ text }, offset) =>
    /^  commands:\s*(?:#.*)?$/.test(text) ? [verificationIndex + 1 + offset] : []);
  if (commandIndexes.length !== 1) {
    throw new TypeError(`Configuration source ${path} must contain one verification.commands sequence`);
  }
  const commandIndex = commandIndexes[0]!;
  const commands: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined;
  for (let index = commandIndex + 1; index < end; index += 1) {
    const line = lines[index]!;
    const indent = indentation(line.text);
    if (indent <= 2) break;
    const item = /^    -\s+([a-z_][a-z0-9_]*):\s*(.+?)\s*$/.exec(line.text);
    const property = /^      ([a-z_][a-z0-9_]*):\s*(.+?)\s*$/.exec(line.text);
    if (item !== null) {
      current = {};
      commands.push(current);
      addYamlProperty(current, item[1]!, item[2]!, path, line.index);
    } else if (property !== null && current !== undefined) {
      addYamlProperty(current, property[1]!, property[2]!, path, line.index);
    } else {
      throw new TypeError(`Configuration source ${path} has malformed verification.commands`);
    }
  }
  if (commands.length === 0) {
    throw new TypeError(`Configuration source ${path} must contain verification commands`);
  }
  return commands;
}

function indentation(line: string): number {
  return /^ */.exec(line)![0].length;
}

function addYamlProperty(
  target: Record<string, unknown>,
  key: string,
  source: string,
  path: string,
  line: number,
): void {
  if (Object.hasOwn(target, key)) {
    throw new TypeError(`Configuration source ${path} contains a duplicate YAML key`);
  }
  try {
    target[key] = parseYamlScalar(source);
  } catch {
    throw new TypeError(`Configuration source ${path} has malformed YAML at line ${line}`);
  }
}

function parseYamlScalar(source: string): unknown {
  const value = source.trim();
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    return JSON.parse(value) as unknown;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new TypeError("unterminated YAML string");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^[A-Za-z0-9_@./-]+$/.test(value)) return value;
  throw new TypeError("unsupported YAML scalar");
}

function extractTypeScriptConfiguration(content: string, path: string): ExtractedConfiguration {
  const wrapper = /^\s*export\s+default\s+defineConfig\s*\(([\s\S]*)\)\s*;?\s*$/.exec(content);
  if (wrapper === null) {
    throw new TypeError(`Configuration source ${path} must use a static export default defineConfig object`);
  }
  const root = new StaticTypeScriptParser(wrapper[1]!, path).parseRootObject();
  const test = optionalRecord(root.test, path, "test");
  const coverage = optionalRecord(test?.coverage, path, "test.coverage");
  const qualityCandidates = [root.qualityGates, test?.qualityGates].filter(value => value !== undefined);
  const coverageCandidates = [root.coverageThresholds, test?.coverageThresholds, coverage?.thresholds]
    .filter(value => value !== undefined);
  if (qualityCandidates.length > 1 || coverageCandidates.length > 1) {
    throw new TypeError(`Configuration source ${path} contains ambiguous protected configuration`);
  }
  return {
    ...(qualityCandidates[0] === undefined ? {} : { qualityGates: qualityCandidates[0] }),
    ...(coverageCandidates[0] === undefined ? {} : {
      coverageThresholds: asCoverageThresholds(coverageCandidates[0], path),
    }),
  };
}

function optionalRecord(value: unknown, path: string, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) {
    throw new TypeError(`Configuration source ${path} contains a non-static ${name} mapping`);
  }
  return value;
}

class StaticTypeScriptParser {
  private offset = 0;

  constructor(private readonly source: string, private readonly path: string) {}

  parseRootObject(): Record<string, unknown> {
    const value = this.parseValue();
    this.skipTrivia();
    if (!isPlainJsonObject(value) || this.offset !== this.source.length) this.malformed();
    return value;
  }

  private parseValue(): unknown {
    this.skipTrivia();
    const character = this.source[this.offset];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"' || character === "'") return this.parseString(character);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(this.source.slice(this.offset));
    if (number !== null) {
      this.offset += number[0].length;
      return Number(number[0]);
    }
    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "null") return null;
    this.malformed();
  }

  private parseObject(): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    this.offset += 1;
    while (true) {
      this.skipTrivia();
      if (this.source[this.offset] === "}") {
        this.offset += 1;
        return value;
      }
      const key = this.source[this.offset] === '"' || this.source[this.offset] === "'"
        ? this.parseString(this.source[this.offset]!)
        : this.parseIdentifier();
      if (key.length === 0 || Object.hasOwn(value, key)) this.malformed();
      this.skipTrivia();
      if (this.source[this.offset] !== ":") this.malformed();
      this.offset += 1;
      value[key] = this.parseValue();
      this.skipTrivia();
      if (this.source[this.offset] === ",") {
        this.offset += 1;
        continue;
      }
      if (this.source[this.offset] !== "}") this.malformed();
    }
  }

  private parseArray(): unknown[] {
    const value: unknown[] = [];
    this.offset += 1;
    while (true) {
      this.skipTrivia();
      if (this.source[this.offset] === "]") {
        this.offset += 1;
        return value;
      }
      value.push(this.parseValue());
      this.skipTrivia();
      if (this.source[this.offset] === ",") {
        this.offset += 1;
        continue;
      }
      if (this.source[this.offset] !== "]") this.malformed();
    }
  }

  private parseString(quote: string): string {
    this.offset += 1;
    let value = "";
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++]!;
      if (character === quote) return value;
      if (character === "\\") {
        const escaped = this.source[this.offset++];
        if (escaped === undefined || !Object.hasOwn({ n: 1, r: 1, t: 1, "\\": 1, "\"": 1, "'": 1 }, escaped)) {
          this.malformed();
        }
        value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
      } else {
        if (character === "\n" || character === "\r") this.malformed();
        value += character;
      }
    }
    this.malformed();
  }

  private parseIdentifier(): string {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.offset));
    if (match === null) this.malformed();
    this.offset += match[0].length;
    return match[0];
  }

  private skipTrivia(): void {
    while (true) {
      const whitespace = /^\s+/.exec(this.source.slice(this.offset));
      if (whitespace !== null) {
        this.offset += whitespace[0].length;
        continue;
      }
      const line = /^\/\/[^\n]*(?:\n|$)/.exec(this.source.slice(this.offset));
      if (line !== null) {
        this.offset += line[0].length;
        continue;
      }
      const block = /^\/\*[\s\S]*?\*\//.exec(this.source.slice(this.offset));
      if (block !== null) {
        this.offset += block[0].length;
        continue;
      }
      return;
    }
  }

  private malformed(): never {
    throw new TypeError(`Configuration source ${this.path} contains unsupported dynamic TypeScript`);
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function asCoverageThresholds(value: unknown, path: string): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Configuration source ${path} contains malformed coverage thresholds`);
  }
  for (const [name, threshold] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim().length === 0 || typeof threshold !== "number" || !Number.isFinite(threshold)) {
      throw new TypeError(`Configuration source ${path} contains malformed coverage thresholds`);
    }
  }
  return value as Readonly<Record<string, number>>;
}

function reconcileInventory(
  expected: readonly string[],
  observed: readonly string[],
  category: string,
): void {
  const sortedExpected = [...expected].sort((a, b) => a.localeCompare(b));
  const sortedObserved = [...observed].sort((a, b) => a.localeCompare(b));
  if (new Set(sortedExpected).size !== sortedExpected.length) {
    throw new TypeError(`Expected ${category} inventory contains duplicate identities`);
  }
  if (new Set(sortedObserved).size !== sortedObserved.length) {
    throw new TypeError(`Observed ${category} evidence contains duplicate identities`);
  }
  if (JSON.stringify(sortedExpected) !== JSON.stringify(sortedObserved)) {
    throw new TypeError(`Observed ${category} evidence does not exactly match its expected inventory`);
  }
}

function locationKey(path: string): string {
  return JSON.stringify([path]);
}

function thresholdKey(path: string, name: string): string {
  if (name.trim().length === 0) {
    throw new TypeError("Coverage threshold identities must contain a name");
  }
  return JSON.stringify([path, name]);
}

function compareFrozenValues(
  observations: readonly FrozenValueObservation[],
  code: string,
  label: string,
  failures: VerificationFailure[],
): void {
  for (const observation of observations) {
    if (stableValue(observation.baseline) !== stableValue(observation.current)) {
      failures.push(failure(code, `${label} in ${observation.path} changed from the frozen base`,
        observation.path));
    }
  }
}

function stableValue(value: unknown): string {
  if (value === undefined) throw new TypeError("Frozen comparison evidence must be paired");
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Frozen comparison evidence must contain normalized JSON values");
    }
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  throw new TypeError("Frozen comparison evidence must contain normalized JSON values");
}

function failure(
  code: string,
  message: string,
  path: string,
  details: NonNullable<VerificationFailure["details"]> = {},
): VerificationFailure {
  return {
    code,
    category: "policy",
    repairability: "repairable",
    message,
    details: { path, ...details },
  };
}

function deduplicateFailures(failures: readonly VerificationFailure[]): VerificationFailure[] {
  const seen = new Set<string>();
  return failures.filter(item => {
    const key = `${item.code}:${JSON.stringify(item.details)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
