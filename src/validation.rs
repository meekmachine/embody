use std::collections::BTreeSet;

use regex_lite::Regex;
use serde::{Deserialize, Serialize};

use crate::profile::{ModelData, MorphRef, ProfileData};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingCorrection {
    pub r#type: String,
    pub source: String,
    pub target: String,
    pub confidence: f64,
    pub reason: String,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub au_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    pub score: u32,
    pub missing_morphs: Vec<String>,
    pub missing_bones: Vec<String>,
    pub found_morphs: Vec<String>,
    pub found_bones: Vec<String>,
    pub unmapped_morphs: Vec<String>,
    pub unmapped_bones: Vec<String>,
    pub missing_meshes: Vec<String>,
    pub found_meshes: Vec<String>,
    pub unmapped_meshes: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_config: Option<ProfileData>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub corrections: Vec<MappingCorrection>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unresolved: Vec<MappingCorrection>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ValidationOptions {
    pub suggest_corrections: bool,
    pub min_confidence: Option<f64>,
    pub use_resolved_names: bool,
}

fn normalize_loose(value: &str) -> String {
    value.replace('.', "")
}

fn full_name(base: &str, prefix: &str, suffix: &str) -> String {
    format!("{prefix}{base}{suffix}")
}

fn fuzzy_match(
    target: &str,
    candidate: &str,
    prefix: &str,
    suffix: &str,
    suffix_pattern: Option<&Regex>,
) -> bool {
    let full = full_name(target, prefix, suffix);
    if candidate == full
        || normalize_loose(candidate) == normalize_loose(target)
        || normalize_loose(candidate) == normalize_loose(&full)
    {
        return true;
    }

    suffix_pattern.is_some_and(|pattern| {
        candidate
            .strip_prefix(&full)
            .is_some_and(|tail| tail.is_empty() || pattern.is_match(tail))
    })
}

fn find_matches(
    targets: &BTreeSet<String>,
    candidates: &BTreeSet<String>,
    prefix: &str,
    suffix: &str,
    suffix_pattern: Option<&Regex>,
) -> (Vec<String>, Vec<String>) {
    targets.iter().cloned().partition(|target| {
        candidates
            .iter()
            .any(|candidate| fuzzy_match(target, candidate, prefix, suffix, suffix_pattern))
    })
}

fn string_morphs(profile: &ProfileData) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for entry in profile.au_to_morphs.values().flatten() {
        for morph in entry.left.iter().chain(&entry.right).chain(&entry.center) {
            if let MorphRef::Name(name) = morph {
                names.insert(name.clone());
            }
        }
    }
    for morph in &profile.viseme_keys {
        if let MorphRef::Name(name) = morph {
            names.insert(name.clone());
        }
    }
    for binding in profile.viseme_bindings.values() {
        if let Some(MorphRef::Name(name)) = &binding.morph {
            names.insert(name.clone());
        }
        for target in binding.targets.iter().flatten() {
            if let Some(MorphRef::Name(name)) = &target.morph {
                names.insert(name.clone());
            }
        }
    }
    names
}

fn referenced_bones(profile: &ProfileData) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = profile.bone_nodes.values().cloned().collect();
    let resolve = |node: &str| {
        profile
            .bone_nodes
            .get(node)
            .cloned()
            .unwrap_or_else(|| node.to_string())
    };
    for bindings in profile.au_to_bones.values() {
        for binding in bindings {
            names.insert(resolve(&binding.node));
        }
    }
    for composite in &profile.composite_rotations {
        names.insert(resolve(&composite.node));
    }
    for pair in profile.continuum_pairs.values().flatten() {
        if let Some(node) = &pair.node {
            names.insert(resolve(node));
        }
    }
    for region in &profile.annotation_regions {
        for bone in &region.bones {
            names.insert(resolve(bone));
        }
    }
    names
}

fn model_assets(model: &ModelData) -> (BTreeSet<String>, BTreeSet<String>, BTreeSet<String>) {
    (
        model
            .morph_targets
            .iter()
            .map(|entry| entry.name.clone())
            .collect(),
        model
            .meshes
            .iter()
            .map(|entry| entry.name.clone())
            .collect(),
        model.bones.iter().map(|entry| entry.name.clone()).collect(),
    )
}

