use super::{error, geometry::*, markers, parse, targets};
use crate::annotation_camera::{
    normalize_camera_angle_degrees, quat_or_identity, rotate_by_quat, sub3,
};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn annotation_query(operation: &str, payload_json: &str) -> Result<String, JsError> {
    let payload = parse(payload_json).map_err(error)?;
    query(operation, &payload)
        .map(|v| v.to_string())
        .map_err(error)
}
pub(super) fn query(op: &str, p: &Value) -> Result<Value, String> {
    Ok(match op {
        "anchor" => {
            if !p["region"].is_object() {
                return Err("Annotation region must be an object".into());
            }
            super::validate_regions(&[p["region"].clone()])?;
            super::geometry::anchor_region(&p["region"])
        }
        "faceAnchor" => json!(
            text(&p["resolved"]["anchor"], "type") == "face-center"
                || (p["resolved"]["useLegacyRegionSemantics"] == true
                    && text(&p["resolved"]["region"], "name")
                        .to_lowercase()
                        .contains("face"))
        ),
        "projectAnchor" => match text(&p["resolved"], "projection") {
            "legacy" => p["legacyDefault"].clone(),
            "project" => json!(true),
            _ => json!(false),
        },
        "side" => {
            let s = text(&p["region"]["runtimeAnnotation"], "side");
            if ["left", "right", "center"].contains(&s) {
                json!(s)
            } else {
                Value::Null
            }
        }
        "inferPreviewSide" => targets::infer_preview_side(
            &p["au"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| p["au"].to_string()),
            &p["profile"],
        ),
        "continuumTarget" => {
            let sticky = &p["stickyId"];
            if !sticky.is_null() && (sticky == &p["negId"] || sticky == &p["posId"]) {
                sticky.clone()
            } else if number(p, "value", 0.) > 0. {
                p["posId"].clone()
            } else {
                p["negId"].clone()
            }
        }
        "meshSideOffset" => markers::mesh_side_offset(
            &p["region"],
            number(p, "sideSign", -1.),
            point(&p["size"]).unwrap_or([0.; 3]),
        )
        .map(point_json)
        .unwrap_or(Value::Null),
        "defaultLaterality" => {
            json!({"leftSideX":-1,"confidence":0,"evidence":["default:left=-X"]})
        }
        "sideSign" => json!(side_sign(
            text(p, "side"),
            number(&p["laterality"], "leftSideX", -1.)
        )),
        "semanticSign" => side(text(p, "name"))
            .map(|s| json!(side_sign(s, number(&p["laterality"], "leftSideX", -1.))))
            .unwrap_or(Value::Null),
        "cameraAngle" | "visibilityAngle" => camera_angle(
            &p["region"],
            number(&p["laterality"], "leftSideX", -1.),
            op == "visibilityAngle",
        )
        .map(|n| json!(n))
        .unwrap_or(Value::Null),
        "worldDirection" => {
            let q: Vec<f32> = p["quaternion"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_f64)
                        .map(|n| n as f32)
                        .collect()
                })
                .unwrap_or_default();
            point_json(crate::annotation_camera::normalize3(rotate_by_quat(
                quat_or_identity(&q),
                point(&p["direction"]).unwrap_or([0., 0., 1.]),
            )))
        }
        "orbitAngle" => {
            let mut q: Vec<f32> = p["quaternion"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_f64)
                        .map(|n| n as f32)
                        .collect()
                })
                .unwrap_or_default();
            if q.len() == 4 {
                for n in &mut q[..3] {
                    *n = -*n
                }
            }
            let delta = rotate_by_quat(
                quat_or_identity(&q),
                sub3(
                    point(&p["position"]).unwrap_or([0.; 3]),
                    point(&p["center"]).unwrap_or([0.; 3]),
                ),
            );
            json!(normalize_camera_angle_degrees(
                delta[0].atan2(delta[2]).to_degrees()
            ))
        }
        "faceCenter" | "laterality" => {
            let model: Model =
                serde_json::from_value(p["model"].clone()).map_err(|e| e.to_string())?;
            model.validate()?;
            if op == "faceCenter" {
                let (center, head) = model.face(&p["region"], &p["profile"]);
                json!({"center":point_json(center),"headBonePosition":head.and_then(|id|model.object(id)).map(|o|point_json(o.position)),"method":"rust-anchor","debugInfo":[]})
            } else {
                let (left, confidence) = model.laterality(
                    p["regions"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    &p["profile"],
                );
                json!({"leftSideX":left,"confidence":confidence,"evidence":if confidence == 0. {json!(["default:left=-X"])} else {json!([])}})
            }
        }
        "isRuntimeName" => json!(text(p, "name").starts_with(targets::PREFIX)),
        "regions" => p["config"]["regions"]
            .as_array()
            .or_else(|| p["config"]["annotationRegions"].as_array())
            .map(|regions| json!(regions))
            .unwrap_or(json!([])),
        "viewRegionIndices" => json!(p["regions"]
            .as_array()
            .map(|regions| regions
                .iter()
                .enumerate()
                .filter(|(_, region)| !text(region, "name").starts_with(targets::PREFIX))
                .map(|(index, _)| index)
                .collect::<Vec<_>>())
            .unwrap_or_default()),
        "viewRegions" => json!(p["regions"]
            .as_array()
            .map(|a| a
                .iter()
                .filter(|r| !text(r, "name").starts_with(targets::PREFIX))
                .cloned()
                .collect::<Vec<_>>())
            .unwrap_or_default()),
        "displayOptions" => {
            let regions = p["regions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|region| !text(region, "name").starts_with(targets::PREFIX))
                .collect::<Vec<_>>();
            let mut options = Vec::new();
            for region in &regions {
                let mut depth = 0;
                let mut current = region;
                let mut visited = std::collections::HashSet::new();
                while !text(current, "parent").is_empty() && visited.insert(text(current, "name")) {
                    let Some(parent) = regions
                        .iter()
                        .find(|other| text(other, "name") == text(current, "parent"))
                    else {
                        break;
                    };
                    depth += 1;
                    current = parent;
                }
                options.push(json!({"name":region["name"], "label":format!("{}{}", "-- ".repeat(depth), format_label(text(region,"name")))}));
            }
            json!(options)
        }
        "revealOptions" => super::lifecycle::reveal_options(&p["config"]),
        "morphNames" => {
            if text(&p["region"]["runtimeAnnotation"], "targetType") == "au" {
                json!(strings(&p["region"]["runtimeAnnotation"]["morphNames"]))
            } else {
                json!([])
            }
        }
        "modelNames" | "validateCharacter" => model_query(op, p)?,
        "boneProfile" => {
            let config = &p["config"];
            let source = if config["profile"].is_object() {
                &config["profile"]
            } else {
                config
            };
            let mut profile = json!({});
            for key in ["boneNodes", "bonePrefix", "boneSuffix", "suffixPattern"] {
                if !source[key].is_null() {
                    profile[key] = source[key].clone()
                } else if !config[key].is_null() {
                    profile[key] = config[key].clone()
                }
            }
            profile
        }
        _ => return Err(format!("Unknown annotation query {op}")),
    })
}
fn model_query(op: &str, p: &Value) -> Result<Value, String> {
    let model = if p["model"].is_null() {
        None
    } else {
        Some(serde_json::from_value::<Model>(p["model"].clone()).map_err(|e| e.to_string())?)
    };
    let objects = model.as_ref().map(|m| m.objects.as_slice()).unwrap_or(&[]);
    let bones = objects
        .iter()
        .filter(|o| o.kind == "Bone")
        .map(|o| o.name.clone())
        .collect::<Vec<_>>();
    let meshes = objects
        .iter()
        .filter(|o| o.kind == "Mesh")
        .map(|o| o.name.clone())
        .collect::<Vec<_>>();
    let morphs = objects
        .iter()
        .flat_map(|o| o.morph_names.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if op == "modelNames" {
        return Ok(json!(match text(p, "kind") {
            "bones" => bones,
            "meshes" => meshes,
            _ => morphs,
        }));
    }
    let mut bone_result = json!({"found":[],"missing":[],"unexpected":[]});
    let mut morph_result = bone_result.clone();
    let expected_bones = p["expectedBones"].as_object().cloned().unwrap_or_default();
    let expected_morphs = strings(&p["expectedMorphs"]);
    for (semantic, name) in &expected_bones {
        if let Some(name) = name.as_str() {
            let key = if bones.iter().any(|n| n == name) {
                "found"
            } else {
                "missing"
            };
            bone_result[key]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name,"semantic":semantic}))
        }
    }
    for name in &bones {
        if !expected_bones.values().any(|v| v.as_str() == Some(name)) {
            bone_result["unexpected"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name}))
        }
    }
    for name in &expected_morphs {
        let key = if morphs.contains(name) {
            "found"
        } else {
            "missing"
        };
        morph_result[key]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":name}))
    }
    for name in &morphs {
        if !expected_morphs.contains(name) {
            morph_result["unexpected"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name}))
        }
    }
    let count = |r: &Value, k: &str| r[k].as_array().map(Vec::len).unwrap_or(0);
    let valid = model.is_some()
        && count(&bone_result, "missing") == 0
        && count(&morph_result, "missing") == 0;
    let summary = if model.is_none() {
        "No model loaded".into()
    } else if valid {
        format!(
            "Valid: {} bones, {} morphs",
            count(&bone_result, "found"),
            count(&morph_result, "found")
        )
    } else {
        let mut parts = Vec::new();
        for (result, kind) in [(&bone_result, "bones"), (&morph_result, "morphs")] {
            let n = count(result, "missing");
            if n > 0 {
                parts.push(format!("{n} missing {kind}"))
            }
        }
        parts.join(", ")
    };
    Ok(
        json!({"valid":valid,"bones":bone_result,"morphs":morph_result,"meshes":{"found":meshes,"total":meshes.len()},"summary":summary}),
    )
}
#[wasm_bindgen]
pub fn annotation_morph_candidates(base: &[f32], morphs: &[f32], relative: bool) -> Box<[f32]> {
    markers::morph_candidates(base, morphs, relative).into_boxed_slice()
}
#[wasm_bindgen]
pub fn annotation_morph_center(
    region_json: &str,
    candidates: &[f32],
) -> Result<Box<[f32]>, JsError> {
    let region = parse(region_json).map_err(error)?;
    Ok(markers::morph_center(&region, candidates)
        .map(|p| p.to_vec())
        .unwrap_or_default()
        .into_boxed_slice())
}
/// Select vertices influenced by any requested skeleton index. The adapter
/// evaluates these indices through the native skinned vertex API.
#[wasm_bindgen]
pub fn annotation_bone_vertices(indices: &[f32], weights: &[f32], bones: &[u32]) -> Box<[u32]> {
    indices
        .chunks_exact(4)
        .zip(weights.chunks_exact(4))
        .enumerate()
        .filter(|(_, (i, w))| (0..4).any(|axis| w[axis] > 0.1 && bones.contains(&(i[axis] as u32))))
        .map(|(index, _)| index as u32)
        .collect::<Vec<_>>()
        .into_boxed_slice()
}
#[wasm_bindgen]
pub fn annotation_point_bounds(points: &[f32]) -> Box<[f32]> {
    let mut bounds: Option<Bounds> = None;
    for p in points
        .chunks_exact(3)
        .filter(|p| p.iter().all(|v| v.is_finite()))
    {
        let p = [p[0], p[1], p[2]];
        if let Some(b) = bounds.as_mut() {
            b.include(p)
        } else {
            bounds = Some(Bounds::at(p))
        }
    }
    bounds
        .map(|b| b.min.into_iter().chain(b.max).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_boxed_slice()
}
