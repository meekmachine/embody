/**
 * Thin Embody host driver — shared by Three, Memory, and future engines.
 *
 * Animation brain stays in Rust `RuntimeCore`. Hosts only configure, forward
 * controls, tick transitions, and apply packed frames.
 */
export type {
  HostAnimationHandle,
  HostAnimationPlayOptions,
  HostAnimationSystem,
  HostFrameApplier,
  HostModelInspector,
} from '../core/contracts/host';

export interface EmbodyHostControls {
  setAU(id: number, value: number, balance?: number): void;
  getAU(id: number): number;
  setContinuum(negAU: number, posAU: number, value: number, balance?: number): void;
  getContinuum(negAU: number, posAU: number): number;
  setViseme(index: number, value: number, jawScale?: number): void;
  setVisemeById(slotId: string, value: number, jawScale?: number): void;
  setAUMixWeight(id: number, weight: number): void;
  transitionAU(id: number, to: number, durationMs?: number, balance?: number): void;
  transitionViseme(index: number, to: number, durationMs?: number, jawScale?: number): void;
  transitionVisemeById(slotId: string, to: number, durationMs?: number, jawScale?: number): void;
  update(dtSeconds: number): void;
  activeTransitionCount(): number;
  clear(): void;
  dispose(): void;
}
