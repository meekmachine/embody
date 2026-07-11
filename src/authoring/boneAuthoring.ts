import type { AUInfo, BoneBinding, CompositeRotation, RotationAxis } from '../core/types';
import type { Profile } from '../mappings/types';
import { fuzzyNameMatch } from '../regions/regionMapping';

export const JOINT_CONTROL_SECTION = 'Joint Controls';

export type BoneAxisKey = 'pitch' | 'yaw' | 'roll';
export type RotationChannel = 'rx' | 'ry' | 'rz';
export type BoneAxisDirection = 'negative' | 'positive';
export type BoneAxisDirectionScale = -1 | 1;

export interface BilateralAxisDirectionScaleState {
  left: BoneAxisDirectionScale | null;
  right: BoneAxisDirectionScale | null;
}

export interface BoneAxisBindingState {
  axis: BoneAxisKey;
  channel: RotationChannel;
  nodeKey: string;
  positiveAuId: number | null;
  negativeAuId: number | null;
  positiveMaxDegrees: number | null;
  negativeMaxDegrees: number | null;
  positiveScale: BoneAxisDirectionScale | null;
  negativeScale: BoneAxisDirectionScale | null;
}

export interface BoneAxisBindingUpdate {
  channel?: RotationChannel;
  positiveAuId?: number | null;
  negativeAuId?: number | null;
  positiveMaxDegrees?: number | null;
  negativeMaxDegrees?: number | null;
  positiveScale?: BoneAxisDirectionScale | null;
  negativeScale?: BoneAxisDirectionScale | null;
  positiveLeftScale?: BoneAxisDirectionScale | null;
  positiveRightScale?: BoneAxisDirectionScale | null;
  negativeLeftScale?: BoneAxisDirectionScale | null;
  negativeRightScale?: BoneAxisDirectionScale | null;
}

export function isMaxDegreesOnlyAxisBindingUpdate(update: BoneAxisBindingUpdate): boolean {
  const entries = Object.entries(update);
  if (entries.length === 0) {
    return false;
  }

  return entries.every(([key]) => key === 'negativeMaxDegrees' || key === 'positiveMaxDegrees');
}

export interface AUBoneBindingState {
  auId: number;
  boneName: string | null;
  nodeKey: string | null;
  axis: BoneAxisKey;
  direction: BoneAxisDirection;
  channel: RotationChannel | null;
  maxDegrees: number | null;
  oppositeAuId: number | null;
  oppositeMaxDegrees: number | null;
  hasBinding: boolean;
  hasMultipleBindings: boolean;
}

export interface CreatedBoneAxisAu {
  auId: number;
  profile: Profile;
}

export interface ChiralBoneNamePair {
  leftBoneName: string;
  rightBoneName: string;
  selectedSide: 'left' | 'right';
  familyLabel: string;
}

type BoneControlMetadata = Pick<AUInfo, 'faceArea' | 'facePart'>;
export type BoneControlScope = 'Left Eye Only' | 'Right Eye Only' | 'Both Eyes';
export type BoneControlFamily = 'Horizontal Gaze' | 'Vertical Gaze';
export type BilateralBoneAxisScope = 'shared' | 'left' | 'right';
type BoneNodesMap = Profile['boneNodes'];
type AuToBonesMap = Profile['auToBones'];
type ContinuumPairsMap = NonNullable<Profile['continuumPairs']>;
type ContinuumPairInfo = ContinuumPairsMap[number];

export interface BilateralAxisScopeBindingState {
  scope: BilateralBoneAxisScope;
  label: string;
  negativeAuId: number | null;
  positiveAuId: number | null;
  negativeMaxDegrees: number | null;
  positiveMaxDegrees: number | null;
  negativeScale: BilateralAxisDirectionScaleState;
  positiveScale: BilateralAxisDirectionScaleState;
}

export interface BilateralAxisBindingState {
  axis: BoneAxisKey;
  familyLabel: string;
  leftBoneName: string;
  leftNodeKey: string;
  rightBoneName: string;
  rightNodeKey: string;
  selectedSide: 'left' | 'right';
  shared: BilateralAxisScopeBindingState;
  left: BilateralAxisScopeBindingState;
  right: BilateralAxisScopeBindingState;
}

type ChiralSide = 'left' | 'right' | 'center' | 'unknown';

interface ChiralNodeMatch {
  nodeKey: string;
  boneName: string;
  side: ChiralSide;
  stem: string;
  strength: number;
}

interface ChiralPairMatch {
  stem: string;
  left: ChiralNodeMatch;
  right: ChiralNodeMatch;
}

interface BilateralAxisContext {
  axis: BoneAxisKey;
  boneNodes: BoneNodesMap;
  familyLabel: string;
  selectedSide: 'left' | 'right';
  leftBoneName: string;
  leftNodeKey: string;
  rightBoneName: string;
  rightNodeKey: string;
  leftChannel: RotationChannel;
  rightChannel: RotationChannel;
  leftNegativeIds: number[];
  leftPositiveIds: number[];
  rightNegativeIds: number[];
  rightPositiveIds: number[];
  sharedNegativeIds: number[];
  sharedPositiveIds: number[];
  leftOnlyNegativeIds: number[];
  leftOnlyPositiveIds: number[];
  rightOnlyNegativeIds: number[];
  rightOnlyPositiveIds: number[];
  leftNeutralIds: number[];
  rightNeutralIds: number[];
}

const DEFAULT_CHANNEL_TO_AXIS: Record<RotationChannel, BoneAxisKey> = {
  rx: 'pitch',
  ry: 'yaw',
  rz: 'roll',
};

function getBoneNodeEntries(boneNodes: BoneNodesMap | undefined): Array<[string, string]> {
  return Object.entries((boneNodes ?? {}) as BoneNodesMap) as Array<[string, string]>;
}

function getAuToBonesEntries(auToBones: AuToBonesMap | undefined): Array<[string, BoneBinding[]]> {
  return Object.entries((auToBones ?? {}) as AuToBonesMap) as Array<[string, BoneBinding[]]>;
}

function getContinuumPairEntries(
  continuumPairs: Profile['continuumPairs'],
): Array<[string, ContinuumPairInfo]> {
  return Object.entries((continuumPairs ?? {}) as ContinuumPairsMap) as Array<[string, ContinuumPairInfo]>;
}

export const DEFAULT_AXIS_TO_CHANNEL: Record<BoneAxisKey, RotationChannel> = {
  pitch: 'rx',
  yaw: 'ry',
  roll: 'rz',
};

export const DEFAULT_BONE_MAX_DEGREES = 60;
const EYE_NODE_KEYS = new Set(['EYE_L', 'EYE_R']);
const LEFT_MARKERS = new Set(['left', 'l']);
const RIGHT_MARKERS = new Set(['right', 'r']);

function normalizeDegrees(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) {
    return DEFAULT_BONE_MAX_DEGREES;
  }

  return Math.max(1, Math.min(180, Math.round(value)));
}

function normalizeDirectionScale(
  value: BoneAxisDirectionScale | null | undefined,
  fallback: BoneAxisDirectionScale,
): BoneAxisDirectionScale {
  if (value === -1 || value === 1) {
    return value;
  }

  return fallback;
}

function isEyeNodeKey(nodeKey: string | null | undefined): boolean {
  if (!nodeKey) return false;
  if (EYE_NODE_KEYS.has(nodeKey)) return true;
  const tokens = tokenizeIdentifier(nodeKey);
  return tokens.includes('eye') || tokens.includes('eyes');
}

