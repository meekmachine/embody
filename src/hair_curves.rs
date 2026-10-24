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

/// Bone observed by the hair response: the profile's humanoid `head` role,
/// resolved against the bound model when one is available.
pub(crate) fn head_bone_name(profile: &crate::profile::ProfileData, model: Option<&crate::profile::ModelData>) -> Option<String> {
    let role = profile.humanoid_characterization.as_ref().and_then(|mapping| mapping.roles.get("head"))?;
    let resolved = model.and_then(|model| {
        let resolver = crate::profile::NameResolver::new(profile, model);
        resolver.resolve_bone(model, profile, &role.node_key).map(|bone| bone.name.clone())
    });
    Some(resolved.unwrap_or_else(|| crate::profile_resolution::configured_bone_name(profile, &role.node_key)))
}

/// Configured gravity weight of one head-up/head-down target at a signed
/// head pitch in radians (negative looks up, positive looks down).
fn gravity_amount(morph: &HairMorphTargetNames, name: &str, pitch: f32) -> f32 {
    if pitch < 0.0 {
        morph.head_up.as_ref().and_then(|map| map.get(name)).copied().unwrap_or(0.0).clamp(0.0, 2.0) * (-pitch).min(1.0)
    } else {
        morph.head_down.as_ref().and_then(|map| map.get(name)).copied().unwrap_or(0.0).clamp(0.0, 2.0) * pitch.min(1.0)
    }
}

/// Longest render step integrated as continuous motion. A longer gap (a
/// suspended tab, a resumed host) re-anchors the response at the observed pose.
pub(crate) const MAX_HEAD_RESPONSE_STEP_SECONDS: f32 = 0.1;
const MAX_HEAD_RESPONSE_SUBSTEPS: u32 = 64;
const MAX_HEAD_LAG_RADIANS: f32 = std::f32::consts::PI;

/// Hair lag behind the observed head pose, one damped spring per axis
/// (yaw, pitch). `lag` is the head angle minus the hair angle in radians and
/// `lag_velocity` its rate in radians per second. The host supplies the
/// rendered head rotation once per render step; nothing here keeps a clock.
#[derive(Clone, Debug, Default)]
pub(crate) struct HairHeadResponse {
    observed: Option<[f32; 2]>,
    head_velocity: [f32; 2],
    lag: [f32; 2],
    lag_velocity: [f32; 2],
}

fn wrap_angle(value: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let wrapped = (value + std::f32::consts::PI).rem_euclid(tau) - std::f32::consts::PI;
    if wrapped.is_finite() { wrapped } else { 0.0 }
}

impl HairHeadResponse {
    pub(crate) fn reset(&mut self) { *self = Self::default(); }

    /// Accept `pose` as the hair's rest position without any lag or motion.
    fn anchor(&mut self, pose: [f32; 2]) {
        self.reset();
        self.observed = Some(pose);
    }

    /// Advance by one render step and return the weight of every configured
    /// hair target, in `configured_targets` order. `head` and `reference` are
    /// the head's model-space rotation now and in the captured reference pose.
    /// A non-positive `dt_seconds` (paused mixer) observes without advancing.
    pub(crate) fn step(
        &mut self, config: &HairPlaybackConfig, dt_seconds: f32, head: [f32; 4], reference: [f32; 4],
    ) -> Result<Vec<(String, f32)>, String> {
        if [head, reference].iter().any(|q| q.iter().any(|value| !value.is_finite()) || q.iter().map(|v| v * v).sum::<f32>() <= f32::EPSILON) {
            return Err("Hair head response requires finite nonzero quaternions.".into());
        }
        if !dt_seconds.is_finite() { return Err("Hair head response requires a finite step in seconds.".into()); }
        let delta = crate::bones::multiply_quat(inverse(crate::bones::normalize_quat(reference)), crate::bones::normalize_quat(head));
        let (yaw, pitch) = yaw_pitch(delta);
        let pose = [yaw * config.direction.yaw_sign, pitch * config.direction.pitch_sign];
        if config.enabled && dt_seconds > 0.0 {
            let previous = self.observed;
            match previous {
                Some(previous) if dt_seconds <= MAX_HEAD_RESPONSE_STEP_SECONDS => self.integrate(config, dt_seconds, previous, pose),
                _ => self.anchor(pose),
            }
        } else if self.observed.is_none() || !config.enabled {
            self.anchor(pose);
        }
        Ok(self.weights(config, pose[1]))
    }

