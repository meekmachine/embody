//! Embedded presets shipped inside the Wasm core.
//!
//! Preset JSON is converted to native `ProfileData` on first use (intake).
//! Hosts pass a preset id + optional override JSON; they do not ship CC4/fish
//! (or other presets) as TypeScript blobs for the runtime path.

use std::sync::OnceLock;

use crate::profile::ProfileData;
use crate::profile_merge::extend_preset_with_profile;

const CC4_PRESET_JSON: &str = include_str!("../assets/presets/cc4.json");
const FISH_PRESET_JSON: &str = include_str!("../assets/presets/fish.json");

static CC4_PROFILE: OnceLock<ProfileData> = OnceLock::new();
static FISH_PROFILE: OnceLock<ProfileData> = OnceLock::new();

pub fn list_preset_ids() -> Vec<&'static str> {
    vec!["cc4", "fish"]
}

pub fn has_preset(preset_id: &str) -> bool {
    normalize_preset_id(preset_id).is_some()
}

pub fn normalize_preset_id(preset_id: &str) -> Option<&'static str> {
    match preset_id.trim().to_ascii_lowercase().as_str() {
        "" | "cc4" | "default" | "human" => Some("cc4"),
        "fish" | "skeletal" => Some("fish"),
        _ => None,
    }
}

pub fn preset_json(preset_id: &str) -> Result<&'static str, String> {
    match normalize_preset_id(preset_id) {
        Some("cc4") => Ok(CC4_PRESET_JSON),
        Some("fish") => Ok(FISH_PRESET_JSON),
        _ => Err(format!(
            "Unknown preset \"{preset_id}\". Known presets: cc4, fish"
        )),
    }
}

pub fn load_profile(preset_id: &str) -> Result<&'static ProfileData, String> {
    match normalize_preset_id(preset_id) {
        Some("cc4") => Ok(CC4_PROFILE.get_or_init(|| {
            serde_json::from_str(CC4_PRESET_JSON)
                .expect("embedded cc4.json must deserialize as ProfileData")
        })),
        Some("fish") => Ok(FISH_PROFILE.get_or_init(|| {
            serde_json::from_str(FISH_PRESET_JSON)
                .expect("embedded fish.json must deserialize as ProfileData")
        })),
        _ => Err(format!(
            "Unknown preset \"{preset_id}\". Known presets: cc4, fish"
        )),
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
    fn embeds_and_loads_presets_and_aliases() {
        assert!(has_preset("cc4"));
        assert!(has_preset("default"));
        assert!(has_preset("human"));
        assert!(has_preset("fish"));
        assert!(has_preset("skeletal"));
        assert!(!has_preset("custom"));
        assert_eq!(list_preset_ids(), vec!["cc4", "fish"]);

        let profile = load_profile("human").unwrap();
        assert!(!profile.au_to_morphs.is_empty() || !profile.au_to_bones.is_empty());
        assert!(preset_json("cc4").unwrap().contains("auToMorphs"));
        let preset: serde_json::Value = serde_json::from_str(preset_json("cc4").unwrap()).unwrap();
        assert_eq!(preset["meshes"]["CC_Base_Eye"]["category"], "eye");
        assert_eq!(
            preset["meshes"]["CC_Base_Eye"]["material"]["renderOrder"],
            -10
        );

        let fish = load_profile("skeletal").unwrap();
        assert!(!fish.au_to_bones.is_empty());
        let fish_preset: serde_json::Value =
            serde_json::from_str(preset_json("fish").unwrap()).unwrap();
        assert_eq!(fish_preset["name"], "Betta Fish");
        assert_eq!(fish_preset["meshes"]["EYES_0"]["category"], "eye");
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
        assert!(load_profile("custom").is_err());
    }
}
