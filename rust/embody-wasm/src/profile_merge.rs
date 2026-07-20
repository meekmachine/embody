//! Preset/profile merging, ported from the TypeScript `extendPresetWithProfile`.
//!
//! Rules:
//! - Scalars: extension wins when provided.
//! - Maps (auToMorphs, auToBones, boneNodes, morphToMesh, ...): shallow-merged
//!   by key, extension values win.
//! - Arrays: replaced when the extension provides them (except
//!   annotationRegions).
//! - annotationRegions: merged by region name, with nested cameraOffset/style
//!   fields preserved.
//! - hairPhysics: deep-merged (direction, morphTargets.headUp/headDown).

use serde_json::{Map, Value};

const MERGED_MAPS: [&str; 12] = [
    "auToMorphs",
    "auToBones",
    "boneNodes",
    "morphToMesh",
    "auFacePartToMeshCategory",
    "visemeBindings",
    "auMixDefaults",
    "auInfo",
    "meshes",
    "continuumPairs",
    "continuumLabels",
    "annotationRegions",
];

fn merge_map(base: Option<&Value>, extension: Option<&Value>) -> Option<Value> {
    match (base, extension) {
        (None, None) => None,
        (Some(base), None) => Some(base.clone()),
        (None, Some(extension)) => Some(extension.clone()),
        (Some(base), Some(extension)) => {
            let mut merged = base.as_object().cloned().unwrap_or_default();
            if let Some(extension) = extension.as_object() {
                for (key, value) in extension {
                    if !value.is_null() {
                        merged.insert(key.clone(), value.clone());
                    }
                }
            }
            Some(Value::Object(merged))
        }
    }
}

fn merge_objects_shallow(base: Option<&Value>, extension: Option<&Value>) -> Option<Value> {
    merge_map(base, extension)
}

fn merge_annotation_region(base: &Value, extension: &Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(extension_map) = extension.as_object() {
        for (key, value) in extension_map {
            merged.insert(key.clone(), value.clone());
        }

        // Nested fields keep base values that the extension does not override.
        if extension_map.contains_key("cameraOffset") {
            if let Some(camera) = merge_objects_shallow(
                base.get("cameraOffset"),
                extension.get("cameraOffset"),
            ) {
                merged.insert("cameraOffset".to_string(), camera);
            }
        }
        if extension_map.contains_key("style") {
            if let Some(mut style) =
                merge_objects_shallow(base.get("style"), extension.get("style"))
            {
                let line = merge_objects_shallow(
                    base.get("style").and_then(|value| value.get("line")),
                    extension.get("style").and_then(|value| value.get("line")),
                );
                if let (Some(style_map), Some(line)) = (style.as_object_mut(), line) {
                    style_map.insert("line".to_string(), line);
                }
                merged.insert("style".to_string(), style);
            }
        }
    }
    Value::Object(merged)
}

fn merge_annotation_regions(base: Option<&Value>, extension: Option<&Value>) -> Option<Value> {
    let base_list = base.and_then(|value| value.as_array());
    let extension_list = extension.and_then(|value| value.as_array());
    if base_list.is_none() && extension_list.is_none() {
        return None;
    }

    let mut order: Vec<String> = Vec::new();
    let mut by_name: Map<String, Value> = Map::new();

    for region in base_list.into_iter().flatten() {
        let Some(name) = region.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        if !by_name.contains_key(name) {
            order.push(name.to_string());
        }
        by_name.insert(name.to_string(), region.clone());
    }

    for region in extension_list.into_iter().flatten() {
        let Some(name) = region.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        let merged = match by_name.get(name) {
            Some(existing) => merge_annotation_region(existing, region),
            None => {
                order.push(name.to_string());
                region.clone()
            }
        };
        by_name.insert(name.to_string(), merged);
    }

    Some(Value::Array(
        order
            .iter()
            .filter_map(|name| by_name.get(name).cloned())
            .collect(),
    ))
}

fn merge_hair_physics(base: Option<&Value>, extension: Option<&Value>) -> Option<Value> {
    if base.is_none() && extension.is_none() {
        return None;
    }
    let mut merged = merge_objects_shallow(base, extension)?;

    let direction = merge_objects_shallow(
        base.and_then(|value| value.get("direction")),
        extension.and_then(|value| value.get("direction")),
    );
    let base_morphs = base.and_then(|value| value.get("morphTargets"));
    let extension_morphs = extension.and_then(|value| value.get("morphTargets"));
    let morph_targets = if base_morphs.is_some() || extension_morphs.is_some() {
        let mut morphs = merge_objects_shallow(base_morphs, extension_morphs)?;
        for key in ["headUp", "headDown"] {
            let inner = merge_objects_shallow(
                base_morphs.and_then(|value| value.get(key)),
                extension_morphs.and_then(|value| value.get(key)),
            );
            if let (Some(map), Some(inner)) = (morphs.as_object_mut(), inner) {
                map.insert(key.to_string(), inner);
            }
        }
        Some(morphs)
    } else {
        None
    };

    if let Some(map) = merged.as_object_mut() {
        if let Some(direction) = direction {
            map.insert("direction".to_string(), direction);
        }
        if let Some(morph_targets) = morph_targets {
            map.insert("morphTargets".to_string(), morph_targets);
        }
    }
    Some(merged)
}