    fn integrate(&mut self, config: &HairPlaybackConfig, dt: f32, previous: [f32; 2], pose: [f32; 2]) {
        // Match the impulse curve's oscillation: stiffness * 0.2 Hz, damping * 4 per second.
        let omega = std::f32::consts::TAU * (config.curves.stiffness * 0.2).max(0.5);
        let decay = (config.curves.damping * 4.0).max(0.1);
        let substeps = ((dt * omega.max(2.0 * decay) / 0.5).ceil() as u32).clamp(1, MAX_HEAD_RESPONSE_SUBSTEPS);
        let step = dt / substeps as f32;
        for axis in 0..2 {
            // The head moves at a constant rate within a render step, so a
            // change of head velocity reaches the lag rate as one impulse.
            let velocity = wrap_angle(pose[axis] - previous[axis]) / dt;
            self.lag_velocity[axis] += velocity - self.head_velocity[axis];
            self.head_velocity[axis] = velocity;
            for _ in 0..substeps {
                // Semi-implicit Euler; substeps keep omega * step <= 0.5 up to the
                // substep cap. Beyond it, the lag clamp below keeps output bounded.
                self.lag_velocity[axis] += (-omega * omega * self.lag[axis] - 2.0 * decay * self.lag_velocity[axis]) * step;
                self.lag[axis] += self.lag_velocity[axis] * step;
            }
            if !self.lag[axis].is_finite() || !self.lag_velocity[axis].is_finite() {
                self.lag[axis] = 0.0;
                self.lag_velocity[axis] = 0.0;
            }
            self.lag[axis] = self.lag[axis].clamp(-MAX_HEAD_LAG_RADIANS, MAX_HEAD_LAG_RADIANS);
        }
        self.observed = Some(pose);
    }

    fn weights(&self, config: &HairPlaybackConfig, pitch: f32) -> Vec<(String, f32)> {
        let horizontal = self.lag[0] * config.inertia * config.response_scale;
        let vertical = self.lag[1] * config.gravity * 0.25 * config.response_scale;
        let (horizontal, vertical) = if config.enabled && horizontal.is_finite() && vertical.is_finite() { (horizontal, vertical) } else { (0.0, 0.0) };
        let pitch = if config.enabled { pitch } else { 0.0 };
        let morph = &config.curves.morph_targets;
        let right = clamp01(-horizontal);
        let sway = [
            (&morph.sway_left, clamp01(horizontal)),
            (&morph.sway_right, right),
            (&morph.sway_front, clamp01(vertical)),
            (&morph.fluff_right, clamp01(right * 0.7)),
            (&morph.fluff_bottom, clamp01((horizontal.abs() + vertical.abs()) * 0.25)),
        ];
        configured_targets(config).into_iter().map(|name| {
            let mut weight = gravity_amount(morph, &name, pitch);
            for (target, value) in &sway {
                if target.as_deref() == Some(name.as_str()) { weight += value; }
            }
            (name, weight.clamp(0.0, 2.0))
        }).collect()
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct CurvePoint {
    time: f32,
    intensity: f32,
}

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
        .push(CurvePoint { time, intensity });
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
                },
                CurvePoint {
                    time: 0.5,
                    intensity: 0.0,
                },
                CurvePoint {
                    time: 1.0,
                    intensity: down,
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

    fn response_config() -> HairPlaybackConfig {
        normalize_config(&HairPlaybackConfig::default(), &json!({
            "enabled":true,"inertia":2,"gravity":4,"responseScale":3,"stiffness":7.5,"damping":0.18,
            "direction":{"yawSign":-1,"pitchSign":1},
            "morphTargets":{"swayLeft":"L","swayRight":"R","swayFront":"F","headUp":{"Up":0.8},"headDown":{"Down":2.0}}
        })).unwrap()
    }
    const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
    fn weight(weights: &[(String, f32)], name: &str) -> f32 {
        weights.iter().find(|(target, _)| target == name).map(|(_, value)| *value).unwrap()
    }
    fn assert_bounded(weights: &[(String, f32)]) {
        assert!(weights.iter().all(|(_, value)| value.is_finite() && (0.0..=2.0).contains(value)), "{weights:?}");
    }

    #[test]
    fn head_bone_comes_from_the_profile_head_role() {
        let profile: crate::profile::ProfileData = serde_json::from_value(json!({
            "boneNodes":{"head":"CustomHead"}, "humanoidCharacterization":{"schemaVersion":1,"standard":"VRMC_vrm-1.0","roles":{"head":{"nodeKey":"head"}}}
        })).unwrap();
        assert_eq!(head_bone_name(&profile, None).as_deref(), Some("CustomHead"));
        let unmapped: crate::profile::ProfileData = serde_json::from_value(json!({})).unwrap();
        assert_eq!(head_bone_name(&unmapped, None), None);
    }

    #[test]
    fn observed_head_turn_produces_a_bounded_response_that_settles_while_the_head_holds() {
        let config = response_config();
        let mut response = HairHeadResponse::default();
        let first = response.step(&config, 1.0 / 60.0, IDENTITY, IDENTITY).unwrap();
        assert_eq!(first.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), vec!["Down", "F", "L", "R", "Up"]);
        assert!(first.iter().all(|(_, value)| *value == 0.0), "the first observation anchors without a response");
        let mut peak: f32 = 0.0;
        let mut previous = 0.0;
        for frame in 1..=240 {
            let yaw = 0.5 * (frame as f32 / 6.0).min(1.0);
            let weights = response.step(&config, 1.0 / 60.0, crate::bones::quat_from_channel(1, yaw), IDENTITY).unwrap();
            assert_bounded(&weights);
            // yawSign -1 maps a positive head yaw to the right-sway target.
            let right = weight(&weights, "R");
            assert!((right - previous).abs() < 0.6, "frame {frame}: the response stays continuous");
            previous = right;
            peak = peak.max(right);
        }
        assert!(peak > 0.2, "the turn moves the hair: peak {peak}");
        let mut settled = Vec::new();
        for _ in 0..600 { settled = response.step(&config, 1.0 / 60.0, crate::bones::quat_from_channel(1, 0.5), IDENTITY).unwrap(); }
        assert!(weight(&settled, "L") < 1e-3 && weight(&settled, "R") < 1e-3, "{settled:?}");
    }

