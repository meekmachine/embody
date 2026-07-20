//! DPthree annotation marker core.
//!
//! Rust port of the pure marker math from the DPthree 3D/HTML marker systems:
//! camera-angle visibility gating, viewport-constrained line clipping,
//! bezier/arc leader-line sampling, and the marker show/hide animation curves.
//! Mesh/material/DOM work stays in the host.

use wasm_bindgen::prelude::*;

use crate::annotation_camera::{normalize_camera_angle_value, read_vec3};

pub const MARKER_VISIBILITY_FACTORS_STRIDE: u32 = 3;

const CLIP_EPSILON: f32 = 1e-6;
const DEFAULT_MIN_VIEWPORT_LINE_SCALE: f32 = 0.18;
const DEFAULT_VIEWPORT_LABEL_EDGE_PADDING_PX: f32 = 12.0;
const DEFAULT_CAMERA_ANGLE_GATE_RANGE: f32 = 90.0;

const LABEL_SHOW_START_SCALE: f32 = 0.18;
const LABEL_SHOW_PEAK_SCALE: f32 = 1.28;
const LABEL_HIDE_BUMP_SCALE: f32 = 1.06;
const LABEL_HIDE_END_SCALE: f32 = 0.14;

#[wasm_bindgen]
pub fn marker_visibility_factors_stride() -> u32 {
    MARKER_VISIBILITY_FACTORS_STRIDE
}

// ====== CAMERA ANGLE GATE ======

fn passes_camera_angle_gate(
    marker_angle: Option<f32>,
    current_camera_angle: Option<f32>,
    range_degrees: f32,
) -> bool {
    let (Some(marker_angle), Some(current)) = (marker_angle, current_camera_angle) else {
        return true;
    };
    if marker_angle == 0.0 {
        return true;
    }

    let mut diff = (normalize_camera_angle_value(current)
        - normalize_camera_angle_value(marker_angle))
    .abs();
    if diff > 180.0 {
        diff = 360.0 - diff;
    }
    diff <= range_degrees
}

/// Whether a marker with a preferred viewing angle should show for the
/// current camera orbit angle. Angles are degrees around the model Y axis.
#[wasm_bindgen]
pub fn passes_marker_camera_angle_gate(
    marker_angle: Option<f32>,
    current_camera_angle: Option<f32>,
    range_degrees: Option<f32>,
) -> bool {
    passes_camera_angle_gate(
        marker_angle,
        current_camera_angle,
        range_degrees.unwrap_or(DEFAULT_CAMERA_ANGLE_GATE_RANGE),
    )
}

/// Solo/expand/angle visibility rule for a marker.
///
/// * `hidden_child` - the marker is a collapsed child of an expandable region.
/// * `soloed` - solo state: 0 = no solo, 1 = this marker is soloed,
///   2 = another marker is soloed.
#[wasm_bindgen]
pub fn should_show_marker(
    hidden_child: bool,
    soloed: u8,
    marker_angle: Option<f32>,
    current_camera_angle: Option<f32>,
) -> bool {
    if hidden_child {
        return false;
    }
    if soloed == 2 {
        return false;
    }
    passes_camera_angle_gate(
        marker_angle,
        current_camera_angle,
        DEFAULT_CAMERA_ANGLE_GATE_RANGE,
    )
}

// ====== VIEWPORT LINE CLIPPING ======

fn is_finite_clip_point(point: &[f32]) -> bool {
    point.len() >= 4 && point.iter().take(4).all(|v| v.is_finite())
}

fn is_clip_point_inside_frustum(point: &[f32]) -> bool {
    if !is_finite_clip_point(point) || point[3] <= CLIP_EPSILON {
        return false;
    }
    let w = point[3];
    point[0] >= -w && point[0] <= w && point[1] >= -w && point[1] <= w && point[2] >= -w
        && point[2] <= w
}