fn levenshtein(a: &str, b: &str) -> usize {
    let mut previous: Vec<usize> = (0..=b.chars().count()).collect();
    for (i, left) in a.chars().enumerate() {
        let mut current = vec![i + 1];
        for (j, right) in b.chars().enumerate() {
            current.push(if left == right {
                previous[j]
            } else {
                1 + previous[j].min(previous[j + 1]).min(current[j])
            });
        }
        previous = current;
    }
    previous.last().copied().unwrap_or(0)
}

fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let left = a.to_ascii_lowercase();
    let right = b.to_ascii_lowercase();
    let max_len = left.chars().count().max(right.chars().count());
    if max_len == 0 {
        1.0
    } else {
        1.0 - levenshtein(&left, &right) as f64 / max_len as f64
    }
}

fn best_match(
    target: &str,
    candidates: &BTreeSet<String>,
    prefix: &str,
    suffix: &str,
    suffix_pattern: Option<&Regex>,
) -> Option<(String, f64, String)> {
    let full = full_name(target, prefix, suffix);
    candidates
        .iter()
        .map(|candidate| {
            if candidate == &full {
                return (candidate.clone(), 1.0, "exact match".to_string());
            }
            if normalize_loose(candidate) == normalize_loose(&full) {
                return (
                    candidate.clone(),
                    1.0,
                    "separator-normalized exact match".to_string(),
                );
            }
            if suffix_pattern.is_some_and(|pattern| {
                candidate
                    .strip_prefix(&full)
                    .is_some_and(|tail| tail.is_empty() || pattern.is_match(tail))
            }) {
                return (candidate.clone(), 0.95, "suffix match".to_string());
            }
            let full_score = similarity(candidate, &full);
            let base_score = similarity(candidate, target);
            if full_score >= base_score {
                (
                    candidate.clone(),
                    full_score,
                    "similar full name".to_string(),
                )
            } else {
                (
                    candidate.clone(),
                    base_score,
                    "similar base name".to_string(),
                )
            }
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
}

fn derive_base(candidate: &str, prefix: &str, suffix: &str) -> Option<String> {
    if prefix.is_empty() && suffix.is_empty() {
        return Some(candidate.to_string());
    }
    candidate
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .map(str::to_string)
}

fn correction(
    kind: &str,
    source: &str,
    matched: Option<(String, f64, String)>,
    applied: bool,
    au_id: Option<u32>,
    key: Option<String>,
) -> MappingCorrection {
    let (target, confidence, reason) =
        matched.unwrap_or_else(|| (source.to_string(), 0.0, "no match".to_string()));
    MappingCorrection {
        r#type: kind.to_string(),
        source: source.to_string(),
        target,
        confidence,
        reason,
        applied,
        au_id,
        key,
    }
}

fn correct_profile(
    profile: &ProfileData,
    model: &ModelData,
    options: &ValidationOptions,
) -> (ProfileData, Vec<MappingCorrection>, Vec<MappingCorrection>) {
    let min_confidence = options.min_confidence.unwrap_or(0.6);
    let suffix_pattern = profile
        .suffix_pattern
        .as_deref()
        .and_then(|value| Regex::new(value).ok());
    let (model_morphs, model_meshes, model_bones) = model_assets(model);
    let bone_prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let bone_suffix = profile.bone_suffix.as_deref().unwrap_or("");
    let morph_prefix = profile.morph_prefix.as_deref().unwrap_or("");
    let morph_suffix = profile.morph_suffix.as_deref().unwrap_or("");
    let mut corrected = profile.clone();
    let mut corrections = Vec::new();
    let mut unresolved = Vec::new();

    if options.use_resolved_names {
        corrected.bone_prefix = None;
        corrected.bone_suffix = None;
        corrected.morph_prefix = None;
        corrected.morph_suffix = None;
    }

    for (key, base) in &profile.bone_nodes {
        let matched = best_match(
            base,
            &model_bones,
            bone_prefix,
            bone_suffix,
            suffix_pattern.as_ref(),
        );
        if matched
            .as_ref()
            .is_none_or(|entry| entry.1 < min_confidence)
        {
            unresolved.push(correction(
                "bone",
                base,
                matched,
                false,
                None,
                Some(key.clone()),
            ));
            continue;
        }
        let candidate = matched.as_ref().unwrap().0.clone();
        let replacement = if options.use_resolved_names {
            Some(candidate.clone())
        } else {
            derive_base(&candidate, bone_prefix, bone_suffix)
        };
        let applied = replacement.as_ref().is_some_and(|value| value != base);
        if let Some(value) = replacement {
            corrected.bone_nodes.insert(key.clone(), value);
        }
        corrections.push(correction(
            "bone",
            base,
            matched,
            applied,
            None,
            Some(key.clone()),
        ));
    }

    let mut replace_morph = |value: &MorphRef, au_id: Option<u32>| -> MorphRef {
        let MorphRef::Name(name) = value else {
            return value.clone();
        };
        if model_morphs.contains(name) {
            return value.clone();
        }
        let matched = best_match(
            name,
            &model_morphs,
            morph_prefix,
            morph_suffix,
            suffix_pattern.as_ref(),
        );
        if matched
            .as_ref()
            .is_none_or(|entry| entry.1 < min_confidence)
        {
            unresolved.push(correction("morph", name, matched, false, au_id, None));
            return value.clone();
        }
        let candidate = matched.as_ref().unwrap().0.clone();
        let replacement = if options.use_resolved_names {
            Some(candidate.clone())
        } else {
            derive_base(&candidate, morph_prefix, morph_suffix)
        };
        let applied = replacement.as_ref().is_some_and(|entry| entry != name);
        corrections.push(correction("morph", name, matched, applied, au_id, None));
        replacement
            .map(MorphRef::Name)
            .unwrap_or_else(|| value.clone())
    };

    for (au_text, entry) in &profile.au_to_morphs {
        let Some(entry) = entry else { continue };
        let mut next = entry.clone();
        let au_id = au_text.parse().ok();
        next.left = entry
            .left
            .iter()
            .map(|value| replace_morph(value, au_id))
            .collect();
        next.right = entry
            .right
            .iter()
            .map(|value| replace_morph(value, au_id))
            .collect();
        next.center = entry
            .center
            .iter()
            .map(|value| replace_morph(value, au_id))
            .collect();
        corrected.au_to_morphs.insert(au_text.clone(), Some(next));
    }
    corrected.viseme_keys = profile
        .viseme_keys
        .iter()
        .map(|value| replace_morph(value, None))
        .collect();

    for (category, mesh_names) in &profile.morph_to_mesh {
        let next = mesh_names
            .iter()
            .map(|name| {
                if model_meshes.contains(name) {
                    return name.clone();
                }
                let matched = best_match(name, &model_meshes, "", "", suffix_pattern.as_ref());
                if matched
                    .as_ref()
                    .is_none_or(|entry| entry.1 < min_confidence)
                {
                    unresolved.push(correction(
                        "mesh",
                        name,
                        matched,
                        false,
                        None,
                        Some(category.clone()),
                    ));
                    return name.clone();
                }
                let candidate = matched.as_ref().unwrap().0.clone();
                corrections.push(correction(
                    "mesh",
                    name,
                    matched,
                    candidate != *name,
                    None,
                    Some(category.clone()),
                ));
                candidate
            })
            .collect();
        corrected.morph_to_mesh.insert(category.clone(), next);
    }

    (corrected, corrections, unresolved)
}

pub fn validate(
    profile: &ProfileData,
    model: &ModelData,
    options: &ValidationOptions,
) -> ValidationResult {
    let suffix_pattern = profile
        .suffix_pattern
        .as_deref()
        .and_then(|value| Regex::new(value).ok());
    let (model_morphs, model_meshes, model_bones) = model_assets(model);
    let preset_morphs = string_morphs(profile);
    let preset_bones = referenced_bones(profile);
    let (found_morphs, missing_morphs) = find_matches(
        &preset_morphs,
        &model_morphs,
        profile.morph_prefix.as_deref().unwrap_or(""),
        profile.morph_suffix.as_deref().unwrap_or(""),
        suffix_pattern.as_ref(),
    );
    let (found_bones, missing_bones) = find_matches(
        &preset_bones,
        &model_bones,
        profile.bone_prefix.as_deref().unwrap_or(""),
        profile.bone_suffix.as_deref().unwrap_or(""),
        suffix_pattern.as_ref(),
    );

    let unmapped_morphs = model_morphs
        .iter()
        .filter(|candidate| {
            !preset_morphs.iter().any(|target| {
                fuzzy_match(
                    target,
                    candidate,
                    profile.morph_prefix.as_deref().unwrap_or(""),
                    profile.morph_suffix.as_deref().unwrap_or(""),
                    suffix_pattern.as_ref(),
                )
            })
        })
        .cloned()
        .collect();
    let unmapped_bones = model_bones
        .iter()
        .filter(|candidate| {
            !preset_bones.iter().any(|target| {
                fuzzy_match(
                    target,
                    candidate,
                    profile.bone_prefix.as_deref().unwrap_or(""),
                    profile.bone_suffix.as_deref().unwrap_or(""),
                    suffix_pattern.as_ref(),
                )
            })
        })
        .cloned()
        .collect();

    let referenced_meshes: BTreeSet<String> =
        profile.morph_to_mesh.values().flatten().cloned().collect();
    let found_meshes: Vec<String> = referenced_meshes
        .intersection(&model_meshes)
        .cloned()
        .collect();
    let missing_meshes: Vec<String> = referenced_meshes
        .difference(&model_meshes)
        .cloned()
        .collect();
    let unmapped_meshes: Vec<String> = model_meshes
        .difference(&referenced_meshes)
        .cloned()
        .collect();
    let mut warnings = Vec::new();
    if !preset_morphs.is_empty() && model_morphs.is_empty() {
        warnings.push("Model has no morph targets - blend shape animations will not work".into());
    }
    if !preset_bones.is_empty() && model_bones.is_empty() {
        warnings.push("Model has no skeleton - bone-based animations will not work".into());
    }
    if !missing_morphs.is_empty() && found_morphs.is_empty() {
        warnings
            .push("No morph targets matched - preset may be incompatible with this model".into());
    }
    if !missing_bones.is_empty() && found_bones.is_empty() {
        warnings.push("No bones matched - preset may be incompatible with this model".into());
    }
    if !missing_meshes.is_empty() {
        warnings.push("Some morphToMesh entries were not found on the model".into());
    }

    let morph_score = if preset_morphs.is_empty() {
        60.0
    } else {
        found_morphs.len() as f64 / preset_morphs.len() as f64 * 60.0
    };
    let bone_score = if preset_bones.is_empty() {
        40.0
    } else {
        found_bones.len() as f64 / preset_bones.len() as f64 * 40.0
    };
    let valid = preset_morphs.is_empty()
        || !found_morphs.is_empty()
        || preset_bones.is_empty()
        || !found_bones.is_empty();
    let (suggested_config, corrections, unresolved) = if options.suggest_corrections {
        let (profile, corrections, unresolved) = correct_profile(profile, model, options);
        (Some(profile), corrections, unresolved)
    } else {
        (None, Vec::new(), Vec::new())
    };

    ValidationResult {
        valid,
        score: (morph_score + bone_score).round() as u32,
        missing_morphs,
        missing_bones,
        found_morphs,
        found_bones,
        unmapped_morphs,
        unmapped_bones,
        missing_meshes,
        found_meshes,
        unmapped_meshes,
        warnings,
        suggested_config,
        corrections,
        unresolved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::deserialize_json;

    #[test]
    fn scores_model_compatibility_and_generates_corrections() {
        let profile: ProfileData = deserialize_json(
            r#"{"auToMorphs":{"12":{"left":["Smile.L"],"right":[],"center":[]}},"auToBones":{},"boneNodes":{"HEAD":"Head"},"morphToMesh":{"face":["Face"]},"visemeKeys":[]}"#,
            "profile",
        )
        .unwrap();
        let model: ModelData = deserialize_json(
            r#"{"meshes":[{"id":1,"name":"Face","morphTargetIds":[1]}],"morphTargets":[{"id":1,"meshId":1,"name":"SmileL","hostIndex":0}],"bones":[{"id":1,"name":"Head"}]}"#,
            "model",
        )
        .unwrap();
        let result = validate(
            &profile,
            &model,
            &ValidationOptions {
                suggest_corrections: true,
                ..Default::default()
            },
        );
        assert!(result.valid);
        assert_eq!(result.score, 100);
        assert_eq!(result.found_morphs, vec!["Smile.L"]);
        assert_eq!(result.corrections.len(), 2);
        assert!(result
            .corrections
            .iter()
            .any(|entry| entry.r#type == "morph" && entry.target == "SmileL"));
    }
}
