import legacyBodyControlAUs from '../assets/legacy/body-control-aus.json';
import { requireInitializedEmbodyCore } from './index';

export interface AUDescriptor {
  auId: number;
  label: string;
  faceArea?: string | null;
  facePart?: string | null;
  negativeAuId?: number | null;
  positiveAuId?: number | null;
  /** At least one left/right output supports balance; inspect availableSides for the actual sides. */
  bilateral: boolean;
  boneBindings: Array<Record<string, unknown> & { auId: number; boneName: string }>;
  boneNames: string[];
  morphBindings: { left: unknown[]; right: unknown[]; center: unknown[] };
  morphNames: string[];
  morphStrength: number;
  availableSides: Array<'left' | 'right' | 'center'>;
  hasBones: boolean;
  hasMorphs: boolean;
  available: boolean;
  diagnostics: string[];
}
/** Inspect saved AU metadata. Optional model is a renderer-neutral model descriptor. */
export function getAUDescriptors(profile: object, model?: object): AUDescriptor[] {
  return JSON.parse(requireInitializedEmbodyCore().embody_request(JSON.stringify({
    op: 'profile.getAUDescriptors', payload: { profile, ...(model ? { model } : {}) },
  }))) as AUDescriptor[];
}
/** @deprecated Reader-only identity snapshot for persisted named poses/animations. Never use for active controls. */
export const LEGACY_BODY_CONTROL_AUS: Readonly<Record<string, { positiveAuId: number; negativeAuId?: number; bilateral: boolean }>> = Object.freeze(legacyBodyControlAUs);