function tokenizeIdentifier(value: string): string[] {
  const withWordBreaks = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');

  return withWordBreaks
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function analyzeChiralIdentifier(rawValue: string): { side: ChiralSide; stem: string; strength: number } {
  const tokens = tokenizeIdentifier(rawValue);
  if (tokens.length === 0) {
    return { side: 'unknown', stem: '', strength: 0 };
  }

  const hasLeftWord = tokens.includes('left');
  const hasRightWord = tokens.includes('right');
  const hasLeftShort = tokens.includes('l');
  const hasRightShort = tokens.includes('r');
  const hasLeft = hasLeftWord || hasLeftShort;
  const hasRight = hasRightWord || hasRightShort;

  const side: ChiralSide = hasLeft && !hasRight
    ? 'left'
    : hasRight && !hasLeft
      ? 'right'
      : !hasLeft && !hasRight
        ? 'center'
        : 'unknown';

  const stemTokens = tokens.filter((token) => !LEFT_MARKERS.has(token) && !RIGHT_MARKERS.has(token));
  return {
    side,
    stem: (stemTokens.length > 0 ? stemTokens : tokens).join('_'),
    strength: hasLeftWord || hasRightWord ? 2 : hasLeftShort || hasRightShort ? 1 : 0,
  };
}

function buildChiralNodeMatch(nodeKey: string, boneName: string): ChiralNodeMatch {
  const keyMatch = analyzeChiralIdentifier(nodeKey);
  const boneMatch = analyzeChiralIdentifier(boneName);
  const keyIsSide = keyMatch.side === 'left' || keyMatch.side === 'right';
  const boneIsSide = boneMatch.side === 'left' || boneMatch.side === 'right';

  if (keyIsSide && (!boneIsSide || keyMatch.strength >= boneMatch.strength)) {
    return {
      nodeKey,
      boneName,
      side: keyMatch.side,
      stem: keyMatch.stem,
      strength: keyMatch.strength,
    };
  }

  if (boneIsSide) {
    return {
      nodeKey,
      boneName,
      side: boneMatch.side,
      stem: boneMatch.stem,
      strength: boneMatch.strength,
    };
  }

  return {
    nodeKey,
    boneName,
    side: 'center',
    stem: keyMatch.stem || boneMatch.stem,
    strength: Math.max(keyMatch.strength, boneMatch.strength),
  };
}

function inferChiralPairMatch(profile: Pick<Profile, 'boneNodes'>, nodeKey: string): ChiralPairMatch | null {
  const entries = getBoneNodeEntries(profile.boneNodes);
  const grouped = new Map<string, { left: ChiralNodeMatch[]; right: ChiralNodeMatch[] }>();

  for (const [candidateNodeKey, boneName] of entries) {
    const match = buildChiralNodeMatch(candidateNodeKey, boneName);
    if (match.side !== 'left' && match.side !== 'right') {
      continue;
    }

    const stem = match.stem || `${candidateNodeKey.toLowerCase()}_${match.side}`;
    const group = grouped.get(stem) ?? { left: [], right: [] };
    group[match.side].push(match);
    grouped.set(stem, group);
  }

  for (const [stem, group] of grouped.entries()) {
    const left = [...group.left].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    const right = [...group.right].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    const pairCount = Math.min(left.length, right.length);
    for (let index = 0; index < pairCount; index += 1) {
      const pair = { stem, left: left[index], right: right[index] };
      if (pair.left.nodeKey === nodeKey || pair.right.nodeKey === nodeKey) {
        return pair;
      }
    }
  }

  return null;
}

function titleCaseStem(stem: string): string {
  return stem
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function getBilateralFamilyLabel(pair: ChiralPairMatch): string {
  const titledStem = titleCaseStem(pair.stem);
  if (titledStem) {
    return titledStem;
  }

  const fallback = pair.left.boneName || pair.right.boneName || pair.left.nodeKey || pair.right.nodeKey;
  return fallback.replace(/\b(left|right)\b/ig, '').replace(/[_-]+/g, ' ').trim() || 'Bone';
}

export function inferChiralBoneNamePair(
  boneNames: string[],
  selectedBoneName: string,
): ChiralBoneNamePair | null {
  const grouped = new Map<string, { left: ChiralNodeMatch[]; right: ChiralNodeMatch[] }>();

  for (const boneName of boneNames) {
    const match = buildChiralNodeMatch(boneName, boneName);
    if (match.side !== 'left' && match.side !== 'right') {
      continue;
    }

    const stem = match.stem || `${boneName.toLowerCase()}_${match.side}`;
    const group = grouped.get(stem) ?? { left: [], right: [] };
    group[match.side].push(match);
    grouped.set(stem, group);
  }

  for (const [stem, group] of grouped.entries()) {
    const left = [...group.left].sort((a, b) => a.boneName.localeCompare(b.boneName));
    const right = [...group.right].sort((a, b) => a.boneName.localeCompare(b.boneName));
    const pairCount = Math.min(left.length, right.length);
    for (let index = 0; index < pairCount; index += 1) {
      const pair = { stem, left: left[index], right: right[index] };
      if (pair.left.boneName !== selectedBoneName && pair.right.boneName !== selectedBoneName) {
        continue;
      }

      return {
        leftBoneName: pair.left.boneName,
        rightBoneName: pair.right.boneName,
        selectedSide: pair.left.boneName === selectedBoneName ? 'left' : 'right',
        familyLabel: getBilateralFamilyLabel(pair),
      };
    }
  }

  return null;
}

export function formatAxisLabel(axis: BoneAxisKey): string {
  if (axis === 'pitch') return 'Pitch';
  if (axis === 'yaw') return 'Yaw';
  return 'Roll';
}

export function formatAxisDirectionLabel(
  axis: BoneAxisKey,
  direction: BoneAxisDirection,
): string {
  if (axis === 'pitch') {
    return direction === 'negative' ? 'Down' : 'Up';
  }

  return direction === 'negative' ? 'Left' : 'Right';
}

function matchesNodeKey(boneName: string, profile: Profile, nodeKey: string): boolean {
  const baseName = profile.boneNodes?.[nodeKey];
  if (!baseName) return false;

  const prefix = profile.bonePrefix ?? '';
  const suffix = profile.boneSuffix ?? '';
  const prefixedBase = prefix && !baseName.startsWith(prefix)
    ? `${prefix}${baseName}`
    : baseName;
  const expected = `${prefixedBase}${suffix}`;

  if (boneName === expected || boneName === baseName) {
    return true;
  }

  if (
    fuzzyNameMatch(boneName, expected, profile.suffixPattern)
    || fuzzyNameMatch(boneName, baseName, profile.suffixPattern)
  ) {
    return true;
  }

  if (profile.suffixPattern && boneName.startsWith(expected)) {
    try {
      const suffixPattern = new RegExp(profile.suffixPattern);
      return suffixPattern.test(boneName.slice(expected.length));
    } catch {
      return false;
    }
  }

  return false;
}

export function stripConfiguredBoneAffixes(
  profile: { bonePrefix?: string; boneSuffix?: string } | null | undefined,
  boneName: string,
): string {
  let stripped = boneName.trim();
  const prefix = profile?.bonePrefix?.trim() ?? '';
  const suffix = profile?.boneSuffix?.trim() ?? '';

  if (prefix && stripped.startsWith(prefix)) {
    stripped = stripped.slice(prefix.length);
  }

  if (suffix && stripped.endsWith(suffix)) {
    stripped = stripped.slice(0, Math.max(0, stripped.length - suffix.length));
  }

  return stripped || boneName.trim();
}

function formatBoneAutoTitle(
  profile: { bonePrefix?: string; boneSuffix?: string } | null | undefined,
  boneName: string,
): string {
  const stripped = stripConfiguredBoneAffixes(profile, boneName);
  const tokens = tokenizeIdentifier(stripped);
  if (tokens.length === 0) {
    return stripped;
  }

  return tokens.map((token) => (
    token.length === 1
      ? token.toUpperCase()
      : `${token.charAt(0).toUpperCase()}${token.slice(1)}`
  )).join(' ');
}

function deriveContinuumLabelFromAuNames(
  negativeName: string | null | undefined,
  positiveName: string | null | undefined,
  axis: BoneAxisKey | null | undefined,
): string | null {
  const left = negativeName?.trim();
  const right = positiveName?.trim();
  if (!left || !right) {
    return null;
  }

  const leftTokens = left.split(/\s+/).filter(Boolean);
  const rightTokens = right.split(/\s+/).filter(Boolean);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return null;
  }

  const commonTokens: string[] = [];
  const sharedLength = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftTokens[index].toLowerCase() !== rightTokens[index].toLowerCase()) {
      break;
    }
    commonTokens.push(leftTokens[index]);
  }

  const root = commonTokens.join(' ').trim();
  if (!root) {
    return null;
  }

  if (!axis) {
    return root;
  }

  const lowerRoot = root.toLowerCase();
  const axisLabel = formatAxisLabel(axis);
  if (
    lowerRoot.includes(axisLabel.toLowerCase())
    || /\b(turn|look|tilt|horizontal|vertical)\b/i.test(root)
  ) {
    return root;
  }

  return `${root} ${axisLabel}`;
}

export function findNodeKeyForBone(boneName: string, profile: Profile | null): string | null {
  if (!profile?.boneNodes) return null;

  for (const nodeKey of Object.keys(profile.boneNodes)) {
    if (matchesNodeKey(boneName, profile, nodeKey)) {
      return nodeKey;
    }
  }

  return null;
}

function sanitizeBoneNodeKey(
  profile: { bonePrefix?: string; boneSuffix?: string } | null | undefined,
  boneName: string,
): string {
  const normalized = stripConfiguredBoneAffixes(profile, boneName)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized || 'CUSTOM';
}

function buildPreferredChiralNodeKey(boneName: string): string | null {
  const match = buildChiralNodeMatch(boneName, boneName);
  if (match.side !== 'left' && match.side !== 'right') {
    return null;
  }

  const normalizedStem = (match.stem || tokenizeIdentifier(boneName).join('_'))
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  if (!normalizedStem) {
    return null;
  }

  return `${normalizedStem}_${match.side === 'left' ? 'L' : 'R'}`;
}

function ensureBoneNodeKeyWithPreferredKey(
  profile: Profile,
  boneName: string,
  preferredKey?: string | null,
): { nodeKey: string; boneNodes: Record<string, string> } {
  const existing = findNodeKeyForBone(boneName, profile);
  if (existing) {
    return { nodeKey: existing, boneNodes: { ...(profile.boneNodes ?? {}) } };
  }

  const boneNodes = { ...(profile.boneNodes ?? {}) };
  const baseKey = boneName.trim() || preferredKey?.trim() || sanitizeBoneNodeKey(profile, boneName);

  if (!boneNodes[baseKey] || boneNodes[baseKey] === boneName) {
    boneNodes[baseKey] = boneName;
    return { nodeKey: baseKey, boneNodes };
  }

  let suffix = 2;
  let candidate = `${baseKey}_${suffix}`;
  while (boneNodes[candidate] && boneNodes[candidate] !== boneName) {
    suffix += 1;
    candidate = `${baseKey}_${suffix}`;
  }

  boneNodes[candidate] = boneName;
  return { nodeKey: candidate, boneNodes };
}

export function ensureBoneNodeKey(profile: Profile, boneName: string): { nodeKey: string; boneNodes: Record<string, string> } {
  return ensureBoneNodeKeyWithPreferredKey(profile, boneName);
}

export function ensureBilateralBoneNodeKeys(
  profile: Profile,
  leftBoneName: string,
  rightBoneName: string,
): Profile {
  const leftEnsured = ensureBoneNodeKeyWithPreferredKey(profile, leftBoneName, buildPreferredChiralNodeKey(leftBoneName));
  const leftProfile = {
    ...profile,
    boneNodes: leftEnsured.boneNodes,
  };
  const rightEnsured = ensureBoneNodeKeyWithPreferredKey(leftProfile, rightBoneName, buildPreferredChiralNodeKey(rightBoneName));
  return {
    ...leftProfile,
    boneNodes: rightEnsured.boneNodes,
  };
}

export function resolveBoneNameForNodeKey(profile: Profile, nodeKey: string): string | null {
  const baseName = profile.boneNodes?.[nodeKey];
  if (!baseName) return null;

  const prefix = profile.bonePrefix ?? '';
  const suffix = profile.boneSuffix ?? '';
  const prefixedBase = prefix && !baseName.startsWith(prefix)
    ? `${prefix}${baseName}`
    : baseName;
  return `${prefixedBase}${suffix}` || baseName;
}

function cloneAuToBones(auToBones: Profile['auToBones']): Record<number, BoneBinding[]> {
  return Object.fromEntries(
    getAuToBonesEntries(auToBones).map(([auId, bindings]) => [
      Number(auId),
      bindings.map((binding) => ({ ...binding })),
    ]),
  ) as Record<number, BoneBinding[]>;
}

function cloneSelector(selector: number | number[] | undefined): number | number[] | undefined {
  if (selector == null) return undefined;
  return Array.isArray(selector) ? [...selector] : selector;
}

function cloneRotationAxis(axisConfig: RotationAxis | null | undefined): RotationAxis | null {
  if (!axisConfig) return null;
  return {
    ...axisConfig,
    aus: [...axisConfig.aus],
    ...(axisConfig.negative !== undefined ? { negative: cloneSelector(axisConfig.negative) } : {}),
    ...(axisConfig.positive !== undefined ? { positive: cloneSelector(axisConfig.positive) } : {}),
  };
}

