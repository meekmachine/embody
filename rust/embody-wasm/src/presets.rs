//! Embedded presets shipped inside the Wasm core.
//!
//! Preset JSON is converted to native `ProfileData` on first use (intake).
//! Hosts pass a preset id + optional override JSON; they do not ship CC4
//! (or other presets) as TypeScript blobs for the runtime path.

use std::sync::OnceLock;

use crate::profile::ProfileData;
use crate::profile_merge::extend_preset_with_profile;

const CC4_PRESET_JSON: &str = include_str!("../assets/presets/cc4.json");

static CC4_PROFILE: OnceLock<ProfileData> = OnceLock::new();

pub fn list_preset_ids() -> Vec<&'static str> {
    vec!["cc4"]
}

pub fn has_preset(preset_id: &str) -> bool {
    matches!(normalize_preset_id(preset_id), Some("cc4"))
}

pub fn normalize_preset_id(preset_id: &str) -> Option<&'static str> {
    match preset_id.trim().to_ascii_lowercase().as_str() {
        "" | "cc4" | "custom" | "default" | "human" => Some("cc4"),
        _ => None,
    }
}

pub fn preset_json(preset_id: &str) -> Result<&'static str, String> {
    match normalize_preset_id(preset_id) {
        Some("cc4") => Ok(CC4_PRESET_JSON),
        _ => Err(format!("Unknown preset \"{preset_id}\". Known: cc4")),
    }
}

pub fn load_profile(preset_id: &str) -> Result<&'static ProfileData, String> {
    match normalize_preset_id(preset_id) {
        Some("cc4") => Ok(CC4_PROFILE.get_or_init(|| {
            serde_json::from_str(CC4_PRESET_JSON)
                .expect("embedded cc4.json must deserialize as ProfileData")
        })),
        _ => Err(format!("Unknown preset \"{preset_id}\". Known: cc4")),
    }
}

/// Merge an optional override JSON onto an embedded preset and return the
/// merged profile JSON (for hosts that still need a Profile object for Mixer
/// host callbacks). Intake conversion to ProfileData happens in configure.
pub fn merge_preset_with_override_json(
    preset_id: &str,
    override_json: &str,
) -> Result<String, String> {
    let base_json = preset_json(preset_id)?;
    let base: serde_json::Value = serde_json::from_str(base_json)
        .map_err(|err| format!("Invalid embedded preset JSON: {err}"))?;
    let extension = if override_json.trim().is_empty() {
        None
    } else {
        Some(
            serde_json::from_str(override_json)
                .map_err(|err| format!("Invalid profile override JSON: {err}"))?,
        )
    };
    let merged = extend_preset_with_profile(&base, extension.as_ref());
    serde_json::to_string(&merged).map_err(|err| format!("Failed to serialize merged profile: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_and_loads_cc4() {
        assert!(has_preset("cc4"));
        assert!(has_preset("custom"));
        let profile = load_profile("cc4").unwrap();
        assert!(!profile.au_to_morphs.is_empty() || !profile.au_to_bones.is_empty());
        assert!(preset_json("cc4").unwrap().contains("auToMorphs"));
    }

    #[test]
    fn merges_override_onto_embedded_preset() {
        let merged = merge_preset_with_override_json("cc4", r#"{"name":"Override"}"#).unwrap();
        let value: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["name"], "Override");
        assert!(value.get("auToMorphs").is_some() || value.get("auToBones").is_some());
    }

    #[test]
    fn rejects_unknown_preset() {
        assert!(load_profile("fish").is_err());
    }
}
