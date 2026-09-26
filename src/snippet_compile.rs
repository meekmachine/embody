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
    pub inherit: bool,
}

#[derive(Clone, Debug)]
pub enum CurveTarget {
    Au { id: u32, balance: f32 },
    Viseme(u32),
    Morph(String),
}

#[derive(Clone, Debug)]
pub struct SnippetCurve {
    pub target: CurveTarget,
    pub points: Vec<CurvePoint>,
}

#[derive(Clone, Debug)]
pub struct SnippetCompileOptions {
    pub intensity_scale: f64,
    pub merge_duplicate_channels: bool,
    pub auto_viseme_jaw: bool,
    pub jaw_scale: f32,
}

impl Default for SnippetCompileOptions {
    fn default() -> Self {
        Self {
            intensity_scale: 1.0,
            merge_duplicate_channels: false,
            auto_viseme_jaw: true,
            jaw_scale: 1.0,
        }
    }
}

pub struct SnippetCompileInput<'a> {
    pub curves: &'a [SnippetCurve],
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

fn keyframe_times(curves: &[SnippetCurve]) -> Vec<f64> {
    let mut times = curves
        .iter()
        .flat_map(|curve| curve.points.iter().map(|point| point.time))
        .collect::<Vec<_>>();
    times.sort_by(f64::total_cmp);
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    times
}

fn scalar_track(
    id: u32,
    target: serde_json::Value,
    times: Vec<f64>,
    values: Vec<f64>,
    inherit_start: bool,
) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target,
        value_type: "scalar".to_string(),
        times,
        values,
        interpolation: Some("linear".to_string()),
        inherit_start,
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

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum MorphSource {
    Au(u32),
    Viseme(u32),
    Named(String),
}

struct MorphTrackContribution {
    channel_index: usize,
    source: MorphSource,
    track: ClipTrackIR,
    side_enabled: bool,
}

fn push_scaled_curve_track(
    tracks: &mut Vec<MorphTrackContribution>,
    next_id: &mut u32,
    mesh_id: u32,
    morph_target_id: u32,
    points: &[CurvePoint],
    effective_scale: f64,
    side_enabled: bool,
    source: MorphSource,
    channel_index: usize,
    retain_zero_owner: bool,
) {
    let inherit_start = points.first().is_some_and(|point| point.inherit);
    // Even a zero-scaled curve can release a nonzero inherited live pose.
    if effective_scale.abs() <= 1e-9 && !inherit_start && !(retain_zero_owner && side_enabled) {
        return;
    }
    let times = points.iter().map(|point| point.time).collect::<Vec<_>>();
    let values = points
        .iter()
        .map(|point| clamp_intensity(point.intensity * effective_scale))
        .collect::<Vec<_>>();
    tracks.push(MorphTrackContribution {
        channel_index,
        source,
        track: scalar_track(
            *next_id,
            morph_target_json(mesh_id, morph_target_id),
            times,
            values,
            inherit_start,
        ),
        side_enabled,
    });
    *next_id += 1;
}