fn clip_segment_against_upper_bound(interval: &mut (f32, f32), q0: f32, dq: f32) -> bool {
    if dq.abs() <= CLIP_EPSILON {
        return q0 <= 0.0;
    }

    let t = -q0 / dq;
    if dq > 0.0 {
        interval.1 = interval.1.min(t);
    } else {
        interval.0 = interval.0.max(t);
    }

    interval.0 <= interval.1
}

/// Clip a marker leader line (clip-space start/end, `[x, y, z, w]` each) to a
/// safe viewport rectangle. Returns `[visible, lineScale]` where `lineScale`
/// is the fraction of the line that stays on screen.
#[wasm_bindgen]
pub fn resolve_viewport_constrained_line_scale(
    start_clip: &[f32],
    end_clip: &[f32],
    safe_x: f32,
    safe_y: f32,
    min_length_ratio: Option<f32>,
) -> Box<[f32]> {
    let min_length_ratio = min_length_ratio.unwrap_or(DEFAULT_MIN_VIEWPORT_LINE_SCALE);
    let hidden = vec![0.0, 0.0].into_boxed_slice();

    if !is_clip_point_inside_frustum(start_clip) || end_clip.len() < 4 {
        return hidden;
    }

    let safe_x = safe_x.clamp(CLIP_EPSILON, 1.0);
    let safe_y = safe_y.clamp(CLIP_EPSILON, 1.0);
    let mut interval = (0.0f32, 1.0f32);

    let dx = end_clip[0] - start_clip[0];
    let dy = end_clip[1] - start_clip[1];
    let dz = end_clip[2] - start_clip[2];
    let dw = end_clip[3] - start_clip[3];

    let constraints: [(f32, f32); 6] = [
        (start_clip[0] - safe_x * start_clip[3], dx - safe_x * dw),
        (-start_clip[0] - safe_x * start_clip[3], -dx - safe_x * dw),
        (start_clip[1] - safe_y * start_clip[3], dy - safe_y * dw),
        (-start_clip[1] - safe_y * start_clip[3], -dy - safe_y * dw),
        (start_clip[2] - start_clip[3], dz - dw),
        (-start_clip[2] - start_clip[3], -dz - dw),
    ];

    for (q0, dq) in constraints {
        if !clip_segment_against_upper_bound(&mut interval, q0, dq) {
            return hidden;
        }
    }

    let line_scale = interval.1.clamp(0.0, 1.0);
    if !line_scale.is_finite() || line_scale < min_length_ratio {
        return hidden;
    }

    vec![1.0, line_scale].into_boxed_slice()
}

/// Safe NDC bounds that keep a screen-space label plus a pixel gutter fully
/// on screen. Returns `[safeX, safeY]`.
#[wasm_bindgen]
pub fn resolve_viewport_safe_bounds(
    label_scale_x: f32,
    label_scale_y: f32,
    projection_x_scale: f32,
    projection_y_scale: f32,
    viewport_width: f32,
    viewport_height: f32,
    edge_padding_px: Option<f32>,
) -> Box<[f32]> {
    let edge_padding_px = edge_padding_px.unwrap_or(DEFAULT_VIEWPORT_LABEL_EDGE_PADDING_PX);
    let width = viewport_width.max(1.0);
    let height = viewport_height.max(1.0);
    let half_label_x = (label_scale_x * projection_x_scale).abs() * 0.5;
    let half_label_y = (label_scale_y * projection_y_scale).abs() * 0.5;
    let padding_x = edge_padding_px.max(0.0) * 2.0 / width;
    let padding_y = edge_padding_px.max(0.0) * 2.0 / height;

    vec![
        (1.0 - half_label_x - padding_x).clamp(CLIP_EPSILON, 1.0),
        (1.0 - half_label_y - padding_y).clamp(CLIP_EPSILON, 1.0),
    ]
    .into_boxed_slice()
}

// ====== LEADER LINE CURVES ======

fn push_point(out: &mut Vec<f32>, point: [f32; 3]) {
    out.push(point[0]);
    out.push(point[1]);
    out.push(point[2]);
}