/// Merge a base preset profile with an extension profile, both as JSON values.
pub fn extend_preset_with_profile(base: &Value, extension: Option<&Value>) -> Value {
    let Some(extension) = extension else {
        return base.clone();
    };
    if extension.is_null() {
        return base.clone();
    }

    // Scalars and untouched arrays: extension wins when the key is present.
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(extension_map) = extension.as_object() {
        for (key, value) in extension_map {
            if !value.is_null() || !merged.contains_key(key) {
                merged.insert(key.clone(), value.clone());
            }
        }
    }

    for key in MERGED_MAPS {
        let value = if key == "annotationRegions" {
            merge_annotation_regions(base.get(key), extension.get(key))
        } else {
            merge_map(base.get(key), extension.get(key))
        };
        if let Some(value) = value {
            merged.insert(key.to_string(), value);
        }
    }

    if let Some(hair) = merge_hair_physics(base.get("hairPhysics"), extension.get("hairPhysics"))
    {
        merged.insert("hairPhysics".to_string(), hair);
    }

    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extension_scalars_win_and_maps_merge_by_key() {
        let base = json!({
            "name": "Base",
            "morphPrefix": "CC_",
            "auToMorphs": { "1": { "center": ["A"] }, "2": { "center": ["B"] } },
            "visemeKeys": ["Aah", "Wide"]
        });
        let extension = json!({
            "name": "Extended",
            "auToMorphs": { "2": { "center": ["B2"] }, "3": { "center": ["C"] } },
            "visemeKeys": ["Ooh"]
        });

        let merged = extend_preset_with_profile(&base, Some(&extension));
        assert_eq!(merged["name"], "Extended");
        assert_eq!(merged["morphPrefix"], "CC_");
        assert_eq!(merged["auToMorphs"]["1"]["center"][0], "A");
        assert_eq!(merged["auToMorphs"]["2"]["center"][0], "B2");
        assert_eq!(merged["auToMorphs"]["3"]["center"][0], "C");
        // Arrays are replaced when the extension provides them.
        assert_eq!(merged["visemeKeys"], json!(["Ooh"]));
    }

    #[test]
    fn annotation_regions_merge_by_name_with_nested_fields() {
        let base = json!({
            "annotationRegions": [
                { "name": "head", "meshes": ["A"], "style": { "color": "red", "line": { "width": 1 } } },
                { "name": "jaw", "meshes": ["B"] }
            ]
        });
        let extension = json!({
            "annotationRegions": [
                { "name": "head", "style": { "line": { "dash": 2 } } },
                { "name": "brow", "meshes": ["C"] }
            ]
        });

        let merged = extend_preset_with_profile(&base, Some(&extension));
        let regions = merged["annotationRegions"].as_array().unwrap();
        assert_eq!(regions.len(), 3);
        let head = &regions[0];
        assert_eq!(head["name"], "head");
        // Base meshes preserved, style deep-merged with line fields combined.
        assert_eq!(head["meshes"], json!(["A"]));
        assert_eq!(head["style"]["color"], "red");
        assert_eq!(head["style"]["line"]["width"], 1);
        assert_eq!(head["style"]["line"]["dash"], 2);
        assert_eq!(regions[2]["name"], "brow");
    }

    #[test]
    fn hair_physics_deep_merges_direction_and_morph_targets() {
        let base = json!({
            "hairPhysics": {
                "windStrength": 0.1,
                "direction": { "x": 1 },
                "morphTargets": { "headUp": { "a": 1 }, "headDown": { "b": 1 } }
            }
        });
        let extension = json!({
            "hairPhysics": {
                "windStrength": 0.3,
                "direction": { "y": 2 },
                "morphTargets": { "headUp": { "c": 2 } }
            }
        });

        let merged = extend_preset_with_profile(&base, Some(&extension));
        let hair = &merged["hairPhysics"];
        assert_eq!(hair["windStrength"], 0.3);
        assert_eq!(hair["direction"]["x"], 1);
        assert_eq!(hair["direction"]["y"], 2);
        assert_eq!(hair["morphTargets"]["headUp"]["a"], 1);
        assert_eq!(hair["morphTargets"]["headUp"]["c"], 2);
        assert_eq!(hair["morphTargets"]["headDown"]["b"], 1);
    }

    #[test]
    fn no_extension_returns_base() {
        let base = json!({ "name": "Base" });
        assert_eq!(extend_preset_with_profile(&base, None), base);
    }
}
