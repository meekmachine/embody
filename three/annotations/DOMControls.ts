/**
 * Self-contained DOM controls for DPthreeCameraController
 * No React dependencies - vanilla DOM manipulation
 */
export interface DOMControlRegion {
  name: string;
  parent?: string;
  children?: string[];
}

export interface DOMControlsConfig {
  /** Container element to append controls to */
  container: HTMLElement;
  /** Callback when user selects a region */
  onRegionSelect: (name: string) => void;
  /** Initial list of regions */
  regions: DOMControlRegion[];
  /** Currently selected region */
  currentRegion?: string;
  /** Initial annotation-marker visibility */
  markersVisible?: boolean;
  /** Callback when the Markers checkbox is toggled */
  onMarkersVisibleChange?: (visible: boolean) => void;
}

/** Temporary AU preview regions must never appear in the View dropdown. */
export const RUNTIME_ANNOTATION_REGION_PREFIX = 'runtime:annotation:';

export function isRuntimeAnnotationRegionName(name: string): boolean {
  return name.startsWith(RUNTIME_ANNOTATION_REGION_PREFIX);
}

export function filterCameraViewRegions<T extends { name: string }>(regions: T[]): T[] {
  return regions.filter((region) => !isRuntimeAnnotationRegionName(region.name));
}

/**
 * CSS styles for the DOM controls
 * Scoped with unique class prefix to avoid conflicts
 */
const STYLES = `
.acc-controls {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 8px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.acc-select {
  background: rgba(255, 255, 255, 0.1);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 14px;
  cursor: pointer;
  outline: none;
  width: 160px;
  max-width: 160px;
  min-width: 160px;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='white' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 28px;
}

.acc-markers {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  padding-left: 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  user-select: none;
  cursor: pointer;
  white-space: nowrap;
}

.acc-markers input {
  margin: 0;
  cursor: pointer;
  accent-color: #3182ce;
}

.acc-select:hover {
  background-color: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}

.acc-select:focus {
  border-color: #3182ce;
  box-shadow: 0 0 0 2px rgba(49, 130, 206, 0.3);
}

.acc-select option {
  background: #1a202c;
  color: white;
  padding: 8px;
}

.acc-label {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  display: flex;
  align-items: center;
  margin-right: 4px;
}
`;

// Track if styles have been injected
let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-acc-styles', 'true');
  style.textContent = STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

/**
 * Format region name for display
 * Converts snake_case to Title Case
 */
function formatName(name: string): string {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getRegionDepth(
  region: DOMControlRegion,
  regionByName: Map<string, DOMControlRegion>,
  seen: Set<string> = new Set()
): number {
  if (!region.parent || seen.has(region.name)) {
    return 0;
  }

  const parent = regionByName.get(region.parent);
  if (!parent) {
    return 0;
  }

  seen.add(region.name);
  return getRegionDepth(parent, regionByName, seen) + 1;
}

export function buildRegionDisplayOptions(
  regions: DOMControlRegion[]
): Array<{ name: string; label: string }> {
  const viewRegions = filterCameraViewRegions(regions);
  const regionByName = new Map(viewRegions.map((region) => [region.name, region]));

  return viewRegions.map((region) => {
    const depth = getRegionDepth(region, regionByName);
    const prefix = depth > 0 ? `${'-- '.repeat(depth)}` : '';
    return {
      name: region.name,
      label: `${prefix}${formatName(region.name)}`,
    };
  });
}

/**
 * CameraDOMControls - Self-contained DOM UI for region selection
 */
export class CameraDOMControls {
  private container: HTMLElement;
  private wrapper: HTMLDivElement;
  private select: HTMLSelectElement;
  private markersCheckbox: HTMLInputElement | null = null;
  private onRegionSelect: (name: string) => void;
  private onMarkersVisibleChange?: (visible: boolean) => void;

  constructor(config: DOMControlsConfig) {
    // Inject styles once
    injectStyles();

    this.container = config.container;
    this.onRegionSelect = config.onRegionSelect;
    this.onMarkersVisibleChange = config.onMarkersVisibleChange;

    // Create wrapper
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'acc-controls';

    // Create label
    const label = document.createElement('span');
    label.className = 'acc-label';
    label.textContent = 'View:';
    this.wrapper.appendChild(label);

    // Create select
    this.select = document.createElement('select');
    this.select.className = 'acc-select';
    this.populateSelect(config.regions, config.currentRegion);

    // Handle selection changes
    this.select.addEventListener('change', () => {
      this.onRegionSelect(this.select.value);
    });

    this.wrapper.appendChild(this.select);

    if (this.onMarkersVisibleChange) {
      const markersLabel = document.createElement('label');
      markersLabel.className = 'acc-markers';

      this.markersCheckbox = document.createElement('input');
      this.markersCheckbox.type = 'checkbox';
      this.markersCheckbox.checked = Boolean(config.markersVisible);
      this.markersCheckbox.setAttribute('aria-label', 'Show annotation markers');
      this.markersCheckbox.addEventListener('change', () => {
        this.onMarkersVisibleChange?.(this.markersCheckbox!.checked);
      });

      const markersText = document.createElement('span');
      markersText.textContent = 'Markers';

      markersLabel.appendChild(this.markersCheckbox);
      markersLabel.appendChild(markersText);
      this.wrapper.appendChild(markersLabel);
    }

    // Append to container
    // Ensure container has relative positioning for absolute positioning to work
    const containerStyle = window.getComputedStyle(this.container);
    if (containerStyle.position === 'static') {
      this.container.style.position = 'relative';
    }

    this.container.appendChild(this.wrapper);
  }

  /**
   * Populate select options
   */
  private populateSelect(regions: DOMControlRegion[], current?: string): void {
    this.select.innerHTML = '';

    const viewRegions = filterCameraViewRegions(regions);

    if (viewRegions.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No regions';
      option.disabled = true;
      this.select.appendChild(option);
      return;
    }

    buildRegionDisplayOptions(viewRegions).forEach(({ name, label }) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = label;
      if (name === current) {
        option.selected = true;
      }
      this.select.appendChild(option);
    });
  }

  /**
   * Update available regions
   */
  updateRegions(regions: DOMControlRegion[], current?: string): void {
    this.populateSelect(regions, current);
  }

  /**
   * Sync Markers checkbox with controller visibility state.
   */
  setMarkersVisible(visible: boolean): void {
    if (!this.markersCheckbox || this.markersCheckbox.checked === visible) return;
    this.markersCheckbox.checked = visible;
  }

  /**
   * Set current region (updates select value)
   */
  setCurrentRegion(name: string): void {
    if (this.select.value !== name) {
      this.select.value = name;
    }
  }

  /**
   * Show/hide controls
   */
  setVisible(visible: boolean): void {
    this.wrapper.style.display = visible ? 'flex' : 'none';
  }

  /**
   * Check if controls are visible
   */
  isVisible(): boolean {
    return this.wrapper.style.display !== 'none';
  }

  /**
   * Cleanup and remove from DOM
   */
  dispose(): void {
    this.wrapper.remove();
  }
}
