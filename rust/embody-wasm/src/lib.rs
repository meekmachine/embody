mod abi;
mod annotation_camera;
mod annotation_markers;
mod bones;
mod clip;
mod hair;
mod hair_curves;
mod humanoid_fit;
mod math;
mod presets;
mod profile;
mod profile_merge;
mod runtime;
mod skeleton;
mod template_fit_metadata;

pub use abi::*;
pub use annotation_camera::*;
pub use annotation_markers::*;
pub use hair::*;
pub use humanoid_fit::*;
pub use math::*;
pub use runtime::*;
pub use skeleton::*;
pub use template_fit_metadata::*;

use wasm_bindgen::prelude::*;

/// Embedded preset ids available inside the Wasm core (currently: "cc4").
#[wasm_bindgen]
pub fn list_presets() -> Vec<String> {
    presets::list_preset_ids()
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// True when the Wasm core ships the given preset id.
#[wasm_bindgen]
pub fn has_preset(preset_id: &str) -> bool {
    presets::has_preset(preset_id)
}

/// Return the embedded preset JSON for a preset id (intake source of truth).
#[wasm_bindgen]
pub fn get_preset_json(preset_id: &str) -> Result<String, JsError> {
    presets::preset_json(preset_id)
        .map(str::to_string)
        .map_err(|err| JsError::new(&err))
}

/// Merge overrides onto an embedded preset. Hosts that still need a JS Profile
/// object for Mixer callbacks can use this; the runtime configure path should
/// prefer `RuntimeCore.configure_with_preset`.
#[wasm_bindgen]
pub fn merge_embedded_preset(preset_id: &str, override_json: &str) -> Result<String, JsError> {
    presets::merge_preset_with_override_json(preset_id, override_json)
        .map_err(|err| JsError::new(&err))
}

/// Merge a base preset profile with an extension profile (both JSON strings)
/// using the engine's preset extension rules. Returns the merged profile JSON.
#[wasm_bindgen]
pub fn merge_preset_profile(base_json: &str, extension_json: &str) -> Result<String, JsError> {
    let base: serde_json::Value = serde_json::from_str(base_json)
        .map_err(|err| JsError::new(&format!("Invalid base profile JSON: {err}")))?;
    let extension: Option<serde_json::Value> = if extension_json.trim().is_empty() {
        None
    } else {
        Some(
            serde_json::from_str(extension_json)
                .map_err(|err| JsError::new(&format!("Invalid profile extension JSON: {err}")))?,
        )
    };
    let merged = profile_merge::extend_preset_with_profile(&base, extension.as_ref());
    serde_json::to_string(&merged)
        .map_err(|err| JsError::new(&format!("Failed to serialize merged profile: {err}")))
}

/// Compile a clip track input (JSON) into host-neutral ClipIR JSON.
#[wasm_bindgen]
pub fn compile_clip(input_json: &str) -> Result<String, JsError> {
    let input: clip::ClipInput = serde_json::from_str(input_json)
        .map_err(|err| JsError::new(&format!("Invalid clip input JSON: {err}")))?;
    let compiled = clip::compile(input).map_err(|err| JsError::new(&err))?;
    serde_json::to_string(&compiled)
        .map_err(|err| JsError::new(&format!("Failed to serialize ClipIR: {err}")))
}

/// Compile named intensity curves (JSON) into host-neutral ClipIR JSON.
#[wasm_bindgen]
pub fn compile_clip_curves(input_json: &str) -> Result<String, JsError> {
    let input: clip::CurvesInput = serde_json::from_str(input_json)
        .map_err(|err| JsError::new(&format!("Invalid clip curves JSON: {err}")))?;
    let compiled = clip::compile_curves(input).map_err(|err| JsError::new(&err))?;
    serde_json::to_string(&compiled)
        .map_err(|err| JsError::new(&format!("Failed to serialize ClipIR: {err}")))
}

/// Build idle/wind hair morph curves (JSON map of morphKey -> [{time,intensity}]).
#[wasm_bindgen]
pub fn build_hair_idle_curves(config_json: &str, duration_sec: f32) -> Result<String, JsError> {
    let config = hair_curves::parse_hair_curve_config(config_json)
        .map_err(|err| JsError::new(&err))?;
    let curves = hair_curves::build_idle_wind_curves(
        &config,
        hair_curves::sanitize_duration(duration_sec, 0.5),
    );
    serde_json::to_string(&curves)
        .map_err(|err| JsError::new(&format!("Failed to serialize hair idle curves: {err}")))
}

/// Build a directional hair impulse curve set.
#[wasm_bindgen]
pub fn build_hair_impulse_curves(
    config_json: &str,
    duration_sec: f32,
    horizontal: f32,
    vertical: f32,
) -> Result<String, JsError> {
    let config = hair_curves::parse_hair_curve_config(config_json)
        .map_err(|err| JsError::new(&err))?;
    let curves = hair_curves::build_impulse_curves(
        &config,
        hair_curves::sanitize_duration(duration_sec, 0.25),
        horizontal,
        vertical,
    );
    serde_json::to_string(&curves)
        .map_err(|err| JsError::new(&format!("Failed to serialize hair impulse curves: {err}")))
}

/// Build head-pitch gravity hair morph curves.
#[wasm_bindgen]
pub fn build_hair_gravity_curves(config_json: &str) -> Result<String, JsError> {
    let config = hair_curves::parse_hair_curve_config(config_json)
        .map_err(|err| JsError::new(&err))?;
    let curves = hair_curves::build_gravity_curves(&config);
    serde_json::to_string(&curves)
        .map_err(|err| JsError::new(&format!("Failed to serialize hair gravity curves: {err}")))
}
