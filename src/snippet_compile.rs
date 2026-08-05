//! Compile AU/viseme/named-morph snippet curves into concrete ClipIR tracks.
//!
//! Host animation systems (Three AnimationMixer, Unity Animator, etc.) own
//! playback and lerping. This module only expands semantic curves into
//! morphTarget / boneTransform tracks — never semantic `au` / `viseme` kinds.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::json;

use crate::bones::{
    composite_axis_value, multiply_quat, quat_from_channel, select_axis_binding, side_scale,
    CompositeAxis, JawBinding, RestTransform, TranslationRow, SIDE_LEFT as BONE_SIDE_LEFT,
    SIDE_RIGHT as BONE_SIDE_RIGHT,
};
use crate::clip::ClipTrackIR;
use crate::math::clamp01;

/// Morph AU binding sides used by RuntimeCore packed tables.
pub const AU_SIDE_LEFT: u8 = 0;
pub const AU_SIDE_RIGHT: u8 = 1;
pub const AU_SIDE_CENTER: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub struct AuMorphBinding {
    pub au_id: u32,
    pub side: u8,
    pub mesh_id: u32,
    pub morph_target_id: u32,
    pub weight: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct VisemeMorphBinding {
    pub viseme_index: u32,
    pub mesh_id: u32,
    pub morph_target_id: u32,
    pub weight: f32,
}

#[derive(Clone, Debug)]
pub struct CurvePoint {
    pub time: f64,
    pub intensity: f64,
}

#[derive(Clone, Debug)]
pub struct SnippetCompileOptions {
    pub intensity_scale: f64,
    pub balance: f32,
    pub balance_map: HashMap<String, f32>,
    pub snippet_category: Option<String>,
    pub auto_viseme_jaw: bool,
    pub jaw_scale: f32,
}

impl Default for SnippetCompileOptions {
    fn default() -> Self {
        Self {
            intensity_scale: 1.0,
            balance: 0.0,
            balance_map: HashMap::new(),
            snippet_category: None,
            auto_viseme_jaw: true,
            jaw_scale: 1.0,
        }
    }
}

pub struct SnippetCompileInput<'a> {
    pub curves: &'a BTreeMap<String, Vec<CurvePoint>>,
    pub au_bindings: &'a [AuMorphBinding],
    pub viseme_bindings: &'a [VisemeMorphBinding],
    pub viseme_slot_count: usize,
    pub mix_weights: &'a HashMap<u32, f32>,
    pub mixed_aus: &'a HashSet<u32>,
    pub composite_axes: &'a [CompositeAxis],
    pub translation_rows: &'a [TranslationRow],
    pub jaw_binding: Option<&'a JawBinding>,
    pub viseme_jaw_amounts: &'a [f32],
    pub bone_rest_transforms: &'a HashMap<u32, RestTransform>,
    /// Resolved named-morph curve targets: curve_id → (mesh_id, morph_target_id)*
    pub named_morph_targets: &'a HashMap<String, Vec<(u32, u32)>>,
    pub options: &'a SnippetCompileOptions,
}

fn sample_at(points: &[CurvePoint], t: f64) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    if t <= points[0].time {
        return points[0].intensity;
    }
    let last = points.last().unwrap();
    if t >= last.time {
        return last.intensity;
    }
    for window in points.windows(2) {
        let a = &window[0];
        let b = &window[1];
        if t >= a.time && t <= b.time {
            let dt = (b.time - a.time).max(1e-6);
            let p = (t - a.time) / dt;
            return a.intensity + (b.intensity - a.intensity) * p;
        }
    }
    0.0
}

fn clamp_intensity(value: f64) -> f64 {
    value.clamp(0.0, 2.0)
}

fn curve_balance(curve_id: &str, options: &SnippetCompileOptions) -> f32 {
    options
        .balance_map
        .get(curve_id)
        .copied()
        .unwrap_or(options.balance)
}

fn keyframe_times(curves: &BTreeMap<String, Vec<CurvePoint>>) -> Vec<f64> {
    let mut times = curves
        .values()
        .flat_map(|points| points.iter().map(|point| point.time))
        .collect::<Vec<_>>();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    times
}

fn is_numeric_id(id: &str) -> Option<u32> {
    if id.chars().all(|c| c.is_ascii_digit()) {
        id.parse().ok()
    } else {
        None
    }
}

fn scalar_track(
    id: u32,
    target: serde_json::Value,
    times: Vec<f64>,
    values: Vec<f64>,
) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target,
        value_type: "scalar".to_string(),
        times,
        values,
        interpolation: Some("linear".to_string()),
        inherit_start: false,
        source_name: None,
    }
}

