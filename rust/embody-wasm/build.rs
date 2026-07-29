//! Compile authored YAML presets into JSON strings embedded by `presets.rs`.
//!
//! Authored source of truth: `assets/presets/*.yaml`
//! Runtime host wire format (LoomLarge → Wasm): JSON
//! Browser never parses YAML; build.rs does that once at compile time.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let presets_dir = manifest_dir.join("assets/presets");

    for preset_id in ["cc4", "fish"] {
        let yaml_path = presets_dir.join(format!("{preset_id}.yaml"));
        println!("cargo:rerun-if-changed={}", yaml_path.display());

        let yaml = fs::read_to_string(&yaml_path).unwrap_or_else(|err| {
            panic!("failed to read authored preset {}: {err}", yaml_path.display())
        });
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap_or_else(|err| {
            panic!("invalid YAML in {}: {err}", yaml_path.display())
        });
        let json = serde_json::to_string(&value).unwrap_or_else(|err| {
            panic!("failed to serialize {preset_id} preset to JSON: {err}")
        });

        let out_path = out_dir.join(format!("preset_{preset_id}.json"));
        fs::write(&out_path, json).unwrap_or_else(|err| {
            panic!("failed to write {}: {err}", out_path.display())
        });
    }
}
