//! Read-only saved-source calibration. Native playback remains the only pose executor.
use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use crate::bones::{composite_axis_value, select_axis_binding, side_scale, AxisBindingRow, AxisValueRow, CompositeAxis, GROUP_NEGATIVE, GROUP_PLAIN, GROUP_POSITIVE};
use crate::profile::{compile_tables, ModelData, NameResolver, ProfileData};

const AXES: [&str; 5] = ["headYaw", "headPitch", "headRoll", "eyeYaw", "eyePitch"];
pub(crate) fn role_bones(profile: &ProfileData, model: &ModelData) -> BTreeMap<String, u32> {
    let resolver = NameResolver::new(profile, model);
    ["head", "leftEye", "rightEye"].into_iter().filter_map(|role| {
        let mapping = profile.humanoid_characterization.as_ref()?.roles.get(role)?;
        let bone = resolver.resolve_bone(model, profile, &mapping.node_key)?;
        Some((role.to_string(), bone.id))
    }).collect()
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point { time: f64, intensity: f64, #[serde(default)] inherit: bool }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snippet {
    duration: f64,
    curves: BTreeMap<String, Vec<Point>>,
    #[serde(default)] snippet_balance: Option<f64>,
    #[serde(default)] balance_map: Option<BTreeMap<String, f64>>,
    #[serde(default)] snippet_balance_map: Option<BTreeMap<String, f64>>,
    #[serde(default)] easing: Option<String>,
    #[serde(default)] snippet_easing: Option<String>,
    #[serde(default)] channels: serde_json::Value,
    #[serde(default)] semantic_animation: serde_json::Value,
    #[serde(default)] snippet_category: Option<String>,
}
impl Snippet {
    fn balance_for(&self, key: &str) -> f64 {
        self.balance_map.as_ref().or(self.snippet_balance_map.as_ref())
            .and_then(|map| map.get(key)).copied().unwrap_or(self.snippet_balance.unwrap_or(0.0))
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding { snippet: Snippet, negative_time_sec: f64, neutral_time_sec: f64, positive_time_sec: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceFrame { bone_id: u32, rotation: [f64; 4] }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValueRow { au_id: u32, group: u8, side: u8 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingRow { au_id: u32, group: u8, side: u8, channel: u8, scale: f32, max_degrees: f32, semantic_sign: f64 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Actuator { directional: bool, values: Vec<ValueRow>, bindings: Vec<BindingRow> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Evaluator { version: u8, binding: Binding, actuators: Vec<Actuator> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample { value: f64, angle_degrees: f64 }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Calibration {
    available: bool,
    samples: Vec<Sample>,
    #[serde(skip_serializing_if = "Option::is_none")] reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] evaluator: Option<Evaluator>,
}
type Calibrations = BTreeMap<String, Calibration>;
fn unavailable(reason: impl Into<String>) -> Calibration { Calibration { available: false, samples: vec![], reason: Some(reason.into()), evaluator: None } }
fn sample(points: &[Point], time: f64) -> f64 {
    if time <= points[0].time { return points[0].intensity; }
    for pair in points.windows(2) {
        if time <= pair[1].time {
            let fraction = (time - pair[0].time) / (pair[1].time - pair[0].time);
            return pair[0].intensity + fraction * (pair[1].intensity - pair[0].intensity);
        }
    }
    points.last().unwrap().intensity
}
fn source_time(binding: &Binding, value: f64) -> f64 {
    binding.neutral_time_sec + value.clamp(-1.0, 1.0) * if value < 0.0 {
        binding.neutral_time_sec - binding.negative_time_sec
    } else { binding.positive_time_sec - binding.neutral_time_sec }
}
fn source_value(binding: &Binding, time: f64) -> f64 {
    (time - binding.neutral_time_sec) / if time < binding.neutral_time_sec {
        binding.neutral_time_sec - binding.negative_time_sec
    } else { binding.positive_time_sec - binding.neutral_time_sec }
}
fn evaluate(evaluator: &Evaluator, value: f64, scale: f64) -> Option<f64> {
    if evaluator.version != 1 || evaluator.actuators.is_empty() { return None; }
    let snippet = &evaluator.binding.snippet;
    let time = source_time(&evaluator.binding, value);
    let effective = |id: u32, side: u8| {
        let key = id.to_string();
        let raw = snippet.curves.get(&key).map_or(0.0, |points| (sample(points, time) * scale).clamp(0.0, 2.0)) as f32;
        raw * side_scale(snippet.balance_for(&key) as f32, side)
    };
    let mut common: Option<f64> = None;
    for actuator in &evaluator.actuators {
        let axis = CompositeAxis { bone_id: 0, has_directional_groups: actuator.directional,
            value_rows: actuator.values.iter().map(|row| AxisValueRow { au_id: row.au_id, group: row.group, side: row.side }).collect(),
            binding_rows: actuator.bindings.iter().map(|row| AxisBindingRow { au_id: row.au_id, group: row.group, side: row.side, channel: row.channel, scale: row.scale, max_degrees: row.max_degrees }).collect() };
        let direction = composite_axis_value(&axis, effective);
        let angle = if direction.abs() <= 1e-6 { 0.0 } else {
            let selected = select_axis_binding(&axis, direction, effective)?;
            let index = axis.binding_rows.iter().position(|row| std::ptr::eq(row, selected))?;
            selected.max_degrees as f64 * selected.scale as f64 * direction.abs() as f64 * actuator.bindings[index].semantic_sign
        };
        if !angle.is_finite() { return None; }
        if let Some(previous) = common {
            if (angle - previous).abs() > 1e-4 { return None; }
        } else { common = Some(angle); }
    }
    common
}
fn validate(binding: &Binding) -> Result<(), String> {
    if !binding.snippet.duration.is_finite() || !binding.negative_time_sec.is_finite() || !binding.neutral_time_sec.is_finite() || !binding.positive_time_sec.is_finite()
        || !(0.0 <= binding.negative_time_sec && binding.negative_time_sec < binding.neutral_time_sec && binding.neutral_time_sec < binding.positive_time_sec && binding.positive_time_sec <= binding.snippet.duration)
        || binding.snippet.curves.is_empty() { return Err("Invalid source landmarks or empty AU curves".into()); }
    if binding.snippet.snippet_balance.is_some_and(|value| !value.is_finite())
        || [binding.snippet.balance_map.as_ref(), binding.snippet.snippet_balance_map.as_ref()].into_iter().flatten().flat_map(|map| map.values()).any(|value| !value.is_finite()) { return Err("Invalid source balance".into()); }
    if binding.snippet.easing.as_deref().or(binding.snippet.snippet_easing.as_deref()).is_some_and(|value| value != "linear") { return Err("Only linear saved-source interpolation is calibrated".into()); }
    if !binding.snippet.channels.is_null() && binding.snippet.channels.as_array().is_none_or(|channels| !channels.is_empty())
        || !binding.snippet.semantic_animation.is_null() || binding.snippet.snippet_category.as_deref() == Some("visemeSnippet") {
        return Err("Only numeric AU-only saved sources are calibrated".into());
    }
    for (id, points) in &binding.snippet.curves {
        if id.parse::<u32>().is_err() || points.is_empty() || points.iter().any(|point| !point.time.is_finite() || !point.intensity.is_finite() || point.inherit || point.intensity < 0.0 || point.time < 0.0 || point.time > binding.snippet.duration)
            || points.windows(2).any(|pair| pair[0].time >= pair[1].time) { return Err("Calibration requires finite ordered numeric AU source curves".into()); }
        if sample(points, binding.neutral_time_sec).abs() > 1e-8 { return Err("Saved neutral source must be zero".into()); }
    }
    Ok(())
}
fn calibrate_axis(profile: &ProfileData, model: &ModelData, frames: &[ReferenceFrame], name: &str, binding: Binding) -> Result<Calibration, String> {
    validate(&binding)?;
    let resolver = NameResolver::new(profile, model);
    let roles: &[&str] = if name.starts_with("head") { &["head"] } else { &["leftEye", "rightEye"] };
    let bones: BTreeSet<u32> = roles.iter().filter_map(|role| profile.humanoid_characterization.as_ref()?.roles.get(*role))
        .filter_map(|role| resolver.resolve_bone(model, profile, &role.node_key).map(|bone| bone.id)).collect();
    if bones.is_empty() { return Err("Mapped head/eye roles are unavailable".into()); }
    let semantic_axis = if name.ends_with("Yaw") { 1 } else if name.ends_with("Pitch") { 0 } else { 2 };
    let tables = compile_tables(profile, model);
    if tables.translations.chunks_exact(5).any(|row| binding.snippet.curves.contains_key(&(row[0] as u32).to_string())) {
        return Err("Saved axis also translates a mapped actuator".into());
    }
    let packed = &tables.composite_axes;
    let mut actuators = Vec::new();
    let mut index = 0;
    while index + 8 <= packed.len() {
        let bone = packed[index] as u32;
        let semantic = packed[index + 1] as u8;
        let directional = packed[index + 2] == 1.0;
        let value_count = packed[index + 3] as usize;
        let binding_count = packed[index + 4] as usize;
        index += 8;
        let value_end = index + value_count * 3;
        let binding_end = value_end + binding_count * 6;
        if binding_end > packed.len() { return Err("Incomplete composite calibration table".into()); }
        let relevant = bones.contains(&bone) && semantic == semantic_axis;
        let values: Vec<ValueRow> = packed[index..value_end].chunks_exact(3).map(|row| ValueRow { au_id: row[0] as u32, group: row[1] as u8, side: row[2] as u8 }).collect();
        if relevant {
            let frame = frames.iter().find(|frame| frame.bone_id == bone).ok_or("Reference frame for mapped actuator is unavailable")?;
            let rotation = crate::gaze_geometry::quaternion(frame.rotation)?;
            let binding_rows = &packed[value_end..binding_end];
            // Match select_axis_binding: each reachable direction prefers its
            // directional rows and uses plain rows only when those are absent.
            // CC4 retains both lists, whose unused plain rows have opposite signs.
            let directions: &[u8] = if directional { &[GROUP_NEGATIVE, GROUP_POSITIVE] } else { &[GROUP_POSITIVE] };
            let selectable_groups: BTreeSet<u8> = directions.iter().map(|group| {
                if binding_rows.chunks_exact(6).any(|row| row[1] as u8 == *group) { *group } else { GROUP_PLAIN }
            }).collect();
            let mut bindings = Vec::new();
            for row in binding_rows.chunks_exact(6) {
                if !selectable_groups.contains(&(row[1] as u8)) { continue; }
                let mut channel_axis = [0.0; 3]; channel_axis[row[3] as usize] = 1.0;
                let axis = crate::gaze_geometry::rotate(rotation, channel_axis);
                // Yaw/pitch are subject-right/up. Authored roll follows the
                // existing positive tilt source (+Z in a canonical frame).
                let alignment = axis[semantic_axis as usize] * if semantic_axis == 2 { 1.0 } else { -1.0 };
                if alignment.abs() < 1.0 - 1e-5 { return Err("Mapped axis is not aligned with the character's neutral frame".into()); }
                bindings.push(BindingRow { au_id: row[0] as u32, group: row[1] as u8, side: row[2] as u8, channel: row[3] as u8, scale: row[4], max_degrees: row[5], semantic_sign: alignment.signum() });
            }
            if bindings.is_empty() { return Err("No calibrated rotational mapping for this axis".into()); }
            for group in 0..=2 {
                let coefficients: Vec<f64> = bindings.iter().filter(|row| row.group == group)
                    .map(|row| row.max_degrees as f64 * row.scale as f64 * row.semantic_sign).collect();
                if coefficients.first().is_some_and(|first| coefficients.iter().any(|value| (value - first).abs() > 1e-5)) {
                    return Err("Competing actuator ranges can switch discontinuously within a direction".into());
                }
            }
            actuators.push(Actuator { directional, values, bindings });
        } else if values.iter().any(|row| binding.snippet.curves.contains_key(&row.au_id.to_string())) {
            return Err("Saved axis also rotates another actuator or semantic axis".into());
        }
        index = binding_end;
    }
    if actuators.len() != bones.len() { return Err("Mapped head/eye axes are missing or ambiguous".into()); }
    let mut times = vec![binding.negative_time_sec, binding.neutral_time_sec, binding.positive_time_sec];
    for points in binding.snippet.curves.values() { times.extend(points.iter().map(|point| point.time).filter(|time| *time > binding.negative_time_sec && *time < binding.positive_time_sec)); }
    times.sort_by(f64::total_cmp); times.dedup_by(|a, b| (*a - *b).abs() < 1e-10);
    let mut clipping_times = Vec::new();
    for pair in times.windows(2) {
        for points in binding.snippet.curves.values() {
            let (a, b) = (sample(points, pair[0]), sample(points, pair[1]));
            if (a - 2.0) * (b - 2.0) < 0.0 { clipping_times.push(pair[0] + (pair[1] - pair[0]) * (2.0 - a) / (b - a)); }
        }
    }
    times.extend(clipping_times); times.sort_by(f64::total_cmp); times.dedup_by(|a, b| (*a - *b).abs() < 1e-10);
    // Selection uses balanced/clipped effective values, not raw source curves.
    // Add their crossings after clamp breakpoints; each resulting segment is
    // linear because competing same-direction coefficients were checked above.
    let mut crossing_times = Vec::new();
    for pair in times.windows(2) {
        for actuator in &actuators {
            let value_at = |row: &ValueRow, time: f64| {
                let key = row.au_id.to_string();
                binding.snippet.curves.get(&key).map_or(0.0, |points| sample(points, time).clamp(0.0, 2.0))
                    * side_scale(binding.snippet.balance_for(&key) as f32, row.side) as f64
            };
            for left in 0..actuator.values.len() { for right in left+1..actuator.values.len() {
                let a = value_at(&actuator.values[left], pair[0]) - value_at(&actuator.values[right], pair[0]);
                let b = value_at(&actuator.values[left], pair[1]) - value_at(&actuator.values[right], pair[1]);
                if a * b < 0.0 { crossing_times.push(pair[0] + (pair[1] - pair[0]) * a / (a - b)); }
            }}
        }
    }
    times.extend(crossing_times); times.sort_by(f64::total_cmp); times.dedup_by(|a, b| (*a - *b).abs() < 1e-10);
    let evaluator = Evaluator { version: 1, binding, actuators };
    let mut samples = Vec::new();
    for time in times {
        let value = source_value(&evaluator.binding, time);
        let angle = evaluate(&evaluator, value, 1.0).ok_or("Bilateral or articulated axis calibration is inconsistent")?;
        samples.push(Sample { value, angle_degrees: angle });
    }
    if samples.first().unwrap().angle_degrees >= -1e-5 || samples.last().unwrap().angle_degrees <= 1e-5
        || samples.windows(2).any(|pair| pair[0].angle_degrees > pair[1].angle_degrees + 1e-5) {
        return Err("Saved axis must monotonically span negative and positive character angles".into());
    }
    Ok(Calibration { available: true, samples, reason: None, evaluator: Some(evaluator) })
}
pub(crate) fn calibrate(profile: &ProfileData, model: &ModelData, bindings_json: &str, frames_json: &str) -> Result<String, String> {
    let bindings: BTreeMap<String, Binding> = serde_json::from_str(bindings_json).map_err(|error| format!("Invalid saved bindings: {error}"))?;
    let frames: Vec<ReferenceFrame> = serde_json::from_str(frames_json).map_err(|error| format!("Invalid reference frames: {error}"))?;
    let mut result = Calibrations::new();
    for (name, binding) in bindings {
        if !AXES.contains(&name.as_str()) { return Err(format!("Unknown gaze axis {name}")); }
        let calibration = calibrate_axis(profile, model, &frames, &name, binding).unwrap_or_else(unavailable);
        result.insert(name, calibration);
    }
    serde_json::to_string(&result).map_err(|error| error.to_string())
}
fn inverse(calibration: &Calibration, angle: f64) -> Option<f64> {
    if !calibration.available || !angle.is_finite() { return None; }
    let minimum = calibration.samples.first()?.angle_degrees;
    let maximum = calibration.samples.last()?.angle_degrees;
    if angle <= minimum { return Some(-1.0); }
    if angle >= maximum { return Some(1.0); }
    if angle.abs() <= 1e-10 { return Some(0.0); }
    for pair in calibration.samples.windows(2) {
        if angle <= pair[1].angle_degrees && pair[1].angle_degrees > pair[0].angle_degrees {
            let fraction = (angle - pair[0].angle_degrees) / (pair[1].angle_degrees - pair[0].angle_degrees);
            return Some(pair[0].value + fraction * (pair[1].value - pair[0].value));
        }
    }
    None
}
fn validate_calibrations(calibrations: &Calibrations) -> Result<(), String> {
    for (name, calibration) in calibrations {
        if !AXES.contains(&name.as_str()) { return Err(format!("Unknown calibrated axis {name}")); }
        if !calibration.available { continue; }
        let evaluator = calibration.evaluator.as_ref().ok_or("Available calibration requires evaluator facts")?;
        if evaluator.version != 1 || evaluator.actuators.is_empty() { return Err("Unsupported or empty calibration evaluator".into()); }
        validate(&evaluator.binding)?;
        for actuator in &evaluator.actuators {
            if actuator.values.is_empty() || actuator.bindings.is_empty()
                || actuator.values.iter().any(|row| row.group > 2 || row.side > 2)
                || actuator.bindings.iter().any(|row| row.channel > 2 || row.group > 2 || row.side > 2 || !row.scale.is_finite() || !row.max_degrees.is_finite() || row.semantic_sign != -1.0 && row.semantic_sign != 1.0) {
                return Err("Invalid calibration actuator rows".into());
            }
        }
        let samples = &calibration.samples;
        if samples.len() < 3 || samples.first().is_none_or(|sample| sample.value != -1.0 || sample.angle_degrees >= 0.0)
            || samples.last().is_none_or(|sample| sample.value != 1.0 || sample.angle_degrees <= 0.0)
            || !samples.iter().any(|sample| sample.value == 0.0 && sample.angle_degrees.abs() <= 1e-5)
            || samples.windows(2).any(|pair| pair[0].value >= pair[1].value || pair[0].angle_degrees > pair[1].angle_degrees + 1e-5) {
            return Err("Calibration samples must monotonically span neutral and both directions".into());
        }
        for sample in samples {
            if !sample.value.is_finite() || !sample.angle_degrees.is_finite() || !(-1.0..=1.0).contains(&sample.value)
                || evaluate(evaluator, sample.value, 1.0).is_none_or(|angle| (angle - sample.angle_degrees).abs() > 1e-4) {
                return Err("Calibration samples do not match the saved-source evaluator".into());
            }
        }
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mapped { targets: BTreeMap<String, f64>, unavailable_axes: Vec<String> }
#[wasm_bindgen]
pub fn map_gaze_angles_to_binding_targets(calibration_json: &str, angles_json: &str) -> Result<String, JsError> {
    let calibration: Calibrations = serde_json::from_str(calibration_json).map_err(|error| JsError::new(&format!("Invalid gaze calibration: {error}")))?;
    validate_calibrations(&calibration).map_err(|error| JsError::new(&error))?;
    let angles: BTreeMap<String, f64> = serde_json::from_str(angles_json).map_err(|error| JsError::new(&format!("Invalid gaze angles: {error}")))?;
    let mut result = Mapped { targets: BTreeMap::new(), unavailable_axes: vec![] };
    for (axis, angle) in angles {
        if !AXES.contains(&axis.as_str()) || !angle.is_finite() { return Err(JsError::new("Gaze axes and angles must be finite and supported")); }
        if let Some(value) = calibration.get(&axis).and_then(|calibration| inverse(calibration, angle)) { result.targets.insert(axis, value); }
        else { result.unavailable_axes.push(axis); }
    }
    serde_json::to_string(&result).map_err(|error| JsError::new(&error.to_string()))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Angles { yaw: f64, pitch: f64, #[serde(default)] roll: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SolveInput { head_angles_degrees: Angles, eye_angles_degrees: Angles, head_enabled: bool, eyes_enabled: bool, head_intensity: f64, eye_intensity: f64, intensity: f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Solved { targets: BTreeMap<String, f64>, unavailable_axes: Vec<String>, residual_angles_degrees: BTreeMap<String, f64> }
fn solve_targets(calibration: &Calibrations, input: SolveInput) -> Result<Solved, String> {
    if [input.head_intensity, input.eye_intensity].iter().any(|value| !value.is_finite() || !(0.0..=1.0).contains(value)) || !input.intensity.is_finite() || !(0.0..=2.0).contains(&input.intensity)
        || [input.head_angles_degrees.yaw, input.head_angles_degrees.pitch, input.head_angles_degrees.roll, input.eye_angles_degrees.yaw, input.eye_angles_degrees.pitch, input.eye_angles_degrees.roll].iter().any(|value| !value.is_finite()) { return Err("Finite angles and supported tracking strengths are required".into()); }
    let mut result = Solved { targets: BTreeMap::new(), unavailable_axes: vec![], residual_angles_degrees: BTreeMap::new() };
    for (suffix, head_goal, eye_goal) in [("Yaw", input.head_angles_degrees.yaw, input.eye_angles_degrees.yaw), ("Pitch", input.head_angles_degrees.pitch, input.eye_angles_degrees.pitch), ("Roll", input.head_angles_degrees.roll, 0.0)] {
        let head_name = format!("head{suffix}");
        let mut head_achieved = 0.0;
        if input.head_enabled && calibration.contains_key(&head_name) {
            if let Some((axis, value)) = calibration.get(&head_name).and_then(|axis| inverse(axis, head_goal).map(|value| (axis, value))) {
                head_achieved = axis.evaluator.as_ref().and_then(|evaluator| evaluate(evaluator, value, input.head_intensity * input.intensity)).ok_or("Scaled head calibration became ambiguous")?;
                result.targets.insert(head_name.clone(), value);
            } else { result.unavailable_axes.push(head_name.clone()); }
        }
        if suffix == "Roll" { continue; }
        let eye_name = format!("eye{suffix}");
        let residual = eye_goal - head_achieved;
        let mut eye_achieved = 0.0;
        if input.eyes_enabled && calibration.contains_key(&eye_name) {
            if let Some((axis, value)) = calibration.get(&eye_name).and_then(|axis| inverse(axis, residual).map(|value| (axis, value))) {
                eye_achieved = axis.evaluator.as_ref().and_then(|evaluator| evaluate(evaluator, value, input.eye_intensity * input.intensity)).ok_or("Scaled eye calibration became ambiguous")?;
                result.targets.insert(eye_name.clone(), value);
            } else { result.unavailable_axes.push(eye_name); }
        }
        result.residual_angles_degrees.insert(suffix.to_lowercase(), residual - eye_achieved);
    }
    Ok(result)
}
#[wasm_bindgen]
pub fn solve_gaze_binding_targets(calibration_json: &str, input_json: &str) -> Result<String, JsError> {
    let calibration: Calibrations = serde_json::from_str(calibration_json).map_err(|error| JsError::new(&format!("Invalid gaze calibration: {error}")))?;
    validate_calibrations(&calibration).map_err(|error| JsError::new(&error))?;
    let input: SolveInput = serde_json::from_str(input_json).map_err(|error| JsError::new(&format!("Invalid gaze allocation: {error}")))?;
    serde_json::to_string(&solve_targets(&calibration, input).map_err(|error| JsError::new(&error))?).map_err(|error| JsError::new(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (ProfileData, ModelData, String, String) {
        let profile = serde_json::from_value(json!({
            "boneNodes":{"head":"Crane","leftEye":"OpticL","rightEye":"OpticR"},
            "humanoidCharacterization":{"schemaVersion":1,"standard":"VRMC_vrm-1.0","roles":{
                "head":{"nodeKey":"head"},"leftEye":{"nodeKey":"leftEye"},"rightEye":{"nodeKey":"rightEye"}}},
            "auToBones":{
                "8001":[{"node":"head","channel":"ry","scale":1,"maxDegrees":50}],
                "8002":[{"node":"head","channel":"ry","scale":-1,"maxDegrees":80}],
                "9001":[{"node":"leftEye","channel":"ry","scale":1,"maxDegrees":25},{"node":"rightEye","channel":"ry","scale":1,"maxDegrees":25}],
                "9002":[{"node":"leftEye","channel":"ry","scale":-1,"maxDegrees":25},{"node":"rightEye","channel":"ry","scale":-1,"maxDegrees":25}]},
            "auToMorphs":{"8002":{"center":["SavedShape"]}},
            "compositeRotations":[{"node":"head","yaw":{"axis":"ry","negative":8001,"positive":8002}},
                {"node":"leftEye","yaw":{"axis":"ry","negative":9001,"positive":9002}},
                {"node":"rightEye","yaw":{"axis":"ry","negative":9001,"positive":9002}}]
        })).unwrap();
        let model = serde_json::from_value(json!({"bones":[{"id":1,"name":"Crane"},{"id":2,"name":"OpticL"},{"id":3,"name":"OpticR"}]})).unwrap();
        let binding = |negative: &str, positive: &str| json!({"negativeTimeSec":0,"neutralTimeSec":1,"positiveTimeSec":2,
            "snippet":{"duration":2,"curves":{negative:[{"time":0,"intensity":1},{"time":1,"intensity":0},{"time":2,"intensity":0}],
                positive:[{"time":0,"intensity":0},{"time":1,"intensity":0},{"time":2,"intensity":1}]}}});
        let bindings = json!({"headYaw":binding("8001","8002"),"eyeYaw":binding("9001","9002")}).to_string();
        let frames = json!([{"boneId":1,"rotation":[0,0,0,1]},{"boneId":2,"rotation":[0,0,0,1]},{"boneId":3,"rotation":[0,0,0,1]}]).to_string();
        (profile,model,bindings,frames)
    }
    fn allocation(head_enabled: bool, head_strength: f64, target: f64) -> SolveInput {
        SolveInput { head_angles_degrees: Angles {yaw:target,pitch:0.,roll:0.}, eye_angles_degrees:Angles {yaw:target,pitch:0.,roll:0.},
            head_enabled,eyes_enabled:true,head_intensity:head_strength,eye_intensity:1.,intensity:1. }
    }
    #[test]
    fn directional_bindings_take_precedence_over_opposing_plain_rows() {
        let (profile,model,bindings,frames)=fixture();
        let mut profile=serde_json::to_value(profile).unwrap();
        // The embedded CC4 preset keeps `aus` alongside both direction lists.
        // The compiler emits all three groups, but native playback never selects
        // the plain bindings when the requested directional bindings exist.
        for (axis, ids) in profile["compositeRotations"].as_array_mut().unwrap().iter_mut()
            .zip([json!([8001,8002]),json!([9001,9002]),json!([9001,9002])]) {
            axis["yaw"]["aus"]=ids;
        }
        let profile:ProfileData=serde_json::from_value(profile).unwrap();
        let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings,&frames).unwrap()).unwrap();
        for (axis, negative, positive) in [("headYaw",-50.,80.),("eyeYaw",-25.,25.)] {
            let calibrated=&result[axis];
            assert!(calibrated.available,"{axis}: {:?}",calibrated.reason);
            assert!((calibrated.samples.first().unwrap().angle_degrees-negative).abs()<1e-5);
            assert!((calibrated.samples.last().unwrap().angle_degrees-positive).abs()<1e-5);
            assert!(calibrated.evaluator.as_ref().unwrap().actuators.iter()
                .all(|actuator|actuator.bindings.iter().all(|row|row.group!=GROUP_PLAIN)));
        }
    }
    #[test]
    fn missing_directional_bindings_keep_the_native_plain_fallback() {
        let (profile,model,bindings,frames)=fixture();
        let mut profile=serde_json::to_value(profile).unwrap();
        profile["compositeRotations"][0]["yaw"]=json!({"axis":"ry","negative":8001,"positive":8999,"aus":[8002]});
        let profile:ProfileData=serde_json::from_value(profile).unwrap();
        let mut bindings:serde_json::Value=serde_json::from_str(&bindings).unwrap();
        // The positive selector contributes direction without its own bone
        // binding; the authored plain binding supplies the selected range.
        bindings["headYaw"]["snippet"]["curves"]["8999"]=bindings["headYaw"]["snippet"]["curves"]["8002"].clone();
        let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings.to_string(),&frames).unwrap()).unwrap();
        let head=&result["headYaw"];
        assert!(head.available,"{:?}",head.reason);
        assert!((inverse(head,-25.).unwrap()+0.5).abs()<1e-5);
        assert!((inverse(head,40.).unwrap()-0.5).abs()<1e-5);
        assert!(head.evaluator.as_ref().unwrap().actuators[0].bindings.iter().any(|row|row.group==GROUP_PLAIN));
    }
    #[test]
    fn competing_reachable_directional_ranges_remain_unavailable() {
        let (profile,model,bindings,frames)=fixture();
        let mut profile=serde_json::to_value(profile).unwrap();
        profile["auToBones"]["8003"]=json!([{"node":"head","channel":"ry","scale":-1,"maxDegrees":40}]);
        profile["compositeRotations"][0]["yaw"]=json!({"axis":"ry","negative":8001,"positive":[8002,8003],"aus":[8001,8002,8003]});
        let profile:ProfileData=serde_json::from_value(profile).unwrap();
        let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings,&frames).unwrap()).unwrap();
        assert!(!result["headYaw"].available);
        assert_eq!(result["headYaw"].reason.as_deref(),Some("Competing actuator ranges can switch discontinuously within a direction"));
    }
    #[test]
    fn calibrates_custom_aus_asymmetric_ranges_and_nonlinear_saved_amplitudes() {
        let (profile,model,bindings,frames)=fixture();
        let mut bindings:serde_json::Value=serde_json::from_str(&bindings).unwrap();
        bindings["headYaw"]["snippet"]["curves"]["8001"][0]["intensity"]=json!(0.4);
        bindings["headYaw"]["snippet"]["curves"]["8002"]=json!([
            {"time":0,"intensity":0},{"time":1,"intensity":0},{"time":1.5,"intensity":0.2},{"time":2,"intensity":0.8}]);
        let calibrated:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings.to_string(),&frames).unwrap()).unwrap();
        let head=&calibrated["headYaw"];
        assert!(head.available);
        assert!((head.samples.first().unwrap().angle_degrees+20.).abs()<1e-5);
        assert!((head.samples.last().unwrap().angle_degrees-64.).abs()<1e-5);
        assert!((inverse(head,32.).unwrap()-2./3.).abs()<1e-5);
        assert!((inverse(head,-10.).unwrap()+0.5).abs()<1e-5);
        assert_eq!(profile.au_to_morphs["8002"].as_ref().unwrap().center.len(),1);
    }
    #[test]
    fn head_and_eyes_allocate_one_bearing_with_delay_strength_and_saturation() {
        let (profile,model,bindings,frames)=fixture();
        let calibration:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings,&frames).unwrap()).unwrap();
        let together=solve_targets(&calibration,allocation(true,1.,20.)).unwrap();
        assert!((together.targets["headYaw"]-0.25).abs()<1e-6);
        assert_eq!(together.targets["eyeYaw"],0.);
        let delayed=solve_targets(&calibration,allocation(false,1.,20.)).unwrap();
        assert!(!delayed.targets.contains_key("headYaw"));
        assert!((delayed.targets["eyeYaw"]-0.8).abs()<1e-6);
        let weak=solve_targets(&calibration,allocation(true,0.5,20.)).unwrap();
        assert!((weak.targets["eyeYaw"]-0.4).abs()<1e-6);
        let beyond=solve_targets(&calibration,allocation(true,1.,120.)).unwrap();
        assert_eq!(beyond.targets["headYaw"],1.);assert_eq!(beyond.targets["eyeYaw"],1.);
        assert!((beyond.residual_angles_degrees["yaw"]-15.).abs()<1e-5);
    }
    #[test]
    fn clipping_uses_actual_source_values_before_head_residual() {
        let (profile,model,bindings,frames)=fixture();
        let mut bindings:serde_json::Value=serde_json::from_str(&bindings).unwrap();
        bindings["headYaw"]["snippet"]["curves"]["8002"][2]["intensity"]=json!(3.);
        let calibration:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings.to_string(),&frames).unwrap()).unwrap();
        assert!(calibration["headYaw"].samples.iter().any(|sample|(sample.value-2./3.).abs()<1e-8));
        let mut input=allocation(true,1.,240.);input.intensity=2.;
        let solved=solve_targets(&calibration,input).unwrap();
        assert!((solved.residual_angles_degrees["yaw"]-30.).abs()<1e-4);
    }
    #[test]
    fn missing_morph_only_asymmetric_or_mixed_sources_are_explicitly_unavailable() {
        let (mut profile,model,bindings,frames)=fixture();
        profile.au_to_bones.remove("8001");profile.au_to_bones.remove("8002");
        let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings,&frames).unwrap()).unwrap();
        assert!(!result["headYaw"].available);
        let (mut profile,model,bindings,frames)=fixture();
        profile.au_to_bones.get_mut("9002").unwrap()[1].max_degrees=Some(40.);
        let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&bindings,&frames).unwrap()).unwrap();
        assert!(!result["eyeYaw"].available);
        let (profile,model,bindings,frames)=fixture();
        for patch in [json!({"channels":[{"target":{"kind":"bone"}}]}),json!({"snippetEasing":"easeInOut"}),json!({"snippetCategory":"visemeSnippet"})] {
            let mut source:serde_json::Value=serde_json::from_str(&bindings).unwrap();
            for (key,value) in patch.as_object().unwrap() {source["headYaw"]["snippet"][key]=value.clone();}
            let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&source.to_string(),&frames).unwrap()).unwrap();
            assert!(!result["headYaw"].available);
        }
    }
    #[test]
    fn saved_balance_and_legacy_map_match_animation_precedence() {
        let (mut profile,model,bindings,frames)=fixture();
        for id in ["9001","9002"] {
            profile.au_to_bones.get_mut(id).unwrap()[0].side=Some("left".into());
            profile.au_to_bones.get_mut(id).unwrap()[1].side=Some("right".into());
        }
        for patch in [json!({"snippetBalance":0.5}),json!({"snippetBalanceMap":{"9001":0.5,"9002":0.5}})] {
            let mut source:serde_json::Value=serde_json::from_str(&bindings).unwrap();
            for (key,value) in patch.as_object().unwrap() {source["eyeYaw"]["snippet"][key]=value.clone();}
            let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&source.to_string(),&frames).unwrap()).unwrap();
            assert!(!result["eyeYaw"].available,"unequal eye contributions must not claim shared angular calibration");
            source["eyeYaw"]["snippet"]["balanceMap"]=json!({});
            // Explicit current map suppresses the legacy map, but scalar
            // snippetBalance continues as the default for every AU.
            if patch.get("snippetBalance").is_none() {
                let result:Calibrations=serde_json::from_str(&calibrate(&profile,&model,&source.to_string(),&frames).unwrap()).unwrap();
                assert!(result["eyeYaw"].available);
            }
        }
    }
}