fn merge_morph_tracks(tracks: Vec<MorphTrackContribution>) -> Result<Vec<ClipTrackIR>, String> {
    let mut by_target: BTreeMap<(MorphSource, u64, u64), Vec<MorphTrackContribution>> =
        BTreeMap::new();
    for contribution in tracks {
        let key = (
            contribution.source.clone(),
            contribution.track.target["meshId"].as_u64().unwrap(),
            contribution.track.target["morphTargetId"].as_u64().unwrap(),
        );
        by_target.entry(key).or_default().push(contribution);
    }
    let mut merged = Vec::new();
    for ((source, mesh_id, morph_id), group) in by_target {
        // Repeated profile bindings from one authored channel keep their
        // existing separate tracks. Only duplicate input channels are combined.
        if group
            .iter()
            .all(|entry| entry.channel_index == group[0].channel_index)
        {
            merged.extend(group.into_iter().map(|entry| entry.track));
            continue;
        }
        // A disabled side may release an inherited live pose when it is the
        // only source. It must not claim another channel's anchor or key times.
        let has_enabled_side = group.iter().any(|entry| entry.side_enabled);
        let group = group
            .into_iter()
            .filter(|entry| !has_enabled_side || entry.side_enabled)
            .collect::<Vec<_>>();
        if group
            .iter()
            .all(|entry| entry.channel_index == group[0].channel_index)
        {
            merged.extend(group.into_iter().map(|entry| entry.track));
            continue;
        }
        let mut group = group
            .into_iter()
            .map(|entry| entry.track)
            .collect::<Vec<_>>();
        let mut result = group.remove(0);
        if result.inherit_start || group.iter().any(|track| track.inherit_start) {
            return Err(format!("Overlapping inherited channels for {source:?} on mesh {mesh_id}, morph {morph_id} cannot share a start anchor; author one curve per side or explicit starting values."));
        }
        group.insert(0, result.clone());
        let curves = group
            .iter()
            .map(|track| {
                track
                    .times
                    .iter()
                    .zip(&track.values)
                    .map(|(&time, &intensity)| CurvePoint {
                        time,
                        intensity,
                        inherit: false,
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let mut times = group
            .iter()
            .flat_map(|track| track.times.iter().copied())
            .collect::<Vec<_>>();
        times.sort_by(f64::total_cmp);
        times.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        // Preserve the exact piecewise-linear maximum, including intersections
        // between authored keys. This is compile-time work, never frame work.
        let mut crossings = Vec::new();
        for interval in times.windows(2) {
            for (i, a) in curves.iter().enumerate() {
                for b in &curves[i + 1..] {
                    let start = sample_at(a, interval[0]) - sample_at(b, interval[0]);
                    let end = sample_at(a, interval[1]) - sample_at(b, interval[1]);
                    if start * end < 0.0 {
                        crossings.push(
                            interval[0] + (interval[1] - interval[0]) * start / (start - end),
                        );
                    }
                }
            }
        }
        times.extend(crossings);
        times.sort_by(f64::total_cmp);
        times.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        result.values = times
            .iter()
            .map(|&t| {
                curves
                    .iter()
                    .map(|points| sample_at(points, t))
                    .fold(0.0_f64, f64::max)
            })
            .collect();
        result.times = times;
        merged.push(result);
    }
    for (index, track) in merged.iter_mut().enumerate() {
        track.id = index as u32 + 1;
    }
    Ok(merged)
}

/// Expand snippet curves into concrete morph/bone ClipIR tracks.
pub fn compile_snippet_tracks(input: SnippetCompileInput<'_>) -> Result<Vec<ClipTrackIR>, String> {
    let options = input.options;
    let scale = options.intensity_scale;
    let times = keyframe_times(input.curves);
    let mut tracks = Vec::new();
    let mut next_id = 1u32;
    // Keep every typed channel: an AU can have independent left/right curves,
    // and a viseme index can equal an AU id without sharing its namespace.
    let mut au_curves: HashMap<u32, Vec<(&[CurvePoint], f32)>> = HashMap::new();
    let mut viseme_curves: HashMap<u32, Vec<&[CurvePoint]>> = HashMap::new();
    let source_for = |target: &CurveTarget| match target {
        CurveTarget::Au { id, .. } => MorphSource::Au(*id),
        CurveTarget::Viseme(id) => MorphSource::Viseme(*id),
        CurveTarget::Morph(name) => MorphSource::Named(name.clone()),
    };
    let mut channel_counts = BTreeMap::new();
    if options.merge_duplicate_channels {
        for curve in input.curves.iter().filter(|curve| !curve.points.is_empty()) {
            *channel_counts.entry(source_for(&curve.target)).or_insert(0) += 1;
        }
    }
    for (channel_index, curve) in input.curves.iter().enumerate() {
        let points = &curve.points;
        if points.is_empty() {
            continue;
        }
        let source = source_for(&curve.target);
        let retain_zero_owner = channel_counts.get(&source).is_some_and(|count| *count > 1);
        match &curve.target {
            CurveTarget::Viseme(id) => {
                viseme_curves.entry(*id).or_default().push(points);
                for binding in input
                    .viseme_bindings
                    .iter()
                    .filter(|binding| binding.viseme_index == *id)
                {
                    push_scaled_curve_track(
                        &mut tracks,
                        &mut next_id,
                        binding.mesh_id,
                        binding.morph_target_id,
                        points,
                        scale * f64::from(binding.weight),
                        true,
                        source.clone(),
                        channel_index,
                        retain_zero_owner,
                    );
                }
            }
            CurveTarget::Au { id, balance } => {
                au_curves.entry(*id).or_default().push((points, *balance));
                let mix_weight = if input.mixed_aus.contains(id) {
                    *input.mix_weights.get(id).unwrap_or(&1.0)
                } else {
                    1.0
                };
                for binding in input
                    .au_bindings
                    .iter()
                    .filter(|binding| binding.au_id == *id)
                {
                    let effective = scale
                        * f64::from(clamp01(mix_weight))
                        * f64::from(binding.weight)
                        * f64::from(au_side_scale(*balance, binding.side));
                    push_scaled_curve_track(
                        &mut tracks,
                        &mut next_id,
                        binding.mesh_id,
                        binding.morph_target_id,
                        points,
                        effective,
                        au_side_scale(*balance, binding.side) > 0.0,
                        source.clone(),
                        channel_index,
                        retain_zero_owner,
                    );
                }
            }
            CurveTarget::Morph(name) => {
                if let Some(targets) = input.named_morph_targets.get(name) {
                    for &(mesh_id, morph_target_id) in targets {
                        push_scaled_curve_track(
                            &mut tracks,
                            &mut next_id,
                            mesh_id,
                            morph_target_id,
                            points,
                            scale,
                            true,
                            source.clone(),
                            channel_index,
                            retain_zero_owner,
                        );
                    }
                }
            }
        }
    }
    // Only duplicate typed channels share this envelope. Preserve legacy
    // tracks and distinct semantic controls' existing host blending behavior.
    let mut tracks = if options.merge_duplicate_channels {
        merge_morph_tracks(tracks)?
    } else {
        tracks.into_iter().map(|source| source.track).collect()
    };
    let mut next_id = tracks.len() as u32 + 1;

    let auto_viseme_jaw = options.auto_viseme_jaw
        && options.jaw_scale > 0.0
        && !viseme_curves.is_empty()
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
                    let intensity = viseme_curves
                        .get(&(viseme_idx as u32))
                        .into_iter()
                        .flatten()
                        .map(|points| clamp_intensity(sample_at(points, t) * scale) as f32)
                        .fold(0.0_f32, f32::max);
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
        return Ok(tracks);
    }

    let sample_au = |au_id: u32, side: u8, t: f64| -> f32 {
        au_curves
            .get(&au_id)
            .into_iter()
            .flatten()
            .map(|(points, balance)| {
                let raw = clamp01(clamp_intensity(sample_at(points, t) * scale) as f32);
                let side_factor = match side {
                    BONE_SIDE_LEFT | BONE_SIDE_RIGHT => side_scale(*balance, side),
                    _ => 1.0,
                };
                raw * side_factor
            })
            .fold(0.0_f32, f32::max)
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
                .any(|row| au_curves.contains_key(&row.au_id))
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
            let effective_value = |au_id: u32, side: u8| sample_au(au_id, side, t);

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
        if au_curves.contains_key(&row.au_id) {
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
            .filter(|row| row.bone_id == bone_id && au_curves.contains_key(&row.au_id))
            .collect::<Vec<_>>();
        if rows.is_empty() {
            continue;
        }
        let mut values = Vec::with_capacity(times.len() * 3);
        for &t in &times {
            let mut position = rest;
            for row in &rows {
                let v = sample_au(row.au_id, crate::bones::SIDE_NONE, t);
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

    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_enabled_inherited_sources_are_rejected() {
        let target = morph_target_json(1, 2);
        let sources = [false, true]
            .into_iter()
            .enumerate()
            .map(|(channel_index, inherit)| MorphTrackContribution {
                channel_index,
                source: MorphSource::Au(43),
                side_enabled: true,
                track: scalar_track(1, target.clone(), vec![0.0, 1.0], vec![0.0, 1.0], inherit),
            });
        let error = merge_morph_tracks(sources.collect()).unwrap_err();
        assert!(error.contains("Overlapping inherited channels for Au(43)"));
        assert!(error.contains("mesh 1, morph 2"));
    }

    #[test]
    fn overlapping_morph_curves_keep_their_interior_maximum() {
        let target = morph_target_json(1, 2);
        let rising = scalar_track(1, target.clone(), vec![0.0, 1.0], vec![0.0, 1.0], false);
        let falling = scalar_track(2, target, vec![0.0, 1.0], vec![1.0, 0.0], false);
        for source in [vec![rising.clone(), falling.clone()], vec![falling, rising]] {
            let tracks = merge_morph_tracks(
                source
                    .into_iter()
                    .enumerate()
                    .map(|(channel_index, track)| MorphTrackContribution {
                        channel_index,
                        source: MorphSource::Au(43),
                        track,
                        side_enabled: true,
                    })
                    .collect(),
            )
            .unwrap();
            assert_eq!(tracks.len(), 1);
            assert_eq!(tracks[0].times, vec![0.0, 0.5, 1.0]);
            assert_eq!(tracks[0].values, vec![1.0, 0.5, 1.0]);
            assert!(!tracks[0].inherit_start);
        }
    }

    #[test]
    fn expands_au_curve_to_morph_target_tracks() {
        let curves = vec![SnippetCurve {
            target: CurveTarget::Au {
                id: 12,
                balance: 0.0,
            },
            points: vec![
                CurvePoint {
                    time: 0.0,
                    intensity: 0.0,
                    inherit: true,
                },
                CurvePoint {
                    time: 0.5,
                    intensity: 1.0,
                    inherit: false,
                },
            ],
        }];
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
        })
        .unwrap();
        assert_eq!(tracks.len(), 1);
        assert!(tracks[0].inherit_start);
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
        let curves = vec![SnippetCurve {
            target: CurveTarget::Au {
                id: 1,
                balance: 0.5,
            },
            points: vec![CurvePoint {
                time: 0.0,
                intensity: 1.0,
                inherit: false,
            }],
        }];
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
        let options = SnippetCompileOptions::default();
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
        })
        .unwrap();
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
