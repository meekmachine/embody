use wasm_bindgen::prelude::*;

const XYZ_STRIDE: usize = 3;
const BOUNDS_LEN: usize = 6;
const MESH_PROPORTIONS_LEN: usize = 16;
const FIT_LEN: usize = 10;
const EPSILON: f32 = 1e-5;

pub const MESH_PROPORTIONS_STRIDE: u32 = MESH_PROPORTIONS_LEN as u32;
pub const TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE: u32 = FIT_LEN as u32;

#[derive(Clone, Copy, Debug)]
struct AxisSet {
    vertical: usize,
    cross_a: usize,
    cross_b: usize,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    min: [f32; 3],
    max: [f32; 3],
}

impl Bounds {
    fn empty() -> Self {
        Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        }
    }

    fn from_slice(values: &[f32]) -> Option<Self> {
        if values.len() < BOUNDS_LEN {
            return None;
        }

        let bounds = Self {
            min: [values[0], values[1], values[2]],
            max: [values[3], values[4], values[5]],
        };
        if bounds.is_valid() {
            Some(bounds)
        } else {
            None
        }
    }

    fn include(&mut self, point: [f32; 3]) {
        for axis in 0..3 {
            self.min[axis] = self.min[axis].min(point[axis]);
            self.max[axis] = self.max[axis].max(point[axis]);
        }
    }

    fn is_valid(&self) -> bool {
        (0..3).all(|axis| {
            self.min[axis].is_finite()
                && self.max[axis].is_finite()
                && self.max[axis] >= self.min[axis]
        })
    }

    fn center(&self) -> [f32; 3] {
        [
            (self.min[0] + self.max[0]) * 0.5,
            (self.min[1] + self.max[1]) * 0.5,
            (self.min[2] + self.max[2]) * 0.5,
        ]
    }

    fn spans(&self) -> [f32; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }
}

#[derive(Clone, Copy, Debug)]
struct Proportions {
    bounds: Bounds,
    spans: [f32; 3],
    vertical_height: f32,
    cross_wide: f32,
    cross_narrow: f32,
    confidence: f32,
}

#[wasm_bindgen]
pub fn mesh_proportions_stride() -> u32 {
    MESH_PROPORTIONS_STRIDE
}

#[wasm_bindgen]
pub fn template_skeleton_fit_solution_stride() -> u32 {
    TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE
}

/// Analyze xyz vertex positions for a rough humanoid proportion signal.
///
/// Input is a packed xyz buffer. `vertical_axis` is 0 for x, 1 for y, and 2 for z.
/// Invalid or incomplete vertices are ignored.
///
/// Output layout:
/// [min_x, min_y, min_z, max_x, max_y, max_z,
///  center_x, center_y, center_z,
///  span_x, span_y, span_z,
///  vertical_height, cross_axis_wide_span, cross_axis_narrow_span,
///  humanoid_likelihood]
#[wasm_bindgen]
pub fn analyze_mesh_proportions(vertices: &[f32], vertical_axis: u8) -> Box<[f32]> {
    match compute_mesh_proportions(vertices, vertical_axis) {
        Some(proportions) => {
            let center = proportions.bounds.center();
            vec![
                proportions.bounds.min[0],
                proportions.bounds.min[1],
                proportions.bounds.min[2],
                proportions.bounds.max[0],
                proportions.bounds.max[1],
                proportions.bounds.max[2],
                center[0],
                center[1],
                center[2],
                proportions.spans[0],
                proportions.spans[1],
                proportions.spans[2],
                proportions.vertical_height,
                proportions.cross_wide,
                proportions.cross_narrow,
                proportions.confidence,
            ]
            .into_boxed_slice()
        }
        None => vec![0.0; MESH_PROPORTIONS_LEN].into_boxed_slice(),
    }
}

