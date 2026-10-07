//! Offline humanoid interchange. Playback and interpolation remain host-owned.
use crate::bones::{multiply_quat as mul, normalize_quat};
use crate::humanoid_characterization::{bone_specification, specification};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

type V3 = [f32; 3];
type Q4 = [f32; 4];
const IDENTITY: Q4 = [0., 0., 0., 1.];
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_SCALARS: usize = 8_000_000;

#[cfg(test)]
#[path = "vrm_animation_tests.rs"]
mod tests;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    id: String,
    name: String,
    parent: Option<String>,
    translation: V3,
    rotation: Q4,
    scale: V3,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rig {
    meters_per_unit: f32,
    nodes: Vec<Node>,
    humanoid_bones: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Track {
    node: String,
    path: String,
    interpolation: String,
    times: Vec<f32>,
    values: Vec<f32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    name: String,
    duration_seconds: f32,
    rig: Rig,
    tracks: Vec<Track>,
}
#[derive(Clone, Copy)]
struct World {
    position: V3,
    rotation: Q4,
    scale: f32,
}
const ORIGIN: World = World {
    position: [0.; 3],
    rotation: IDENTITY,
    scale: 1.,
};
fn inv(q: Q4) -> Q4 {
    [-q[0], -q[1], -q[2], q[3]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: V3, b: f32) -> V3 {
    [a[0] * b, a[1] * b, a[2] * b]
}
fn rotate(q: Q4, v: V3) -> V3 {
    let cross = |a: V3, b: V3| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let xyz = [q[0], q[1], q[2]];
    let t = scale(cross(xyz, v), 2.);
    add(v, add(scale(t, q[3]), cross(xyz, t)))
}
fn finite(values: &[f32]) -> bool {
    values.iter().all(|x| x.is_finite())
}
fn quaternion(q: Q4) -> Result<Q4, String> {
    let length = q.iter().map(|v| v * v).sum::<f32>();
    if !finite(&q) || (length - 1.).abs() > 0.01 {
        return Err("Rotation must be a finite unit quaternion".into());
    }
    Ok(normalize_quat(q))
}
fn read_json<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T, String> {
    if s.len() > MAX_BYTES {
        return Err("Animation JSON exceeds 64 MiB".into());
    }
    serde_json::from_str(s).map_err(|e| format!("Invalid animation JSON: {e}"))
}
fn json_result<T: Serialize>(value: Result<T, String>) -> Result<String, JsError> {
    value
        .and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
        .map_err(|e| JsError::new(&e))
}

/// Convert an explicitly referenced Mixamo rig to normalized VRM humanoid keys.
#[wasm_bindgen]
pub fn normalize_mixamo_animation(input_json: &str) -> Result<String, JsError> {
    json_result(read_json(input_json).and_then(normalize_mixamo))
}
/// Write a standalone glTF 2 GLB with VRMC_vrm_animation 1.0, suitable for .vrma.
#[wasm_bindgen]
pub fn encode_vrma_animation(animation_json: &str) -> Result<Vec<u8>, JsError> {
    read_json(animation_json)
        .and_then(encode)
        .map_err(|e| JsError::new(&e))
}
/// Decode the supported body-only VRMA subset; rejects unsupported channels.
#[wasm_bindgen]
pub fn decode_vrma_animation(bytes: &[u8]) -> Result<String, JsError> {
    json_result(decode(bytes))
}
/// Convert portable keys to target local rotations/translations without sampling.
#[wasm_bindgen]
pub fn retarget_vrma_animation(
    animation_json: &str,
    target_rig_json: &str,
) -> Result<String, JsError> {
    json_result((|| {
        retarget(read_json(animation_json)?, read_json(target_rig_json)?)
    })())
}

fn worlds(rig: &Rig) -> Result<BTreeMap<String, World>, String> {
    if !rig.meters_per_unit.is_finite()
        || rig.meters_per_unit <= 0.
        || rig.nodes.len() > 4096
        || rig.nodes.is_empty()
    {
        return Err("Rig requires 1..4096 nodes and positive finite metersPerUnit".into());
    }
    let mut result: BTreeMap<String, World> = BTreeMap::new();
    // Parent-first ordering makes cycles, missing parents and ambiguous identity errors explicit.
    for node in &rig.nodes {
        if node.id.is_empty()
            || node.id.len() > 512
            || node.name.len() > 512
            || result.contains_key(&node.id)
        {
            return Err(format!("Duplicate or empty node id: {}", node.id));
        }
        if !finite(&node.translation)
            || !finite(&node.scale)
            || node.scale[0] <= 0.
            || node
                .scale
                .iter()
                .any(|x| (*x - node.scale[0]).abs() > 1e-5 * node.scale[0])
        {
            return Err(format!(
                "{} requires finite translation and positive uniform scale (no shear/reflection)",
                node.name
            ));
        }
        let parent = match &node.parent {
            Some(id) => *result
                .get(id)
                .ok_or_else(|| format!("{} parent must precede child", node.name))?,
            None => ORIGIN,
        };
        let world = World {
            position: add(
                parent.position,
                rotate(parent.rotation, scale(node.translation, parent.scale)),
            ),
            rotation: mul(parent.rotation, quaternion(node.rotation)?),
            scale: parent.scale * node.scale[0],
        };
        if !finite(&world.position) || !world.scale.is_finite() || world.scale <= 0. {
            return Err("Rig world transform overflow".into());
        }
        result.insert(node.id.clone(), world);
    }
    let mut bound = BTreeSet::new();
    for (role, id) in &rig.humanoid_bones {
        if bone_specification(role).is_none()
            || role.ends_with("Eye")
            || !result.contains_key(id)
            || !bound.insert(id)
        {
            return Err(format!(
                "Invalid, duplicate or unsupported humanoid binding: {role}"
            ));
        }
        let spec = bone_specification(role).unwrap();
        if spec.requires_parent
            && !rig
                .humanoid_bones
                .contains_key(spec.parent.as_ref().unwrap())
        {
            return Err(format!("{role} requires its humanoid parent"));
        }
        let mut expected = spec.parent.as_deref();
        while let Some(parent_role) = expected {
            if let Some(parent_id) = rig.humanoid_bones.get(parent_role) {
                let mut actual = rig
                    .nodes
                    .iter()
                    .find(|n| n.id == *id)
                    .unwrap()
                    .parent
                    .as_deref();
                while actual.is_some() && actual != Some(parent_id.as_str()) {
                    // Crossing another humanoid role is an incompatible hierarchy.
                    if rig
                        .humanoid_bones
                        .values()
                        .any(|mapped| Some(mapped.as_str()) == actual)
                    {
                        break;
                    }
                    actual = rig
                        .nodes
                        .iter()
                        .find(|n| Some(n.id.as_str()) == actual)
                        .unwrap()
                        .parent
                        .as_deref();
                }
                if actual != Some(parent_id.as_str()) {
                    return Err(format!(
                        "{role} is not below expected humanoid parent {parent_role}"
                    ));
                }
                break;
            }
            expected = bone_specification(parent_role).and_then(|s| s.parent.as_deref());
        }
    }
    for spec in &specification().bones {
        if spec.required && !rig.humanoid_bones.contains_key(&spec.role) {
            return Err(format!("Missing required humanoid bone: {}", spec.role));
        }
    }
    validate_t_pose(rig, &result)?;
    Ok(result)
}

fn validate_t_pose(rig: &Rig, world: &BTreeMap<String, World>) -> Result<(), String> {
    let p = |role: &str| world[&rig.humanoid_bones[role]].position;
    if p("hips")[1] <= 0. {
        return Err("Reference hips must be above the model-space ground plane".into());
    }
    // Reject obvious A-poses, mirrored rigs and differing up/forward conventions.
    // Fingers and natural minor joint offsets do not need perfectly collinear bones.
    let along = |a: &str, b: &str, axis: usize, sign: f32| {
        let d = sub(p(b), p(a));
        let length = d.iter().map(|x| x * x).sum::<f32>().sqrt();
        length > 1e-6 && d[axis] * sign / length > 0.94
    };
    for side in ["left", "right"] {
        let sign = if side == "left" { 1. } else { -1. };
        for (a, b, axis, direction) in [
            ("UpperArm", "LowerArm", 0, sign),
            ("LowerArm", "Hand", 0, sign),
            ("UpperLeg", "LowerLeg", 1, -1.),
            ("LowerLeg", "Foot", 1, -1.),
        ] {
            if !along(
                &format!("{side}{a}"),
                &format!("{side}{b}"),
                axis,
                direction,
            ) {
                return Err(format!(
                    "Reference {side}{a}/{b} is not a supported VRM T-pose (+Y up, +Z forward)"
                ));
            }
        }
    }
    if p("head")[1] <= p("hips")[1] {
        return Err("Reference head must be above hips".into());
    }
    Ok(())
}

fn validate_tracks(doc: &Document, body_only: bool) -> Result<(), String> {
    if doc.version != 1
        || doc.name.len() > 512
        || !doc.duration_seconds.is_finite()
        || doc.duration_seconds < 0.
        || doc.tracks.is_empty()
        || doc.tracks.len() > 4096
    {
        return Err("Animation requires version 1, finite duration and 1..4096 tracks".into());
    }
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    for track in &doc.tracks {
        total += track.values.len() + track.times.len();
        let width = match track.path.as_str() {
            "rotation" => 4,
            "translation" | "scale" => 3,
            _ => return Err(format!("Unsupported animation path {}", track.path)),
        };
        if !seen.insert((&track.node, &track.path))
            || !doc.rig.nodes.iter().any(|n| n.id == track.node)
        {
            return Err("Animation has duplicate or missing target node".into());
        }
        if !matches!(track.interpolation.as_str(), "LINEAR" | "STEP")
            || track.times.is_empty()
            || total > MAX_SCALARS
            || track.values.len() != track.times.len() * width
            || !finite(&track.times)
            || !finite(&track.values)
            || track.times[0] < 0.
            || track.times.windows(2).any(|t| t[1] <= t[0])
            || *track.times.last().unwrap() > doc.duration_seconds + 1e-5
        {
            return Err(format!(
                "Malformed keys or unsupported interpolation for {}",
                track.node
            ));
        }
        if track.path == "rotation" {
            for q in track.values.chunks_exact(4) {
                quaternion(q.try_into().unwrap())?;
            }
        }
        if body_only
            && (!doc.rig.humanoid_bones.values().any(|id| id == &track.node)
                || track.path == "scale"
                || (track.path == "translation"
                    && doc.rig.humanoid_bones.get("hips") != Some(&track.node)))
        {
            return Err("VRMA body supports humanoid rotations and hips translation only".into());
        }
    }
    Ok(())
}

fn mixamo_role(name: &str) -> Option<String> {
    let name = name.rsplit(':').next().unwrap_or(name);
    let name = name.strip_prefix("mixamorig").unwrap_or(name);
    let basic = match name {
        "Hips" => "hips",
        "Spine" => "spine",
        "Spine1" => "chest",
        "Spine2" => "upperChest",
        "Neck" => "neck",
        "Head" => "head",
        _ => "",
    };
    if !basic.is_empty() {
        return Some(basic.into());
    }
    for (prefix, side) in [("Left", "left"), ("Right", "right")] {
        if let Some(part) = name.strip_prefix(prefix) {
            let role = match part {
                "Shoulder" => "Shoulder",
                "Arm" => "UpperArm",
                "ForeArm" => "LowerArm",
                "Hand" => "Hand",
                "UpLeg" => "UpperLeg",
                "Leg" => "LowerLeg",
                "Foot" => "Foot",
                "ToeBase" => "Toes",
                _ => "",
            };
            if !role.is_empty() {
                return Some(format!("{side}{role}"));
            }
            for finger in ["Thumb", "Index", "Middle", "Ring", "Pinky"] {
                if let Some(joint) = part.strip_prefix(&format!("Hand{finger}")) {
                    let segment = match (finger, joint) {
                        ("Thumb", "1") => "Metacarpal",
                        ("Thumb", "2") => "Proximal",
                        (_, "1") => "Proximal",
                        (_, "2") => "Intermediate",
                        (_, "3") => "Distal",
                        _ => continue,
                    };
                    let finger = if finger == "Pinky" { "Little" } else { finger };
                    return Some(format!("{side}{finger}{segment}"));
                }
            }
        }
    }
    None
}

fn normalize_mixamo(mut source: Document) -> Result<Document, String> {
    if !source.rig.humanoid_bones.is_empty() {
        return Err("Mixamo mapping is inferred; humanoidBones must be empty".into());
    }
    for node in &source.rig.nodes {
        if let Some(role) = mixamo_role(&node.name) {
            if source
                .rig
                .humanoid_bones
                .insert(role.clone(), node.id.clone())
                .is_some()
            {
                return Err(format!("Ambiguous Mixamo bone: {role}"));
            }
        }
    }
    let world = worlds(&source.rig)?;
    validate_tracks(&source, false)?;
    let mut rig = Rig {
        meters_per_unit: 1.,
        nodes: Vec::new(),
        humanoid_bones: BTreeMap::new(),
    };
    for node in &source.rig.nodes {
        let Some((role, _)) = source
            .rig
            .humanoid_bones
            .iter()
            .find(|(_, id)| *id == &node.id)
        else {
            continue;
        };
        let mut parent = node.parent.as_deref();
        let parent_role = loop {
            match parent {
                None => break None,
                Some(id) => {
                    if let Some((role, _)) = source
                        .rig
                        .humanoid_bones
                        .iter()
                        .find(|(_, mapped)| mapped.as_str() == id)
                    {
                        break Some(role.clone());
                    }
                    parent = source
                        .rig
                        .nodes
                        .iter()
                        .find(|n| n.id == id)
                        .unwrap()
                        .parent
                        .as_deref();
                }
            }
        };
        let position = scale(world[&node.id].position, source.rig.meters_per_unit);
        let parent_position = parent_role
            .as_ref()
            .map(|r| {
                scale(
                    world[&source.rig.humanoid_bones[r]].position,
                    source.rig.meters_per_unit,
                )
            })
            .unwrap_or([0.; 3]);
        rig.nodes.push(Node {
            id: role.clone(),
            name: role.clone(),
            parent: parent_role,
            translation: sub(position, parent_position),
            rotation: IDENTITY,
            scale: [1.; 3],
        });
        rig.humanoid_bones.insert(role.clone(), role.clone());
    }
    let mut tracks = Vec::new();
    for track in &source.tracks {
        let node = source
            .rig
            .nodes
            .iter()
            .find(|n| n.id == track.node)
            .unwrap();
        let role = source
            .rig
            .humanoid_bones
            .iter()
            .find(|(_, id)| *id == &track.node)
            .map(|(role, _)| role);
        if track.path == "scale"
            || (track.path == "translation" && role.map(String::as_str) != Some("hips"))
            || role.is_none()
        {
            let rest: &[f32] = match track.path.as_str() {
                "rotation" => &node.rotation,
                "translation" => &node.translation,
                _ => &node.scale,
            };
            if !track
                .values
                .chunks_exact(rest.len())
                .all(|key| key.iter().zip(rest).all(|(v, r)| (*v - *r).abs() < 1e-4))
            {
                return Err(format!("Unsupported animated {} on {} (only humanoid rotations and hips translation are portable)",track.path,node.name));
            }
            continue;
        }
        let role = role.unwrap();
        let w = world[&node.id];
        let parent = node.parent.as_ref().map(|id| world[id]).unwrap_or(ORIGIN);
        let values = if track.path == "rotation" {
            track
                .values
                .chunks_exact(4)
                .flat_map(|key| {
                    mul(
                        mul(mul(w.rotation, inv(node.rotation)), key.try_into().unwrap()),
                        inv(w.rotation),
                    )
                })
                .collect()
        } else {
            track
                .values
                .chunks_exact(3)
                .flat_map(|key| {
                    scale(
                        add(
                            parent.position,
                            rotate(
                                parent.rotation,
                                scale(key.try_into().unwrap(), parent.scale),
                            ),
                        ),
                        source.rig.meters_per_unit,
                    )
                })
                .collect()
        };
        tracks.push(Track {
            node: role.clone(),
            values,
            ..track.clone()
        });
    }
    let normalized = Document {
        rig,
        tracks,
        ..source
    };
    validate_tracks(&normalized, true)?;
    worlds(&normalized.rig)?;
    Ok(normalized)
}

fn retarget(source: Document, target: Rig) -> Result<Document, String> {
    let source_world = worlds(&source.rig)?;
    let target_world = worlds(&target)?;
    validate_tracks(&source, true)?;
    let source_hips = source_world[&source.rig.humanoid_bones["hips"]].position;
    let target_hips = target_world[&target.humanoid_bones["hips"]].position;
    let height_ratio =
        target_hips[1] * target.meters_per_unit / (source_hips[1] * source.rig.meters_per_unit);
    let mut tracks = Vec::new();
    for track in &source.tracks {
        let role = source
            .rig
            .humanoid_bones
            .iter()
            .find(|(_, id)| *id == &track.node)
            .unwrap()
            .0;
        let target_id=target.humanoid_bones.get(role).ok_or_else(||format!("Target lacks animated role {role}; optional-bone folding requires resampling and is unsupported"))?;
        let a = source
            .rig
            .nodes
            .iter()
            .find(|n| n.id == track.node)
            .unwrap();
        let b = target.nodes.iter().find(|n| &n.id == target_id).unwrap();
        let wa = source_world[&a.id];
        let wb = target_world[&b.id];
        let pa = a
            .parent
            .as_ref()
            .map(|id| source_world[id])
            .unwrap_or(ORIGIN);
        let pb = b
            .parent
            .as_ref()
            .map(|id| target_world[id])
            .unwrap_or(ORIGIN);
        let values = if track.path == "rotation" {
            track
                .values
                .chunks_exact(4)
                .flat_map(|key| {
                    let normalized = mul(
                        mul(mul(wa.rotation, inv(a.rotation)), key.try_into().unwrap()),
                        inv(wa.rotation),
                    );
                    mul(
                        mul(mul(b.rotation, inv(wb.rotation)), normalized),
                        wb.rotation,
                    )
                })
                .collect()
        } else {
            track
                .values
                .chunks_exact(3)
                .flat_map(|key| {
                    let position = add(
                        pa.position,
                        rotate(pa.rotation, scale(key.try_into().unwrap(), pa.scale)),
                    );
                    let delta = scale(
                        sub(position, source_hips),
                        source.rig.meters_per_unit * height_ratio / target.meters_per_unit,
                    );
                    scale(
                        rotate(inv(pb.rotation), sub(add(target_hips, delta), pb.position)),
                        1. / pb.scale,
                    )
                })
                .collect()
        };
        tracks.push(Track {
            node: target_id.clone(),
            values,
            ..track.clone()
        });
    }
    let result = Document {
        rig: target,
        tracks,
        ..source
    };
    validate_tracks(&result, true)?;
    Ok(result)
}

fn encode(mut doc: Document) -> Result<Vec<u8>, String> {
    worlds(&doc.rig)?;
    validate_tracks(&doc, true)?;
    // glTF derives duration from the last key. Preserve an explicit held tail
    // (including after removal of redundant static tracks) without sampling.
    let last_key = doc
        .tracks
        .iter()
        .filter_map(|t| t.times.last())
        .copied()
        .fold(0f32, f32::max);
    if doc.duration_seconds > last_key {
        let track = &mut doc.tracks[0];
        let width = if track.path == "rotation" { 4 } else { 3 };
        let held_value = track.values[track.values.len() - width..].to_vec();
        track.times.push(doc.duration_seconds);
        track.values.extend(held_value);
        validate_tracks(&doc, true)?;
    }
    if doc.rig.meters_per_unit != 1. {
        return Err("VRMA glTF distances must be meters".into());
    }
    let mut gltf = json!({"asset":{"version":"2.0","generator":"Embody"},"extensionsUsed":["VRMC_vrm_animation"],
        "extensions":{"VRMC_vrm_animation":{"specVersion":"1.0","humanoid":{"humanBones":{}}}},
        "nodes":[],"scenes":[{"nodes":[]}],"scene":0,"buffers":[],"bufferViews":[],"accessors":[],
        "animations":[{"name":doc.name,"channels":[],"samplers":[]}]});
    let indices: BTreeMap<_, _> = doc
        .rig
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    for node in &doc.rig.nodes {
        let children: Vec<_> = doc
            .rig
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.parent.as_deref() == Some(node.id.as_str()))
            .map(|(i, _)| i)
            .collect();
        let mut item = json!({"name":node.name,"translation":node.translation,"rotation":node.rotation,"scale":node.scale});
        if !children.is_empty() {
            item["children"] = json!(children);
        }
        gltf["nodes"].as_array_mut().unwrap().push(item);
        if node.parent.is_none() {
            gltf["scenes"][0]["nodes"]
                .as_array_mut()
                .unwrap()
                .push(json!(indices[node.id.as_str()]));
        }
    }
    for (role, id) in &doc.rig.humanoid_bones {
        gltf["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"][role] =
            json!({"node":indices[id.as_str()]});
    }
    let mut binary = Vec::new();
    for (i, track) in doc.tracks.iter().enumerate() {
        for (values, width) in [
            (&track.times, 1),
            (&track.values, if track.path == "rotation" { 4 } else { 3 }),
        ] {
            let offset = binary.len();
            for value in values {
                binary.extend(value.to_le_bytes());
            }
            gltf["bufferViews"]
                .as_array_mut()
                .unwrap()
                .push(json!({"buffer":0,"byteOffset":offset,"byteLength":values.len()*4}));
            let mut accessor = json!({"bufferView":gltf["bufferViews"].as_array().unwrap().len()-1,"componentType":5126,"count":values.len()/width,"type":match width{1=>"SCALAR",3=>"VEC3",_=>"VEC4"}});
            if width == 1 {
                accessor["min"] = json!([values[0]]);
                accessor["max"] = json!([values[values.len() - 1]]);
            }
            gltf["accessors"].as_array_mut().unwrap().push(accessor);
        }
        gltf["animations"][0]["samplers"]
            .as_array_mut()
            .unwrap()
            .push(json!({"input":i*2,"output":i*2+1,"interpolation":track.interpolation}));
        gltf["animations"][0]["channels"].as_array_mut().unwrap().push(json!({"sampler":i,"target":{"node":indices[track.node.as_str()],"path":track.path}}));
    }
    gltf["buffers"] = json!([{"byteLength":binary.len()}]);
    let mut json = serde_json::to_vec(&gltf).map_err(|e| e.to_string())?;
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let length = 12 + 8 + json.len() + 8 + binary.len();
    if length > MAX_BYTES {
        return Err("VRMA exceeds 64 MiB".into());
    }
    let mut bytes = Vec::with_capacity(length);
    for word in [0x46546c67, 2, length as u32, json.len() as u32, 0x4e4f534a] {
        bytes.extend(word.to_le_bytes());
    }
    bytes.extend(json);
    bytes.extend((binary.len() as u32).to_le_bytes());
    bytes.extend(0x004e4942u32.to_le_bytes());
    bytes.extend(binary);
    Ok(bytes)
}

fn integer(value: &Value, context: &str) -> Result<usize, String> {
    value
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| format!("Expected nonnegative integer: {context}"))
}
fn array<'a>(value: &'a Value, context: &str) -> Result<&'a Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("Expected array: {context}"))
}
fn at<'a>(value: &'a Value, index: usize, context: &str) -> Result<&'a Value, String> {
    array(value, context)?
        .get(index)
        .ok_or_else(|| format!("Out-of-range {context} index"))
}
fn decode(bytes: &[u8]) -> Result<Document, String> {
    if bytes.len() < 28 || bytes.len() > MAX_BYTES {
        return Err("Invalid VRMA GLB length".into());
    }
    let word = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    if word(0) != 0x46546c67
        || word(4) != 2
        || word(8) as usize != bytes.len()
        || word(16) != 0x4e4f534a
    {
        return Err("Expected glTF 2 GLB with JSON first".into());
    }
    let json_end = 20usize
        .checked_add(word(12) as usize)
        .filter(|end| {
            end.checked_add(8)
                .is_some_and(|header_end| header_end <= bytes.len())
                && *end % 4 == 0
        })
        .ok_or("Invalid GLB JSON chunk")?;
    let gltf: Value = serde_json::from_slice(&bytes[20..json_end])
        .map_err(|e| format!("Invalid GLB JSON: {e}"))?;
    if word(json_end + 4) != 0x004e4942
        || (json_end + 8).checked_add(word(json_end) as usize) != Some(bytes.len())
        || word(json_end) % 4 != 0
    {
        return Err("VRMA requires one embedded binary chunk".into());
    }
    let binary = &bytes[json_end + 8..];
    let extension = &gltf["extensions"]["VRMC_vrm_animation"];
    if gltf["asset"]["version"] != "2.0"
        || extension["specVersion"] != "1.0"
        || extension.get("expressions").is_some()
        || extension.get("lookAt").is_some()
    {
        return Err("Only VRMC_vrm_animation 1.0 body animations are supported".into());
    }
    if !array(&gltf["extensionsUsed"], "extensionsUsed")?
        .iter()
        .any(|v| v == "VRMC_vrm_animation")
    {
        return Err("Missing VRMC_vrm_animation declaration".into());
    }
    if let Some(required) = gltf.get("extensionsRequired") {
        if array(required, "extensionsRequired")?
            .iter()
            .any(|v| v != "VRMC_vrm_animation")
        {
            return Err("Unsupported required glTF extension".into());
        }
    }
    let buffers = array(&gltf["buffers"], "buffers")?;
    if buffers.len() != 1 || buffers[0].get("uri").is_some() {
        return Err("External or multiple buffers are unsupported".into());
    }
    let buffer_length = integer(&buffers[0]["byteLength"], "buffer.byteLength")?;
    if buffer_length > binary.len() || binary.len() - buffer_length > 3 {
        return Err("GLB buffer length mismatch".into());
    }
    let binary = &binary[..buffer_length];
    let nodes = array(&gltf["nodes"], "nodes")?;
    if nodes.is_empty() || nodes.len() > 4096 {
        return Err("VRMA requires 1..4096 nodes".into());
    }
    let mut parents = vec![None; nodes.len()];
    for (i, node) in nodes.iter().enumerate() {
        if node.get("matrix").is_some() || node.get("extensions").is_some() {
            return Err("Node matrices/extensions are unsupported; use explicit TRS".into());
        }
        if let Some(children) = node.get("children") {
            for child in array(children, "children")? {
                let child = integer(child, "child")?;
                if child >= nodes.len() || child == i || parents[child].replace(i).is_some() {
                    return Err("Invalid or duplicate node parent".into());
                }
            }
        }
    }
    let mut ordered = Vec::new();
    let mut emitted = BTreeSet::new();
    while ordered.len() < nodes.len() {
        let before = ordered.len();
        for (i, node) in nodes.iter().enumerate() {
            if !emitted.contains(&i) && parents[i].map(|p| emitted.contains(&p)).unwrap_or(true) {
                ordered.push(Node {
                    id: i.to_string(),
                    name: node["name"].as_str().unwrap_or("").into(),
                    parent: parents[i].map(|p| p.to_string()),
                    translation: serde_json::from_value(
                        node.get("translation")
                            .cloned()
                            .unwrap_or(json!([0., 0., 0.])),
                    )
                    .map_err(|e| e.to_string())?,
                    rotation: serde_json::from_value(
                        node.get("rotation").cloned().unwrap_or(json!(IDENTITY)),
                    )
                    .map_err(|e| e.to_string())?,
                    scale: serde_json::from_value(
                        node.get("scale").cloned().unwrap_or(json!([1., 1., 1.])),
                    )
                    .map_err(|e| e.to_string())?,
                });
                emitted.insert(i);
            }
        }
        if ordered.len() == before {
            return Err("Cyclic node hierarchy".into());
        }
    }
    let bindings = extension["humanoid"]["humanBones"]
        .as_object()
        .ok_or("Missing VRMA humanoid humanBones")?;
    let mut humanoid_bones = BTreeMap::new();
    for (role, binding) in bindings {
        humanoid_bones.insert(
            role.clone(),
            integer(&binding["node"], "humanBone.node")?.to_string(),
        );
    }
    let animations = array(&gltf["animations"], "animations")?;
    if animations.len() != 1 {
        return Err("Expected one animation per VRMA file".into());
    }
    let animation = &animations[0];
    let mut tracks = Vec::new();
    let mut duration = 0f32;
    let mut remaining_scalars = MAX_SCALARS;
    for channel in array(&animation["channels"], "channels")? {
        if tracks.len() >= 4096 {
            return Err("Too many animation channels".into());
        }
        let sampler = at(
            &animation["samplers"],
            integer(&channel["sampler"], "sampler")?,
            "samplers",
        )?;
        let path = channel["target"]["path"]
            .as_str()
            .ok_or("Missing target path")?;
        let interpolation = match sampler.get("interpolation") {
            None => "LINEAR",
            Some(Value::String(value)) if matches!(value.as_str(), "LINEAR" | "STEP") => {
                value.as_str()
            }
            _ => return Err("Unsupported or malformed VRMA sampler interpolation".into()),
        };
        let times = read_accessor(
            &gltf,
            binary,
            integer(&sampler["input"], "input")?,
            "SCALAR",
            1,
            remaining_scalars,
        )?;
        remaining_scalars -= times.len();
        let (kind, width) = match path {
            "rotation" => ("VEC4", 4),
            "translation" => ("VEC3", 3),
            _ => return Err(format!("Unsupported VRMA path {path}")),
        };
        let values = read_accessor(
            &gltf,
            binary,
            integer(&sampler["output"], "output")?,
            kind,
            width,
            remaining_scalars,
        )?;
        remaining_scalars -= values.len();
        if let Some(last) = times.last() {
            duration = duration.max(*last);
        }
        tracks.push(Track {
            node: integer(&channel["target"]["node"], "target.node")?.to_string(),
            path: path.into(),
            interpolation: interpolation.into(),
            times,
            values,
        });
    }
    let doc = Document {
        version: 1,
        name: animation["name"].as_str().unwrap_or("VRM Animation").into(),
        duration_seconds: duration,
        rig: Rig {
            meters_per_unit: 1.,
            nodes: ordered,
            humanoid_bones,
        },
        tracks,
    };
    worlds(&doc.rig)?;
    validate_tracks(&doc, true)?;
    Ok(doc)
}