function cloneCompositeRotations(composites: Profile['compositeRotations']): CompositeRotation[] {
  return (composites ?? []).map((entry) => ({
    node: entry.node,
    pitch: cloneRotationAxis(entry.pitch),
    yaw: cloneRotationAxis(entry.yaw),
    roll: cloneRotationAxis(entry.roll),
  }));
}

function findDirectionalBindingForAxisFallback(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
  channel: RotationChannel,
  scale: -1 | 1,
): { auId: number | null; binding: BoneBinding | null } {
  const semanticAxisClaims = getSemanticAxisClaims(profile, nodeKey);

  for (const [auIdStr, bindings] of getAuToBonesEntries(profile.auToBones)) {
    const match = bindings.find((binding) => (
      binding.node === nodeKey &&
      binding.channel === channel &&
      binding.scale === scale
    ));
    if (!match) {
      continue;
    }

    const auId = Number(auIdStr);
    const claimedAxis = semanticAxisClaims.get(auId);
    if (claimedAxis && claimedAxis !== axis) {
      continue;
    }

    return { auId, binding: match };
  }

  return { auId: null, binding: null };
}

function getDirectionalAuIdsForAxisFallback(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
  channel: RotationChannel,
  scale: -1 | 1,
): number[] {
  const semanticAxisClaims = getSemanticAxisClaims(profile, nodeKey);

  return getAuToBonesEntries(profile.auToBones)
    .filter(([auIdStr, bindings]) => {
      const claimedAxis = semanticAxisClaims.get(Number(auIdStr));
      if (claimedAxis && claimedAxis !== axis) {
        return false;
      }

      return bindings.some((binding) => (
        binding.node === nodeKey &&
        binding.channel === channel &&
        binding.scale === scale
      ));
    })
    .map(([auIdStr]) => Number(auIdStr));
}

function findAuBinding(
  profile: Profile,
  nodeKey: string,
  channel: RotationChannel,
  auId: number,
): BoneBinding | null {
  return profile.auToBones?.[auId]?.find((binding) => (
    binding.node === nodeKey &&
    binding.channel === channel
  )) ?? null;
}

function findAnyRotationBindingForAu(
  profile: Profile,
  nodeKey: string,
  auId: number,
): (BoneBinding & { channel: RotationChannel }) | null {
  return profile.auToBones?.[auId]?.find((binding): binding is BoneBinding & { channel: RotationChannel } => (
    binding.node === nodeKey &&
    isRotationChannel(binding.channel)
  )) ?? null;
}

function selectorToArray(selector: number | number[] | undefined): number[] {
  if (selector == null) return [];
  return Array.isArray(selector) ? selector : [selector];
}

function selectorFromArray(values: number[]): number | number[] | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return values;
}

function getSemanticAxisClaims(
  profile: Profile,
  nodeKey: string,
): Map<number, BoneAxisKey> {
  const claims = new Map<number, BoneAxisKey>();

  getContinuumPairEntries(profile.continuumPairs).forEach(([auIdStr, info]) => {
    if (info.node === nodeKey) {
      claims.set(Number(auIdStr), info.axis);
    }
  });

  const composite = getCompositeRotationEntry(profile, nodeKey);
  if (!composite) {
    return claims;
  }

  (['pitch', 'yaw', 'roll'] as BoneAxisKey[]).forEach((axis) => {
    const axisConfig = composite[axis];
    if (!axisConfig) {
      return;
    }

    selectorToArray(axisConfig.negative).forEach((auId) => claims.set(auId, axis));
    selectorToArray(axisConfig.positive).forEach((auId) => claims.set(auId, axis));
    axisConfig.aus.forEach((auId) => claims.set(auId, axis));
  });

  return claims;
}

function isRotationChannel(channel: BoneBinding['channel']): channel is RotationChannel {
  return channel === 'rx' || channel === 'ry' || channel === 'rz';
}

function getAssignedAuIds(binding: Pick<BoneAxisBindingState, 'negativeAuId' | 'positiveAuId'>): number[] {
  return Array.from(new Set([binding.negativeAuId, binding.positiveAuId].filter((value): value is number => value != null)));
}

export function inferEyeControlScope(
  profile: Pick<Profile, 'auToBones'>,
  binding: Pick<BoneAxisBindingState, 'nodeKey' | 'negativeAuId' | 'positiveAuId'>,
): BoneControlScope | null {
  if (!isEyeNodeKey(binding.nodeKey)) {
    return null;
  }

  const touchedEyeNodes = new Set<string>();
  getAssignedAuIds(binding).forEach((auId) => {
    (profile.auToBones?.[auId] ?? []).forEach((entry) => {
      if (isRotationChannel(entry.channel) && isEyeNodeKey(entry.node)) {
        touchedEyeNodes.add(entry.node);
      }
    });
  });

  const touchedSides = Array.from(touchedEyeNodes)
    .map((node) => buildChiralNodeMatch(node, node).side);
  if (touchedSides.includes('left') && touchedSides.includes('right')) {
    return 'Both Eyes';
  }

  const selectedSide = buildChiralNodeMatch(binding.nodeKey, binding.nodeKey).side;
  if (binding.nodeKey === 'EYE_L' || selectedSide === 'left') {
    return 'Left Eye Only';
  }

  if (binding.nodeKey === 'EYE_R' || selectedSide === 'right') {
    return 'Right Eye Only';
  }

  return null;
}

export function inferEyeControlFamily(
  binding: Pick<BoneAxisBindingState, 'nodeKey' | 'axis'>,
): BoneControlFamily | null {
  if (!isEyeNodeKey(binding.nodeKey)) {
    return null;
  }

  if (binding.axis === 'yaw') {
    return 'Horizontal Gaze';
  }

  if (binding.axis === 'pitch') {
    return 'Vertical Gaze';
  }

  return null;
}

function getConfiguredCompositeChannel(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
): RotationChannel | null {
  const composite = profile.compositeRotations?.find((entry) => entry.node === nodeKey);
  const axisConfig = composite?.[axis];
  return axisConfig?.axis ?? null;
}

function getCompositeRotationEntry(profile: Profile, nodeKey: string): CompositeRotation | null {
  return profile.compositeRotations?.find((entry) => entry.node === nodeKey) ?? null;
}

function getCompositeAxisConfig(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
): RotationAxis | null {
  return getCompositeRotationEntry(profile, nodeKey)?.[axis] ?? null;
}

function getContinuumChannel(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
): RotationChannel | null {
  for (const [auIdStr, info] of getContinuumPairEntries(profile.continuumPairs)) {
    if (info.node !== nodeKey || info.axis !== axis) {
      continue;
    }

    const candidates = [Number(auIdStr), info.pairId];
    for (const auId of candidates) {
      const binding = profile.auToBones?.[auId]?.find((entry): entry is BoneBinding & { channel: RotationChannel } => (
        entry.node === nodeKey &&
        isRotationChannel(entry.channel)
      ));
      if (binding) {
        return binding.channel;
      }
    }
  }

  return null;
}

function findSemanticDirectionalBinding(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
  channel: RotationChannel,
  direction: BoneAxisDirection,
): { auId: number | null; binding: BoneBinding | null } {
  const isNegative = direction === 'negative';

  for (const [auIdStr, info] of getContinuumPairEntries(profile.continuumPairs)) {
    if (
      info.node === nodeKey &&
      info.axis === axis &&
      info.isNegative === isNegative
    ) {
      const auId = Number(auIdStr);
      const binding = findAuBinding(profile, nodeKey, channel, auId);
      if (binding && isRotationChannel(binding.channel)) {
        return { auId, binding };
      }

      const fallbackBinding = findAnyRotationBindingForAu(profile, nodeKey, auId);
      if (fallbackBinding) {
        return { auId, binding: fallbackBinding };
      }
    }
  }

  const composite = profile.compositeRotations?.find((entry) => entry.node === nodeKey);
  const axisConfig = composite?.[axis];
  const candidateIds = selectorToArray(isNegative ? axisConfig?.negative : axisConfig?.positive);

  for (const auId of candidateIds) {
    const binding = findAuBinding(profile, nodeKey, channel, auId);
    if (binding && isRotationChannel(binding.channel)) {
      return { auId, binding };
    }

    const fallbackBinding = findAnyRotationBindingForAu(profile, nodeKey, auId);
    if (fallbackBinding) {
      return { auId, binding: fallbackBinding };
    }
  }

  return findDirectionalBindingForAxisFallback(
    profile,
    nodeKey,
    axis,
    channel,
    direction === 'positive' ? 1 : -1,
  );
}

function getAxisDirectionSelectorIds(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
  channel: RotationChannel,
  direction: BoneAxisDirection,
): number[] {
  const axisConfig = getCompositeAxisConfig(profile, nodeKey, axis);
  const pairIds = getContinuumPairEntries(profile.continuumPairs)
    .filter(([, info]) => (
      info.node === nodeKey &&
      info.axis === axis &&
      info.isNegative === (direction === 'negative')
    ))
    .map(([auIdStr]) => Number(auIdStr));

  const selectorIds = selectorToArray(direction === 'negative' ? axisConfig?.negative : axisConfig?.positive);
  if (axisConfig) {
    const negativeIds = selectorToArray(axisConfig.negative);
    const positiveIds = selectorToArray(axisConfig.positive);
    const unassignedIds = axisConfig.aus.filter((auId) => (
      !negativeIds.includes(auId) &&
      !positiveIds.includes(auId)
    ));
    const semanticIds = Array.from(new Set([
      ...selectorIds,
      ...(direction === 'positive' && selectorIds.length > 0 ? unassignedIds : []),
      ...pairIds,
    ]));

    if (semanticIds.length > 0) {
      return semanticIds;
    }
  }

  if (pairIds.length > 0) {
    return Array.from(new Set(pairIds));
  }

  const targetScale = direction === 'positive' ? 1 : -1;
  return getDirectionalAuIdsForAxisFallback(profile, nodeKey, axis, channel, targetScale);
}

function findRotationBindingForAxisAu(
  profile: Profile,
  nodeKey: string,
  auId: number,
  channels: RotationChannel[],
): BoneBinding | null {
  return profile.auToBones?.[auId]?.find((binding) => (
    binding.node === nodeKey &&
    isRotationChannel(binding.channel) &&
    channels.includes(binding.channel)
  )) ?? null;
}

function findAxisRotationBinding(
  profile: Profile,
  auId: number | null,
  nodeKey: string,
  channel: RotationChannel,
): BoneBinding | null {
  if (auId == null) return null;
  return profile.auToBones?.[auId]?.find((binding) => (
    binding.node === nodeKey &&
    binding.channel === channel
  )) ?? null;
}