    #[test]
    fn a_repeatedly_observed_still_head_never_produces_an_impulse() {
        // Replaying or retargeting a clip that holds the same pose leaves the
        // rendered head unchanged; the response observes motion, not requests.
        let config = response_config();
        let mut response = HairHeadResponse::default();
        let pose = crate::bones::quat_from_channel(1, 0.3);
        for _ in 0..120 {
            let weights = response.step(&config, 1.0 / 30.0, pose, IDENTITY).unwrap();
            assert_eq!(weight(&weights, "L"), 0.0);
            assert_eq!(weight(&weights, "R"), 0.0);
        }
    }

    #[test]
    fn head_pitch_drives_configured_gravity_targets() {
        let config = response_config();
        let mut response = HairHeadResponse::default();
        let down = crate::bones::quat_from_channel(0, 0.5);
        let mut weights = Vec::new();
        for _ in 0..600 { weights = response.step(&config, 1.0 / 60.0, down, IDENTITY).unwrap(); }
        assert!((weight(&weights, "Down") - 1.0).abs() < 1e-4, "{weights:?}");
        assert_eq!(weight(&weights, "Up"), 0.0);
        let reference = crate::bones::quat_from_channel(0, 0.5);
        let up = crate::bones::quat_from_channel(0, 0.1);
        let weights = HairHeadResponse::default().step(&config, 1.0 / 60.0, up, reference).unwrap();
        assert!((weight(&weights, "Up") - 0.32).abs() < 1e-4, "pitch is relative to the reference pose: {weights:?}");
    }

    #[test]
    fn paused_steps_long_gaps_and_disabled_hair_do_not_advance_the_response() {
        let config = response_config();
        let mut response = HairHeadResponse::default();
        response.step(&config, 1.0 / 60.0, IDENTITY, IDENTITY).unwrap();
        let turned = crate::bones::quat_from_channel(1, 0.4);
        let paused = response.step(&config, 0.0, IDENTITY, IDENTITY).unwrap();
        assert_eq!(weight(&paused, "R"), 0.0);
        let gap = response.step(&config, 1.5, turned, IDENTITY).unwrap();
        assert_eq!(weight(&gap, "R"), 0.0, "a suspended host re-anchors instead of integrating a jump");
        let moving = response.step(&config, 1.0 / 60.0, crate::bones::quat_from_channel(1, 0.0), IDENTITY).unwrap();
        assert!(weight(&moving, "L") > 0.0);
        let disabled = normalize_config(&config, &json!({"enabled":false})).unwrap();
        let weights = response.step(&disabled, 1.0 / 60.0, turned, IDENTITY).unwrap();
        assert!(weights.iter().all(|(_, value)| *value == 0.0));
        assert!(response.step(&config, 1.0 / 60.0, [0.0; 4], IDENTITY).is_err());
        assert!(response.step(&config, f32::NAN, IDENTITY, IDENTITY).is_err());
    }

    #[test]
    fn stiff_springs_remain_stable_at_the_longest_integrated_step() {
        let config = normalize_config(&response_config(), &json!({"stiffness":500,"damping":0})).unwrap();
        let mut response = HairHeadResponse::default();
        response.step(&config, MAX_HEAD_RESPONSE_STEP_SECONDS, IDENTITY, IDENTITY).unwrap();
        for frame in 0..200 {
            let yaw = if frame % 2 == 0 { 1.0 } else { -1.0 };
            assert_bounded(&response.step(&config, MAX_HEAD_RESPONSE_STEP_SECONDS, crate::bones::quat_from_channel(1, yaw), IDENTITY).unwrap());
        }
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
    fn gravity_curves_span_up_neutral_down() {
        let curves = build_gravity_curves(&test_config());
        assert!((curves["Up"][0]["intensity"].as_f64().unwrap() - 1.0).abs() < 1e-5);
        assert!((curves["Up"][1]["intensity"].as_f64().unwrap() - 0.0).abs() < 1e-5);
        assert!((curves["Down"][2]["intensity"].as_f64().unwrap() - 0.8).abs() < 1e-5);
    }
}