fn read_accessor(
    gltf: &Value,
    binary: &[u8],
    index: usize,
    kind: &str,
    width: usize,
    remaining_scalars: usize,
) -> Result<Vec<f32>, String> {
    let a = at(&gltf["accessors"], index, "accessors")?;
    if a["componentType"] != 5126
        || a["type"] != kind
        || a.get("sparse").is_some()
        || a.get("normalized").is_some_and(|v| v != false)
    {
        return Err("Only dense float animation accessors are supported".into());
    }
    let view = at(
        &gltf["bufferViews"],
        integer(&a["bufferView"], "bufferView")?,
        "bufferViews",
    )?;
    if view["buffer"] != 0 || view.get("byteStride").is_some() {
        return Err("Only packed embedded animation accessors are supported".into());
    }
    let view_start = integer(
        view.get("byteOffset").unwrap_or(&json!(0)),
        "view.byteOffset",
    )?;
    let view_length = integer(&view["byteLength"], "view.byteLength")?;
    let offset = integer(
        a.get("byteOffset").unwrap_or(&json!(0)),
        "accessor.byteOffset",
    )?;
    let count = integer(&a["count"], "accessor.count")?;
    // A tiny GLB can reuse a large accessor thousands of times. Bound expanded
    // data before allocation, rather than validating only after cloning tracks.
    if count
        .checked_mul(width)
        .filter(|n| *n <= remaining_scalars)
        .is_none()
    {
        return Err("VRMA expanded keys exceed scalar budget".into());
    }
    let length = count.checked_mul(width * 4).ok_or("Accessor overflow")?;
    if count == 0
        || count > 2_000_000
        || view_start % 4 != 0
        || offset % 4 != 0
        || view_start
            .checked_add(view_length)
            .filter(|end| *end <= binary.len())
            .is_none()
        || offset
            .checked_add(length)
            .filter(|end| *end <= view_length)
            .is_none()
    {
        return Err("Accessor exceeds buffer bounds or is misaligned".into());
    }
    Ok(binary[view_start + offset..view_start + offset + length]
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect())
}