function buildBilateralAxisContext(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
): BilateralAxisContext | null {
  const { boneNodes, nodeKey } = ensureBoneNodeKey(profile, boneName);
  const profileWithSelectedNode = {
    ...profile,
    boneNodes,
  };
  const pair = inferChiralPairMatch(profileWithSelectedNode, nodeKey);
  if (!pair) {
    return null;
  }

  const selectedSide = pair.left.nodeKey === nodeKey ? 'left' : 'right';
  const leftBoneName = resolveBoneNameForNodeKey(profileWithSelectedNode, pair.left.nodeKey)
    ?? profileWithSelectedNode.boneNodes?.[pair.left.nodeKey]
    ?? pair.left.nodeKey;
  const rightBoneName = resolveBoneNameForNodeKey(profileWithSelectedNode, pair.right.nodeKey)
    ?? profileWithSelectedNode.boneNodes?.[pair.right.nodeKey]
    ?? pair.right.nodeKey;
  const leftChannel = resolveBoneAxisChannel(profileWithSelectedNode, leftBoneName, axis);
  const rightChannel = resolveBoneAxisChannel(profileWithSelectedNode, rightBoneName, axis);

  const leftNegativeIds = getAxisDirectionSelectorIds(profileWithSelectedNode, pair.left.nodeKey, axis, leftChannel, 'negative');
  const leftPositiveIds = getAxisDirectionSelectorIds(profileWithSelectedNode, pair.left.nodeKey, axis, leftChannel, 'positive');
  const rightNegativeIds = getAxisDirectionSelectorIds(profileWithSelectedNode, pair.right.nodeKey, axis, rightChannel, 'negative');
  const rightPositiveIds = getAxisDirectionSelectorIds(profileWithSelectedNode, pair.right.nodeKey, axis, rightChannel, 'positive');

  const hasBilateralBinding = (auId: number): boolean => (
    !!findRotationBindingForAxisAu(profileWithSelectedNode, pair.left.nodeKey, auId, [leftChannel]) &&
    !!findRotationBindingForAxisAu(profileWithSelectedNode, pair.right.nodeKey, auId, [rightChannel])
  );

  const sharedNegativeIds = Array.from(new Set([
    ...leftNegativeIds,
    ...rightNegativeIds,
  ])).filter((auId) => hasBilateralBinding(auId));
  const sharedPositiveIds = Array.from(new Set([
    ...leftPositiveIds,
    ...rightPositiveIds,
  ])).filter((auId) => (
    !sharedNegativeIds.includes(auId) &&
    hasBilateralBinding(auId)
  ));

  const leftOnlyNegativeIds = leftNegativeIds.filter((auId) => !sharedNegativeIds.includes(auId));
  const leftOnlyPositiveIds = leftPositiveIds.filter((auId) => !sharedPositiveIds.includes(auId));
  const rightOnlyNegativeIds = rightNegativeIds.filter((auId) => !sharedNegativeIds.includes(auId));
  const rightOnlyPositiveIds = rightPositiveIds.filter((auId) => !sharedPositiveIds.includes(auId));

  const leftAxisConfig = getCompositeAxisConfig(profileWithSelectedNode, pair.left.nodeKey, axis);
  const rightAxisConfig = getCompositeAxisConfig(profileWithSelectedNode, pair.right.nodeKey, axis);
  const leftNeutralIds = leftAxisConfig?.aus.filter((auId) => (
    !leftNegativeIds.includes(auId) && !leftPositiveIds.includes(auId)
  )) ?? [];
  const rightNeutralIds = rightAxisConfig?.aus.filter((auId) => (
    !rightNegativeIds.includes(auId) && !rightPositiveIds.includes(auId)
  )) ?? [];

  return {
    axis,
    boneNodes: profileWithSelectedNode.boneNodes,
    familyLabel: getBilateralFamilyLabel(pair),
    selectedSide,
    leftBoneName,
    leftNodeKey: pair.left.nodeKey,
    rightBoneName,
    rightNodeKey: pair.right.nodeKey,
    leftChannel,
    rightChannel,
    leftNegativeIds,
    leftPositiveIds,
    rightNegativeIds,
    rightPositiveIds,
    sharedNegativeIds,
    sharedPositiveIds,
    leftOnlyNegativeIds,
    leftOnlyPositiveIds,
    rightOnlyNegativeIds,
    rightOnlyPositiveIds,
    leftNeutralIds,
    rightNeutralIds,
  };
}

function buildBilateralScopeState(
  profile: Profile,
  context: BilateralAxisContext,
  scope: BilateralBoneAxisScope,
): BilateralAxisScopeBindingState {
  const negativeAuId = scope === 'shared'
    ? context.sharedNegativeIds[0] ?? null
    : scope === 'left'
      ? context.leftOnlyNegativeIds[0] ?? null
      : context.rightOnlyNegativeIds[0] ?? null;
  const positiveAuId = scope === 'shared'
    ? context.sharedPositiveIds[0] ?? null
    : scope === 'left'
      ? context.leftOnlyPositiveIds[0] ?? null
      : context.rightOnlyPositiveIds[0] ?? null;
  const maxDegreesSourceNode = scope === 'right' ? context.rightNodeKey : context.leftNodeKey;
  const maxDegreesSourceChannel = scope === 'right' ? context.rightChannel : context.leftChannel;
  const negativeLeftBinding = scope === 'right'
    ? null
    : findAxisRotationBinding(profile, negativeAuId, context.leftNodeKey, context.leftChannel);
  const negativeRightBinding = scope === 'left'
    ? null
    : findAxisRotationBinding(profile, negativeAuId, context.rightNodeKey, context.rightChannel);
  const positiveLeftBinding = scope === 'right'
    ? null
    : findAxisRotationBinding(profile, positiveAuId, context.leftNodeKey, context.leftChannel);
  const positiveRightBinding = scope === 'left'
    ? null
    : findAxisRotationBinding(profile, positiveAuId, context.rightNodeKey, context.rightChannel);

  return {
    scope,
    label: scope === 'shared' ? 'Both' : scope === 'left' ? 'Left only' : 'Right only',
    negativeAuId,
    positiveAuId,
    negativeMaxDegrees: findAxisRotationBinding(profile, negativeAuId, maxDegreesSourceNode, maxDegreesSourceChannel)?.maxDegrees ?? null,
    positiveMaxDegrees: findAxisRotationBinding(profile, positiveAuId, maxDegreesSourceNode, maxDegreesSourceChannel)?.maxDegrees ?? null,
    negativeScale: {
      left: negativeLeftBinding?.scale ?? null,
      right: negativeRightBinding?.scale ?? null,
    },
    positiveScale: {
      left: positiveLeftBinding?.scale ?? null,
      right: positiveRightBinding?.scale ?? null,
    },
  };
}

function resolveSemanticDirectionScale(
  profile: Profile,
  nodeKey: string,
  axis: BoneAxisKey,
  channel: RotationChannel,
  direction: BoneAxisDirection,
): -1 | 1 {
  const current = findSemanticDirectionalBinding(profile, nodeKey, axis, channel, direction).binding;
  if (current) {
    return current.scale;
  }

  const opposite = findSemanticDirectionalBinding(
    profile,
    nodeKey,
    axis,
    channel,
    direction === 'negative' ? 'positive' : 'negative',
  ).binding;
  if (opposite) {
    return opposite.scale === 1 ? -1 : 1;
  }

  return direction === 'negative' ? -1 : 1;
}

export function resolveBoneAxisChannel(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
): RotationChannel {
  const { nodeKey } = ensureBoneNodeKey(profile, boneName);
  const configuredChannel = getConfiguredCompositeChannel(profile, nodeKey, axis);
  if (configuredChannel) {
    const negativeBinding = findSemanticDirectionalBinding(
      profile,
      nodeKey,
      axis,
      configuredChannel,
      'negative',
    ).binding;
    if (negativeBinding && isRotationChannel(negativeBinding.channel)) {
      return negativeBinding.channel;
    }

    const positiveBinding = findSemanticDirectionalBinding(
      profile,
      nodeKey,
      axis,
      configuredChannel,
      'positive',
    ).binding;
    if (positiveBinding && isRotationChannel(positiveBinding.channel)) {
      return positiveBinding.channel;
    }

    return configuredChannel;
  }

  return getContinuumChannel(profile, nodeKey, axis)
    ?? DEFAULT_AXIS_TO_CHANNEL[axis];
}

export function getBoneAxisBindingState(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
): BoneAxisBindingState {
  const { nodeKey } = ensureBoneNodeKey(profile, boneName);
  const channel = resolveBoneAxisChannel(profile, boneName, axis);
  const positive = findSemanticDirectionalBinding(profile, nodeKey, axis, channel, 'positive');
  const negative = findSemanticDirectionalBinding(profile, nodeKey, axis, channel, 'negative');

  return {
    axis,
    channel,
    nodeKey,
    positiveAuId: positive.auId,
    negativeAuId: negative.auId,
    positiveMaxDegrees: positive.binding?.maxDegrees ?? null,
    negativeMaxDegrees: negative.binding?.maxDegrees ?? null,
    positiveScale: positive.binding?.scale ?? null,
    negativeScale: negative.binding?.scale ?? null,
  };
}

export function getBilateralAxisBindingState(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
): BilateralAxisBindingState | null {
  const context = buildBilateralAxisContext(profile, boneName, axis);
  if (!context) {
    return null;
  }

  return {
    axis,
    familyLabel: context.familyLabel,
    leftBoneName: context.leftBoneName,
    leftNodeKey: context.leftNodeKey,
    rightBoneName: context.rightBoneName,
    rightNodeKey: context.rightNodeKey,
    selectedSide: context.selectedSide,
    shared: buildBilateralScopeState(profile, context, 'shared'),
    left: buildBilateralScopeState(profile, context, 'left'),
    right: buildBilateralScopeState(profile, context, 'right'),
  };
}

