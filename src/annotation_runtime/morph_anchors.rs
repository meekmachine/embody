//! Attachment policy is renderer independent. Native adapters evaluate only the
//! requested vertices; the runtime retains their identities and influence weights.
use super::geometry::Point;
use super::markers::{morph_candidates, morph_sample_indices};
use serde_json::Value;

pub struct MorphAnchorPlan {
    pub region: String,
    pub vertices: Vec<(u32, f32)>,
    pub position: Option<Point>,
}

impl MorphAnchorPlan {
    pub fn new(region: &Value, base: &[f32], morphs: &[f32], relative: bool) -> Option<Self> {
        let candidates = morph_candidates(base, morphs, relative);
        let samples = candidates
            .chunks_exact(2)
            .flat_map(|candidate| {
                let offset = candidate[0] as usize * 3;
                [base[offset], base[offset + 1], base[offset + 2], candidate[1]]
            })
            .collect::<Vec<_>>();
        // Select the semantic band in mesh space once. Re-selecting by world Y
        // would move an attachment to different vertices when the model rotates.
        let vertices = morph_sample_indices(region, &samples)
            .into_iter()
            .map(|index| (candidates[index * 2] as u32, candidates[index * 2 + 1]))
            .collect::<Vec<_>>();
        if vertices.is_empty() {
            return None;
        }
        Some(Self {
            region: super::geometry::text(region, "name").to_owned(),
            vertices,
            position: None,
        })
    }

    pub fn observe(&mut self, positions: &[f32]) -> bool {
        if positions.len() != self.vertices.len() * 3 || !positions.iter().all(|p| p.is_finite()) {
            return false;
        }
        let mut sum = [0_f64; 3];
        let mut weight = 0_f64;
        for (point, (_, influence)) in positions.chunks_exact(3).zip(&self.vertices) {
            for axis in 0..3 {
                sum[axis] += point[axis] as f64 * *influence as f64;
            }
            weight += *influence as f64;
        }
        self.position = Some(sum.map(|value| (value / weight) as f32));
        true
    }
}
