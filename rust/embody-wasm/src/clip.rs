//! Clip compilation, ported from the TypeScript `TsClipCompiler`.
//!
//! Compiles track/curve inputs into the host-neutral ClipIR JSON. Hosts only
//! translate the finished ClipIR into their engine's clip type (e.g.
//! `ThreeClipAdapter` -> THREE.AnimationClip).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipChannel {
    pub id: u32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum KeyframeValue {
    Scalar(f64),
    Vector(Vec<f64>),
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeInput {
    pub time: f64,
    pub value: KeyframeValue,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackInput {
    #[serde(default)]
    pub id: Option<u32>,
    #[serde(default)]
    pub channel_id: Option<u32>,
    pub target: Value,
    pub value_type: String,
    pub keyframes: Vec<KeyframeInput>,
    #[serde(default)]
    pub interpolation: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub channels: Option<Vec<ClipChannel>>,
    pub tracks: Vec<TrackInput>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub time: f64,
    pub intensity: f64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurveTarget {
    #[serde(default)]
    pub channel_id: Option<u32>,
    pub target: Value,
    #[serde(default)]
    pub value_type: Option<String>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub interpolation: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum CurveTargets {
    One(CurveTarget),
    Many(Vec<CurveTarget>),
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CurvesInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub curves: std::collections::BTreeMap<String, Vec<CurvePoint>>,
    pub targets: std::collections::BTreeMap<String, CurveTargets>,
    #[serde(default)]
    pub channels: Option<Vec<ClipChannel>>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub intensity_scale: Option<f64>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipTrackIR {
    pub id: u32,
    pub channel_id: u32,
    pub target: Value,
    pub value_type: String,
    pub times: Vec<f64>,
    pub values: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpolation: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipIR {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub duration_seconds: f64,
    pub channels: Vec<ClipChannel>,
    pub tracks: Vec<ClipTrackIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

const DEFAULT_CHANNEL_ID: u32 = 1;

fn value_size(value_type: &str) -> Result<usize, String> {
    match value_type {
        "scalar" => Ok(1),
        "vec3" => Ok(3),
        "quat" => Ok(4),
        other => Err(format!("Unknown clip track value type \"{other}\".")),
    }
}

fn encode_value(value: &KeyframeValue, size: usize) -> Result<Vec<f64>, String> {
    let values: Vec<f64> = match value {
        KeyframeValue::Scalar(scalar) => vec![*scalar],
        KeyframeValue::Vector(vector) => vector.clone(),
    };
    if values.len() != size {
        return Err(format!(
            "Expected {size} values for keyframe, received {}.",
            values.len()
        ));
    }
    for entry in &values {
        if !entry.is_finite() {
            return Err(format!("Invalid keyframe value \"{entry}\"."));
        }
    }
    Ok(values)
}

fn normalize_channels(channels: Option<Vec<ClipChannel>>) -> Vec<ClipChannel> {
    match channels {
        Some(channels) if !channels.is_empty() => channels,
        _ => vec![ClipChannel {
            id: DEFAULT_CHANNEL_ID,
            kind: "face".to_string(),
            name: Some("default".to_string()),
        }],
    }
}

fn compile_track(track: &TrackInput, index: usize) -> Result<ClipTrackIR, String> {
    if track.keyframes.is_empty() {
        return Err("ClipIR tracks require at least one keyframe.".to_string());
    }

    let size = value_size(&track.value_type)?;
    let mut times = Vec::with_capacity(track.keyframes.len());
    let mut values = Vec::with_capacity(track.keyframes.len() * size);

    for keyframe in &track.keyframes {
        if !keyframe.time.is_finite() || keyframe.time < 0.0 {
            return Err(format!("Invalid keyframe time \"{}\".", keyframe.time));
        }
        times.push(keyframe.time);
        values.extend(encode_value(&keyframe.value, size)?);
    }

    Ok(ClipTrackIR {
        id: track.id.unwrap_or((index + 1) as u32),
        channel_id: track.channel_id.unwrap_or(DEFAULT_CHANNEL_ID),
        target: track.target.clone(),
        value_type: track.value_type.clone(),
        times,
        values,
        interpolation: track.interpolation.clone(),
    })
}

fn infer_duration_seconds(tracks: &[ClipTrackIR]) -> f64 {
    tracks
        .iter()
        .flat_map(|track| track.times.iter())
        .fold(0.0f64, |duration, time| duration.max(*time))
}

pub fn compile(input: ClipInput) -> Result<ClipIR, String> {
    let channels = normalize_channels(input.channels);
    let tracks: Vec<ClipTrackIR> = input
        .tracks
        .iter()
        .enumerate()
        .map(|(index, track)| compile_track(track, index))
        .collect::<Result<_, _>>()?;

    let duration_seconds = input
        .duration_seconds
        .unwrap_or_else(|| infer_duration_seconds(&tracks));

    Ok(ClipIR {
        id: input.id,
        name: input.name,
        duration_seconds,
        channels,
        tracks,
        metadata: input.metadata,
    })
}

pub fn compile_curves(input: CurvesInput) -> Result<ClipIR, String> {
    let intensity_scale = input.intensity_scale.unwrap_or(1.0);
    let mut tracks: Vec<TrackInput> = Vec::new();

    for (curve_id, curve) in &input.curves {
        let Some(targets) = input.targets.get(curve_id) else {
            continue;
        };
        if curve.is_empty() {
            continue;
        }

        let target_list: Vec<&CurveTarget> = match targets {
            CurveTargets::One(target) => vec![target],
            CurveTargets::Many(list) => list.iter().collect(),
        };

        for target in target_list {
            let scale = target.scale.unwrap_or(1.0) * intensity_scale;
            tracks.push(TrackInput {
                id: None,
                channel_id: target.channel_id,
                target: target.target.clone(),
                value_type: target.value_type.clone().unwrap_or_else(|| "scalar".to_string()),
                interpolation: target.interpolation.clone(),
                keyframes: curve
                    .iter()
                    .map(|point| KeyframeInput {
                        time: point.time,
                        value: KeyframeValue::Scalar(point.intensity * scale),
                    })
                    .collect(),
            });
        }
    }

    compile(ClipInput {
        id: input.id,
        name: input.name,
        duration_seconds: input.duration_seconds,
        channels: input.channels,
        tracks,
        metadata: input.metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiles_tracks_and_infers_duration() {
        let input: ClipInput = serde_json::from_value(json!({
            "name": "Test",
            "tracks": [
                {
                    "target": { "kind": "morphTarget", "meshId": 1, "morphTargetId": 7 },
                    "valueType": "scalar",
                    "keyframes": [
                        { "time": 0.0, "value": 0.0 },
                        { "time": 1.5, "value": 0.8 }
                    ]
                },
                {
                    "target": { "kind": "boneTransform", "boneId": 4, "property": "rotation" },
                    "valueType": "quat",
                    "keyframes": [
                        { "time": 0.0, "value": [0.0, 0.0, 0.0, 1.0] }
                    ]
                }
            ]
        }))
        .unwrap();

        let clip = compile(input).unwrap();
        assert_eq!(clip.duration_seconds, 1.5);
        assert_eq!(clip.channels.len(), 1);
        assert_eq!(clip.tracks.len(), 2);
        assert_eq!(clip.tracks[0].id, 1);
        assert_eq!(clip.tracks[0].values, vec![0.0, 0.8]);
        assert_eq!(clip.tracks[1].values, vec![0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn compiles_curves_with_scales() {
        let input: CurvesInput = serde_json::from_value(json!({
            "name": "Curves",
            "intensityScale": 2.0,
            "curves": {
                "smile": [
                    { "time": 0.0, "intensity": 0.0 },
                    { "time": 0.5, "intensity": 0.4 }
                ]
            },
            "targets": {
                "smile": { "target": { "kind": "morphTarget", "meshId": 1, "morphTargetId": 3 }, "scale": 0.5 }
            }
        }))
        .unwrap();

        let clip = compile_curves(input).unwrap();
        assert_eq!(clip.tracks.len(), 1);
        // 0.4 * 0.5 (target scale) * 2.0 (intensity scale) = 0.4
        assert_eq!(clip.tracks[0].values, vec![0.0, 0.4]);
        assert_eq!(clip.duration_seconds, 0.5);
    }

    #[test]
    fn rejects_invalid_keyframes() {
        let input: ClipInput = serde_json::from_value(json!({
            "name": "Bad",
            "tracks": [
                {
                    "target": { "kind": "morphTarget", "meshId": 1, "morphTargetId": 7 },
                    "valueType": "vec3",
                    "keyframes": [{ "time": 0.0, "value": [1.0, 2.0] }]
                }
            ]
        }))
        .unwrap();
        assert!(compile(input).is_err());
    }
}