export function getAUBoneBindingState(
  profile: Profile,
  auId: number,
): AUBoneBindingState {
  const rotationBindings = (profile.auToBones?.[auId] ?? []).filter((binding): binding is BoneBinding & { channel: RotationChannel } => (
    isRotationChannel(binding.channel)
  ));
  const primary = rotationBindings[0] ?? null;
  const pairInfo = profile.continuumPairs?.[auId];
  const boneName = primary ? resolveBoneNameForNodeKey(profile, primary.node) ?? profile.boneNodes?.[primary.node] ?? primary.node : null;
  const axis = pairInfo?.axis
    ?? (primary ? getAxisFromChannel(primary.channel) : null)
    ?? 'pitch';
  const axisState = boneName ? getBoneAxisBindingState(profile, boneName, axis) : null;
  const direction: BoneAxisDirection = axisState?.negativeAuId === auId
    ? 'negative'
    : axisState?.positiveAuId === auId
      ? 'positive'
      : pairInfo?.isNegative
        ? 'negative'
        : primary?.scale === -1
          ? 'negative'
          : 'positive';

  return {
    auId,
    boneName,
    nodeKey: primary?.node ?? pairInfo?.node ?? null,
    axis,
    direction,
    channel: primary?.channel ?? null,
    maxDegrees: primary?.maxDegrees ?? null,
    oppositeAuId: axisState
      ? direction === 'negative' ? axisState.positiveAuId : axisState.negativeAuId
      : null,
    oppositeMaxDegrees: axisState
      ? direction === 'negative' ? axisState.positiveMaxDegrees : axisState.negativeMaxDegrees
      : null,
    hasBinding: primary != null,
    hasMultipleBindings: rotationBindings.length > 1,
  };
}

function removeAUBoneBinding(profile: Profile, auId: number): Profile {
  const rotationBindings = (profile.auToBones?.[auId] ?? []).filter((binding): binding is BoneBinding & { channel: RotationChannel } => (
    isRotationChannel(binding.channel)
  ));
  if (rotationBindings.length === 0) {
    return profile;
  }

  let nextProfile = profile;

  rotationBindings.forEach((binding) => {
    const boneName = resolveBoneNameForNodeKey(nextProfile, binding.node) ?? nextProfile.boneNodes?.[binding.node] ?? binding.node;
    const inferredAxis = nextProfile.continuumPairs?.[auId]?.node === binding.node
      ? nextProfile.continuumPairs?.[auId]?.axis
      : getAxisFromChannel(binding.channel);
    if (!boneName || !inferredAxis) return;

    const axisState = getBoneAxisBindingState(nextProfile, boneName, inferredAxis);

    if (axisState.negativeAuId === auId) {
      nextProfile = applyBoneAxisBindingUpdate(nextProfile, boneName, inferredAxis, {
        negativeAuId: null,
        negativeMaxDegrees: null,
      });
    }

    if (axisState.positiveAuId === auId) {
      nextProfile = applyBoneAxisBindingUpdate(nextProfile, boneName, inferredAxis, {
        positiveAuId: null,
        positiveMaxDegrees: null,
      });
    }
  });

  return nextProfile;
}

export function applyAUBoneBindingUpdate(
  profile: Profile,
  auId: number,
  update: {
    boneName: string | null;
    axis: BoneAxisKey;
    direction: BoneAxisDirection;
    maxDegrees: number | null;
  },
): Profile {
  const clearedProfile = removeAUBoneBinding(profile, auId);
  if (!update.boneName) {
    return clearedProfile;
  }

  return applyBoneAxisBindingUpdate(clearedProfile, update.boneName, update.axis, update.direction === 'negative'
    ? {
        negativeAuId: auId,
        negativeMaxDegrees: update.maxDegrees,
      }
    : {
        positiveAuId: auId,
        positiveMaxDegrees: update.maxDegrees,
      });
}

function buildContinuumLabel(profile: Profile, boneName: string, axis: BoneAxisKey): string {
  return `${formatBoneAutoTitle(profile, boneName)} ${formatAxisLabel(axis)}`;
}

export function resolveContinuumDisplayLabel(
  profile: Pick<Profile, 'continuumPairs' | 'continuumLabels' | 'auInfo' | 'boneNodes' | 'bonePrefix' | 'boneSuffix'>,
  negativeAuId: number,
  positiveAuId: number,
): string {
  const explicitLabel = profile.continuumLabels?.[`${negativeAuId}-${positiveAuId}`]?.trim() || '';
  const pairInfo = profile.continuumPairs?.[negativeAuId];
  const axis = pairInfo?.axis ?? null;
  const nodeKey = pairInfo?.node ?? null;
  const boneName = nodeKey
    ? resolveBoneNameForNodeKey(profile as Profile, nodeKey) ?? profile.boneNodes?.[nodeKey] ?? nodeKey
    : null;
  const autoLabel = axis && boneName
    ? buildContinuumLabel(profile as Profile, boneName, axis)
    : '';
  const derivedLabel = deriveContinuumLabelFromAuNames(
    profile.auInfo?.[String(negativeAuId)]?.name,
    profile.auInfo?.[String(positiveAuId)]?.name,
    axis,
  );

  if (explicitLabel && (!autoLabel || explicitLabel !== autoLabel)) {
    return explicitLabel;
  }

  return derivedLabel || explicitLabel || autoLabel || `AU ${negativeAuId} <-> AU ${positiveAuId}`;
}

export function applyBoneAxisBindingUpdate(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
  update: BoneAxisBindingUpdate,
): Profile {
  const current = getBoneAxisBindingState(profile, boneName, axis);
  const { boneNodes, nodeKey } = ensureBoneNodeKey(profile, boneName);
  const previousChannel = current.channel;
  const channel = update.channel ?? current.channel;
  const existingAxisConfig = getCompositeAxisConfig(profile, nodeKey, axis);
  const existingNegativeSelectorIds = getAxisDirectionSelectorIds(profile, nodeKey, axis, previousChannel, 'negative');
  const existingPositiveSelectorIds = getAxisDirectionSelectorIds(profile, nodeKey, axis, previousChannel, 'positive');
  const existingNeutralSelectorIds = existingAxisConfig?.aus.filter((auId) => (
    !existingNegativeSelectorIds.includes(auId) &&
    !existingPositiveSelectorIds.includes(auId)
  )) ?? [];

  const nextPositiveAuId = update.positiveAuId !== undefined
    ? update.positiveAuId
    : current.positiveAuId;
  const nextNegativeAuId = update.negativeAuId !== undefined
    ? update.negativeAuId
    : current.negativeAuId;
  const nextPositiveMaxDegrees = nextPositiveAuId == null
    ? null
    : normalizeDegrees(update.positiveMaxDegrees !== undefined
      ? update.positiveMaxDegrees
      : current.positiveMaxDegrees);
  const nextNegativeMaxDegrees = nextNegativeAuId == null
    ? null
    : normalizeDegrees(update.negativeMaxDegrees !== undefined
      ? update.negativeMaxDegrees
      : current.negativeMaxDegrees);

  const nextNegativeSelectorIds = update.negativeAuId !== undefined
    ? (nextNegativeAuId == null ? [] : [nextNegativeAuId])
    : existingNegativeSelectorIds.length > 0
      ? existingNegativeSelectorIds
      : (current.negativeAuId != null ? [current.negativeAuId] : []);
  const nextPositiveSelectorIds = update.positiveAuId !== undefined
    ? (nextPositiveAuId == null ? [] : [nextPositiveAuId])
    : existingPositiveSelectorIds.length > 0
      ? existingPositiveSelectorIds
      : (current.positiveAuId != null ? [current.positiveAuId] : []);
  const normalizedNegativeSelectorIds = Array.from(new Set(
    nextNegativeSelectorIds.filter((auId) => auId !== nextPositiveAuId),
  ));
  const normalizedPositiveSelectorIds = Array.from(new Set(
    nextPositiveSelectorIds.filter((auId) => auId !== nextNegativeAuId),
  ));

  const previousPositive = findSemanticDirectionalBinding(profile, nodeKey, axis, previousChannel, 'positive').binding;
  const previousNegative = findSemanticDirectionalBinding(profile, nodeKey, axis, previousChannel, 'negative').binding;
  const resolvedPositiveScale = resolveSemanticDirectionScale(profile, nodeKey, axis, previousChannel, 'positive');
  const resolvedNegativeScale = resolveSemanticDirectionScale(profile, nodeKey, axis, previousChannel, 'negative');
  const nextPositiveScale = nextPositiveAuId == null
    ? null
    : normalizeDirectionScale(
      update.positiveScale !== undefined ? update.positiveScale : current.positiveScale,
      resolvedPositiveScale,
    );
  const nextNegativeScale = nextNegativeAuId == null
    ? null
    : normalizeDirectionScale(
      update.negativeScale !== undefined ? update.negativeScale : current.negativeScale,
      resolvedNegativeScale,
    );
  const nextAuToBones = cloneAuToBones(profile.auToBones ?? {});
  const relevantChannels = Array.from(new Set([previousChannel, channel]));
  const relevantAuIds = Array.from(new Set([
    ...existingNegativeSelectorIds,
    ...existingPositiveSelectorIds,
    ...existingNeutralSelectorIds,
    ...normalizedNegativeSelectorIds,
    ...normalizedPositiveSelectorIds,
  ]));
  const previousBindingsByAuId = new Map<number, BoneBinding | null>(
    relevantAuIds.map((auId) => [
      auId,
      findRotationBindingForAxisAu(profile, nodeKey, auId, relevantChannels),
    ]),
  );

  const stripAxisBindings = (auIds: number[]) => {
    for (const auId of auIds) {
      const currentBindings = nextAuToBones[auId];
      if (!currentBindings) continue;

      const nextBindings = currentBindings.filter((binding) => !(
        binding.node === nodeKey &&
        isRotationChannel(binding.channel) &&
        relevantChannels.includes(binding.channel)
      ));

      if (nextBindings.length > 0) {
        nextAuToBones[auId] = nextBindings;
      } else {
        delete nextAuToBones[auId];
      }
    }
  };

  stripAxisBindings(relevantAuIds);

  const upsertBinding = (
    auId: number,
    scale: -1 | 1,
    maxDegrees: number,
    previousBinding: BoneBinding | null,
  ) => {
    const nextBinding: BoneBinding = {
      node: nodeKey,
      channel,
      scale,
      maxDegrees,
    };

    if (previousBinding?.side) {
      nextBinding.side = previousBinding.side;
    }

    nextAuToBones[auId] = [...(nextAuToBones[auId] ?? []), nextBinding];
  };

  existingNeutralSelectorIds.forEach((auId) => {
    const previousBinding = previousBindingsByAuId.get(auId);
    if (!previousBinding?.maxDegrees) return;
    upsertBinding(auId, previousBinding.scale, previousBinding.maxDegrees, previousBinding);
  });

  normalizedNegativeSelectorIds.forEach((auId) => {
    const previousBinding = previousBindingsByAuId.get(auId);
    const maxDegrees = auId === nextNegativeAuId
      ? nextNegativeMaxDegrees
      : previousBinding?.maxDegrees ?? null;
    if (maxDegrees == null) return;
    const scale = auId === nextNegativeAuId
      ? nextNegativeScale
      : previousBinding?.scale ?? resolvedNegativeScale;
    if (scale == null) return;
    upsertBinding(auId, scale, maxDegrees, previousBinding ?? previousNegative);
  });

  normalizedPositiveSelectorIds.forEach((auId) => {
    const previousBinding = previousBindingsByAuId.get(auId);
    const maxDegrees = auId === nextPositiveAuId
      ? nextPositiveMaxDegrees
      : previousBinding?.maxDegrees ?? null;
    if (maxDegrees == null) return;
    const scale = auId === nextPositiveAuId
      ? nextPositiveScale
      : previousBinding?.scale ?? resolvedPositiveScale;
    if (scale == null) return;
    upsertBinding(auId, scale, maxDegrees, previousBinding ?? previousPositive);
  });

  const nextCompositeRotations = cloneCompositeRotations(profile.compositeRotations);
  const compositeIndex = nextCompositeRotations.findIndex((entry) => entry.node === nodeKey);
  const nextAxisAus = Array.from(new Set([
    ...existingNeutralSelectorIds,
    ...normalizedNegativeSelectorIds,
    ...normalizedPositiveSelectorIds,
  ]));
  const nextAxisConfig: RotationAxis | null = nextAxisAus.length > 0 ? {
    aus: nextAxisAus,
    axis: channel,
    ...(normalizedNegativeSelectorIds.length > 0 ? { negative: selectorFromArray(normalizedNegativeSelectorIds) } : {}),
    ...(normalizedPositiveSelectorIds.length > 0 ? { positive: selectorFromArray(normalizedPositiveSelectorIds) } : {}),
  } : null;

  if (compositeIndex >= 0) {
    const existingComposite = nextCompositeRotations[compositeIndex];
    nextCompositeRotations[compositeIndex] = {
      ...existingComposite,
      [axis]: nextAxisConfig,
    };

    const updatedComposite = nextCompositeRotations[compositeIndex];
    if (!updatedComposite.pitch && !updatedComposite.yaw && !updatedComposite.roll) {
      nextCompositeRotations.splice(compositeIndex, 1);
    }
  } else if (nextAxisConfig) {
    nextCompositeRotations.push({
      node: nodeKey,
      pitch: axis === 'pitch' ? nextAxisConfig : null,
      yaw: axis === 'yaw' ? nextAxisConfig : null,
      roll: axis === 'roll' ? nextAxisConfig : null,
    });
  }

  const nextContinuumPairs = { ...(profile.continuumPairs ?? {}) };
  const nextContinuumLabels = { ...(profile.continuumLabels ?? {}) };
  const removedLabelKeys = new Set<string>();

  for (const [auIdStr, info] of getContinuumPairEntries(profile.continuumPairs)) {
    if (info.node !== nodeKey || info.axis !== axis) {
      continue;
    }

    const auId = Number(auIdStr);
    delete nextContinuumPairs[auId];
    removedLabelKeys.add(
      info.isNegative
        ? `${auId}-${info.pairId}`
        : `${info.pairId}-${auId}`,
    );
  }

  for (const labelKey of removedLabelKeys) {
    delete nextContinuumLabels[labelKey];
  }

  if (
    nextNegativeAuId != null &&
    nextPositiveAuId != null &&
    nextNegativeAuId !== nextPositiveAuId
  ) {
    nextContinuumPairs[nextNegativeAuId] = {
      pairId: nextPositiveAuId,
      isNegative: true,
      axis,
      node: nodeKey,
    };
    nextContinuumPairs[nextPositiveAuId] = {
      pairId: nextNegativeAuId,
      isNegative: false,
      axis,
      node: nodeKey,
    };
    nextContinuumLabels[`${nextNegativeAuId}-${nextPositiveAuId}`] = buildContinuumLabel(profile, boneName, axis);
  }

  return {
    ...profile,
    boneNodes,
    auToBones: nextAuToBones,
    compositeRotations: nextCompositeRotations.length > 0 ? nextCompositeRotations : undefined,
    continuumPairs: Object.keys(nextContinuumPairs).length > 0 ? nextContinuumPairs : undefined,
    continuumLabels: Object.keys(nextContinuumLabels).length > 0 ? nextContinuumLabels : undefined,
  };
}

