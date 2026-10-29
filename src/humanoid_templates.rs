use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::profile::{deserialize_json, ModelData};

const CC4_HUMANOID_TEMPLATE_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/templates/cc4-humanoid.json"
));

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanoidSkeletonTemplateBone {
    pub name: String,
    pub parent: Option<String>,
    pub translation: [f64; 3],
    #[serde(default = "identity_rotation")]
    pub rotation: [f64; 4],
    #[serde(default = "identity_scale")]
    pub scale: [f64; 3],
}

fn identity_rotation() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn identity_scale() -> [f64; 3] {
    [1.0; 3]
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanoidSkeletonTemplate {
    pub id: String,
    pub source_character_id: String,
    pub source_asset: String,
    pub source_skin_name: String,
    pub bones: Vec<HumanoidSkeletonTemplateBone>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractOptions {
    id: String,
    source_character_id: String,
    #[serde(default)]
    source_asset: String,
    #[serde(default)]
    source_skin_name: String,
}

fn cc4_humanoid_template() -> &'static HumanoidSkeletonTemplate {
    static TEMPLATE: OnceLock<HumanoidSkeletonTemplate> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        deserialize_json(
            CC4_HUMANOID_TEMPLATE_JSON,
            "Invalid embedded humanoid template",
        )
        .expect("embedded humanoid template must be valid")
    })
}

fn parse_template(json: &str) -> Result<HumanoidSkeletonTemplate, String> {
    if json.trim().is_empty() {
        Ok(cc4_humanoid_template().clone())
    } else {
        deserialize_json(json, "Invalid humanoid skeleton template JSON")
    }
}

// Column-major matrices, matching glTF and Three.js. Keep the complete parent
// matrix: composing only positions (or decomposing accumulated TRS) loses rotated
// offsets and can discard shear introduced by rotated, non-uniform scales.
fn local_matrix(bone: &HumanoidSkeletonTemplateBone) -> [f64; 16] {
    let [x, y, z, w] = bone.rotation;
    let [sx, sy, sz] = bone.scale;
    let [tx, ty, tz] = bone.translation;
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [
        (1.0 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.0,
        (xy - wz) * sy,
        (1.0 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0.0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1.0 - (xx + yy)) * sz,
        0.0,
        tx,
        ty,
        tz,
        1.0,
    ]
}

fn multiply_matrices(parent: &[f64; 16], local: &[f64; 16]) -> [f64; 16] {
    let mut result = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            result[column * 4 + row] = (0..4)
                .map(|k| parent[k * 4 + row] * local[column * 4 + k])
                .sum();
        }
    }
    result
}

