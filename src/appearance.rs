use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::profile::deserialize_json;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HairColorAppearance {
    pub name: String,
    pub base_color: String,
    pub emissive: String,
    pub emissive_intensity: f64,
}

const HAIR_COLOR_PRESETS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/appearance/hair-color-presets.json"
));

fn presets() -> &'static BTreeMap<String, HairColorAppearance> {
    static PRESETS: OnceLock<BTreeMap<String, HairColorAppearance>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        deserialize_json(
            HAIR_COLOR_PRESETS_JSON,
            "Invalid embedded hair color presets",
        )
        .expect("embedded hair color presets must be valid")
    })
}

fn preset(id: &str) -> Option<HairColorAppearance> {
    presets().get(id.trim()).cloned()
}

fn default_appearance() -> HairColorAppearance {
    preset("natural_brown").expect("natural_brown hair preset exists")
}

fn parse_fallback(json: &str) -> Result<HairColorAppearance, String> {
    if json.trim().is_empty() {
        return Ok(default_appearance());
    }
    deserialize_json(json, "Invalid fallback hair appearance JSON")
}

fn normalize(value: Value, fallback: HairColorAppearance) -> HairColorAppearance {
    match value {
        Value::String(value) => {
            let value = value.trim();
            if value.starts_with('#') {
                HairColorAppearance {
                    base_color: value.to_string(),
                    ..fallback
                }
            } else {
                preset(value).unwrap_or(fallback)
            }
        }
        Value::Object(value) => HairColorAppearance {
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&fallback.name)
                .to_string(),
            base_color: value
                .get("baseColor")
                .and_then(Value::as_str)
                .unwrap_or(&fallback.base_color)
                .to_string(),
            emissive: value
                .get("emissive")
                .and_then(Value::as_str)
                .unwrap_or(&fallback.emissive)
                .to_string(),
            emissive_intensity: value
                .get("emissiveIntensity")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .unwrap_or(fallback.emissive_intensity),
        },
        _ => fallback,
    }
}

#[wasm_bindgen]
pub fn hair_color_presets_json() -> Result<String, JsError> {
    serde_json::to_string(presets())
        .map_err(|error| JsError::new(&format!("Failed to serialize hair presets: {error}")))
}

#[wasm_bindgen]
pub fn default_hair_color_appearance_json() -> Result<String, JsError> {
    serde_json::to_string(&default_appearance())
        .map_err(|error| JsError::new(&format!("Failed to serialize hair appearance: {error}")))
}

#[wasm_bindgen]
pub fn normalize_hair_color_appearance_json(
    value_json: &str,
    fallback_json: &str,
) -> Result<String, JsError> {
    let value: Value = if value_json.trim().is_empty() {
        Value::Null
    } else {
        deserialize_json(value_json, "Invalid hair appearance JSON")
            .map_err(|error| JsError::new(&error))?
    };
    let fallback = parse_fallback(fallback_json).map_err(|error| JsError::new(&error))?;
    serde_json::to_string(&normalize(value, fallback))
        .map_err(|error| JsError::new(&format!("Failed to serialize hair appearance: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_presets_hex_and_sparse_objects() {
        assert_eq!(
            normalize(Value::String("neon_blue".into()), default_appearance()).base_color,
            "#00ffff"
        );
        assert_eq!(
            normalize(Value::String("#123456".into()), default_appearance()).base_color,
            "#123456"
        );
        let sparse = normalize(
            serde_json::json!({ "emissiveIntensity": 0.4 }),
            default_appearance(),
        );
        assert_eq!(sparse.base_color, "#4a3728");
        assert_eq!(sparse.emissive_intensity, 0.4);
    }
}
