//! Transient renderer-neutral selection previews, independent of clip playback.
use serde::Serialize;
use crate::profile::ModelData;

const DEFAULT_COLOR: u32 = 0xd4a040;
const DEFAULT_INTENSITY: f32 = 0.35;
const FADE_SECONDS: f64 = 0.4;
const EDGE_BRIGHTNESS: f32 = 0.65;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshHighlightWrite {
    pub mesh_id: u32,
    /// Linear RGB, independent of renderer color management.
    pub fill_color: [f32; 3],
    pub fill_intensity: f32,
    pub edge_color: [f32; 3],
    pub edge_mode: &'static str,
    pub edge_opacity: f32,
}

/// Complete snapshot: an omitted mesh must have its previous preview removed.
#[derive(Debug, Serialize)]
pub struct MeshHighlightFrame {
    pub version: u32,
    pub highlights: Vec<MeshHighlightWrite>,
}

#[derive(Default)]
pub(crate) struct MeshHighlightState {
    targets: Vec<u32>,
    color: u32,
    intensity: f32,
    from: f32,
    to: f32,
    elapsed: f64,
}

impl MeshHighlightState {
    pub fn request(&mut self, model: Option<&ModelData>, name: Option<&str>, color: Option<u32>, intensity: Option<f32>) {
        let targets: Vec<u32> = model.into_iter().flat_map(|model| model.meshes.iter())
            .filter(|mesh| Some(mesh.name.as_str()) == name)
            .map(|mesh| mesh.id).collect();
        let color = color.unwrap_or(DEFAULT_COLOR) & 0xffffff;
        let intensity = intensity.filter(|value| value.is_finite()).unwrap_or(DEFAULT_INTENSITY).clamp(0.0, 1.0);
        if targets.is_empty() {
            // Retain the previous target while fading out. Repeated clears don't restart it.
            if self.to == 0.0 { return; }
            self.to = 0.0;
        } else {
            if self.targets == targets && self.color == color && self.to == intensity { return; }
            if self.targets != targets { self.intensity = 0.0; }
            self.targets = targets;
            self.color = color;
            self.to = intensity;
        }
        self.from = self.intensity;
        self.elapsed = 0.0;
    }

    pub fn advance(&mut self, delta_seconds: f64) {
        if delta_seconds.is_finite() && delta_seconds > 0.0 {
            self.elapsed = (self.elapsed + delta_seconds).min(FADE_SECONDS);
        }
        let t = (self.elapsed / FADE_SECONDS) as f32;
        let eased = if t < 0.5 { 2.0 * t * t } else { -1.0 + (4.0 - 2.0 * t) * t };
        self.intensity = self.from + (self.to - self.from) * eased;
        if self.elapsed >= FADE_SECONDS && self.to == 0.0 { self.targets.clear(); }
    }

    pub fn frame(&self) -> MeshHighlightFrame {
        let linear = |shift: u32| {
            let srgb = ((self.color >> shift) & 255) as f32 / 255.0;
            if srgb <= 0.04045 { srgb / 12.92 } else { ((srgb + 0.055) / 1.055).powf(2.4) }
        };
        let fill = [linear(16), linear(8), linear(0)];
        MeshHighlightFrame {
            version: 1,
            highlights: self.targets.iter().map(|id| MeshHighlightWrite {
                mesh_id: *id,
                fill_color: fill,
                fill_intensity: self.intensity,
                edge_color: fill.map(|channel| channel * EDGE_BRIGHTNESS),
                edge_mode: "triangles",
                edge_opacity: self.intensity,
            }).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> ModelData {
        serde_json::from_str(r#"{"meshes":[{"id":7,"name":"Face"},{"id":9,"name":"Face"},{"id":12,"name":"Body"}]}"#).unwrap()
    }
    #[test]
    fn resolves_duplicate_names_and_derives_linear_colors_and_fades() {
        let model = model();
        let mut state = MeshHighlightState::default();
        state.request(Some(&model), Some("Face"), None, None);
        assert_eq!(state.frame().highlights.iter().map(|write| write.mesh_id).collect::<Vec<_>>(), vec![7, 9]);
        state.advance(0.2);
        let frame = state.frame();
        let write = &frame.highlights[0];
        assert!((write.fill_intensity - 0.175).abs() < 1e-6);
        assert!((write.fill_color[0] - 0.658375).abs() < 1e-5);
        assert_eq!(write.edge_color, write.fill_color.map(|channel| channel * 0.65));
        assert_eq!(write.edge_opacity, write.fill_intensity);
        state.request(Some(&model), None, None, None);
        state.advance(0.2);
        assert!((state.frame().highlights[0].fill_intensity - 0.0875).abs() < 1e-6);
        state.request(Some(&model), None, None, None);
        state.advance(0.2);
        assert!(state.frame().highlights.is_empty());
    }
    #[test]
    fn interrupts_without_jumping_and_replaces_targets_without_leaking_selection() {
        let model = model();
        let mut state = MeshHighlightState::default();
        state.request(Some(&model), Some("Face"), Some(0xffffff), Some(1.0));
        state.advance(0.2);
        state.request(Some(&model), None, None, None);
        state.advance(0.1);
        let intensity = state.frame().highlights[0].fill_intensity;
        state.request(Some(&model), Some("Face"), Some(0xffffff), Some(1.0));
        assert_eq!(state.frame().highlights[0].fill_intensity, intensity);
        state.request(Some(&model), Some("Body"), None, None);
        assert_eq!(state.frame().highlights.len(), 1);
        assert_eq!(state.frame().highlights[0].mesh_id, 12);
        assert_eq!(state.frame().highlights[0].fill_intensity, 0.0);
        state.advance(f64::NAN);
        state.advance(-1.0);
        assert_eq!(state.frame().highlights[0].fill_intensity, 0.0);
        state.advance(10.0);
        state.request(Some(&model), Some("Missing"), None, None);
        state.advance(0.4);
        assert!(state.frame().highlights.is_empty());
    }
    #[test]
    fn repeated_selection_does_not_restart_and_invalid_strength_uses_defaults() {
        let model = model();
        let mut state = MeshHighlightState::default();
        state.request(Some(&model), Some("Face"), None, Some(f32::NAN));
        state.advance(0.2);
        state.request(Some(&model), Some("Face"), None, Some(f32::NAN));
        state.advance(0.2);
        assert!((state.frame().highlights[0].fill_intensity - DEFAULT_INTENSITY).abs() < 1e-6);
        state.request(Some(&model), Some("Face"), Some(0xffffffff), Some(2.0));
        state.advance(0.4);
        assert_eq!(state.frame().highlights[0].fill_color, [1.0, 1.0, 1.0]);
        assert_eq!(state.frame().highlights[0].fill_intensity, 1.0);
    }

}