fn rest_matrices(
    template: &HumanoidSkeletonTemplate,
) -> Result<BTreeMap<String, [f64; 16]>, String> {
    if template.bones.is_empty() {
        return Err("Humanoid skeleton template has no bones".to_string());
    }
    let mut matrices = BTreeMap::<String, [f64; 16]>::new();
    let mut unresolved = template
        .bones
        .iter()
        .map(|bone| bone.name.clone())
        .collect::<BTreeSet<_>>();

    while !unresolved.is_empty() {
        let before = unresolved.len();
        for bone in &template.bones {
            if !unresolved.contains(&bone.name) {
                continue;
            }
            let local = local_matrix(bone);
            let matrix = match &bone.parent {
                None => local,
                Some(parent) => match matrices.get(parent) {
                    Some(parent) => multiply_matrices(parent, &local),
                    None => continue,
                },
            };
            matrices.insert(bone.name.clone(), matrix);
            unresolved.remove(&bone.name);
        }
        if unresolved.len() == before {
            return Err(format!(
                "Humanoid skeleton template has unresolved parents for: {}",
                unresolved.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }

    Ok(matrices)
}

fn rest_bounds(template: &HumanoidSkeletonTemplate) -> Result<[f64; 6], String> {
    let matrices = rest_matrices(template)?;
    let mut bounds = [f64::INFINITY; 6];
    bounds[3] = f64::NEG_INFINITY;
    bounds[4] = f64::NEG_INFINITY;
    bounds[5] = f64::NEG_INFINITY;
    for matrix in matrices.values() {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(matrix[12 + axis]);
            bounds[axis + 3] = bounds[axis + 3].max(matrix[12 + axis]);
        }
    }
    Ok(bounds)
}

#[wasm_bindgen]
pub fn list_humanoid_skeleton_templates_json() -> Result<String, JsError> {
    serde_json::to_string(&[cc4_humanoid_template()])
        .map_err(|error| JsError::new(&format!("Failed to serialize humanoid templates: {error}")))
}

#[wasm_bindgen]
pub fn get_humanoid_skeleton_template_json(id: &str) -> Result<String, JsError> {
    let value = (id == cc4_humanoid_template().id).then(cc4_humanoid_template);
    serde_json::to_string(&value)
        .map_err(|error| JsError::new(&format!("Failed to serialize humanoid template: {error}")))
}

#[wasm_bindgen]
pub fn humanoid_skeleton_template_bone_names(template_json: &str) -> Result<String, JsError> {
    let template = parse_template(template_json).map_err(|error| JsError::new(&error))?;
    serde_json::to_string(
        &template
            .bones
            .iter()
            .map(|bone| &bone.name)
            .collect::<Vec<_>>(),
    )
    .map_err(|error| JsError::new(&format!("Failed to serialize bone names: {error}")))
}

#[wasm_bindgen]
pub fn create_validation_skeleton_json(template_json: &str) -> Result<String, JsError> {
    let template = parse_template(template_json).map_err(|error| JsError::new(&error))?;
    let bones = template
        .bones
        .iter()
        .map(|bone| serde_json::json!({ "name": bone.name }))
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({ "bones": bones }))
        .map_err(|error| JsError::new(&format!("Failed to serialize validation skeleton: {error}")))
}

#[wasm_bindgen]
pub fn compute_humanoid_skeleton_template_rest_bounds(
    template_json: &str,
) -> Result<Box<[f64]>, JsError> {
    let template = parse_template(template_json).map_err(|error| JsError::new(&error))?;
    Ok(Box::new(
        rest_bounds(&template).map_err(|error| JsError::new(&error))?,
    ))
}

#[wasm_bindgen]
pub fn extract_humanoid_skeleton_template_json(
    model_json: &str,
    options_json: &str,
) -> Result<String, JsError> {
    let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")
        .map_err(|error| JsError::new(&error))?;
    let options: ExtractOptions = deserialize_json(options_json, "Invalid template options JSON")
        .map_err(|error| JsError::new(&error))?;
    if options.id.trim().is_empty() || options.source_character_id.trim().is_empty() {
        return Err(JsError::new(
            "id and sourceCharacterId must be non-empty strings",
        ));
    }
    if model.bones.is_empty() {
        return Err(JsError::new(
            "Cannot extract humanoid skeleton template from a model with no bones",
        ));
    }
    let bones = model
        .bones
        .iter()
        .map(|bone| {
            let position = bone
                .rest_transform
                .as_ref()
                .and_then(|transform| transform.position.as_ref())
                .cloned()
                .unwrap_or_default();
            HumanoidSkeletonTemplateBone {
                name: bone.name.clone(),
                parent: bone.parent_name.clone(),
                translation: [position.x as f64, position.y as f64, position.z as f64],
                // This legacy descriptor extractor remains translation-only.
                // General rest-pose extraction is phase two of LoomLarge #483.
                rotation: identity_rotation(),
                scale: identity_scale(),
            }
        })
        .collect();
    let template = HumanoidSkeletonTemplate {
        id: options.id,
        source_character_id: options.source_character_id,
        source_asset: options.source_asset,
        source_skin_name: options.source_skin_name,
        bones,
    };
    serde_json::to_string(&template)
        .map_err(|error| JsError::new(&format!("Failed to serialize humanoid template: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_template_matches_reviewed_source_landmarks_and_bounds() {
        let template = cc4_humanoid_template();
        assert_eq!(template.id, "cc4-humanoid");
        assert_eq!(template.bones.len(), 101);
        let matrices = rest_matrices(template).unwrap();
        // Independently measured from Jonathan's authored glTF rest scene,
        // including Armature's scale. Coordinates are Y-up metres.
        let landmarks = [
            (
                "CC_Base_Hip",
                [0.0, 1.0233649628496708, 3.502829158472763e-8],
            ),
            (
                "CC_Base_L_Foot",
                [
                    0.07909041879238371,
                    0.05915138441647877,
                    -0.0392840505172362,
                ],
            ),
            (
                "CC_Base_R_Foot",
                [
                    -0.07906649878077213,
                    0.05922174716491391,
                    -0.039343487761360256,
                ],
            ),
            (
                "CC_Base_L_Hand",
                [0.45852487916312096, 1.045450789545773, -0.07831043447798759],
            ),
            (
                "CC_Base_R_Hand",
                [-0.458520845398502, 1.0454302728719786, -0.07827835857603803],
            ),
            (
                "CC_Base_Head",
                [
                    4.16466808997218e-6,
                    1.6473637850150162,
                    -0.029690342793475693,
                ],
            ),
        ];
        for (name, expected) in landmarks {
            assert_close(&matrices[name][12..15], &expected);
        }
        assert_close(
            &rest_bounds(template).unwrap(),
            &[
                -0.5578611774224631,
                0.0,
                -0.11902267382729066,
                0.5578652603846969,
                1.726530169334735,
                0.13601826252530588,
            ],
        );
    }

    fn assert_close(actual: &[f64], expected: &[f64]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
        }
    }

    #[test]
    fn composes_rotated_scaled_ancestors_independent_of_bone_order() {
        // The rotated child under a non-uniformly scaled root produces a world
        // matrix that cannot be represented faithfully by adding translations.
        let mut template = cc4_humanoid_template().clone();
        let quarter_turn = [
            0.0,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        ];
        template.bones = vec![
            HumanoidSkeletonTemplateBone {
                name: "Tip".into(),
                parent: Some("Child".into()),
                translation: [1.0, 1.0, 1.0],
                rotation: identity_rotation(),
                scale: identity_scale(),
            },
            HumanoidSkeletonTemplateBone {
                name: "Child".into(),
                parent: Some("Root".into()),
                translation: [1.0, 0.0, 0.0],
                rotation: quarter_turn,
                scale: [5.0, 6.0, 7.0],
            },
            HumanoidSkeletonTemplateBone {
                name: "Root".into(),
                parent: None,
                translation: [10.0, 20.0, 30.0],
                rotation: quarter_turn,
                scale: [2.0, 3.0, 4.0],
            },
        ];
        let matrices = rest_matrices(&template).unwrap();
        assert_close(&matrices["Child"][12..15], &[10.0, 22.0, 30.0]);
        assert_close(
            &matrices["Tip"],
            &[
                -15.0, 0.0, 0.0, 0.0, 0.0, -12.0, 0.0, 0.0, 0.0, 0.0, 28.0, 0.0, -5.0, 10.0, 58.0,
                1.0,
            ],
        );
        assert_close(
            &rest_bounds(&template).unwrap(),
            &[-5.0, 10.0, 30.0, 10.0, 22.0, 58.0],
        );
    }

    #[test]
    fn omitted_rotation_and_scale_keep_translation_only_compatibility() {
        let bone: HumanoidSkeletonTemplateBone =
            serde_json::from_str(r#"{"name":"Root","parent":null,"translation":[1,2,3]}"#).unwrap();
        assert_eq!(bone.rotation, identity_rotation());
        assert_eq!(bone.scale, identity_scale());
        assert_close(
            &local_matrix(&bone),
            &[
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 3.0, 1.0,
            ],
        );
    }

    #[test]
    fn rejects_templates_with_unresolved_parents() {
        let template = HumanoidSkeletonTemplate {
            id: "bad".into(),
            source_character_id: "bad".into(),
            source_asset: String::new(),
            source_skin_name: String::new(),
            bones: vec![HumanoidSkeletonTemplateBone {
                name: "Child".into(),
                parent: Some("Missing".into()),
                translation: [0.0; 3],
                rotation: identity_rotation(),
                scale: identity_scale(),
            }],
        };
        assert!(rest_bounds(&template).is_err());
    }
}
