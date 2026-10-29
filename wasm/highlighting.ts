/** Rust's complete preview snapshot. Mesh IDs come from the configured ModelData.
 * RGB channels are linear (0..1). Omitted IDs restore the renderer's native state.
 * Hosts apply these values; they do not derive colors, targets, or fade curves.
 */
export interface MeshHighlightWrite {
  meshId: number;
  fillColor: [number, number, number];
  fillIntensity: number;
  edgeColor: [number, number, number];
  edgeMode: 'triangles';
  edgeOpacity: number;
}
export interface MeshHighlightFrame {
  version: 1;
  highlights: MeshHighlightWrite[];
}
