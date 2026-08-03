use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::clip::{ClipIR, ClipTrackIR};
use crate::profile::{deserialize_json, ModelData, ProfileData};
use crate::validation::{self, ValidationOptions, ValidationResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoneInfo {
    name: String,
    parent: Option<String>,
    children: Vec<String>,
    world_position: Point,
    depth: u32,
}

#[derive(Debug, Serialize)]
struct Point {
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MorphInfo {
    name: String,
    mesh_name: String,
    index: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelMeshInfo {
    name: String,
    has_morph_targets: bool,
    morph_count: usize,
}

#[derive(Debug, Serialize)]
struct ValueRange {
    min: Vec<f64>,
    max: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackInfo {
    name: String,
    target_name: String,
    property: String,
    r#type: String,
    keyframe_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    value_range: Option<ValueRange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimationInfo {
    name: String,
    duration: f64,
    tracks: Vec<TrackInfo>,
    animated_bones: Vec<String>,
    animated_morphs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedModelData {
    bones: Vec<BoneInfo>,
    morphs: Vec<MorphInfo>,
    meshes: Vec<ModelMeshInfo>,
    animations: Vec<AnimationInfo>,
    bone_names: Vec<String>,
    morph_names: Vec<String>,
    mesh_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimationSummaryClip {
    name: String,
    duration: f64,
    affected_bones: Vec<String>,
    affected_morphs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimationAnalysis {
    count: usize,
    has_idle_candidate: bool,
    clips: Vec<AnimationSummaryClip>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelAnalysisReport {
    model: ExtractedModelData,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation: Option<ValidationResult>,
    animations: AnimationAnalysis,
    overall_score: u32,
    summary: String,
}

fn value_size(track: &ClipTrackIR) -> usize {
    match track.value_type.as_str() {
        "quat" => 4,
        "vec3" => 3,
        _ => 1,
    }
}

fn value_range(track: &ClipTrackIR) -> Option<ValueRange> {
    let size = value_size(track);
    if track.values.is_empty() || track.values.len() % size != 0 {
        return None;
    }
    let mut min = vec![f64::INFINITY; size];
    let mut max = vec![f64::NEG_INFINITY; size];
    for values in track.values.chunks_exact(size) {
        for axis in 0..size {
            min[axis] = min[axis].min(values[axis]);
            max[axis] = max[axis].max(values[axis]);
        }
    }
    Some(ValueRange { min, max })
}

fn track_info(
    track: &ClipTrackIR,
    model: &ModelData,
) -> (TrackInfo, Option<String>, Option<String>) {
    let kind = track
        .target
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let property = track
        .target
        .get("property")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(match kind {
            "morphTarget" => "morphTargetInfluences",
            "meshVisibility" => "visible",
            _ => "unknown",
        })
        .to_string();
    let (target_name, track_type, bone_name, morph_name) = match kind {
        "morphTarget" => {
            let id = track
                .target
                .get("morphTargetId")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
            let morph = model.morph_targets.iter().find(|entry| entry.id == id);
            let mesh =
                morph.and_then(|morph| model.meshes.iter().find(|mesh| mesh.id == morph.mesh_id));
            (
                mesh.map(|mesh| mesh.name.clone()).unwrap_or_default(),
                "morph".to_string(),
                None,
                morph.map(|morph| morph.name.clone()),
            )
        }
        "boneTransform" => {
            let id = track
                .target
                .get("boneId")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
            let name = model
                .bones
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.name.clone())
                .unwrap_or_default();
            let track_type = if property == "position" {
                "position"
            } else if property == "scale" {
                "scale"
            } else {
                "rotation"
            };
            (name.clone(), track_type.to_string(), Some(name), None)
        }
        "objectTransform" => {
            let id = track
                .target
                .get("objectId")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
            let name = model
                .objects
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.name.clone())
                .unwrap_or_default();
            let track_type = if property == "position" {
                "position"
            } else if property == "scale" {
                "scale"
            } else {
                "rotation"
            };
            (name, track_type.to_string(), None, None)
        }
        "meshVisibility" => {
            let id = track
                .target
                .get("meshId")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
            let name = model
                .meshes
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.name.clone())
                .unwrap_or_default();
            (name, "unknown".to_string(), None, None)
        }
        _ => (String::new(), "unknown".to_string(), None, None),
    };
    let name = track.source_name.clone().unwrap_or_else(|| {
        if target_name.is_empty() {
            property.clone()
        } else {
            format!("{target_name}.{property}")
        }
    });
    (
        TrackInfo {
            name,
            target_name,
            property,
            r#type: track_type,
            keyframe_count: track.times.len(),
            value_range: value_range(track),
        },
        bone_name,
        morph_name,
    )
}

fn animation_info(clip: &ClipIR, model: &ModelData) -> AnimationInfo {
    let mut animated_bones = BTreeSet::new();
    let mut animated_morphs = BTreeSet::new();
    let tracks = clip
        .tracks
        .iter()
        .map(|track| {
            let (info, bone, morph) = track_info(track, model);
            if let Some(bone) = bone {
                animated_bones.insert(bone);
            }
            if let Some(morph) = morph {
                animated_morphs.insert(morph);
            }
            info
        })
        .collect();
    AnimationInfo {
        name: clip.name.clone(),
        duration: clip.duration_seconds,
        tracks,
        animated_bones: animated_bones.into_iter().collect(),
        animated_morphs: animated_morphs.into_iter().collect(),
    }
}

fn extract(model: &ModelData, clips: &[ClipIR]) -> ExtractedModelData {
    let children = model.bones.iter().fold(
        BTreeMap::<String, Vec<String>>::new(),
        |mut children, bone| {
            if let Some(parent) = &bone.parent_name {
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(bone.name.clone());
            }
            children
        },
    );
    let bones = model
        .bones
        .iter()
        .map(|bone| {
            let position = bone.world_position.clone().unwrap_or_default();
            BoneInfo {
                name: bone.name.clone(),
                parent: bone.parent_name.clone(),
                children: children.get(&bone.name).cloned().unwrap_or_default(),
                world_position: Point {
                    x: position.x,
                    y: position.y,
                    z: position.z,
                },
                depth: bone.depth,
            }
        })
        .collect::<Vec<_>>();
    let morphs = model
        .morph_targets
        .iter()
        .map(|morph| MorphInfo {
            name: morph.name.clone(),
            mesh_name: model
                .meshes
                .iter()
                .find(|mesh| mesh.id == morph.mesh_id)
                .map(|mesh| mesh.name.clone())
                .unwrap_or_default(),
            index: morph.host_index.unwrap_or(morph.id as i64 - 1),
        })
        .collect::<Vec<_>>();
    let meshes = model
        .meshes
        .iter()
        .map(|mesh| ModelMeshInfo {
            name: mesh.name.clone(),
            has_morph_targets: !mesh.morph_target_ids.is_empty(),
            morph_count: mesh.morph_target_ids.len(),
        })
        .collect::<Vec<_>>();
    let animations = clips
        .iter()
        .map(|clip| animation_info(clip, model))
        .collect::<Vec<_>>();
    ExtractedModelData {
        bone_names: bones.iter().map(|bone| bone.name.clone()).collect(),
        morph_names: morphs.iter().map(|morph| morph.name.clone()).collect(),
        mesh_names: meshes.iter().map(|mesh| mesh.name.clone()).collect(),
        bones,
        morphs,
        meshes,
        animations,
    }
}

fn animation_analysis(animations: &[AnimationInfo]) -> AnimationAnalysis {
    let has_idle_candidate = animations.iter().any(|animation| {
        let name = animation.name.to_ascii_lowercase();
        animation.duration > 0.5
            && animation.duration < 5.0
            && (name.contains("idle") || name.contains("stand") || name.contains("breath"))
    });
    AnimationAnalysis {
        count: animations.len(),
        has_idle_candidate,
        clips: animations
            .iter()
            .map(|animation| AnimationSummaryClip {
                name: animation.name.clone(),
                duration: animation.duration,
                affected_bones: animation.animated_bones.clone(),
                affected_morphs: animation.animated_morphs.clone(),
            })
            .collect(),
    }
}

fn summary(
    model: &ExtractedModelData,
    validation: Option<&ValidationResult>,
    animations: &AnimationAnalysis,
) -> String {
    let mut parts = vec![format!(
        "Model has {} bones, {} morphs, {} animations.",
        model.bones.len(),
        model.morphs.len(),
        animations.count
    )];
    if let Some(validation) = validation {
        if validation.score >= 70 {
            parts.push(format!(
                "Preset is compatible ({}% match).",
                validation.score
            ));
        } else if validation.score >= 40 {
            parts.push(format!(
                "Preset is partially compatible ({}% match).",
                validation.score
            ));
            if !validation.missing_bones.is_empty() {
                parts.push(format!("Missing {} bones.", validation.missing_bones.len()));
            }
            if !validation.missing_morphs.is_empty() {
                parts.push(format!(
                    "Missing {} morphs.",
                    validation.missing_morphs.len()
                ));
            }
        } else {
            parts.push(format!(
                "Preset is incompatible ({}% match).",
                validation.score
            ));
        }
        if !validation.corrections.is_empty() {
            parts.push(format!(
                "{} corrections suggested.",
                validation.corrections.len()
            ));
        }
    }
    if animations.count == 0 {
        parts.push("No animations found.".to_string());
    } else if animations.has_idle_candidate {
        parts.push("Idle animation detected.".to_string());
    }
    parts.join(" ")
}

fn parse_inputs(model_json: &str, clips_json: &str) -> Result<(ModelData, Vec<ClipIR>), String> {
    let model = deserialize_json(model_json, "Invalid model descriptor JSON")?;
    let clips = if clips_json.trim().is_empty() {
        Vec::new()
    } else {
        deserialize_json(clips_json, "Invalid animation clip JSON")?
    };
    Ok((model, clips))
}

#[wasm_bindgen]
pub fn extract_model_data_json(model_json: &str, clips_json: &str) -> Result<String, JsError> {
    let (model, clips) =
        parse_inputs(model_json, clips_json).map_err(|error| JsError::new(&error))?;
    serde_json::to_string(&extract(&model, &clips))
        .map_err(|error| JsError::new(&format!("Failed to serialize model data: {error}")))
}

#[wasm_bindgen]
pub fn analyze_model_descriptor(
    model_json: &str,
    clips_json: &str,
    profile_json: &str,
    options_json: &str,
) -> Result<String, JsError> {
    let (model, clips) =
        parse_inputs(model_json, clips_json).map_err(|error| JsError::new(&error))?;
    let extracted = extract(&model, &clips);
    let animations = animation_analysis(&extracted.animations);
    let validation = if profile_json.trim().is_empty() {
        None
    } else {
        let profile: ProfileData = deserialize_json(profile_json, "Invalid profile JSON")
            .map_err(|error| JsError::new(&error))?;
        let options: ValidationOptions = if options_json.trim().is_empty() {
            ValidationOptions::default()
        } else {
            deserialize_json(options_json, "Invalid model analysis options JSON")
                .map_err(|error| JsError::new(&error))?
        };
        Some(validation::validate(&profile, &model, &options))
    };
    let overall_score = validation.as_ref().map_or_else(
        || if animations.count > 0 { 100 } else { 80 },
        |validation| {
            let animation_score = if animations.count > 0 { 20.0 } else { 0.0 }
                + if animations.has_idle_candidate {
                    10.0
                } else {
                    0.0
                };
            (validation.score as f64 * 0.7 + animation_score * 0.3).round() as u32
        },
    );
    let summary = summary(&extracted, validation.as_ref(), &animations);
    serde_json::to_string(&ModelAnalysisReport {
        model: extracted,
        validation,
        animations,
        overall_score,
        summary,
    })
    .map_err(|error| JsError::new(&format!("Failed to serialize model analysis: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_model_and_identifies_idle_clips() {
        let model: ModelData = deserialize_json(
            r#"{"meshes":[{"id":1,"name":"Face","morphTargetIds":[1]}],"morphTargets":[{"id":1,"meshId":1,"name":"Smile","hostIndex":0}],"bones":[{"id":1,"name":"Head","parentName":null,"worldPosition":{"x":0,"y":1,"z":0},"depth":0}],"objects":[]}"#,
            "model",
        )
        .unwrap();
        let clips: Vec<ClipIR> = deserialize_json(
            r#"[{"name":"Idle","durationSeconds":2,"channels":[{"id":1,"kind":"custom"}],"tracks":[{"id":1,"channelId":1,"target":{"kind":"boneTransform","boneId":1,"property":"rotation"},"valueType":"quat","times":[0,1],"values":[0,0,0,1,0,0,0,1]}]}]"#,
            "clips",
        )
        .unwrap();
        let extracted = extract(&model, &clips);
        assert_eq!(extracted.bones[0].name, "Head");
        assert_eq!(extracted.morphs[0].mesh_name, "Face");
        assert!(animation_analysis(&extracted.animations).has_idle_candidate);
    }
}
