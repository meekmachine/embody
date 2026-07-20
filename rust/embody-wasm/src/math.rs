use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn solve_bilateral_values(base: f32, balance: f32) -> Box<[f32]> {
    let base = clamp01(base);
    let balance = clamp_signed(balance);
    let (left, right) = bilateral_values(base, balance);
    vec![left, right].into_boxed_slice()
}

#[wasm_bindgen]
pub fn solve_morph_batch(values: &[f32], balances: &[f32], mix_weights: &[f32]) -> Box<[f32]> {
    let count = values.len();
    let mut out = Vec::with_capacity(count * 3);

    for index in 0..count {
        let value = clamp01(values[index]);
        let balance = clamp_signed(*balances.get(index).unwrap_or(&0.0));
        let mix_weight = clamp01(*mix_weights.get(index).unwrap_or(&1.0));
        let base = value * mix_weight;
        let (left, right) = bilateral_values(base, balance);
        out.push(left);
        out.push(right);
        out.push(base);
    }

    out.into_boxed_slice()
}

#[wasm_bindgen]
pub fn solve_axis_quaternion(axis: u8, degrees: f32, value: f32, scale: f32) -> Box<[f32]> {
    let radians = degrees.to_radians() * value.abs() * scale;
    let (x, y, z) = match axis {
        0 => (1.0, 0.0, 0.0),
        1 => (0.0, 1.0, 0.0),
        _ => (0.0, 0.0, 1.0),
    };
    let half = radians / 2.0;
    let s = half.sin();
    normalize_quat([x * s, y * s, z * s, half.cos()])
        .to_vec()
        .into_boxed_slice()
}

pub(crate) fn clamp01(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

pub(crate) fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn bilateral_values(base: f32, balance: f32) -> (f32, f32) {
    if balance == 0.0 {
        return (base, base);
    }
    if balance < 0.0 {
        return (base, base * (1.0 + balance));
    }
    (base * (1.0 - balance), base)
}

fn normalize_quat(q: [f32; 4]) -> [f32; 4] {
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if len <= f32::EPSILON {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

fn clamp_signed(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_bilateral_values() {
        assert_eq!(&*solve_bilateral_values(0.8, -0.25), &[0.8, 0.6]);
        assert_eq!(&*solve_bilateral_values(0.8, 0.25), &[0.6, 0.8]);
    }

    #[test]
    fn solves_morph_batches() {
        let output = solve_morph_batch(&[0.8, 0.5], &[-0.25, 0.5], &[1.0, 0.5]);
        assert_eq!(&*output, &[0.8, 0.6, 0.8, 0.125, 0.25, 0.25]);
    }

    #[test]
    fn solves_axis_quaternion() {
        let output = solve_axis_quaternion(1, 20.0, -0.5, -1.0);
        assert!((output[0] - 0.0).abs() < 1e-6);
        assert!((output[1] - -0.08715574).abs() < 1e-6);
        assert!((output[2] - 0.0).abs() < 1e-6);
        assert!((output[3] - 0.9961947).abs() < 1e-6);
    }
}