function buildBilateralContinuumLabel(
  familyLabel: string,
  axis: BoneAxisKey,
  scope: BilateralBoneAxisScope,
): string {
  const axisLabel = formatAxisLabel(axis);
  if (scope === 'shared') {
    return `${familyLabel} ${axisLabel}`;
  }
  return `${scope === 'left' ? 'Left' : 'Right'} ${familyLabel} ${axisLabel}`;
}

function upsertCompositeAxisConfig(
  composites: CompositeRotation[],
  nodeKey: string,
  axis: BoneAxisKey,
  axisConfig: RotationAxis | null,
): void {
  const compositeIndex = composites.findIndex((entry) => entry.node === nodeKey);
  if (compositeIndex >= 0) {
    const nextComposite = {
      ...composites[compositeIndex],
      [axis]: axisConfig,
    };
    if (!nextComposite.pitch && !nextComposite.yaw && !nextComposite.roll) {
      composites.splice(compositeIndex, 1);
      return;
    }
    composites[compositeIndex] = nextComposite;
    return;
  }

  if (!axisConfig) return;
  composites.push({
    node: nodeKey,
    pitch: axis === 'pitch' ? axisConfig : null,
    yaw: axis === 'yaw' ? axisConfig : null,
    roll: axis === 'roll' ? axisConfig : null,
  });
}

function setBilateralScopeDuplicatesToNull(
  desiredScopes: Record<BilateralBoneAxisScope, {
    negativeAuId: number | null;
    positiveAuId: number | null;
    negativeMaxDegrees: number | null;
    positiveMaxDegrees: number | null;
    negativeScale: BilateralAxisDirectionScaleState;
    positiveScale: BilateralAxisDirectionScaleState;
  }>,
  targetScope: BilateralBoneAxisScope,
  direction: BoneAxisDirection,
  auId: number | null,
): void {
  if (auId == null) return;
  const property = direction === 'negative' ? 'negativeAuId' : 'positiveAuId';
  const maxProperty = direction === 'negative' ? 'negativeMaxDegrees' : 'positiveMaxDegrees';

  (['shared', 'left', 'right'] as BilateralBoneAxisScope[]).forEach((scope) => {
    if (scope === targetScope) return;
    if (desiredScopes[scope][property] === auId) {
      desiredScopes[scope][property] = null;
      desiredScopes[scope][maxProperty] = null;
    }
  });
}

