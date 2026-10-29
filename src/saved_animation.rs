//! Read historical saved records without mutating or relabelling profile-local AU IDs.
use serde_json::{Map, Value};
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

fn historical_controls() -> &'static Value {
    static CONTROLS: OnceLock<Value> = OnceLock::new();
    CONTROLS.get_or_init(|| serde_json::from_str(include_str!("../assets/legacy/body-control-aus.json")).expect("historical controls JSON"))
}

fn row<'a>(id: &str, profile: &'a Value) -> &'a Value {
    // An explicit empty mapping is authoritative; never fall back per missing key.
    match profile.get("bodyControls").filter(|v| !v.is_null() && **v != Value::Bool(false)) {
        Some(metadata) => &metadata[id],
        None => &historical_controls()[id],
    }
}

fn unresolved(id: &str, detail: &str) -> String {
    format!("Cannot resolve saved movement {id}{detail}. The original saved record is unchanged.")
}

fn action_id(id: &str, direction: &str, profile: &Value) -> Result<String, String> {
    if direction != "positive" && direction != "negative" {
        return Err(unresolved(id, " direction"));
    }
    let record = row(id, profile);
    if !record.is_object() { return Err(unresolved(id, "")); }
    let value = if direction == "positive" {
        record.get("positiveAuId").filter(|v| !v.is_null()).or_else(|| record.get("auId"))
    } else { record.get("negativeAuId") };
    value.and_then(Value::as_f64).filter(|id| id.fract() == 0.0)
        .map(|id| format!("{id:.0}"))
        .ok_or_else(|| unresolved(id, &format!(" ({direction})")))
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn conflict(id: &str, suffix: &str) -> String {
    format!("Saved movement conflicts with AU {id}{suffix}. The original saved record is unchanged.")
}

fn equal_setting(left: &Value, right: &Value) -> bool {
    match (left.as_f64(), right.as_f64()) {
        (Some(left), Some(right)) => left == right,
        _ => left == right,
    }
}

pub(crate) fn decode_pose(mut pose: Value, profile: &Value) -> Result<Value, String> {
    let Some(legacy) = pose.get("semanticPose").filter(|v| !v.is_null() && **v != Value::Bool(false)) else { return Ok(pose); };
    let controls = legacy["controls"].as_array().ok_or("Invalid saved movement controls")?;
    let mut aus = object(&pose["aus"]);
    let mut balances = object(&pose["auBalances"]);
    let mut weights = object(&pose["auMixWeights"]);
    for control in controls {
        let name = control["controlId"].as_str().ok_or("Invalid saved movement controlId")?;
        for direction in ["positive", "negative"] {
            let Some(value) = control.get(direction).filter(|v| !v.is_null()) else { continue; };
            let id = action_id(name, direction, profile)?;
            let intensity = value.get("intensity").ok_or("Invalid saved movement intensity")?;
            if aus.get(&id).is_some_and(|old| !equal_setting(old, intensity)) { return Err(conflict(&id, "")); }
            for (field, destination) in [("balance", &mut balances), ("morphStrength", &mut weights)] {
                if let Some(setting) = value.get(field).filter(|v| !v.is_null()) {
                    if destination.get(&id).is_some_and(|old| !equal_setting(old, setting)) { return Err(conflict(&id, " side settings")); }
                    destination.insert(id.clone(), setting.clone());
                }
            }
            aus.insert(id, intensity.clone());
        }
    }
    for control in controls {
        let name = control["controlId"].as_str().ok_or("Invalid saved movement controlId")?;
        if let (Ok(positive), Ok(negative)) = (action_id(name, "positive", profile), action_id(name, "negative", profile)) {
            if aus.get(&positive).and_then(Value::as_f64).unwrap_or(0.0) > 0.0
                && aus.get(&negative).and_then(Value::as_f64).unwrap_or(0.0) > 0.0 {
                return Err(format!("Saved movement {name} activates opposing AUs. The original saved record is unchanged."));
            }
        }
    }
    let out = pose.as_object_mut().ok_or("Saved pose must be an object")?;
    out.remove("semanticPose");
    out.insert("aus".into(), Value::Object(aus));
    out.insert("auBalances".into(), Value::Object(balances));
    out.insert("auMixWeights".into(), Value::Object(weights));
    Ok(pose)
}

pub(crate) fn decode_animation(mut animation: Value, profile: &Value) -> Result<Value, String> {
    let Some(legacy) = animation.get("semanticAnimation").filter(|v| !v.is_null() && **v != Value::Bool(false)) else { return Ok(animation); };
    let tracks = legacy["tracks"].as_array().ok_or("Invalid saved movement tracks")?;
    let mut curves = object(&animation["curves"]);
    let mut balances = object(&animation["balanceMap"]);
    let mut weights = object(&animation["mixWeights"]);
    for track in tracks {
        let name = track["controlId"].as_str().ok_or("Invalid saved movement controlId")?;
        let id = action_id(name, track["direction"].as_str().unwrap_or_default(), profile)?;
        if curves.contains_key(&id) { return Err(conflict(&id, "")); }
        curves.insert(id.clone(), track.get("keyframes").ok_or("Invalid saved movement keyframes")?.clone());
        for (field, destination) in [("balance", &mut balances), ("morphStrength", &mut weights)] {
            if let Some(value) = track.get(field).filter(|v| !v.is_null()) { destination.insert(id.clone(), value.clone()); }
        }
    }
    let out = animation.as_object_mut().ok_or("Saved animation must be an object")?;
    out.remove("semanticAnimation");
    out.insert("curves".into(), Value::Object(curves));
    out.insert("balanceMap".into(), Value::Object(balances));
    out.insert("mixWeights".into(), Value::Object(weights));
    Ok(animation)
}

#[wasm_bindgen]
pub fn decode_legacy_pose(pose_json: &str, profile_json: &str) -> Result<String, JsError> {
    decode_json(pose_json, profile_json, decode_pose)
}

#[wasm_bindgen]
pub fn decode_legacy_animation(animation_json: &str, profile_json: &str) -> Result<String, JsError> {
    decode_json(animation_json, profile_json, decode_animation)
}

fn decode_json(input: &str, profile: &str, decode: fn(Value, &Value) -> Result<Value, String>) -> Result<String, JsError> {
    let input = serde_json::from_str(input).map_err(|e| JsError::new(&format!("Invalid saved record JSON: {e}")))?;
    let profile = serde_json::from_str(profile).map_err(|e| JsError::new(&format!("Invalid historical profile JSON: {e}")))?;
    let result = decode(input, &profile).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&result).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
#[path = "saved_animation_tests.rs"]
mod tests;