fn quat_track(id: u32, bone_id: u32, times: Vec<f64>, values: Vec<f64>) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target: json!({
            "kind": "boneTransform",
            "boneId": bone_id,
            "property": "rotation",
        }),
        value_type: "quat".to_string(),
        times,
        values,
        interpolation: Some("linear".to_string()),
        inherit_start: false,
        source_name: None,
    }
}

fn position_track(id: u32, bone_id: u32, times: Vec<f64>, values: Vec<f64>) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target: json!({
            "kind": "boneTransform",
            "boneId": bone_id,
            "property": "position",
        }),
        value_type: "vec3".to_string(),
        times,
        values,
        interpolation: Some("linear".to_string()),
        inherit_start: false,
        source_name: None,
    }
}

fn morph_target_json(mesh_id: u32, morph_target_id: u32) -> serde_json::Value {
    json!({
        "kind": "morphTarget",
        "meshId": mesh_id,
        "morphTargetId": morph_target_id,
    })
}

fn au_side_scale(balance: f32, side: u8) -> f32 {
    let balance = balance.clamp(-1.0, 1.0);
    match side {
        AU_SIDE_LEFT => {
            if balance > 0.0 {
                1.0 - balance
            } else {
                1.0
            }
        }
        AU_SIDE_RIGHT => {
            if balance < 0.0 {
                1.0 + balance
            } else {
                1.0
            }
        }
        _ => 1.0,
    }
}

fn push_scaled_curve_track(
    tracks: &mut Vec<ClipTrackIR>,
    next_id: &mut u32,
    mesh_id: u32,
    morph_target_id: u32,
    points: &[CurvePoint],
    effective_scale: f64,
) {
    if effective_scale.abs() <= 1e-9 {
        return;
    }
    let times = points.iter().map(|point| point.time).collect::<Vec<_>>();
    let values = points
        .iter()
        .map(|point| clamp_intensity(point.intensity * effective_scale))
        .collect::<Vec<_>>();
    tracks.push(scalar_track(
        *next_id,
        morph_target_json(mesh_id, morph_target_id),
        times,
        values,
    ));
    *next_id += 1;
}