/// Quadratic bezier leader line points between two world positions.
/// Returns `(segments + 1) * 3` floats.
#[wasm_bindgen]
pub fn sample_marker_bezier_curve(start: &[f32], end: &[f32], segments: u32) -> Box<[f32]> {
    let start = read_vec3(start, 0);
    let end = read_vec3(end, 0);
    let segments = segments.max(1);

    let midpoint = [
        (start[0] + end[0]) * 0.5,
        (start[1] + end[1]) * 0.5,
        (start[2] + end[2]) * 0.5,
    ];

    let direction = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    let length =
        (direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2])
            .sqrt();

    // Control point perpendicular to the line (screen-plane style bend).
    let mut perpendicular = [-direction[1], direction[0], 0.0];
    let perp_len = (perpendicular[0] * perpendicular[0] + perpendicular[1] * perpendicular[1])
        .sqrt();
    if perp_len < 0.001 {
        perpendicular = [0.0, 1.0, 0.0];
    } else {
        perpendicular = [perpendicular[0] / perp_len, perpendicular[1] / perp_len, 0.0];
    }

    let curve_intensity = length * 0.3;
    let control = [
        midpoint[0] + perpendicular[0] * curve_intensity,
        midpoint[1] + perpendicular[1] * curve_intensity,
        midpoint[2] + perpendicular[2] * curve_intensity,
    ];

    let mut out = Vec::with_capacity(((segments + 1) * 3) as usize);
    for i in 0..=segments {
        let t = i as f32 / segments as f32;
        let one_minus = 1.0 - t;
        let point = [
            one_minus * one_minus * start[0] + 2.0 * one_minus * t * control[0] + t * t * end[0],
            one_minus * one_minus * start[1] + 2.0 * one_minus * t * control[1] + t * t * end[1],
            one_minus * one_minus * start[2] + 2.0 * one_minus * t * control[2] + t * t * end[2],
        ];
        push_point(&mut out, point);
    }

    out.into_boxed_slice()
}

/// Sinusoidal arc leader line points between two world positions.
/// Returns `(segments + 1) * 3` floats.
#[wasm_bindgen]
pub fn sample_marker_arc_curve(start: &[f32], end: &[f32], segments: u32) -> Box<[f32]> {
    let start = read_vec3(start, 0);
    let end = read_vec3(end, 0);
    let segments = segments.max(1);

    let delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    let distance = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
    let radius = distance * 0.6;

    let direction = if distance > f32::EPSILON {
        [delta[0] / distance, delta[1] / distance, delta[2] / distance]
    } else {
        [0.0, 0.0, 0.0]
    };

    // perpendicular = normalize(cross(direction, up))
    let mut perpendicular = [
        direction[1] * 0.0 - direction[2] * 1.0,
        direction[2] * 0.0 - direction[0] * 0.0,
        direction[0] * 1.0 - direction[1] * 0.0,
    ];
    let perp_len = (perpendicular[0] * perpendicular[0]
        + perpendicular[1] * perpendicular[1]
        + perpendicular[2] * perpendicular[2])
        .sqrt();
    if perp_len < 0.001 {
        perpendicular = [1.0, 0.0, 0.0];
    } else {
        perpendicular = [
            perpendicular[0] / perp_len,
            perpendicular[1] / perp_len,
            perpendicular[2] / perp_len,
        ];
    }

    let mut out = Vec::with_capacity(((segments + 1) * 3) as usize);
    for i in 0..=segments {
        let t = i as f32 / segments as f32;
        let arc_offset = (t * std::f32::consts::PI).sin() * radius * 0.3;
        let point = [
            start[0] + delta[0] * t + perpendicular[0] * arc_offset,
            start[1] + delta[1] * t + perpendicular[1] * arc_offset,
            start[2] + delta[2] * t + perpendicular[2] * arc_offset,
        ];
        push_point(&mut out, point);
    }

    out.into_boxed_slice()
}

// ====== VISIBILITY ANIMATION CURVES ======

