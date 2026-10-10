import { ThreeAnnotationMarkers, type AnnotationMarkersConfig } from './ThreeAnnotationMarkers';
/** HTML rendering of the same Rust annotation state and layout. */
export class HtmlAnnotationMarkers extends ThreeAnnotationMarkers { constructor(options: AnnotationMarkersConfig) { super(options, 'html'); } }