export function applyBilateralAxisBindingUpdate(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
  scope: BilateralBoneAxisScope,
  update: BoneAxisBindingUpdate,
): Profile {
  const context = buildBilateralAxisContext(profile, boneName, axis);
  if (!context) {
    return profile;
  }

  const currentState = getBilateralAxisBindingState(profile, boneName, axis);
  if (!currentState) {
    return profile;
  }

  const nextLeftChannel = update.channel ?? context.leftChannel;
  const nextRightChannel = update.channel ?? context.rightChannel;
  const defaultLeftNegativeScale = resolveSemanticDirectionScale(profile, context.leftNodeKey, axis, nextLeftChannel, 'negative');
  const defaultLeftPositiveScale = resolveSemanticDirectionScale(profile, context.leftNodeKey, axis, nextLeftChannel, 'positive');
  const defaultRightNegativeScale = resolveSemanticDirectionScale(profile, context.rightNodeKey, axis, nextRightChannel, 'negative');
  const defaultRightPositiveScale = resolveSemanticDirectionScale(profile, context.rightNodeKey, axis, nextRightChannel, 'positive');

  const desiredScopes: Record<BilateralBoneAxisScope, {
    negativeAuId: number | null;
    positiveAuId: number | null;
    negativeMaxDegrees: number | null;
    positiveMaxDegrees: number | null;
    negativeScale: BilateralAxisDirectionScaleState;
    positiveScale: BilateralAxisDirectionScaleState;
  }> = {
    shared: {
      negativeAuId: currentState.shared.negativeAuId,
      positiveAuId: currentState.shared.positiveAuId,
      negativeMaxDegrees: currentState.shared.negativeMaxDegrees,
      positiveMaxDegrees: currentState.shared.positiveMaxDegrees,
      negativeScale: { ...currentState.shared.negativeScale },
      positiveScale: { ...currentState.shared.positiveScale },
    },
    left: {
      negativeAuId: currentState.left.negativeAuId,
      positiveAuId: currentState.left.positiveAuId,
      negativeMaxDegrees: currentState.left.negativeMaxDegrees,
      positiveMaxDegrees: currentState.left.positiveMaxDegrees,
      negativeScale: { ...currentState.left.negativeScale },
      positiveScale: { ...currentState.left.positiveScale },
    },
    right: {
      negativeAuId: currentState.right.negativeAuId,
      positiveAuId: currentState.right.positiveAuId,
      negativeMaxDegrees: currentState.right.negativeMaxDegrees,
      positiveMaxDegrees: currentState.right.positiveMaxDegrees,
      negativeScale: { ...currentState.right.negativeScale },
      positiveScale: { ...currentState.right.positiveScale },
    },
  };

  const getScopeDefaultScale = (
    targetScope: BilateralBoneAxisScope,
    direction: BoneAxisDirection,
    side: 'left' | 'right',
  ): BoneAxisDirectionScale => {
    if (direction === 'negative') {
      return side === 'left' ? defaultLeftNegativeScale : defaultRightNegativeScale;
    }

    return side === 'left' ? defaultLeftPositiveScale : defaultRightPositiveScale;
  };

  const ensureScopeScaleDefaults = (
    targetScope: BilateralBoneAxisScope,
    direction: BoneAxisDirection,
  ) => {
    const scaleState = direction === 'negative'
      ? desiredScopes[targetScope].negativeScale
      : desiredScopes[targetScope].positiveScale;

    if (targetScope !== 'right' && scaleState.left == null) {
      scaleState.left = getScopeDefaultScale(targetScope, direction, 'left');
    }
    if (targetScope !== 'left' && scaleState.right == null) {
      scaleState.right = getScopeDefaultScale(targetScope, direction, 'right');
    }
  };

  if (update.negativeAuId !== undefined) {
    desiredScopes[scope].negativeAuId = update.negativeAuId;
    desiredScopes[scope].negativeMaxDegrees = update.negativeAuId == null
      ? null
      : normalizeDegrees(update.negativeMaxDegrees ?? desiredScopes[scope].negativeMaxDegrees);
    if (update.negativeAuId != null) {
      ensureScopeScaleDefaults(scope, 'negative');
    }
    if (update.negativeAuId != null && update.negativeAuId === desiredScopes[scope].positiveAuId) {
      desiredScopes[scope].positiveAuId = null;
      desiredScopes[scope].positiveMaxDegrees = null;
    }
    setBilateralScopeDuplicatesToNull(desiredScopes, scope, 'negative', update.negativeAuId);
  } else if (update.negativeMaxDegrees !== undefined && desiredScopes[scope].negativeAuId != null) {
    desiredScopes[scope].negativeMaxDegrees = normalizeDegrees(update.negativeMaxDegrees);
  }

  if (update.positiveAuId !== undefined) {
    desiredScopes[scope].positiveAuId = update.positiveAuId;
    desiredScopes[scope].positiveMaxDegrees = update.positiveAuId == null
      ? null
      : normalizeDegrees(update.positiveMaxDegrees ?? desiredScopes[scope].positiveMaxDegrees);
    if (update.positiveAuId != null) {
      ensureScopeScaleDefaults(scope, 'positive');
    }
    if (update.positiveAuId != null && update.positiveAuId === desiredScopes[scope].negativeAuId) {
      desiredScopes[scope].negativeAuId = null;
      desiredScopes[scope].negativeMaxDegrees = null;
    }
    setBilateralScopeDuplicatesToNull(desiredScopes, scope, 'positive', update.positiveAuId);
  } else if (update.positiveMaxDegrees !== undefined && desiredScopes[scope].positiveAuId != null) {
    desiredScopes[scope].positiveMaxDegrees = normalizeDegrees(update.positiveMaxDegrees);
  }

  const applyDirectionalScaleUpdate = (
    direction: BoneAxisDirection,
    sharedScale: BoneAxisDirectionScale | null | undefined,
    leftScale: BoneAxisDirectionScale | null | undefined,
    rightScale: BoneAxisDirectionScale | null | undefined,
  ) => {
    if (
      sharedScale === undefined &&
      leftScale === undefined &&
      rightScale === undefined
    ) {
      return;
    }

    ensureScopeScaleDefaults(scope, direction);
    const scaleState = direction === 'negative'
      ? desiredScopes[scope].negativeScale
      : desiredScopes[scope].positiveScale;

    if (sharedScale !== undefined) {
      if (scope !== 'right') {
        scaleState.left = normalizeDirectionScale(sharedScale, getScopeDefaultScale(scope, direction, 'left'));
      }
      if (scope !== 'left') {
        scaleState.right = normalizeDirectionScale(sharedScale, getScopeDefaultScale(scope, direction, 'right'));
      }
    }
    if (leftScale !== undefined && scope !== 'right') {
      scaleState.left = normalizeDirectionScale(leftScale, getScopeDefaultScale(scope, direction, 'left'));
    }
    if (rightScale !== undefined && scope !== 'left') {
      scaleState.right = normalizeDirectionScale(rightScale, getScopeDefaultScale(scope, direction, 'right'));
    }
  };

  applyDirectionalScaleUpdate('negative', update.negativeScale, update.negativeLeftScale, update.negativeRightScale);
  applyDirectionalScaleUpdate('positive', update.positiveScale, update.positiveLeftScale, update.positiveRightScale);

  const relevantAuIds = Array.from(new Set([
    ...context.leftNegativeIds,
    ...context.leftPositiveIds,
    ...context.rightNegativeIds,
    ...context.rightPositiveIds,
    ...Object.values(desiredScopes).flatMap((entry) => [
      entry.negativeAuId,
      entry.positiveAuId,
    ]),
  ].filter((value): value is number => value != null)));

  const previousBindings = new Map<string, BoneBinding | null>();
  relevantAuIds.forEach((auId) => {
    previousBindings.set(`${auId}:${context.leftNodeKey}`, findAxisRotationBinding(profile, auId, context.leftNodeKey, context.leftChannel));
    previousBindings.set(`${auId}:${context.rightNodeKey}`, findAxisRotationBinding(profile, auId, context.rightNodeKey, context.rightChannel));
  });

  const nextAuToBones = cloneAuToBones(profile.auToBones ?? {});
  relevantAuIds.forEach((auId) => {
    const filtered = (nextAuToBones[auId] ?? []).filter((binding) => !(
      (binding.node === context.leftNodeKey && binding.channel === context.leftChannel) ||
      (binding.node === context.rightNodeKey && binding.channel === context.rightChannel)
    ));
    if (filtered.length > 0) {
      nextAuToBones[auId] = filtered;
    } else {
      delete nextAuToBones[auId];
    }
  });

  const nextContinuumPairs = { ...(profile.continuumPairs ?? {}) };
  const nextContinuumLabels = { ...(profile.continuumLabels ?? {}) };
  const removedLabelKeys = new Set<string>();
  for (const [auIdStr, info] of getContinuumPairEntries(profile.continuumPairs)) {
    if (
      info.axis !== axis ||
      (info.node !== context.leftNodeKey && info.node !== context.rightNodeKey)
    ) {
      continue;
    }

    const auId = Number(auIdStr);
    delete nextContinuumPairs[auId];
    removedLabelKeys.add(info.isNegative ? `${auId}-${info.pairId}` : `${info.pairId}-${auId}`);
  }
  removedLabelKeys.forEach((key) => {
    delete nextContinuumLabels[key];
  });

  const leftNegativeSelectorIds = Array.from(new Set([
    ...(desiredScopes.shared.negativeAuId != null ? [desiredScopes.shared.negativeAuId] : []),
    ...(desiredScopes.left.negativeAuId != null ? [desiredScopes.left.negativeAuId] : []),
  ]));
  const leftPositiveSelectorIds = Array.from(new Set([
    ...(desiredScopes.shared.positiveAuId != null ? [desiredScopes.shared.positiveAuId] : []),
    ...(desiredScopes.left.positiveAuId != null ? [desiredScopes.left.positiveAuId] : []),
  ]));
  const rightNegativeSelectorIds = Array.from(new Set([
    ...(desiredScopes.shared.negativeAuId != null ? [desiredScopes.shared.negativeAuId] : []),
    ...(desiredScopes.right.negativeAuId != null ? [desiredScopes.right.negativeAuId] : []),
  ]));
  const rightPositiveSelectorIds = Array.from(new Set([
    ...(desiredScopes.shared.positiveAuId != null ? [desiredScopes.shared.positiveAuId] : []),
    ...(desiredScopes.right.positiveAuId != null ? [desiredScopes.right.positiveAuId] : []),
  ]));

  const leftAxisAus = Array.from(new Set([
    ...context.leftNeutralIds,
    ...(desiredScopes.left.negativeAuId != null ? [desiredScopes.left.negativeAuId] : []),
    ...(desiredScopes.left.positiveAuId != null ? [desiredScopes.left.positiveAuId] : []),
    ...(desiredScopes.shared.negativeAuId != null ? [desiredScopes.shared.negativeAuId] : []),
    ...(desiredScopes.shared.positiveAuId != null ? [desiredScopes.shared.positiveAuId] : []),
  ]));
  const rightAxisAus = Array.from(new Set([
    ...context.rightNeutralIds,
    ...(desiredScopes.right.negativeAuId != null ? [desiredScopes.right.negativeAuId] : []),
    ...(desiredScopes.right.positiveAuId != null ? [desiredScopes.right.positiveAuId] : []),
    ...(desiredScopes.shared.negativeAuId != null ? [desiredScopes.shared.negativeAuId] : []),
    ...(desiredScopes.shared.positiveAuId != null ? [desiredScopes.shared.positiveAuId] : []),
  ]));

  const nextCompositeRotations = cloneCompositeRotations(profile.compositeRotations);
  upsertCompositeAxisConfig(nextCompositeRotations, context.leftNodeKey, axis, leftAxisAus.length > 0 ? {
    aus: leftAxisAus,
    axis: nextLeftChannel,
    ...(leftNegativeSelectorIds.length > 0 ? { negative: selectorFromArray(leftNegativeSelectorIds) } : {}),
    ...(leftPositiveSelectorIds.length > 0 ? { positive: selectorFromArray(leftPositiveSelectorIds) } : {}),
  } : null);
  upsertCompositeAxisConfig(nextCompositeRotations, context.rightNodeKey, axis, rightAxisAus.length > 0 ? {
    aus: rightAxisAus,
    axis: nextRightChannel,
    ...(rightNegativeSelectorIds.length > 0 ? { negative: selectorFromArray(rightNegativeSelectorIds) } : {}),
    ...(rightPositiveSelectorIds.length > 0 ? { positive: selectorFromArray(rightPositiveSelectorIds) } : {}),
  } : null);

  const upsertBinding = (
    auId: number,
    nodeKey: string,
    channel: RotationChannel,
    scale: -1 | 1,
    maxDegrees: number,
    inferredSide: 'left' | 'right',
  ) => {
    const previousBinding = previousBindings.get(`${auId}:${nodeKey}`);
    const nextBinding: BoneBinding = {
      node: nodeKey,
      channel,
      scale,
      maxDegrees,
      ...(previousBinding?.side ? { side: previousBinding.side } : { side: inferredSide }),
    };
    nextAuToBones[auId] = [...(nextAuToBones[auId] ?? []), nextBinding];
  };

  if (desiredScopes.shared.negativeAuId != null && desiredScopes.shared.negativeMaxDegrees != null) {
    upsertBinding(
      desiredScopes.shared.negativeAuId,
      context.leftNodeKey,
      nextLeftChannel,
      desiredScopes.shared.negativeScale.left ?? defaultLeftNegativeScale,
      desiredScopes.shared.negativeMaxDegrees,
      'left',
    );
    upsertBinding(
      desiredScopes.shared.negativeAuId,
      context.rightNodeKey,
      nextRightChannel,
      desiredScopes.shared.negativeScale.right ?? defaultRightNegativeScale,
      desiredScopes.shared.negativeMaxDegrees,
      'right',
    );
  }

  if (desiredScopes.shared.positiveAuId != null && desiredScopes.shared.positiveMaxDegrees != null) {
    upsertBinding(
      desiredScopes.shared.positiveAuId,
      context.leftNodeKey,
      nextLeftChannel,
      desiredScopes.shared.positiveScale.left ?? defaultLeftPositiveScale,
      desiredScopes.shared.positiveMaxDegrees,
      'left',
    );
    upsertBinding(
      desiredScopes.shared.positiveAuId,
      context.rightNodeKey,
      nextRightChannel,
      desiredScopes.shared.positiveScale.right ?? defaultRightPositiveScale,
      desiredScopes.shared.positiveMaxDegrees,
      'right',
    );
  }

  if (desiredScopes.left.negativeAuId != null && desiredScopes.left.negativeMaxDegrees != null) {
    upsertBinding(
      desiredScopes.left.negativeAuId,
      context.leftNodeKey,
      nextLeftChannel,
      desiredScopes.left.negativeScale.left ?? defaultLeftNegativeScale,
      desiredScopes.left.negativeMaxDegrees,
      'left',
    );
  }
  if (desiredScopes.left.positiveAuId != null && desiredScopes.left.positiveMaxDegrees != null) {
    upsertBinding(
      desiredScopes.left.positiveAuId,
      context.leftNodeKey,
      nextLeftChannel,
      desiredScopes.left.positiveScale.left ?? defaultLeftPositiveScale,
      desiredScopes.left.positiveMaxDegrees,
      'left',
    );
  }
  if (desiredScopes.right.negativeAuId != null && desiredScopes.right.negativeMaxDegrees != null) {
    upsertBinding(
      desiredScopes.right.negativeAuId,
      context.rightNodeKey,
      nextRightChannel,
      desiredScopes.right.negativeScale.right ?? defaultRightNegativeScale,
      desiredScopes.right.negativeMaxDegrees,
      'right',
    );
  }
  if (desiredScopes.right.positiveAuId != null && desiredScopes.right.positiveMaxDegrees != null) {
    upsertBinding(
      desiredScopes.right.positiveAuId,
      context.rightNodeKey,
      nextRightChannel,
      desiredScopes.right.positiveScale.right ?? defaultRightPositiveScale,
      desiredScopes.right.positiveMaxDegrees,
      'right',
    );
  }

  const upsertContinuumPair = (
    pairScope: BilateralBoneAxisScope,
    negativeAuId: number | null,
    positiveAuId: number | null,
    nodeKey: string,
  ) => {
    if (
      negativeAuId == null ||
      positiveAuId == null ||
      negativeAuId === positiveAuId
    ) {
      return;
    }

    nextContinuumPairs[negativeAuId] = {
      pairId: positiveAuId,
      isNegative: true,
      axis,
      node: nodeKey,
    };
    nextContinuumPairs[positiveAuId] = {
      pairId: negativeAuId,
      isNegative: false,
      axis,
      node: nodeKey,
    };
    nextContinuumLabels[`${negativeAuId}-${positiveAuId}`] = buildBilateralContinuumLabel(
      context.familyLabel,
      axis,
      pairScope,
    );
  };

  upsertContinuumPair('shared', desiredScopes.shared.negativeAuId, desiredScopes.shared.positiveAuId, context.leftNodeKey);
  upsertContinuumPair('left', desiredScopes.left.negativeAuId, desiredScopes.left.positiveAuId, context.leftNodeKey);
  upsertContinuumPair('right', desiredScopes.right.negativeAuId, desiredScopes.right.positiveAuId, context.rightNodeKey);

  return {
    ...profile,
    boneNodes: { ...(context.boneNodes ?? {}) },
    auToBones: nextAuToBones,
    compositeRotations: nextCompositeRotations.length > 0 ? nextCompositeRotations : undefined,
    continuumPairs: Object.keys(nextContinuumPairs).length > 0 ? nextContinuumPairs : undefined,
    continuumLabels: Object.keys(nextContinuumLabels).length > 0 ? nextContinuumLabels : undefined,
  };
}