fn ease_in_cubic(t: f32) -> f32 {
    t * t * t
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn label_visibility_scale(visible: bool, t: f32) -> f32 {
    if visible {
        if t <= 0.68 {
            return lerp(
                LABEL_SHOW_START_SCALE,
                LABEL_SHOW_PEAK_SCALE,
                ease_out_cubic(t / 0.68),
            );
        }
        return lerp(
            LABEL_SHOW_PEAK_SCALE,
            1.0,
            ease_in_cubic((t - 0.68) / 0.32),
        );
    }

    if t <= 0.2 {
        return lerp(1.0, LABEL_HIDE_BUMP_SCALE, ease_out_cubic(t / 0.2));
    }

    lerp(
        LABEL_HIDE_BUMP_SCALE,
        LABEL_HIDE_END_SCALE,
        ease_in_cubic((t - 0.2) / 0.8),
    )
}

/// Marker show/hide animation factors at normalized time `t` in `[0, 1]`.
/// Returns `[itemOpacityFactor, labelScaleFactor, lineOpacityFactor]`.
#[wasm_bindgen]
pub fn marker_visibility_animation_factors(visible: bool, t: f32) -> Box<[f32]> {
    let t = t.clamp(0.0, 1.0);

    let item_opacity = if visible {
        ease_out_cubic(((t - 0.04) / 0.96).clamp(0.0, 1.0))
    } else {
        1.0 - ease_in_cubic((t / 0.78).clamp(0.0, 1.0))
    };

    let line_opacity = if visible {
        ease_out_cubic(((t - 0.14) / 0.86).clamp(0.0, 1.0))
    } else {
        1.0 - ease_in_cubic((t / 0.55).clamp(0.0, 1.0))
    };

    vec![item_opacity, label_visibility_scale(visible, t), line_opacity].into_boxed_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_children_stay_hidden_even_when_angle_matches() {
        assert!(!should_show_marker(true, 0, Some(45.0), Some(45.0)));
    }

    #[test]
    fn non_solo_markers_hide_while_solo_is_active() {
        assert!(!should_show_marker(false, 2, Some(315.0), Some(315.0)));
    }

    #[test]
    fn visible_markers_show_within_camera_angle_gate() {
        assert!(should_show_marker(false, 0, Some(315.0), Some(315.0)));
        assert!(should_show_marker(false, 1, Some(315.0), Some(315.0)));
    }

    #[test]
    fn camera_angle_gate_uses_wraparound_distance() {
        assert!(passes_camera_angle_gate(Some(350.0), Some(10.0), 90.0));
        assert!(!passes_camera_angle_gate(Some(180.0), Some(10.0), 90.0));
        // Zero marker angle and missing angles always pass.
        assert!(passes_camera_angle_gate(Some(0.0), Some(180.0), 90.0));
        assert!(passes_camera_angle_gate(None, Some(180.0), 90.0));
        assert!(passes_camera_angle_gate(Some(90.0), None, 90.0));
    }

    #[test]
    fn keeps_full_line_when_endpoint_fits_safe_viewport() {
        let result = resolve_viewport_constrained_line_scale(
            &[0.0, 0.0, 0.0, 1.0],
            &[0.4, 0.2, 0.0, 1.0],
            0.85,
            0.85,
            None,
        );
        assert_eq!(&*result, &[1.0, 1.0]);
    }

    #[test]
    fn shortens_line_to_safe_horizontal_bound() {
        let result = resolve_viewport_constrained_line_scale(
            &[0.0, 0.0, 0.0, 1.0],
            &[2.0, 0.0, 0.0, 1.0],
            0.8,
            0.9,
            None,
        );
        assert_eq!(result[0], 1.0);
        assert!((result[1] - 0.4).abs() < 1e-6);
    }

    #[test]
    fn hides_marker_when_line_start_exits_safe_viewport() {
        let result = resolve_viewport_constrained_line_scale(
            &[0.95, 0.0, 0.0, 1.0],
            &[1.2, 0.0, 0.0, 1.0],
            0.8,
            0.9,
            None,
        );
        assert_eq!(&*result, &[0.0, 0.0]);
    }

    #[test]
    fn hides_marker_when_anchor_is_offscreen() {
        let result = resolve_viewport_constrained_line_scale(
            &[1.2, 0.0, 0.0, 1.0],
            &[1.4, 0.0, 0.0, 1.0],
            0.8,
            0.9,
            None,
        );
        assert_eq!(&*result, &[0.0, 0.0]);
    }

    #[test]
    fn safe_bounds_keep_pixel_gutter_around_labels() {
        let bounds = resolve_viewport_safe_bounds(0.1, 0.04, 2.0, 2.5, 1000.0, 750.0, Some(12.0));
        assert!((bounds[0] - 0.876).abs() < 1e-6);
        assert!((bounds[1] - 0.918).abs() < 1e-6);
    }

    #[test]
    fn safe_bounds_use_width_and_height_independently() {
        let bounds = resolve_viewport_safe_bounds(0.0, 0.0, 1.0, 1.0, 1200.0, 600.0, Some(12.0));
        assert!((bounds[0] - 0.98).abs() < 1e-6);
        assert!((bounds[1] - 0.96).abs() < 1e-6);
    }

    #[test]
    fn bezier_curve_starts_and_ends_on_anchor_points() {
        let points = sample_marker_bezier_curve(&[0.0, 0.0, 0.0], &[1.0, 0.0, 0.0], 16);
        assert_eq!(points.len(), 17 * 3);
        assert_eq!(&points[0..3], &[0.0, 0.0, 0.0]);
        assert_eq!(&points[16 * 3..17 * 3], &[1.0, 0.0, 0.0]);

        // Midpoint bends perpendicular to the line.
        let mid = &points[8 * 3..8 * 3 + 3];
        assert!(mid[1] > 0.0);
    }

    #[test]
    fn arc_curve_bends_sinusoidally_between_anchor_points() {
        let points = sample_marker_arc_curve(&[0.0, 0.0, 0.0], &[1.0, 0.0, 0.0], 16);
        assert_eq!(points.len(), 17 * 3);
        assert_eq!(&points[0..3], &[0.0, 0.0, 0.0]);
        let last = &points[16 * 3..17 * 3];
        assert!((last[0] - 1.0).abs() < 1e-6);
        assert!(last[1].abs() < 1e-6);

        // Peak arc offset at t=0.5: sin(pi/2) * (d*0.6) * 0.3 = 0.18 along
        // +Z (cross of +X direction with +Y up).
        let mid = &points[8 * 3..8 * 3 + 3];
        assert!((mid[2] - 0.18).abs() < 1e-6);
    }

    #[test]
    fn visibility_animation_factors_ramp_between_zero_and_one() {
        let start = marker_visibility_animation_factors(true, 0.0);
        assert!(start[0].abs() < 1e-6);
        assert!((start[1] - LABEL_SHOW_START_SCALE).abs() < 1e-6);
        assert!(start[2].abs() < 1e-6);

        let end = marker_visibility_animation_factors(true, 1.0);
        assert!((end[0] - 1.0).abs() < 1e-6);
        assert!((end[1] - 1.0).abs() < 1e-6);
        assert!((end[2] - 1.0).abs() < 1e-6);

        let hide_end = marker_visibility_animation_factors(false, 1.0);
        assert!(hide_end[0].abs() < 1e-6);
        assert!((hide_end[1] - LABEL_HIDE_END_SCALE).abs() < 1e-6);
        assert!(hide_end[2].abs() < 1e-6);
    }

    #[test]
    fn label_scale_overshoots_then_settles_when_showing() {
        let peak = label_visibility_scale(true, 0.68);
        assert!((peak - LABEL_SHOW_PEAK_SCALE).abs() < 1e-6);
        let settled = label_visibility_scale(true, 1.0);
        assert!((settled - 1.0).abs() < 1e-6);
    }
}