/// Solve a uniform scale and translation for placing a template skeleton inside a mesh.
///
/// `template_bounds` is [min_x, min_y, min_z, max_x, max_y, max_z] in the
/// template skeleton's rest-pose coordinate space. `vertical_axis` is 0, 1, or 2.
/// `vertical_anchor` controls vertical placement: 0 aligns mins, 1 aligns centers,
/// 2 aligns maxes.
///
/// Output layout:
/// [scale, translate_x, translate_y, translate_z,
///  mesh_humanoid_likelihood, mesh_height, template_height,
///  mesh_cross_axis_wide_span, template_cross_axis_wide_span, status]
///
/// `status` is 1 for solved, 0 for invalid mesh input, and -1 for invalid template
/// bounds. This does not compute skin weights, inverse bind matrices, or pose
/// retargeting.
#[wasm_bindgen]
pub fn solve_template_skeleton_fit(
    mesh_vertices: &[f32],
    template_bounds: &[f32],
    vertical_axis: u8,
    vertical_anchor: u8,
) -> Box<[f32]> {
    let axes = axes_for(vertical_axis);
    let Some(mesh) = compute_mesh_proportions(mesh_vertices, vertical_axis) else {
        return status_fit(0.0);
    };
    let Some(template_bounds) = Bounds::from_slice(template_bounds) else {
        return status_fit(-1.0);
    };

    let template_spans = template_bounds.spans();
    let template_height = template_spans[axes.vertical];
    if template_height <= EPSILON {
        return status_fit(-1.0);
    }

    let template_cross_wide = template_spans[axes.cross_a].max(template_spans[axes.cross_b]);
    let scale = mesh.vertical_height / template_height;
    let mesh_center = mesh.bounds.center();
    let template_center = template_bounds.center();

    let mut translation = [0.0; 3];
    for axis in 0..3 {
        translation[axis] = mesh_center[axis] - (template_center[axis] * scale);
    }

    translation[axes.vertical] = match vertical_anchor {
        1 => mesh_center[axes.vertical] - (template_center[axes.vertical] * scale),
        2 => mesh.bounds.max[axes.vertical] - (template_bounds.max[axes.vertical] * scale),
        _ => mesh.bounds.min[axes.vertical] - (template_bounds.min[axes.vertical] * scale),
    };

    vec![
        scale,
        translation[0],
        translation[1],
        translation[2],
        mesh.confidence,
        mesh.vertical_height,
        template_height,
        mesh.cross_wide,
        template_cross_wide,
        1.0,
    ]
    .into_boxed_slice()
}

/// Compose user-facing manual adjustments onto a solved skeleton fit.
///
/// `fit` must start with [scale, translate_x, translate_y, translate_z]. The
/// output preserves those four fields after multiplying scale and adding offsets.
#[wasm_bindgen]
pub fn compose_template_fit_adjustment(
    fit: &[f32],
    scale_multiplier: f32,
    offset_x: f32,
    offset_y: f32,
    offset_z: f32,
) -> Box<[f32]> {
    let base_scale = finite_or(*fit.first().unwrap_or(&1.0), 1.0).max(EPSILON);
    let multiplier = finite_or(scale_multiplier, 1.0).max(EPSILON);
    let translate_x = finite_or(*fit.get(1).unwrap_or(&0.0), 0.0) + finite_or(offset_x, 0.0);
    let translate_y = finite_or(*fit.get(2).unwrap_or(&0.0), 0.0) + finite_or(offset_y, 0.0);
    let translate_z = finite_or(*fit.get(3).unwrap_or(&0.0), 0.0) + finite_or(offset_z, 0.0);

    vec![
        base_scale * multiplier,
        translate_x,
        translate_y,
        translate_z,
    ]
    .into_boxed_slice()
}

fn compute_mesh_proportions(vertices: &[f32], vertical_axis: u8) -> Option<Proportions> {
    let axes = axes_for(vertical_axis);
    let mut bounds = Bounds::empty();
    let mut count = 0usize;

    for chunk in vertices.chunks_exact(XYZ_STRIDE) {
        let point = [chunk[0], chunk[1], chunk[2]];
        if point.iter().all(|value| value.is_finite()) {
            bounds.include(point);
            count += 1;
        }
    }

    if count == 0 || !bounds.is_valid() {
        return None;
    }

    let spans = bounds.spans();
    let vertical_height = spans[axes.vertical];
    let cross_a = spans[axes.cross_a];
    let cross_b = spans[axes.cross_b];
    let cross_wide = cross_a.max(cross_b);
    let cross_narrow = cross_a.min(cross_b);

    if vertical_height <= EPSILON || cross_wide <= EPSILON {
        return Some(Proportions {
            bounds,
            spans,
            vertical_height,
            cross_wide,
            cross_narrow,
            confidence: 0.0,
        });
    }

    let height_to_width = vertical_height / cross_wide;
    let verticality = smooth_window(height_to_width, 1.35, 2.0, 4.2, 6.0);
    let thickness_ratio = if cross_wide <= EPSILON {
        0.0
    } else {
        cross_narrow / cross_wide
    };
    let thickness = smooth_window(thickness_ratio, 0.08, 0.18, 0.95, 1.1);
    let confidence = (verticality * 0.75 + thickness * 0.25).clamp(0.0, 1.0);

    Some(Proportions {
        bounds,
        spans,
        vertical_height,
        cross_wide,
        cross_narrow,
        confidence,
    })
}