/// Expand snippet curves into concrete morph/bone ClipIR tracks.
pub fn compile_snippet_tracks(input: SnippetCompileInput<'_>) -> Vec<ClipTrackIR> {
    let options = input.options;
    let scale = options.intensity_scale;
    let times = keyframe_times(input.curves);
    let mut tracks = Vec::new();
    let mut next_id = 1u32;
    let is_viseme_snippet = options.snippet_category.as_deref() == Some("visemeSnippet");

    let sample_curve = |curve_id: &str, t: f64| -> f64 {
        let Some(points) = input.curves.get(curve_id) else {
            return 0.0;
        };
        clamp_intensity(sample_at(points, t) * scale)
    };

    for (curve_id, points) in input.curves {
        if points.is_empty() {
            continue;
        }

        if let Some(id) = is_numeric_id(curve_id) {
            if is_viseme_snippet && (id as usize) < input.viseme_slot_count {
                for binding in input
                    .viseme_bindings
                    .iter()
                    .filter(|binding| binding.viseme_index == id)
                {
                    push_scaled_curve_track(
                        &mut tracks,
                        &mut next_id,
                        binding.mesh_id,
                        binding.morph_target_id,
                        points,
                        scale * f64::from(binding.weight),
                    );
                }
                continue;
            }

            let mix_weight = if input.mixed_aus.contains(&id) {
                *input.mix_weights.get(&id).unwrap_or(&1.0)
            } else {
                1.0
            };
            let balance = curve_balance(curve_id, options);
            for binding in input
                .au_bindings
                .iter()
                .filter(|binding| binding.au_id == id)
            {
                let side_factor = au_side_scale(balance, binding.side);
                let effective = scale
                    * f64::from(clamp01(mix_weight))
                    * f64::from(binding.weight)
                    * f64::from(side_factor);
                push_scaled_curve_track(
                    &mut tracks,
                    &mut next_id,
                    binding.mesh_id,
                    binding.morph_target_id,
                    points,
                    effective,
                );
            }
            continue;
        }

        if let Some(targets) = input.named_morph_targets.get(curve_id) {
            for &(mesh_id, morph_target_id) in targets {
                push_scaled_curve_track(
                    &mut tracks,
                    &mut next_id,
                    mesh_id,
                    morph_target_id,
                    points,
                    scale,
                );
            }
        }
    }

    let auto_viseme_jaw = options.auto_viseme_jaw
        && options.jaw_scale > 0.0
        && is_viseme_snippet
        && !times.is_empty()
        && input.jaw_binding.is_some()
        && !input.viseme_jaw_amounts.is_empty();

    if auto_viseme_jaw {
        if let Some(jaw) = input.jaw_binding {
            let rest = input
                .bone_rest_transforms
                .get(&jaw.bone_id)
                .map(|rest| rest.rotation)
                .unwrap_or([0.0, 0.0, 0.0, 1.0]);
            let mut values = Vec::with_capacity(times.len() * 4);
            for &t in &times {
                let mut jaw_amount = 0.0f32;
                for viseme_idx in 0..input.viseme_slot_count {
                    let intensity = sample_curve(&viseme_idx.to_string(), t) as f32;
                    if intensity <= 1e-6 {
                        continue;
                    }
                    let amount = *input.viseme_jaw_amounts.get(viseme_idx).unwrap_or(&0.0);
                    jaw_amount = jaw_amount.max(amount * intensity * options.jaw_scale);
                }
                let rotation = if jaw_amount > 1e-6 {
                    multiply_quat(
                        rest,
                        quat_from_channel(
                            jaw.channel,
                            jaw.max_degrees.to_radians() * jaw_amount * jaw.scale,
                        ),
                    )
                } else {
                    rest
                };
                values.extend(rotation.map(f64::from));
            }
            tracks.push(quat_track(next_id, jaw.bone_id, times.clone(), values));
            next_id += 1;
        }
    }

    if times.is_empty() {
        return tracks;
    }

    let has_curve_au = input
        .curves
        .keys()
        .filter_map(|id| is_numeric_id(id))
        .filter(|id| !(is_viseme_snippet && (*id as usize) < input.viseme_slot_count))
        .collect::<HashSet<_>>();

    let bone_side_scale = |balance: f32, side: u8| -> f32 {
        match side {
            BONE_SIDE_LEFT | BONE_SIDE_RIGHT => side_scale(balance, side),
            _ => 1.0,
        }
    };

    // Group composite axes by bone_id (packed tables are contiguous per bone).
    let mut composite_index = 0;
    while composite_index < input.composite_axes.len() {
        let bone_id = input.composite_axes[composite_index].bone_id;
        let start = composite_index;
        while composite_index < input.composite_axes.len()
            && input.composite_axes[composite_index].bone_id == bone_id
        {
            composite_index += 1;
        }
        let axes = &input.composite_axes[start..composite_index];

        if auto_viseme_jaw && input.jaw_binding.is_some_and(|jaw| jaw.bone_id == bone_id) {
            continue;
        }

        let has_relevant = axes.iter().any(|axis| {
            axis.value_rows
                .iter()
                .any(|row| has_curve_au.contains(&row.au_id))
        });
        if !has_relevant {
            continue;
        }

        let rest = input
            .bone_rest_transforms
            .get(&bone_id)
            .map(|rest| rest.rotation)
            .unwrap_or([0.0, 0.0, 0.0, 1.0]);
        let mut values = Vec::with_capacity(times.len() * 4);

        for &t in &times {
            let effective_value = |au_id: u32, side: u8| -> f32 {
                let raw = sample_curve(&au_id.to_string(), t) as f32;
                if raw <= 1e-6 {
                    return 0.0;
                }
                let balance = curve_balance(&au_id.to_string(), options);
                clamp01(raw) * bone_side_scale(balance, side)
            };

            let mut rotation = rest;
            for axis in axes {
                let direction = composite_axis_value(axis, effective_value);
                if direction.abs() <= 1e-6 {
                    continue;
                }
                if let Some(binding) = select_axis_binding(axis, direction, effective_value) {
                    if binding.max_degrees.abs() > 0.0 {
                        rotation = multiply_quat(
                            rotation,
                            quat_from_channel(
                                binding.channel,
                                binding.max_degrees.to_radians() * direction.abs() * binding.scale,
                            ),
                        );
                    }
                }
            }
            values.extend(rotation.map(f64::from));
        }

        tracks.push(quat_track(next_id, bone_id, times.clone(), values));
        next_id += 1;
    }

    let mut translation_bones = HashSet::new();
    for row in input.translation_rows {
        if has_curve_au.contains(&row.au_id) {
            translation_bones.insert(row.bone_id);
        }
    }
    for bone_id in translation_bones {
        let rest = input
            .bone_rest_transforms
            .get(&bone_id)
            .map(|rest| rest.position)
            .unwrap_or([0.0, 0.0, 0.0]);
        let rows = input
            .translation_rows
            .iter()
            .filter(|row| row.bone_id == bone_id && has_curve_au.contains(&row.au_id))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            continue;
        }
        let mut values = Vec::with_capacity(times.len() * 3);
        for &t in &times {
            let mut position = rest;
            for row in &rows {
                let v = sample_curve(&row.au_id.to_string(), t) as f32;
                if v <= 1e-6 {
                    continue;
                }
                let axis = row.axis.min(2) as usize;
                position[axis] += clamp01(v) * row.scale.clamp(-1.0, 1.0) * row.max_units;
            }
            values.extend(position.map(f64::from));
        }
        tracks.push(position_track(next_id, bone_id, times.clone(), values));
        next_id += 1;
    }

    tracks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_au_curve_to_morph_target_tracks() {
        let curves = BTreeMap::from([(
            "12".to_string(),
            vec![
                CurvePoint {
                    time: 0.0,
                    intensity: 0.0,
                },
                CurvePoint {
                    time: 0.5,
                    intensity: 1.0,
                },
            ],
        )]);
        let au_bindings = [AuMorphBinding {
            au_id: 12,
            side: AU_SIDE_CENTER,
            mesh_id: 1,
            morph_target_id: 7,
            weight: 1.0,
        }];
        let options = SnippetCompileOptions {
            intensity_scale: 1.0,
            ..Default::default()
        };
        let named = HashMap::new();
        let mix = HashMap::new();
        let mixed = HashSet::new();
        let rests = HashMap::new();
        let tracks = compile_snippet_tracks(SnippetCompileInput {
            curves: &curves,
            au_bindings: &au_bindings,
            viseme_bindings: &[],
            viseme_slot_count: 0,
            mix_weights: &mix,
            mixed_aus: &mixed,
            composite_axes: &[],
            translation_rows: &[],
            jaw_binding: None,
            viseme_jaw_amounts: &[],
            bone_rest_transforms: &rests,
            named_morph_targets: &named,
            options: &options,
        });
        assert_eq!(tracks.len(), 1);
        assert_eq!(
            tracks[0].target.get("kind").and_then(|v| v.as_str()),
            Some("morphTarget")
        );
        assert_eq!(
            tracks[0]
                .target
                .get("morphTargetId")
                .and_then(|v| v.as_u64()),
            Some(7)
        );
        assert!(tracks[0]
            .target
            .get("kind")
            .and_then(|v| v.as_str())
            .is_some_and(|kind| kind != "au"));
    }

    #[test]
    fn applies_balance_to_left_right_morphs() {
        let curves = BTreeMap::from([(
            "1".to_string(),
            vec![CurvePoint {
                time: 0.0,
                intensity: 1.0,
            }],
        )]);
        let au_bindings = [
            AuMorphBinding {
                au_id: 1,
                side: AU_SIDE_LEFT,
                mesh_id: 1,
                morph_target_id: 10,
                weight: 1.0,
            },
            AuMorphBinding {
                au_id: 1,
                side: AU_SIDE_RIGHT,
                mesh_id: 1,
                morph_target_id: 11,
                weight: 1.0,
            },
        ];
        let options = SnippetCompileOptions {
            balance: 0.5,
            ..Default::default()
        };
        let named = HashMap::new();
        let mix = HashMap::new();
        let mixed = HashSet::new();
        let rests = HashMap::new();
        let tracks = compile_snippet_tracks(SnippetCompileInput {
            curves: &curves,
            au_bindings: &au_bindings,
            viseme_bindings: &[],
            viseme_slot_count: 0,
            mix_weights: &mix,
            mixed_aus: &mixed,
            composite_axes: &[],
            translation_rows: &[],
            jaw_binding: None,
            viseme_jaw_amounts: &[],
            bone_rest_transforms: &rests,
            named_morph_targets: &named,
            options: &options,
        });
        assert_eq!(tracks.len(), 2);
        let left = tracks
            .iter()
            .find(|track| track.target.get("morphTargetId").and_then(|v| v.as_u64()) == Some(10))
            .unwrap();
        let right = tracks
            .iter()
            .find(|track| track.target.get("morphTargetId").and_then(|v| v.as_u64()) == Some(11))
            .unwrap();
        assert!((left.values[0] - 0.5).abs() < 1e-6);
        assert!((right.values[0] - 1.0).abs() < 1e-6);
    }
}
