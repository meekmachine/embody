//! Hair idle/impulse/gravity curve generation for AnimationMixer clips.
//!
//! Hosts only schedule the resulting curves on Three.js (or another mixer);
//! all sampling math lives here.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::math::{clamp01, finite_or};

#[derive(Deserialize, Debug, Clone, Default)]
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

#[derive(Deserialize, Debug, Clone)]
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
            (t * config.idle_sway_speed * std::f32::consts::PI * 2.0).sin() * config.idle_sway_amount
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
        let fluffy_bottom =
            clamp01((horizontal_value.abs() + vertical_value.abs()) * 0.25);

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
    serde_json::from_str(config_json).map_err(|err| format!("Invalid hair curve config JSON: {err}"))
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
