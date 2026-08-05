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
        deserialize_json(CC4_HUMANOID_TEMPLATE_JSON, "Invalid embedded humanoid template")
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

fn rest_bounds(template: &HumanoidSkeletonTemplate) -> Result<[f64; 6], String> {
    if template.bones.is_empty() {
        return Err("Humanoid skeleton template has no bones".to_string());
    }
    let mut positions = BTreeMap::<String, [f64; 3]>::new();
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
            let position = match &bone.parent {
                None => bone.translation,
                Some(parent) => match positions.get(parent) {
                    Some(parent) => [
                        parent[0] + bone.translation[0],
                        parent[1] + bone.translation[1],
                        parent[2] + bone.translation[2],
                    ],
                    None => continue,
                },
            };
            positions.insert(bone.name.clone(), position);
            unresolved.remove(&bone.name);
        }
        if unresolved.len() == before {
            return Err(format!(
                "Humanoid skeleton template has unresolved parents for: {}",
                unresolved.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }

    let mut bounds = [f64::INFINITY; 6];
    bounds[3] = f64::NEG_INFINITY;
    bounds[4] = f64::NEG_INFINITY;
    bounds[5] = f64::NEG_INFINITY;
    for position in positions.values() {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(position[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(position[axis]);
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
    fn loads_embedded_template_and_computes_finite_bounds() {
        let template = cc4_humanoid_template();
        assert_eq!(template.id, "cc4-humanoid");
        assert!(!template.bones.is_empty());
        assert!(rest_bounds(template)
            .unwrap()
            .iter()
            .all(|value| value.is_finite()));
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
            }],
        };
        assert!(rest_bounds(&template).is_err());
    }
}