fn axes_for(vertical_axis: u8) -> AxisSet {
    match vertical_axis {
        0 => AxisSet {
            vertical: 0,
            cross_a: 1,
            cross_b: 2,
        },
        2 => AxisSet {
            vertical: 2,
            cross_a: 0,
            cross_b: 1,
        },
        _ => AxisSet {
            vertical: 1,
            cross_a: 0,
            cross_b: 2,
        },
    }
}

fn smooth_window(value: f32, min: f32, full_min: f32, full_max: f32, max: f32) -> f32 {
    if value <= min || value >= max {
        return 0.0;
    }
    if value >= full_min && value <= full_max {
        return 1.0;
    }
    if value < full_min {
        return ((value - min) / (full_min - min)).clamp(0.0, 1.0);
    }
    ((max - value) / (max - full_max)).clamp(0.0, 1.0)
}

fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn status_fit(status: f32) -> Box<[f32]> {
    let mut fit = vec![0.0; FIT_LEN];
    fit[9] = status;
    fit.into_boxed_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tall_mesh_vertices() -> Vec<f32> {
        vec![
            -0.5, 0.0, -0.2, 0.5, 0.0, 0.2, -0.45, 1.0, -0.18, 0.45, 1.0, 0.18, -0.35, 1.8, -0.15,
            0.35, 1.8, 0.15,
        ]
    }

    #[test]
    fn analyzes_mesh_proportions() {
        let output = analyze_mesh_proportions(&tall_mesh_vertices(), 1);

        assert_eq!(output.len(), MESH_PROPORTIONS_STRIDE as usize);
        assert_close(output[0], -0.5);
        assert_close(output[1], 0.0);
        assert_close(output[4], 1.8);
        assert_close(output[12], 1.8);
        assert_close(output[13], 1.0);
        assert_close(output[14], 0.4);
        assert!(output[15] > 0.7);
    }

    #[test]
    fn ignores_invalid_vertices() {
        let vertices = vec![f32::NAN, 0.0, 0.0, -1.0, 0.0, -0.5, 1.0, 2.0, 0.5];
        let output = analyze_mesh_proportions(&vertices, 1);

        assert_close(output[0], -1.0);
        assert_close(output[4], 2.0);
        assert!(output[15] > 0.0);
    }

    #[test]
    fn solves_template_fit_with_min_vertical_anchor() {
        let template_bounds = [-10.0, 0.0, -5.0, 10.0, 100.0, 5.0];
        let output = solve_template_skeleton_fit(&tall_mesh_vertices(), &template_bounds, 1, 0);

        assert_eq!(output.len(), TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE as usize);
        assert_close(output[0], 0.018);
        assert_close(output[1], 0.0);
        assert_close(output[2], 0.0);
        assert_close(output[3], 0.0);
        assert_close(output[5], 1.8);
        assert_close(output[6], 100.0);
        assert_close(output[9], 1.0);
    }

    #[test]
    fn solves_template_fit_with_center_vertical_anchor() {
        let template_bounds = [0.0, -50.0, 0.0, 20.0, 50.0, 10.0];
        let output = solve_template_skeleton_fit(&tall_mesh_vertices(), &template_bounds, 1, 1);

        assert_close(output[0], 0.018);
        assert_close(output[1], -0.18);
        assert_close(output[2], 0.9);
        assert_close(output[3], -0.09);
    }

    #[test]
    fn returns_status_for_invalid_template_bounds() {
        let output = solve_template_skeleton_fit(&tall_mesh_vertices(), &[0.0, 0.0], 1, 0);

        assert_close(output[9], -1.0);
    }

    #[test]
    fn composes_manual_adjustments() {
        let output = compose_template_fit_adjustment(&[2.0, 1.0, -1.0, 0.5], 1.5, 0.25, 0.5, -0.5);

        assert_eq!(&*output, &[3.0, 1.25, -0.5, 0.0]);
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1e-5,
            "expected {actual} to be close to {expected}"
        );
    }
}
