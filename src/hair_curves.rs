//! Hair idle/impulse/gravity curve generation for AnimationMixer clips.
//!
//! Hosts only schedule the resulting curves on Three.js (or another mixer);
//! all sampling math lives here.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::math::{clamp01, finite_or};

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairMorphTargetNames {
    pub sway_left: Option<String>,
    pub sway_right: Option<String>,
    pub sway_front: Option<String>,
    pub fluff_right: Option<String>,
    pub fluff_bottom: Option<String>,
    pub head_up: Option<std::collections::BTreeMap<String, f32>>,
    pub head_down: Option<std::collections::BTreeMap<String, f32>>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HairCurveConfig {
    #[serde(default = "default_idle_sway_amount")]
    pub idle_sway_amount: f32,
    #[serde(default = "default_idle_sway_speed")]
    pub idle_sway_speed: f32,
    #[serde(default)]
    pub wind_strength: f32,
    #[serde(default = "default_one")]
    pub wind_direction_x: f32,
    #[serde(default)]
    pub wind_direction_z: f32,
    #[serde(default = "default_wind_turbulence")]
    pub wind_turbulence: f32,
    #[serde(default = "default_wind_frequency")]
    pub wind_frequency: f32,
    #[serde(default = "default_stiffness")]
    pub stiffness: f32,
    #[serde(default = "default_damping")]
    pub damping: f32,
    #[serde(default)]
    pub morph_targets: HairMorphTargetNames,
}

fn default_idle_sway_amount() -> f32 {
    0.08
}
fn default_idle_sway_speed() -> f32 {
    0.75
}
fn default_one() -> f32 {
    1.0
}
fn default_wind_turbulence() -> f32 {
    0.2
}
fn default_wind_frequency() -> f32 {
    0.5
}
fn default_stiffness() -> f32 {
    15.0
}
fn default_damping() -> f32 {
    0.8
}

/// Runtime options are normalized in Rust. Rig-specific names and tuning come
/// exclusively from the selected profile; an unmapped profile stays unmapped.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HairPlaybackConfig {
    #[serde(default)] pub enabled: bool,
    #[serde(default)] pub inertia: f32,
    #[serde(default)] pub gravity: f32,
    #[serde(default = "default_one")] pub response_scale: f32,
    #[serde(default = "minimum_idle_duration")] pub idle_clip_duration: f32,
    #[serde(default = "minimum_impulse_duration")] pub impulse_clip_duration: f32,
    #[serde(default)] pub direction: HairDirection,
    #[serde(flatten)] pub curves: HairCurveConfig,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct HairDirection { pub yaw_sign: f32, pub pitch_sign: f32 }
impl Default for HairDirection {
    fn default() -> Self { Self { yaw_sign: 1.0, pitch_sign: 1.0 } }
}
fn minimum_idle_duration() -> f32 { 0.5 }
fn minimum_impulse_duration() -> f32 { 0.25 }
impl Default for HairPlaybackConfig {
    fn default() -> Self { serde_json::from_value(json!({})).expect("empty hair config has neutral defaults") }
}

fn merge_config_value(current: &mut Value, update: &Value) {
    // Omitted fields retain their value; explicit null/empty containers clear
    // mappings instead of resurrecting mappings from a previous profile.
    if let (Some(current), Some(update)) = (current.as_object_mut(), update.as_object()) {
        if update.is_empty() { current.clear(); return; }
        for (key, value) in update {
            if let Some(previous) = current.get_mut(key) { merge_config_value(previous, value); }
            else { current.insert(key.clone(), value.clone()); }
        }
    } else { *current = update.clone(); }
}

pub(crate) fn normalize_config(current: &HairPlaybackConfig, update: &Value) -> Result<HairPlaybackConfig, String> {
    if !update.is_object() && !update.is_null() { return Err("Hair config must be an object or null.".into()); }
    let mut value = serde_json::to_value(current).map_err(|error| error.to_string())?;
    merge_config_value(&mut value, update);
    if value.is_null() { value = json!({}); }
    if value["direction"].is_null() { value["direction"] = json!({}); }
    if value["morphTargets"].is_null() { value["morphTargets"] = json!({}); }
    let targets = value["morphTargets"].as_object_mut().ok_or("Hair morphTargets must be an object or null.")?;
    for key in ["swayLeft", "swayRight", "swayFront", "fluffRight", "fluffBottom"] {
        if let Some(target) = targets.get_mut(key) {
            if target.is_object() { *target = target.get("key").cloned().unwrap_or(Value::Null); }
            if !target.is_null() && !target.is_string() { return Err(format!("Hair morph target {key} requires a name.")); }
        }
    }
    for key in ["headUp", "headDown"] {
        if let Some(group) = targets.get_mut(key) {
            if group.is_null() { continue; }
            let group = group.as_object_mut().ok_or_else(|| format!("Hair {key} must be a target map or null."))?;
            group.retain(|_, value| !value.is_null());
            for target in group.values_mut() {
                if target.is_object() { *target = target.get("value").cloned().ok_or("Hair gravity mapping requires a value.")?; }
            }
        }
    }
    let config: HairPlaybackConfig = serde_json::from_value(value).map_err(|error| format!("Invalid hair config: {error}"))?;
    for (name, number) in [
        ("inertia", config.inertia), ("gravity", config.gravity), ("responseScale", config.response_scale),
        ("idleClipDuration", config.idle_clip_duration), ("impulseClipDuration", config.impulse_clip_duration),
        ("idleSwayAmount", config.curves.idle_sway_amount), ("idleSwaySpeed", config.curves.idle_sway_speed),
        ("windStrength", config.curves.wind_strength), ("windTurbulence", config.curves.wind_turbulence),
        ("windFrequency", config.curves.wind_frequency), ("stiffness", config.curves.stiffness), ("damping", config.curves.damping),
    ] {
        if !number.is_finite() || number < 0.0 { return Err(format!("Hair {name} must be finite and nonnegative.")); }
    }
    for number in [config.curves.wind_direction_x, config.curves.wind_direction_z, config.direction.yaw_sign, config.direction.pitch_sign] {
        if !number.is_finite() { return Err("Hair directions must be finite.".into()); }
    }
    for group in [&config.curves.morph_targets.head_up, &config.curves.morph_targets.head_down].into_iter().flatten() {
        if group.values().any(|value| !value.is_finite() || *value < 0.0) {
            return Err("Hair gravity target values must be finite and nonnegative.".into());
        }
    }
    Ok(config)
}

pub(crate) fn configured_targets(config: &HairPlaybackConfig) -> std::collections::BTreeSet<String> {
    let morph = &config.curves.morph_targets;
    let mut names: std::collections::BTreeSet<_> = [&morph.sway_left, &morph.sway_right, &morph.sway_front, &morph.fluff_right, &morph.fluff_bottom]
        .into_iter().filter_map(|name| name.as_ref()).filter(|name| !name.is_empty()).cloned().collect();
    for group in [&morph.head_up, &morph.head_down].into_iter().flatten() { names.extend(group.keys().filter(|name| !name.is_empty()).cloned()); }
    names
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeQuaternionTrack {
    pub bone_name: String,
    pub current: [f32; 4],
    pub reference: [f32; 4],
    pub samples: Vec<[f32; 4]>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HairMotion {
    pub horizontal: f32,
    pub vertical: f32,
    pub pitch: f32,
    pub affects_pitch: bool,
}

fn inverse(q: [f32; 4]) -> [f32; 4] { [-q[0], -q[1], -q[2], q[3]] }
fn yaw_pitch(q: [f32; 4]) -> (f32, f32) {
    // YXZ decomposition matches the authored head response convention.
    let [x, y, z, w] = q;
    let m23 = 2.0 * (y * z - x * w);
    let pitch = (-m23.clamp(-1.0, 1.0)).asin();
    let yaw = if m23.abs() < 0.9999999 {
        (2.0 * (x * z + y * w)).atan2(1.0 - 2.0 * (x * x + y * y))
    } else { (-2.0 * (x * z - y * w)).atan2(1.0 - 2.0 * (y * y + z * z)) };
    (yaw, pitch)
}

pub(crate) fn authored_motion(
    config: &HairPlaybackConfig, profile: &crate::profile::ProfileData,
    model: Option<&crate::profile::ModelData>, tracks: &[NativeQuaternionTrack], additive: bool,
) -> Result<Option<HairMotion>, String> {
    if !config.enabled { return Ok(None); }
    let configured_head = profile.humanoid_characterization.as_ref().and_then(|mapping|mapping.roles.get("head"))
        .map(|role|crate::profile_resolution::configured_bone_name(profile,&role.node_key));
    let resolved_head = model.and_then(|model| {
        let resolver=crate::profile::NameResolver::new(profile,model);
        profile.humanoid_characterization.as_ref().and_then(|mapping|mapping.roles.get("head"))
            .and_then(|role|resolver.resolve_bone(model,profile,&role.node_key)).map(|bone|bone.name.clone())
    });
    let head_name=resolved_head.or(configured_head);
    let (mut yaw, mut pitch, mut target_pitch) = (0.0_f32, 0.0_f32, 0.0_f32);
    let mut affects_pitch = false;
    for track in tracks.iter().filter(|track| head_name.as_deref()==Some(track.bone_name.as_str())) {
        if std::iter::once(&track.current).chain(std::iter::once(&track.reference)).chain(&track.samples)
            .any(|q| q.iter().any(|value| !value.is_finite()) || q.iter().map(|v| v * v).sum::<f32>() <= f32::EPSILON) {
            return Err("Hair motion requires finite nonzero quaternions.".into());
        }
        let current = crate::bones::normalize_quat(track.current);
        let reference = crate::bones::normalize_quat(track.reference);
        let reference_inverse = inverse(reference);
        affects_pitch |= yaw_pitch(crate::bones::multiply_quat(reference_inverse, current)).1.abs() > 1e-5;
        for (index, sample) in track.samples.iter().enumerate() {
            let sample = if additive { crate::bones::multiply_quat(reference, *sample) } else { crate::bones::normalize_quat(*sample) };
            let sample_pitch = yaw_pitch(crate::bones::multiply_quat(reference_inverse, sample)).1;
            // Include an inherited pitched start even when the goal is neutral.
            // Yaw/roll-only contributions must not replace pitch-owned gravity.
            affects_pitch |= sample_pitch.abs() > 1e-5;
            if index + 1 == track.samples.len() { target_pitch = sample_pitch; }
            let delta = yaw_pitch(crate::bones::multiply_quat(inverse(current), sample));
            if delta.0.abs() > yaw.abs() { yaw = delta.0; }
            if delta.1.abs() > pitch.abs() { pitch = delta.1; }
        }
    }
    if yaw.abs() < 1e-5 && pitch.abs() < 1e-5 { return Ok(None); }
    let motion = HairMotion {
        horizontal: yaw * config.inertia * config.response_scale * config.direction.yaw_sign,
        vertical: pitch * config.gravity * 0.25 * config.response_scale * config.direction.pitch_sign,
        pitch: target_pitch * config.direction.pitch_sign,
        affects_pitch,
    };
    if [motion.horizontal, motion.vertical, motion.pitch].iter().any(|value| !value.is_finite()) {
        return Err("Configured hair response exceeds finite motion limits.".into());
    }
    Ok(Some(motion))
}

pub(crate) fn gravity_pose_curves(config: &HairPlaybackConfig, pitch: f32, duration_seconds: f64) -> Result<Value, String> {
    if !pitch.is_finite() || !duration_seconds.is_finite() || duration_seconds < 0.0 {
        return Err("Hair gravity requires finite pitch and nonnegative durationSeconds.".into());
    }
    let morph = &config.curves.morph_targets;
    let mut names = std::collections::BTreeSet::new();
    for group in [&morph.head_up, &morph.head_down].into_iter().flatten() { names.extend(group.keys()); }
    let mut curves = serde_json::Map::new();
    for name in names {
        let amount = if pitch < 0.0 { morph.head_up.as_ref().and_then(|map| map.get(name)).copied().unwrap_or(0.0).clamp(0.0, 2.0) * (-pitch).min(1.0) }
            else { morph.head_down.as_ref().and_then(|map| map.get(name)).copied().unwrap_or(0.0).clamp(0.0, 2.0) * pitch.min(1.0) };
        let points = if duration_seconds > 0.0 { json!([{ "time": 0.0, "intensity": amount, "inherit": true }, { "time": duration_seconds, "intensity": amount }]) }
            else { json!([{ "time": 0.0, "intensity": amount }]) };
        curves.insert(name.clone(), points);
    }
    Ok(Value::Object(curves))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct CurvePoint {
    time: f32,
    intensity: f32,
    #[serde(skip_serializing_if = "is_false")]
    inherit: bool,
}

fn is_false(value: &bool) -> bool { !*value }

fn push_point(
    curves: &mut std::collections::BTreeMap<String, Vec<CurvePoint>>,
    key: Option<&String>,
    time: f32,
    intensity: f32,
) {
    let Some(key) = key else { return };
    if key.is_empty() {
        return;
    }
    curves
        .entry(key.clone())
        .or_default()
        .push(CurvePoint { time, intensity, inherit: false });
}

pub fn build_idle_wind_curves(config: &HairCurveConfig, duration_sec: f32) -> Value {
    let duration = duration_sec.max(0.5);
    let sample_count = ((duration * 12.0).round() as i32).clamp(16, 120) as i32;
    let has_wind = config.wind_strength > 0.0;
    let has_idle = config.idle_sway_amount > 0.0;
    let wind_scale = config.wind_strength * 0.1;
    let morph = &config.morph_targets;
    let mut curves: std::collections::BTreeMap<String, Vec<CurvePoint>> =
        std::collections::BTreeMap::new();

    for i in 0..=sample_count {
        let t = duration * (i as f32) / (sample_count as f32);
        let idle_offset = if has_idle {
            (t * config.idle_sway_speed * std::f32::consts::PI * 2.0).sin()
                * config.idle_sway_amount
        } else {
            0.0
        };

        let (wind_offset_x, wind_offset_z) = if has_wind {
            let base_phase = t * config.wind_frequency * std::f32::consts::PI * 2.0;
            let primary = base_phase.sin();
            let secondary = (base_phase * 1.7).sin() * 0.3;
            let turbulence = (base_phase * 3.3).sin() * config.wind_turbulence * 0.2;
            let wave = primary + secondary + turbulence;
            (
                config.wind_direction_x * wave * wind_scale,
                config.wind_direction_z * wave * wind_scale,
            )
        } else {
            (0.0, 0.0)
        };

        let combined_x = idle_offset + wind_offset_x;
        let combined_z = wind_offset_z;
        let left = clamp01(if combined_x > 0.0 { combined_x } else { 0.0 });
        let right = clamp01(if combined_x < 0.0 { -combined_x } else { 0.0 });
        let front = clamp01(if combined_z > 0.0 { combined_z } else { 0.0 });
        let fluffy_right = clamp01(right * 0.7);
        let fluffy_bottom = clamp01((combined_x.abs() + combined_z.abs()) * 0.25);

        push_point(&mut curves, morph.sway_left.as_ref(), t, left);
        push_point(&mut curves, morph.sway_right.as_ref(), t, right);
        push_point(&mut curves, morph.sway_front.as_ref(), t, front);
        push_point(&mut curves, morph.fluff_right.as_ref(), t, fluffy_right);
        push_point(&mut curves, morph.fluff_bottom.as_ref(), t, fluffy_bottom);
    }

    for points in curves.values_mut() {
        if points.len() > 1 {
            let first = points[0].intensity;
            if let Some(last) = points.last_mut() {
                last.intensity = first;
            }
        }
    }

    serde_json::to_value(curves).unwrap_or_else(|_| json!({}))
}

pub fn build_impulse_curves(
    config: &HairCurveConfig,
    duration_sec: f32,
    horizontal: f32,
    vertical: f32,
) -> Value {
    let duration = duration_sec.max(0.25);
    let sample_count = ((duration * 30.0).round() as i32).clamp(12, 90) as i32;
    let frequency = (config.stiffness * 0.2).max(0.5);
    let decay = (config.damping * 4.0).max(0.1);
    let omega = std::f32::consts::PI * 2.0 * frequency;
    let morph = &config.morph_targets;
    let mut curves: std::collections::BTreeMap<String, Vec<CurvePoint>> =
        std::collections::BTreeMap::new();

    for i in 0..=sample_count {
        let t = duration * (i as f32) / (sample_count as f32);
        let wave = (omega * t).cos() * (-decay * t).exp();
        let horizontal_value = horizontal * wave;
        let vertical_value = vertical * wave;

        let left = clamp01(if horizontal_value > 0.0 {
            horizontal_value
        } else {
            0.0
        });
        let right = clamp01(if horizontal_value < 0.0 {
            -horizontal_value
        } else {
            0.0
        });
        let front = clamp01(if vertical_value > 0.0 {
            vertical_value
        } else {
            0.0
        });
        let fluffy_right = clamp01(right * 0.7);
        let fluffy_bottom = clamp01((horizontal_value.abs() + vertical_value.abs()) * 0.25);

        push_point(&mut curves, morph.sway_left.as_ref(), t, left);
        push_point(&mut curves, morph.sway_right.as_ref(), t, right);
        push_point(&mut curves, morph.sway_front.as_ref(), t, front);
        push_point(&mut curves, morph.fluff_right.as_ref(), t, fluffy_right);
        push_point(&mut curves, morph.fluff_bottom.as_ref(), t, fluffy_bottom);
    }

    for points in curves.values_mut() {
        // Same-name native replacement starts from this impulse's outgoing
        // contribution, without inheriting independent hair idle or gravity.
        if let Some(first) = points.first_mut() {
            first.inherit = true;
        }
        if let Some(last) = points.last_mut() {
            last.intensity = 0.0;
        }
    }

    serde_json::to_value(curves).unwrap_or_else(|_| json!({}))
}

pub fn build_gravity_curves(config: &HairCurveConfig) -> Value {
    let morph = &config.morph_targets;
    let head_up = morph.head_up.clone().unwrap_or_default();
    let head_down = morph.head_down.clone().unwrap_or_default();
    let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    keys.extend(head_up.keys().cloned());
    keys.extend(head_down.keys().cloned());

    let mut curves: std::collections::BTreeMap<String, Vec<CurvePoint>> =
        std::collections::BTreeMap::new();
    for key in keys {
        let up = *head_up.get(&key).unwrap_or(&0.0);
        let down = *head_down.get(&key).unwrap_or(&0.0);
        curves.insert(
            key,
            vec![
                CurvePoint {
                    time: 0.0,
                    intensity: up,
                    inherit: false,
                },
                CurvePoint {
                    time: 0.5,
                    intensity: 0.0,
                    inherit: false,
                },
                CurvePoint {
                    time: 1.0,
                    intensity: down,
                    inherit: false,
                },
            ],
        );
    }
    serde_json::to_value(curves).unwrap_or_else(|_| json!({}))
}

pub fn parse_hair_curve_config(config_json: &str) -> Result<HairCurveConfig, String> {
    serde_json::from_str(config_json)
        .map_err(|err| format!("Invalid hair curve config JSON: {err}"))
}

/// Packed helper used by wasm_bindgen exports that take discrete numeric params.
pub fn sanitize_duration(duration: f32, minimum: f32) -> f32 {
    finite_or(duration, minimum).max(minimum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> HairCurveConfig {
        HairCurveConfig {
            idle_sway_amount: 0.2,
            idle_sway_speed: 1.0,
            wind_strength: 0.5,
            wind_direction_x: 1.0,
            wind_direction_z: 0.0,
            wind_turbulence: 0.2,
            wind_frequency: 0.5,
            stiffness: 15.0,
            damping: 0.8,
            morph_targets: HairMorphTargetNames {
                sway_left: Some("L".into()),
                sway_right: Some("R".into()),
                sway_front: Some("F".into()),
                fluff_right: Some("FR".into()),
                fluff_bottom: Some("FB".into()),
                head_up: Some(std::collections::BTreeMap::from([("Up".into(), 1.0)])),
                head_down: Some(std::collections::BTreeMap::from([("Down".into(), 0.8)])),
            },
        }
    }

    #[test]
    fn configured_hair_uses_selected_profile_and_preserves_explicit_clears() {
        let cc4 = crate::presets::load_profile("cc4").unwrap();
        let source = serde_json::to_value(&cc4.hair_physics).unwrap();
        let config = normalize_config(&HairPlaybackConfig::default(), &source).unwrap();
        assert_eq!(config.curves.stiffness, source["stiffness"].as_f64().unwrap() as f32);
        assert_eq!(config.curves.morph_targets.sway_left.as_deref(), source["morphTargets"]["swayLeft"]["key"].as_str());
        assert!(!configured_targets(&config).is_empty());
        let cleared = normalize_config(&config, &json!({"morphTargets":{}})).unwrap();
        assert!(configured_targets(&cleared).is_empty());
        let cleared = normalize_config(&config, &json!({"morphTargets":null})).unwrap();
        assert!(configured_targets(&cleared).is_empty());
        let cleared = normalize_config(&config, &json!({"morphTargets":{"headUp":null,"headDown":{},"swayLeft":null}})).unwrap();
        assert!(cleared.curves.morph_targets.head_up.is_none());
        assert!(cleared.curves.morph_targets.head_down.as_ref().unwrap().is_empty());
        assert!(cleared.curves.morph_targets.sway_left.is_none());
        assert_eq!(cleared.curves.morph_targets.sway_right, config.curves.morph_targets.sway_right);
        let fish = crate::presets::load_profile("fish").unwrap();
        let fish = normalize_config(&HairPlaybackConfig::default(), &serde_json::to_value(&fish.hair_physics).unwrap()).unwrap();
        assert!(configured_targets(&fish).is_empty());
        assert!(configured_targets(&HairPlaybackConfig::default()).is_empty());
    }

    #[test]
    fn custom_hair_mapping_never_gains_other_presets_targets() {
        let custom = normalize_config(&HairPlaybackConfig::default(), &json!({
            "enabled":true,"idleClipDuration":3.0,"morphTargets":{"swayLeft":{"key":"custom-lock","axis":"yaw"},"headDown":{"custom-tip":{"value":0.7,"axis":"pitch"}}}
        })).unwrap();
        assert_eq!(configured_targets(&custom), std::collections::BTreeSet::from(["custom-lock".into(), "custom-tip".into()]));
        let patch = normalize_config(&custom, &json!({"windStrength":0.8})).unwrap();
        assert_eq!(configured_targets(&patch), configured_targets(&custom));
        assert_eq!(patch.idle_clip_duration, 3.0);
        assert!(normalize_config(&custom, &json!({"idleClipDuration":-1})).is_err());
        assert!(normalize_config(&custom, &json!({"morphTargets":{"headUp":{"bad":1e100}}})).is_err());
    }

    #[test]
    fn authored_response_uses_profile_head_roles_and_native_reference_transforms() {
        let profile = serde_json::from_value(json!({
            "boneNodes":{"head":"CustomHead"}, "humanoidCharacterization":{"schemaVersion":1,"standard":"VRMC_vrm-1.0","roles":{"head":{"nodeKey":"head"}}},
            "auToBones":{"1":[{"node":"CustomHead","channel":"ry","scale":1}]}
        })).unwrap();
        let config = normalize_config(&HairPlaybackConfig::default(), &json!({"enabled":true,"inertia":2,"gravity":4,"responseScale":3,"direction":{"yawSign":-1,"pitchSign":1}})).unwrap();
        let sample = crate::bones::quat_from_channel(1, 0.5);
        let track = NativeQuaternionTrack { bone_name:"CustomHead".into(), current:[0.0,0.0,0.0,1.0], reference:[0.0,0.0,0.0,1.0], samples:vec![sample] };
        let motion = authored_motion(&config, &profile, None, &[track], false).unwrap().unwrap();
        assert!((motion.horizontal + 3.0).abs() < 1e-5);
        assert!(!motion.affects_pitch);
        assert_eq!(serde_json::to_value(&motion).unwrap()["affectsPitch"], false);
        let reference = crate::bones::quat_from_channel(0, 0.3);
        let track = NativeQuaternionTrack { bone_name:"CustomHead".into(), current:reference, reference, samples:vec![crate::bones::quat_from_channel(0, 0.2)] };
        let motion = authored_motion(&config, &profile, None, &[track], true).unwrap().unwrap();
        assert!((motion.vertical - 0.6).abs() < 1e-5);
        assert!((motion.pitch - 0.2).abs() < 1e-5);
        assert!(motion.affects_pitch);
        let unrelated = NativeQuaternionTrack { bone_name:"Hand".into(), current:reference, reference, samples:vec![sample] };
        assert!(authored_motion(&config, &profile, None, &[unrelated], false).unwrap().is_none());
    }

    #[test]
    fn yaw_and_roll_contributions_do_not_claim_pitch_gravity() {
        let profile = serde_json::from_value(json!({
            "boneNodes":{"head":"CustomHead"}, "humanoidCharacterization":{"schemaVersion":1,"standard":"VRMC_vrm-1.0","roles":{"head":{"nodeKey":"head"}}}
        })).unwrap();
        let config = normalize_config(&HairPlaybackConfig::default(), &json!({"enabled":true,"inertia":1,"gravity":1})).unwrap();
        let reference = crate::bones::quat_from_channel(0, 0.3);
        for additive in [false, true] {
            let yaw_start = crate::bones::quat_from_channel(1, 0.1);
            let yaw_goal = crate::bones::quat_from_channel(1, 0.5);
            let samples = if additive { vec![yaw_start, yaw_goal] }
                else { vec![crate::bones::multiply_quat(reference, yaw_start), crate::bones::multiply_quat(reference, yaw_goal)] };
            let track = NativeQuaternionTrack { bone_name:"CustomHead".into(),
                current:crate::bones::multiply_quat(reference, yaw_start), reference, samples };
            let motion = authored_motion(&config, &profile, None, &[track], additive).unwrap().unwrap();
            assert!((motion.horizontal - 0.4).abs() < 1e-5);
            assert!(!motion.affects_pitch);
            assert!(motion.pitch.abs() < 1e-5);

            let roll_start = crate::bones::quat_from_channel(2, 0.1);
            let roll_goal = crate::bones::quat_from_channel(2, 0.5);
            let samples = if additive { vec![roll_start, roll_goal] }
                else { vec![crate::bones::multiply_quat(reference, roll_start), crate::bones::multiply_quat(reference, roll_goal)] };
            let track = NativeQuaternionTrack { bone_name:"CustomHead".into(),
                current:crate::bones::multiply_quat(reference, roll_start), reference, samples };
            assert!(authored_motion(&config, &profile, None, &[track], additive).unwrap().is_none());
        }
    }

    #[test]
    fn pitch_return_to_neutral_claims_gravity_and_fixed_one_key_pitch_still_causes_a_response() {
        let profile = serde_json::from_value(json!({
            "boneNodes":{"head":"CustomHead"}, "humanoidCharacterization":{"schemaVersion":1,"standard":"VRMC_vrm-1.0","roles":{"head":{"nodeKey":"head"}}}
        })).unwrap();
        let config = normalize_config(&HairPlaybackConfig::default(), &json!({"enabled":true,"inertia":1,"gravity":4})).unwrap();
        let reference = crate::bones::quat_from_channel(1, 0.2);
        let pitched = crate::bones::quat_from_channel(0, 0.4);
        let track = NativeQuaternionTrack { bone_name:"CustomHead".into(),
            current:crate::bones::multiply_quat(reference, pitched), reference,
            samples:vec![pitched, [0.0, 0.0, 0.0, 1.0]] };
        let motion = authored_motion(&config, &profile, None, &[track], true).unwrap().unwrap();
        assert!(motion.affects_pitch);
        assert!(motion.pitch.abs() < 1e-5);
        assert!((motion.vertical + 0.4).abs() < 1e-5);

        let fixed = crate::bones::quat_from_channel(0, 0.25);
        let track = NativeQuaternionTrack { bone_name:"CustomHead".into(), current:reference, reference, samples:vec![fixed] };
        let motion = authored_motion(&config, &profile, None, &[track], true).unwrap().unwrap();
        assert!(motion.affects_pitch);
        assert!((motion.pitch - 0.25).abs() < 1e-5);
        assert!((motion.vertical - 0.25).abs() < 1e-5);
    }

    #[test]
    fn gravity_pose_is_compiled_from_configured_pitch_without_a_runtime_sampler() {
        let config = normalize_config(&HairPlaybackConfig::default(), &json!({"morphTargets":{"headUp":{"up":{"value":0.8}},"headDown":{"down":2.0}}})).unwrap();
        let down = gravity_pose_curves(&config, 0.5, 2.0).unwrap();
        assert_eq!(down["down"], json!([{"time":0.0,"intensity":1.0,"inherit":true},{"time":2.0,"intensity":1.0}]));
        assert_eq!(down["up"][1]["intensity"], 0.0);
        let up = gravity_pose_curves(&config, -0.5, 0.0).unwrap();
        assert!((up["up"][0]["intensity"].as_f64().unwrap() - 0.4).abs() < 1e-6);
        assert_eq!(up["up"].as_array().unwrap().len(), 1);
        assert!(gravity_pose_curves(&config, 0.0, -1.0).is_err());
    }

    #[test]
    fn idle_curves_are_loopable() {
        let curves = build_idle_wind_curves(&test_config(), 2.0);
        let left = curves["L"].as_array().unwrap();
        assert!(left.len() > 2);
        let first = left[0]["intensity"].as_f64().unwrap();
        let last = left[left.len() - 1]["intensity"].as_f64().unwrap();
        assert!((first - last).abs() < 1e-5);
    }

    #[test]
    fn impulse_curves_end_at_zero() {
        let curves = build_impulse_curves(&test_config(), 0.75, 1.0, 0.0);
        let left = curves["L"].as_array().unwrap();
        assert_eq!(left[left.len() - 1]["intensity"], 0.0);
    }

    #[test]
    fn impulse_replacement_inherits_only_its_first_key_and_retains_authored_decay() {
        let mut config = test_config();
        config.stiffness = 2.5;
        config.damping = 0.25;
        let curves = build_impulse_curves(&config, 1.0, 1.0, 0.5);
        let object = curves.as_object().unwrap();
        assert_eq!(object.len(), 5);
        for points in object.values() {
            let points = points.as_array().unwrap();
            assert_eq!(points.len(), 31);
            assert_eq!(points[0]["time"], 0.0);
            assert_eq!(points[0]["inherit"], true);
            assert!(points[1..].iter().all(|point| point.get("inherit").is_none()));
            assert_eq!(points.last().unwrap()["time"], 1.0);
            assert_eq!(points.last().unwrap()["intensity"], 0.0);
        }
        // The nominal first peak remains authored data; the native mixer alone
        // replaces it at admission. Later oscillation and decay are unchanged.
        assert_eq!(curves["L"][0]["intensity"], 1.0);
        assert_eq!(curves["F"][0]["intensity"], 0.5);
        let first_swing = 0.5_f64 * (-1.0_f64 / 3.0).exp();
        let opposite_swing = 0.5_f64 * (-2.0_f64 / 3.0).exp();
        assert!((curves["L"][10]["intensity"].as_f64().unwrap() - first_swing).abs() < 1e-6);
        assert!((curves["F"][10]["intensity"].as_f64().unwrap() - first_swing * 0.5).abs() < 1e-6);
        assert!((curves["R"][20]["intensity"].as_f64().unwrap() - opposite_swing).abs() < 1e-6);
        assert!((curves["FR"][20]["intensity"].as_f64().unwrap() - opposite_swing * 0.7).abs() < 1e-6);
        assert_eq!(curves["L"][20]["intensity"], 0.0);
        assert_eq!(curves["F"][20]["intensity"], 0.0);
    }

    #[test]
    fn idle_and_gravity_curve_serialization_remain_plain_authored_samples() {
        let config = test_config();
        for curves in [build_idle_wind_curves(&config, 1.0), build_gravity_curves(&config)] {
            for points in curves.as_object().unwrap().values() {
                for point in points.as_array().unwrap() {
                    assert_eq!(point.as_object().unwrap().len(), 2);
                    assert!(point.get("inherit").is_none());
                }
            }
        }
        assert_eq!(build_gravity_curves(&config)["Up"][0], json!({"time":0.0,"intensity":1.0}));
    }

    #[test]
    fn gravity_curves_span_up_neutral_down() {
        let curves = build_gravity_curves(&test_config());
        assert!((curves["Up"][0]["intensity"].as_f64().unwrap() - 1.0).abs() < 1e-5);
        assert!((curves["Up"][1]["intensity"].as_f64().unwrap() - 0.0).abs() < 1e-5);
        assert!((curves["Down"][2]["intensity"].as_f64().unwrap() - 0.8).abs() < 1e-5);
    }
}
