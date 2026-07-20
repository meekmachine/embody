//! Host-neutral bone evaluation: composite rotations, AU translations, and
//! viseme-driven jaw rotation. Mirrors TsRuntimeCore.collectBoneWrites.

pub const BONE_REST_TRANSFORM_STRIDE: usize = 8;
pub const COMPOSITE_AXIS_HEADER_STRIDE: usize = 8;
pub const COMPOSITE_AXIS_VALUE_ROW_STRIDE: usize = 3;
pub const COMPOSITE_AXIS_BINDING_ROW_STRIDE: usize = 6;
pub const BONE_TRANSLATION_ROW_STRIDE: usize = 5;
pub const JAW_BINDING_STRIDE: usize = 4;

pub const AXIS_PITCH: u8 = 0;
pub const AXIS_YAW: u8 = 1;
pub const AXIS_ROLL: u8 = 2;

pub const GROUP_NEGATIVE: u8 = 0;
pub const GROUP_POSITIVE: u8 = 1;
pub const GROUP_PLAIN: u8 = 2;

pub const SIDE_NONE: u8 = 0;
pub const SIDE_LEFT: u8 = 1;
pub const SIDE_RIGHT: u8 = 2;

pub const FLAG_HAS_POSITION: u32 = 1;
pub const FLAG_HAS_ROTATION: u32 = 2;

#[derive(Clone, Copy, Debug, Default)]
pub struct RestTransform {
    pub position: [f32; 3],
    pub rotation: [f32; 4],
}

/// `[au_id, group, side]`
#[derive(Clone, Copy, Debug)]
pub struct AxisValueRow {
    pub au_id: u32,
    pub group: u8,
    pub side: u8,
}

/// `[au_id, group, side, channel, scale, max_degrees]`
#[derive(Clone, Copy, Debug)]
pub struct AxisBindingRow {
    pub au_id: u32,
    pub group: u8,
    pub side: u8,
    pub channel: u8,
    pub scale: f32,
    pub max_degrees: f32,
}

#[derive(Clone, Debug)]
pub struct CompositeAxis {
    pub bone_id: u32,
    pub axis: u8,
    pub has_directional_groups: bool,
    pub value_rows: Vec<AxisValueRow>,
    pub binding_rows: Vec<AxisBindingRow>,
}

/// `[au_id, bone_id, axis(0=x,1=y,2=z), scale, max_units]`
#[derive(Clone, Copy, Debug)]
pub struct TranslationRow {
    pub au_id: u32,
    pub bone_id: u32,
    pub axis: u8,
    pub scale: f32,
    pub max_units: f32,
}

/// `[bone_id, channel, scale, max_degrees]`
#[derive(Clone, Copy, Debug)]
pub struct JawBinding {
    pub bone_id: u32,
    pub channel: u8,
    pub scale: f32,
    pub max_degrees: f32,
}

pub fn side_scale(balance: f32, side: u8) -> f32 {
    let balance = balance.clamp(-1.0, 1.0);
    match side {
        SIDE_LEFT => {
            if balance > 0.0 {
                1.0 - balance
            } else {
                1.0
            }
        }
        SIDE_RIGHT => {
            if balance < 0.0 {
                1.0 + balance
            } else {
                1.0
            }
        }
        _ => 1.0,
    }
}

pub fn quat_from_channel(channel: u8, radians: f32) -> [f32; 4] {
    let axis = match channel {
        0 => [1.0, 0.0, 0.0],
        1 => [0.0, 1.0, 0.0],
        _ => [0.0, 0.0, 1.0],
    };
    let half = radians / 2.0;
    let s = half.sin();
    normalize_quat([axis[0] * s, axis[1] * s, axis[2] * s, half.cos()])
}

pub fn multiply_quat(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    normalize_quat([
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ])
}

pub fn normalize_quat(q: [f32; 4]) -> [f32; 4] {
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if len <= 1e-12 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

/// Composite axis value: pos - neg when directional groups exist,
/// otherwise max over the plain AU group (values are always >= 0).
pub fn composite_axis_value(axis: &CompositeAxis, effective_value: impl Fn(u32, u8) -> f32) -> f32 {
    if axis.has_directional_groups {
        let mut negative = 0.0f32;
        let mut positive = 0.0f32;
        for row in &axis.value_rows {
            let value = effective_value(row.au_id, row.side);
            match row.group {
                GROUP_NEGATIVE => negative = negative.max(value),
                GROUP_POSITIVE => positive = positive.max(value),
                _ => {}
            }
        }
        return positive - negative;
    }

    let mut best = 0.0f32;
    for row in &axis.value_rows {
        best = best.max(effective_value(row.au_id, row.side));
    }
    best
}

/// Pick the binding for the direction sign: directional rows when present,
/// otherwise plain rows; highest effective AU value wins (stable tie-break).
pub fn select_axis_binding<'a>(
    axis: &'a CompositeAxis,
    direction: f32,
    effective_value: impl Fn(u32, u8) -> f32,
) -> Option<&'a AxisBindingRow> {
    let wanted_group = if direction < 0.0 {
        GROUP_NEGATIVE
    } else {
        GROUP_POSITIVE
    };
    let directional: Vec<&AxisBindingRow> = axis
        .binding_rows
        .iter()
        .filter(|row| row.group == wanted_group)
        .collect();
    let candidates: Vec<&AxisBindingRow> = if directional.is_empty() {
        axis.binding_rows
            .iter()
            .filter(|row| row.group == GROUP_PLAIN)
            .collect()
    } else {
        directional
    };

    let mut best: Option<(&AxisBindingRow, f32)> = None;
    for row in candidates {
        let value = effective_value(row.au_id, row.side);
        match best {
            Some((_, best_value)) if value <= best_value => {}
            _ => best = Some((row, value)),
        }
    }
    best.map(|(row, _)| row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_scale_matches_ts_semantics() {
        assert_eq!(side_scale(0.5, SIDE_LEFT), 0.5);
        assert_eq!(side_scale(-0.5, SIDE_LEFT), 1.0);
        assert_eq!(side_scale(-0.5, SIDE_RIGHT), 0.5);
        assert_eq!(side_scale(0.5, SIDE_RIGHT), 1.0);
        assert_eq!(side_scale(0.5, SIDE_NONE), 1.0);
    }

    #[test]
    fn quat_multiplication_is_normalized() {
        let yaw = quat_from_channel(1, 0.5);
        let pitch = quat_from_channel(0, -0.25);
        let combined = multiply_quat(yaw, pitch);
        let len: f32 = combined.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((len - 1.0).abs() < 1e-6);
    }
}
