use wasm_bindgen::prelude::*;

use crate::math::finite_or;

pub const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE: u32 = 4;

#[wasm_bindgen]
pub fn template_skeleton_fit_transform_stride() -> u32 {
    TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE
}

#[wasm_bindgen]
pub fn compose_template_skeleton_fit_transform(
    fit_scale: f32,
    fit_translation: &[f32],
    manual_scale: f32,
    manual_translation: &[f32],
) -> Box<[f32]> {
    let scale = positive_finite_or(fit_scale, 1.0) * positive_finite_or(manual_scale, 1.0);

    vec![
        scale,
        finite_or(*fit_translation.get(0).unwrap_or(&0.0), 0.0)
            + finite_or(*manual_translation.get(0).unwrap_or(&0.0), 0.0),
        finite_or(*fit_translation.get(1).unwrap_or(&0.0), 0.0)
            + finite_or(*manual_translation.get(1).unwrap_or(&0.0), 0.0),
        finite_or(*fit_translation.get(2).unwrap_or(&0.0), 0.0)
            + finite_or(*manual_translation.get(2).unwrap_or(&0.0), 0.0),
    ]
    .into_boxed_slice()
}

fn positive_finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_template_skeleton_fit_stride() {
        assert_eq!(template_skeleton_fit_transform_stride(), 4);
    }

    #[test]
    fn composes_manual_fit_adjustments() {
        let output = compose_template_skeleton_fit_transform(
            1.2,
            &[0.1, 0.2, -0.1],
            1.05,
            &[0.01, -0.02, 0.03],
        );

        assert!((output[0] - 1.26).abs() < 1e-6);
        assert!((output[1] - 0.11).abs() < 1e-6);
        assert!((output[2] - 0.18).abs() < 1e-6);
        assert!((output[3] - -0.07).abs() < 1e-6);
    }

    #[test]
    fn sanitizes_invalid_fit_values() {
        let output = compose_template_skeleton_fit_transform(
            f32::NAN,
            &[f32::INFINITY, 2.0],
            -1.0,
            &[1.0, f32::NAN, 3.0],
        );

        assert_eq!(&*output, &[1.0, 1.0, 2.0, 3.0]);
    }
}
