//! Attachment policy is renderer independent. Native adapters evaluate only the
//! requested vertices; the runtime retains their identities and influence weights.
use super::geometry::Point;
use super::markers::{morph_candidates, morph_sample_indices};
use serde_json::Value;

pub struct MorphAnchorPlan {
    pub object_id: u32,
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
            object_id: 0,
            region: super::geometry::text(region, "name").to_owned(),
            vertices,
            position: None,
        })
    }

    pub fn observe(&mut self, positions: &[f32]) -> bool {
        if positions.len() != self.vertices.len() * 3 || !positions.iter().all(|p| p.is_finite()) {
            return false;
        }
        self.position = weighted_center(
            positions
                .chunks_exact(3)
                .zip(&self.vertices)
                .map(|(point, (_, weight))| ([point[0], point[1], point[2]], *weight)),
        );
        self.position.is_some()
    }
}

/// Shared reduction for live attachments and one-shot queries. No second
/// semantic-band selection is performed on posed/world-space observations.
pub fn weighted_center(samples: impl Iterator<Item = (Point, f32)>) -> Option<Point> {
    let mut sum = [0_f64; 3];
    let mut total = 0_f64;
    for (point, weight) in samples {
        if !weight.is_finite() || weight <= 0. || !point.iter().all(|v| v.is_finite()) {
            return None;
        }
        for axis in 0..3 {
            sum[axis] += point[axis] as f64 * weight as f64;
        }
        total += weight as f64;
    }
    (total > 0.).then(|| sum.map(|value| (value / total) as f32))
}
