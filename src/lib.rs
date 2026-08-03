mod abi;
mod animation;
mod annotation_camera;
mod annotation_markers;
mod appearance;
mod bones;
mod clip;
mod hair;
mod hair_curves;
mod humanoid_fit;
mod humanoid_templates;
mod math;
mod model_analysis;
mod presets;
mod profile;
mod profile_api;
mod profile_merge;
mod runtime;
mod skeleton;
mod template_fit_metadata;
mod validation;

pub use abi::*;
pub use annotation_camera::*;
pub use annotation_markers::*;
pub use appearance::*;
pub use hair::*;
pub use humanoid_fit::*;
pub use humanoid_templates::*;
pub use math::*;
pub use model_analysis::*;
pub use profile_api::*;
pub use runtime::*;
pub use skeleton::*;
pub use template_fit_metadata::*;

use wasm_bindgen::prelude::*;

/// Validate an authored profile against a renderer-neutral model descriptor.
/// Three.js objects are reduced to this descriptor by the thin host adapter;
/// all mapping analysis and correction generation stays in Rust.
#[wasm_bindgen]
pub fn validate_profile_model(
    profile_json: &str,
    model_json: &str,
    options_json: &str,
) -> Result<String, JsError> {
    let profile: profile::ProfileData =
        profile::deserialize_json(profile_json, "Invalid profile JSON")
            .map_err(|err| JsError::new(&err))?;
    let model: profile::ModelData =
        profile::deserialize_json(model_json, "Invalid model descriptor JSON")
            .map_err(|err| JsError::new(&err))?;
    let options: validation::ValidationOptions = if options_json.trim().is_empty() {
        validation::ValidationOptions::default()
    } else {
        profile::deserialize_json(options_json, "Invalid validation options JSON")
            .map_err(|err| JsError::new(&err))?
    };
    serde_json::to_string(&validation::validate(&profile, &model, &options))
        .map_err(|err| JsError::new(&format!("Failed to serialize validation result: {err}")))
}

/// Canonical embedded preset ids available inside the Wasm core.
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
    let base: profile::ProfileData =
        profile::deserialize_json(base_json, "Invalid base profile JSON")
            .map_err(|err| JsError::new(&err))?;
    let extension =
        profile_merge::parse_profile_patch(extension_json).map_err(|err| JsError::new(&err))?;
    let merged = profile_merge::extend_preset_with_profile(&base, extension);
    serde_json::to_string(&merged)
        .map_err(|err| JsError::new(&format!("Failed to serialize merged profile: {err}")))
}

/// Resolve profile routing/metadata answers that hosts need without making
/// hosts duplicate profile semantics in JavaScript.
#[wasm_bindgen]
pub fn resolve_profile_view(profile_json: &str) -> Result<String, JsError> {
    let profile: profile::ProfileData =
        profile::deserialize_json(profile_json, "Invalid profile JSON")
            .map_err(|err| JsError::new(&err))?;
    serde_json::to_string(&profile::resolve_profile_view(&profile))
        .map_err(|err| JsError::new(&format!("Failed to serialize resolved profile view: {err}")))
}

/// Merge an embedded preset with sparse overrides, then return the resolved
/// routing/metadata view for host adapters.
#[wasm_bindgen]
pub fn resolve_embedded_profile_view(
    preset_id: &str,
    override_json: &str,
) -> Result<String, JsError> {
    let base = presets::load_profile(preset_id).map_err(|err| JsError::new(&err))?;
    let extension =
        profile_merge::parse_profile_patch(override_json).map_err(|err| JsError::new(&err))?;
    let profile = profile_merge::extend_preset_with_profile(base, extension);
    serde_json::to_string(&profile::resolve_profile_view(&profile)).map_err(|err| {
        JsError::new(&format!(
            "Failed to serialize resolved embedded profile view: {err}"
        ))
    })
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
    let config =
        hair_curves::parse_hair_curve_config(config_json).map_err(|err| JsError::new(&err))?;
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
    let config =
        hair_curves::parse_hair_curve_config(config_json).map_err(|err| JsError::new(&err))?;
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
    let config =
        hair_curves::parse_hair_curve_config(config_json).map_err(|err| JsError::new(&err))?;
    let curves = hair_curves::build_gravity_curves(&config);
    serde_json::to_string(&curves)
        .map_err(|err| JsError::new(&format!("Failed to serialize hair gravity curves: {err}")))
}
