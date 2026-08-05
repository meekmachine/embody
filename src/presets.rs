//! Embedded presets shipped inside the Wasm core.
//!
//! Preset JSON is converted to native `ProfileData` on first use (intake).
//! Hosts pass a preset id + optional override JSON; they do not ship preset
//! data as TypeScript blobs for the runtime path.

use std::sync::OnceLock;

use crate::profile::{deserialize_json, ProfileData};
use crate::profile_merge::{extend_preset_with_profile, parse_profile_patch};

struct EmbeddedPreset {
    id: &'static str,
    json: &'static str,
    profile: OnceLock<ProfileData>,
}

include!(concat!(env!("OUT_DIR"), "/embedded_presets.rs"));

fn normalized_preset_id(preset_id: &str) -> String {
    preset_id.trim().to_ascii_lowercase()
}

fn find_preset(preset_id: &str) -> Option<&'static EmbeddedPreset> {
    let normalized = normalized_preset_id(preset_id);
    EMBEDDED_PRESETS
        .iter()
        .find(|preset| preset.id == normalized)
}

fn unknown_preset_error(preset_id: &str) -> String {
    format!(
        "Unknown preset \"{preset_id}\". Known presets: {}",
        list_preset_ids().join(", ")
    )
}

pub fn list_preset_ids() -> Vec<&'static str> {
    EMBEDDED_PRESETS.iter().map(|preset| preset.id).collect()
}

pub fn has_preset(preset_id: &str) -> bool {
    find_preset(preset_id).is_some()
}

pub fn preset_json(preset_id: &str) -> Result<&'static str, String> {
    find_preset(preset_id)
        .map(|preset| preset.json)
        .ok_or_else(|| unknown_preset_error(preset_id))
}

pub fn load_profile(preset_id: &str) -> Result<&'static ProfileData, String> {
    let preset = find_preset(preset_id).ok_or_else(|| unknown_preset_error(preset_id))?;
    Ok(preset.profile.get_or_init(|| {
        deserialize_json(preset.json, "Invalid embedded preset JSON").unwrap_or_else(|error| {
            panic!(
                "embedded preset {} must deserialize as ProfileData: {error}",
                preset.id
            )
        })
    }))
}

/// Merge an optional override JSON onto an embedded preset and return the
/// merged profile JSON (for hosts that still need a Profile object for Mixer
/// host callbacks). Intake conversion to ProfileData happens in configure.
pub fn merge_preset_with_override_json(
    preset_id: &str,
    override_json: &str,
) -> Result<String, String> {
    let base = load_profile(preset_id)?;
    let extension = parse_profile_patch(override_json)?;
    let merged = extend_preset_with_profile(base, extension);
    serde_json::to_string(&merged)
        .map_err(|err| format!("Failed to serialize merged profile: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_and_loads_registered_presets() {
        assert!(has_preset("cc4"));
        assert!(has_preset("fish"));
        assert!(!has_preset("default"));
        assert!(!has_preset("human"));
        assert!(!has_preset("skeletal"));
        assert!(!has_preset("custom"));
        let preset_ids = list_preset_ids();
        assert!(preset_ids.contains(&"cc4"));
        assert!(preset_ids.contains(&"fish"));
        assert!(preset_ids.windows(2).all(|ids| ids[0] < ids[1]));

        for preset_id in &preset_ids {
            let profile = load_profile(preset_id)
                .unwrap_or_else(|error| panic!("embedded preset {preset_id} is invalid: {error}"));
            assert!(
                profile.has_runtime_mappings(),
                "embedded preset {preset_id} has no runtime mappings"
            );
        }

        let profile = load_profile("cc4").unwrap();
        assert!(!profile.au_to_morphs.is_empty() || !profile.au_to_bones.is_empty());
        assert!(preset_json("cc4").unwrap().contains("auToMorphs"));
        let preset: serde_json::Value = serde_json::from_str(preset_json("cc4").unwrap()).unwrap();
        assert_eq!(preset["meshes"]["CC_Base_Eye"]["category"], "eye");
        assert_eq!(
            preset["meshes"]["CC_Base_Eye"]["material"]["renderOrder"],
            -10
        );

        let fish = load_profile("fish").unwrap();
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
    fn typed_round_trip_preserves_three_adapter_and_legacy_fish_metadata() {
        let cc4: serde_json::Value =
            serde_json::from_str(&merge_preset_with_override_json("cc4", "").unwrap()).unwrap();
        assert_eq!(cc4["meshes"]["CC_Base_Eye"]["category"], "eye");
        assert_eq!(cc4["meshes"]["CC_Base_Eye"]["material"]["renderOrder"], -10);
        assert_eq!(cc4["mappingSections"][0]["kind"], "au");
        assert_eq!(cc4["visemeSlots"][0]["providerIds"]["azure"][0], 4);
        assert_eq!(
            cc4["hairPhysics"]["morphTargets"]["headUp"]["Hairline_High_ALL"]["axis"],
            "pitch"
        );
        assert!(
            cc4["compositeRotations"]
                .as_array()
                .is_some_and(|value| !value.is_empty()),
            "CC4 must embed compositeRotations so AU→bone rotations compile"
        );
        assert_eq!(cc4["compositeRotations"][1]["node"], "HEAD");
        assert_eq!(cc4["compositeRotations"][1]["yaw"]["axis"], "ry");

        let fish: serde_json::Value =
            serde_json::from_str(&merge_preset_with_override_json("fish", "").unwrap()).unwrap();
        assert_eq!(fish["meshes"]["EYES_0"]["category"], "eye");
        assert_eq!(fish["meshes"]["EYES_0"]["material"]["renderOrder"], 17);
        assert_eq!(fish["compositeRotations"][0]["yaw"]["axis"], "ry");
        assert_eq!(fish["actionInfo"]["2"]["name"], "Turn Left");
        assert_eq!(fish["boneBindings"]["2"][0]["node"], "HEAD");
        assert_eq!(fish["bones"][0], "Armature_rootJoint");
    }

    #[test]
    fn rejects_invalid_typed_adapter_overrides() {
        let error = merge_preset_with_override_json(
            "cc4",
            r#"{"meshes":{"CC_Base_Eye":{"material":{"opacity":"opaque"}}}}"#,
        )
        .unwrap_err();
        assert!(error.contains("Invalid profile override JSON"));
        assert!(error.contains("opacity"));
    }

    #[test]
    fn rejects_unknown_preset() {
        assert!(load_profile("custom").is_err());
    }
}