function getNextAvailableAuId(profile: Profile): number {
  const ids = new Set<number>();
  Object.keys(profile.auToBones ?? {}).forEach((auId) => ids.add(Number(auId)));
  Object.keys(profile.auInfo ?? {}).forEach((auId) => ids.add(Number(auId)));
  Object.keys(profile.auToMorphs ?? {}).forEach((auId) => ids.add(Number(auId)));
  getContinuumPairEntries(profile.continuumPairs).forEach(([auId, info]) => {
    ids.add(Number(auId));
    ids.add(Number(info.pairId));
  });

  return ids.size > 0 ? Math.max(...ids) + 1 : 1;
}

function guessBoneFaceArea(
  boneName: string,
  nodeKey: string,
): NonNullable<AUInfo['faceArea']> {
  const label = `${nodeKey} ${boneName}`.toLowerCase();

  if (label.includes('jaw') || label.includes('mouth') || label.includes('lip') || label.includes('tongue') || label.includes('chin')) {
    return 'Lower';
  }

  return 'Upper';
}

function guessBoneAuMetadata(
  boneName: string,
  nodeKey: string,
): BoneControlMetadata {
  return {
    faceArea: guessBoneFaceArea(boneName, nodeKey),
    facePart: JOINT_CONTROL_SECTION,
  };
}

export function isJointControlAuInfo(
  info: Pick<AUInfo, 'facePart'> | null | undefined,
): boolean {
  return info?.facePart === JOINT_CONTROL_SECTION;
}

export function classifyAuAsJointControl(
  profile: Profile,
  auId: number,
  options: {
    boneName?: string | null;
    nodeKey?: string | null;
  } = {},
): Profile {
  const key = String(auId);
  const current = profile.auInfo?.[key];
  const boneName = options.boneName ?? current?.name ?? `Control ${auId}`;
  const nodeKey = options.nodeKey ?? findNodeKeyForBone(boneName, profile) ?? sanitizeBoneNodeKey(profile, boneName);
  const faceArea = current?.faceArea ?? guessBoneFaceArea(boneName, nodeKey);
  const autoName = formatBoneAutoTitle(profile, boneName);

  return {
    ...profile,
    auInfo: {
      ...(profile.auInfo ?? {}),
      [key]: {
        id: current?.id ?? key,
        name: current?.name ?? autoName,
        ...current,
        faceArea,
        facePart: JOINT_CONTROL_SECTION,
      },
    },
  };
}

export function createBoneAxisAu(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
  direction: BoneAxisDirection,
  options: {
    name?: string;
  } = {},
): CreatedBoneAxisAu {
  const { nodeKey } = ensureBoneNodeKey(profile, boneName);
  const auId = getNextAvailableAuId(profile);
  const faceMetadata = guessBoneAuMetadata(boneName, nodeKey);
  const boneLabel = formatBoneAutoTitle(profile, boneName);
  const name = options.name?.trim() || `${boneLabel} ${formatAxisLabel(axis)} ${formatAxisDirectionLabel(axis, direction)}`;

  return {
    auId,
    profile: {
      ...profile,
      auInfo: {
        ...(profile.auInfo ?? {}),
        [String(auId)]: {
          id: String(auId),
          name,
          ...faceMetadata,
        },
      },
    },
  };
}

export function createBilateralBoneAxisAu(
  profile: Profile,
  boneName: string,
  axis: BoneAxisKey,
  scope: BilateralBoneAxisScope,
  direction: BoneAxisDirection,
  options: {
    name?: string;
  } = {},
): CreatedBoneAxisAu {
  const context = buildBilateralAxisContext(profile, boneName, axis);
  if (!context) {
    return createBoneAxisAu(profile, boneName, axis, direction, options);
  }

  const auId = getNextAvailableAuId(profile);
  const labelRoot = scope === 'shared'
    ? `Both ${context.familyLabel}`
    : scope === 'left'
      ? `Left ${context.familyLabel}`
      : `Right ${context.familyLabel}`;
  const name = options.name?.trim() || `${labelRoot} ${formatAxisLabel(axis)} ${formatAxisDirectionLabel(axis, direction)}`;
  const metadataNodeKey = scope === 'right' ? context.rightNodeKey : context.leftNodeKey;
  const metadataBoneName = scope === 'right' ? context.rightBoneName : context.leftBoneName;
  const faceMetadata = guessBoneAuMetadata(metadataBoneName, metadataNodeKey);

  return {
    auId,
    profile: {
      ...profile,
      boneNodes: { ...(context.boneNodes ?? {}) },
      auInfo: {
        ...(profile.auInfo ?? {}),
        [String(auId)]: {
          id: String(auId),
          name,
          ...faceMetadata,
        },
      },
    },
  };
}

function getContinuumOptionLabel(
  profile: Profile,
  auId: number,
): { label: string; originalName?: string } | null {
  const pairInfo = profile.continuumPairs?.[auId];
  if (!pairInfo) {
    return null;
  }

  const negativeAuId = pairInfo.isNegative ? auId : pairInfo.pairId;
  const positiveAuId = pairInfo.isNegative ? pairInfo.pairId : auId;
  const pairLabel = resolveContinuumDisplayLabel(profile, negativeAuId, positiveAuId);
  if (!pairLabel) {
    return null;
  }

  const originalName = profile.auInfo?.[String(auId)]?.name?.trim();
  const direction = pairInfo.axis
    ? formatAxisDirectionLabel(pairInfo.axis, pairInfo.isNegative ? 'negative' : 'positive')
    : pairInfo.isNegative
      ? 'Negative'
      : 'Positive';

  return {
    label: `${pairLabel} ${direction}`,
    ...(originalName ? { originalName } : {}),
  };
}

export function buildBoneAuOptions(profile: Profile): Array<{ value: string; label: string; detail?: string }> {
  const ids = new Set<number>();

  Object.keys(profile.auToBones ?? {}).forEach((auId) => ids.add(Number(auId)));
  Object.keys(profile.auInfo ?? {}).forEach((auId) => ids.add(Number(auId)));
  Object.keys(profile.continuumPairs ?? {}).forEach((auId) => ids.add(Number(auId)));

  const options: Array<{ value: string; label: string; detail?: string }> = [
    { value: '', label: 'Unassigned' },
  ];
  Array.from(ids)
    .sort((a, b) => a - b)
    .forEach((auId) => {
      const info = profile.auInfo?.[String(auId)];
      const labelPrefix = isJointControlAuInfo(info) ? 'Joint' : 'AU';
      const continuumOption = getContinuumOptionLabel(profile, auId);
      const displayName = continuumOption?.label ?? info?.name ?? '';
      const detailParts = [
        ...(continuumOption?.originalName && continuumOption.originalName !== displayName
          ? [continuumOption.originalName]
          : []),
        ...(isJointControlAuInfo(info)
          ? [JOINT_CONTROL_SECTION]
          : info?.facePart
            ? [info.facePart]
            : []),
      ];
      options.push({
        value: String(auId),
        label: displayName ? `${labelPrefix} ${auId} - ${displayName}` : `${labelPrefix} ${auId}`,
        detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
      });
    });

  return options;
}

export function getAxisFromChannel(channel: string | undefined): BoneAxisKey | null {
  if (!channel || !Object.prototype.hasOwnProperty.call(DEFAULT_CHANNEL_TO_AXIS, channel)) {
    return null;
  }

  return DEFAULT_CHANNEL_TO_AXIS[channel as RotationChannel];
}
