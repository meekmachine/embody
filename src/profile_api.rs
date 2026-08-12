use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

use crate::presets;
use crate::profile::{
    deserialize_json, AuInfoData, AuSelector, BoneBindingData, CompositeRotationData,
    ContinuumPairData, ProfileData, RotationAxisData,
};
use crate::profile_merge::{extend_preset_with_profile, parse_profile_patch};

const JOINT_CONTROL_SECTION: &str = "Joint Controls";
const DEFAULT_BONE_MAX_DEGREES: f64 = 60.0;
const PROFILE_OVERRIDE_KEYS: &[&str] = &[
    "name",
    "animalType",
    "emoji",
    "auToMorphs",
    "auToBones",
    "boneNodes",
    "bonePrefix",
    "boneSuffix",
    "morphPrefix",
    "morphSuffix",
    "suffixPattern",
    "leftMorphSuffixes",
    "rightMorphSuffixes",
    "morphToMesh",
    "auFacePartToMeshCategory",
    "mappingSections",
    "visemeKeys",
    "visemeSystemId",
    "visemeSlots",
    "visemeBindings",
    "visemeMeshCategory",
    "visemeJawAmounts",
    "visemeTongueTargets",
    "auMixDefaults",
    "auInfo",
    "eyeMeshNodes",
    "compositeRotations",
    "meshes",
    "continuumPairs",
    "continuumLabels",
    "annotationRegions",
    "disabledRegions",
    "hairPhysics",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Axis {
    Pitch,
    Yaw,
    Roll,
}

impl Axis {
    fn key(self) -> &'static str {
        match self {
            Axis::Pitch => "pitch",
            Axis::Yaw => "yaw",
            Axis::Roll => "roll",
        }
    }

    fn channel(self) -> &'static str {
        match self {
            Axis::Pitch => "rx",
            Axis::Yaw => "ry",
            Axis::Roll => "rz",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Axis::Pitch => "Pitch",
            Axis::Yaw => "Yaw",
            Axis::Roll => "Roll",
        }
    }

    fn from_channel(channel: &str) -> Option<Self> {
        match channel {
            "rx" => Some(Axis::Pitch),
            "ry" => Some(Axis::Yaw),
            "rz" => Some(Axis::Roll),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Negative,
    Positive,
}

impl Direction {
    fn scale(self) -> f64 {
        if self == Direction::Negative {
            -1.0
        } else {
            1.0
        }
    }

    fn label(self, axis: Axis) -> &'static str {
        match (axis, self) {
            (Axis::Pitch, Direction::Negative) => "Down",
            (Axis::Pitch, Direction::Positive) => "Up",
            (_, Direction::Negative) => "Left",
            (_, Direction::Positive) => "Right",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
enum Scope {
    Shared,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoneAxisState {
    axis: Axis,
    channel: String,
    node_key: String,
    positive_au_id: Option<u32>,
    negative_au_id: Option<u32>,
    positive_max_degrees: Option<f64>,
    negative_max_degrees: Option<f64>,
    positive_scale: Option<i8>,
    negative_scale: Option<i8>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct DirectionScaleState {
    left: Option<i8>,
    right: Option<i8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeState {
    scope: Scope,
    label: String,
    negative_au_id: Option<u32>,
    positive_au_id: Option<u32>,
    negative_max_degrees: Option<f64>,
    positive_max_degrees: Option<f64>,
    negative_scale: DirectionScaleState,
    positive_scale: DirectionScaleState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BilateralState {
    axis: Axis,
    family_label: String,
    left_bone_name: String,
    left_node_key: String,
    right_bone_name: String,
    right_node_key: String,
    selected_side: String,
    shared: ScopeState,
    left: ScopeState,
    right: ScopeState,
}

#[derive(Debug, Clone)]
struct BilateralContext {
    family_label: String,
    selected_side: Scope,
    left_bone_name: String,
    left_node_key: String,
    right_bone_name: String,
    right_node_key: String,
    left_channel: String,
    right_channel: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    op: String,
    #[serde(default)]
    payload: Value,
}

fn value_field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("Missing request field \"{key}\""))
}

fn string_field(value: &Value, key: &str) -> Result<String, String> {
    value_field(value, key)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Request field \"{key}\" must be a string"))
}

fn profile_field(value: &Value) -> Result<ProfileData, String> {
    serde_json::from_value(value_field(value, "profile")?.clone())
        .map_err(|error| format!("Invalid profile: {error}"))
}

fn axis_field(value: &Value) -> Result<Axis, String> {
    serde_json::from_value(value_field(value, "axis")?.clone())
        .map_err(|error| format!("Invalid axis: {error}"))
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn normalize_degrees(value: Option<f64>) -> f64 {
    value
        .filter(|entry| entry.is_finite())
        .unwrap_or(DEFAULT_BONE_MAX_DEGREES)
        .round()
        .clamp(1.0, 180.0)
}

fn direction_scale(value: Option<i64>, fallback: i8) -> i8 {
    match value {
        Some(-1) => -1,
        Some(1) => 1,
        _ => fallback,
    }
}

fn tokenize(value: &str) -> Vec<String> {
    let mut with_breaks = String::with_capacity(value.len() + 8);
    let chars: Vec<char> = value.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if index > 0 && character.is_ascii_uppercase() && chars[index - 1].is_ascii_lowercase() {
            with_breaks.push('_');
        }
        with_breaks.push(*character);
    }
    with_breaks
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn chiral(value: &str) -> (Option<&'static str>, String, u8) {
    let tokens = tokenize(value);
    let has_left_word = tokens.iter().any(|token| token == "left");
    let has_right_word = tokens.iter().any(|token| token == "right");
    let has_left_short = tokens.iter().any(|token| token == "l");
    let has_right_short = tokens.iter().any(|token| token == "r");
    let left = has_left_word || has_left_short;
    let right = has_right_word || has_right_short;
    let side = match (left, right) {
        (true, false) => Some("left"),
        (false, true) => Some("right"),
        _ => None,
    };
    let stem = tokens
        .iter()
        .filter(|token| !matches!(token.as_str(), "left" | "right" | "l" | "r"))
        .cloned()
        .collect::<Vec<_>>()
        .join("_");
    let strength = if has_left_word || has_right_word {
        2
    } else if left || right {
        1
    } else {
        0
    };
    (side, stem, strength)
}

fn chiral_match(node: &str, bone: &str) -> (Option<&'static str>, String) {
    let key = chiral(node);
    let name = chiral(bone);
    if key.0.is_some() && (name.0.is_none() || key.2 >= name.2) {
        (key.0, key.1)
    } else {
        (name.0, name.1)
    }
}

fn title_case_stem(stem: &str) -> String {
    stem.split(['_', '-', ' '])
        .filter(|token| !token.is_empty())
        .map(|token| {
            let mut chars = token.chars();
            chars
                .next()
                .map(|head| head.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn infer_chiral_pair(names: &[String], selected: &str) -> Option<Value> {
    let mut groups: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
    for name in names {
        let (side, stem, _) = chiral(name);
        let Some(side) = side else { continue };
        let entry = groups.entry(stem).or_default();
        if side == "left" {
            entry.0.push(name.clone())
        } else {
            entry.1.push(name.clone())
        }
    }
    for (stem, (mut left, mut right)) in groups {
        left.sort();
        right.sort();
        for (left_name, right_name) in left.into_iter().zip(right) {
            if left_name == selected || right_name == selected {
                return Some(json!({
                    "leftBoneName": left_name,
                    "rightBoneName": right_name,
                    "selectedSide": if left_name == selected { "left" } else { "right" },
                    "familyLabel": title_case_stem(&stem),
                }));
            }
        }
    }
    None
}

fn strip_affixes(profile: &ProfileData, bone_name: &str) -> String {
    let mut value = bone_name.trim().to_string();
    if let Some(prefix) = profile
        .bone_prefix
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped.to_string();
        }
    }
    if let Some(suffix) = profile
        .bone_suffix
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if let Some(stripped) = value.strip_suffix(suffix) {
            value = stripped.to_string();
        }
    }
    if value.is_empty() {
        bone_name.trim().to_string()
    } else {
        value
    }
}

fn fuzzy_name_match(object_name: &str, target_name: &str, pattern: Option<&str>) -> bool {
    if object_name == target_name || object_name.replace('.', "") == target_name.replace('.', "") {
        return true;
    }
    let Some(suffix) = object_name.strip_prefix(target_name) else {
        return false;
    };
    if suffix.is_empty() {
        return true;
    }
    pattern
        .and_then(|value| Regex::new(value).ok())
        .unwrap_or_else(|| Regex::new(r"^[_\.]\d+$").unwrap())
        .is_match(suffix)
}

fn matches_node(profile: &ProfileData, bone_name: &str, node_key: &str) -> bool {
    let Some(base) = profile.bone_nodes.get(node_key) else {
        return false;
    };
    let prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let suffix = profile.bone_suffix.as_deref().unwrap_or("");
    let prefixed = if !prefix.is_empty() && !base.starts_with(prefix) {
        format!("{prefix}{base}")
    } else {
        base.clone()
    };
    let expected = format!("{prefixed}{suffix}");
    fuzzy_name_match(bone_name, &expected, profile.suffix_pattern.as_deref())
        || fuzzy_name_match(bone_name, base, profile.suffix_pattern.as_deref())
}

fn find_node_key(profile: &ProfileData, bone_name: &str) -> Option<String> {
    profile
        .bone_nodes
        .keys()
        .find(|node| matches_node(profile, bone_name, node))
        .cloned()
}

fn ensure_node(profile: &mut ProfileData, bone_name: &str) -> String {
    if let Some(existing) = find_node_key(profile, bone_name) {
        return existing;
    }
    let base = bone_name.trim();
    let mut key = if base.is_empty() { "CUSTOM" } else { base }.to_string();
    let mut suffix = 2;
    while profile
        .bone_nodes
        .get(&key)
        .is_some_and(|current| current != bone_name)
    {
        key = format!("{base}_{suffix}");
        suffix += 1;
    }
    profile
        .bone_nodes
        .insert(key.clone(), bone_name.to_string());
    key
}

fn resolve_bone_name(profile: &ProfileData, node: &str) -> Option<String> {
    let base = profile.bone_nodes.get(node)?;
    let prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let suffix = profile.bone_suffix.as_deref().unwrap_or("");
    let value = if !prefix.is_empty() && !base.starts_with(prefix) {
        format!("{prefix}{base}")
    } else {
        base.clone()
    };
    Some(format!("{value}{suffix}"))
}

fn axis_config<'a>(
    composite: &'a CompositeRotationData,
    axis: Axis,
) -> &'a Option<RotationAxisData> {
    match axis {
        Axis::Pitch => &composite.pitch,
        Axis::Yaw => &composite.yaw,
        Axis::Roll => &composite.roll,
    }
}

fn axis_config_mut<'a>(
    composite: &'a mut CompositeRotationData,
    axis: Axis,
) -> &'a mut Option<RotationAxisData> {
    match axis {
        Axis::Pitch => &mut composite.pitch,
        Axis::Yaw => &mut composite.yaw,
        Axis::Roll => &mut composite.roll,
    }
}

fn selector_values(selector: &Option<AuSelector>) -> Vec<u32> {
    match selector {
        None => Vec::new(),
        Some(AuSelector::One(value)) => vec![*value],
        Some(AuSelector::Many(values)) => values.clone(),
    }
}

fn selector(values: Vec<u32>) -> Option<AuSelector> {
    match values.as_slice() {
        [] => None,
        [value] => Some(AuSelector::One(*value)),
        _ => Some(AuSelector::Many(values)),
    }
}

fn push_unique(values: &mut Vec<u32>, value: u32) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn semantic_axis_claims(profile: &ProfileData, node: &str) -> HashMap<u32, Axis> {
    let mut claims = HashMap::new();
    for (key, pair) in &profile.continuum_pairs {
        let (Ok(id), Some(pair)) = (key.parse(), pair) else {
            continue;
        };
        if pair.node.as_deref() != Some(node) {
            continue;
        }
        if let Some(axis) = pair
            .axis
            .as_deref()
            .and_then(|value| serde_json::from_value(json!(value)).ok())
        {
            claims.insert(id, axis);
        }
    }
    if let Some(composite) = profile
        .composite_rotations
        .iter()
        .find(|entry| entry.node == node)
    {
        for axis in [Axis::Pitch, Axis::Yaw, Axis::Roll] {
            let Some(config) = axis_config(composite, axis).as_ref() else {
                continue;
            };
            for id in selector_values(&config.negative)
                .into_iter()
                .chain(selector_values(&config.positive))
                .chain(config.aus.iter().copied())
            {
                claims.insert(id, axis);
            }
        }
    }
    claims
}

fn semantic_ids(profile: &ProfileData, node: &str, axis: Axis, direction: Direction) -> Vec<u32> {
    let mut pair_ids = profile
        .continuum_pairs
        .iter()
        .filter_map(|(key, pair)| {
            let id = key.parse::<u32>().ok()?;
            let pair = pair.as_ref()?;
            (pair.node.as_deref() == Some(node)
                && pair.axis.as_deref() == Some(axis.key())
                && pair.is_negative == (direction == Direction::Negative))
                .then_some(id)
        })
        .collect::<Vec<_>>();
    pair_ids.sort_unstable();

    let mut ids = Vec::new();
    if let Some(config) = profile
        .composite_rotations
        .iter()
        .find(|entry| entry.node == node)
        .and_then(|entry| axis_config(entry, axis).as_ref())
    {
        let negative = selector_values(&config.negative);
        let positive = selector_values(&config.positive);
        let selected = if direction == Direction::Negative {
            negative.clone()
        } else {
            positive.clone()
        };
        for id in selected.iter().copied() {
            push_unique(&mut ids, id);
        }
        if direction == Direction::Positive && !selected.is_empty() {
            for id in config
                .aus
                .iter()
                .copied()
                .filter(|id| !negative.contains(id) && !positive.contains(id))
            {
                push_unique(&mut ids, id);
            }
        }
        for id in pair_ids.iter().copied() {
            push_unique(&mut ids, id);
        }
        if !ids.is_empty() {
            return ids;
        }
    }

    if !pair_ids.is_empty() {
        return pair_ids;
    }

    let claims = semantic_axis_claims(profile, node);
    let mut binding_ids = profile
        .au_to_bones
        .keys()
        .filter_map(|key| key.parse::<u32>().ok())
        .collect::<Vec<_>>();
    binding_ids.sort_unstable();
    for id in binding_ids {
        if claims.get(&id).is_some_and(|claimed| *claimed != axis) {
            continue;
        }
        let matches = profile
            .au_to_bones
            .get(&id.to_string())
            .is_some_and(|bindings| {
                bindings.iter().any(|binding| {
                    binding.node == node
                        && binding.channel == axis.channel()
                        && binding.scale.signum() == direction.scale()
                })
            });
        if matches {
            ids.push(id);
        }
    }
    ids
}

fn find_binding<'a>(
    profile: &'a ProfileData,
    au_id: u32,
    node: &str,
    channel: Option<&str>,
) -> Option<&'a BoneBindingData> {
    profile
        .au_to_bones
        .get(&au_id.to_string())?
        .iter()
        .find(|binding| {
            binding.node == node
                && matches!(binding.channel.as_str(), "rx" | "ry" | "rz")
                && channel.is_none_or(|expected| expected == binding.channel)
        })
}

fn get_axis_state(profile: &ProfileData, bone_name: &str, axis: Axis) -> Option<BoneAxisState> {
    let node = find_node_key(profile, bone_name)?;
    let composite = profile
        .composite_rotations
        .iter()
        .find(|entry| entry.node == node);
    let configured = composite.and_then(|entry| axis_config(entry, axis).as_ref());
    let negative_ids = semantic_ids(profile, &node, axis, Direction::Negative);
    let positive_ids = semantic_ids(profile, &node, axis, Direction::Positive);
    let configured_channel = configured.and_then(|entry| entry.axis.as_deref());
    let negative = negative_ids
        .iter()
        .find_map(|id| {
            find_binding(profile, *id, &node, configured_channel).map(|binding| (*id, binding))
        })
        .or_else(|| {
            negative_ids.iter().find_map(|id| {
                find_binding(profile, *id, &node, None).map(|binding| (*id, binding))
            })
        });
    let positive = positive_ids
        .iter()
        .find_map(|id| {
            find_binding(profile, *id, &node, configured_channel).map(|binding| (*id, binding))
        })
        .or_else(|| {
            positive_ids.iter().find_map(|id| {
                find_binding(profile, *id, &node, None).map(|binding| (*id, binding))
            })
        });
    let channel = negative
        .as_ref()
        .map(|entry| entry.1.channel.clone())
        .or_else(|| positive.as_ref().map(|entry| entry.1.channel.clone()))
        .or_else(|| configured_channel.map(str::to_string))
        .unwrap_or_else(|| axis.channel().to_string());
    Some(BoneAxisState {
        axis,
        channel,
        node_key: node,
        positive_au_id: positive.as_ref().map(|entry| entry.0),
        negative_au_id: negative.as_ref().map(|entry| entry.0),
        positive_max_degrees: positive.as_ref().and_then(|entry| entry.1.max_degrees),
        negative_max_degrees: negative.as_ref().and_then(|entry| entry.1.max_degrees),
        positive_scale: positive.as_ref().map(|entry| entry.1.scale.signum() as i8),
        negative_scale: negative.as_ref().map(|entry| entry.1.scale.signum() as i8),
    })
}

fn update_option_u32(update: &Map<String, Value>, key: &str, current: Option<u32>) -> Option<u32> {
    match update.get(key) {
        None => current,
        Some(Value::Null) => None,
        Some(value) => value.as_u64().map(|entry| entry as u32),
    }
}

fn update_option_f64(update: &Map<String, Value>, key: &str, current: Option<f64>) -> Option<f64> {
    match update.get(key) {
        None => current,
        Some(Value::Null) => None,
        Some(value) => value.as_f64(),
    }
}

fn update_option_scale(update: &Map<String, Value>, key: &str, current: Option<i8>) -> Option<i8> {
    match update.get(key) {
        None => current,
        Some(Value::Null) => None,
        Some(value) => value
            .as_i64()
            .map(|entry| direction_scale(Some(entry), current.unwrap_or(1))),
    }
}

fn remove_axis_metadata(profile: &mut ProfileData, node: &str, axis: Axis) {
    let mut removed_labels = Vec::new();
    profile.continuum_pairs.retain(|key, pair| {
        let remove = pair.as_ref().is_some_and(|entry| {
            entry.node.as_deref() == Some(node) && entry.axis.as_deref() == Some(axis.key())
        });
        if remove {
            if let (Ok(id), Some(pair)) = (key.parse::<u32>(), pair.as_ref()) {
                let label = if pair.is_negative {
                    format!("{id}-{}", pair.pair_id)
                } else {
                    format!("{}-{id}", pair.pair_id)
                };
                removed_labels.push(label);
            }
        }
        !remove
    });
    for label in removed_labels {
        profile.continuum_labels.remove(&label);
    }
}

fn upsert_composite(
    profile: &mut ProfileData,
    node: &str,
    axis: Axis,
    channel: &str,
    negative: Vec<u32>,
    positive: Vec<u32>,
    ordered_aus: Option<Vec<u32>>,
) {
    let mut all = Vec::new();
    for id in ordered_aus.unwrap_or_else(|| negative.iter().chain(&positive).copied().collect()) {
        push_unique(&mut all, id);
    }
    let index = profile
        .composite_rotations
        .iter()
        .position(|entry| entry.node == node)
        .unwrap_or_else(|| {
            profile.composite_rotations.push(CompositeRotationData {
                node: node.to_string(),
                pitch: None,
                yaw: None,
                roll: None,
                extensions: Map::new(),
            });
            profile.composite_rotations.len() - 1
        });
    *axis_config_mut(&mut profile.composite_rotations[index], axis) = if all.is_empty() {
        None
    } else {
        Some(RotationAxisData {
            aus: all,
            axis: Some(channel.to_string()),
            negative: selector(negative),
            positive: selector(positive),
            extensions: Map::new(),
        })
    };
    profile
        .composite_rotations
        .retain(|entry| entry.pitch.is_some() || entry.yaw.is_some() || entry.roll.is_some());
}

fn continuum_label(profile: &ProfileData, negative: u32, positive: u32) -> Option<String> {
    let key = format!("{negative}-{positive}");
    let stored = profile
        .continuum_labels
        .get(&key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let neg_name = profile
        .au_info
        .get(&negative.to_string())
        .and_then(|entry| entry.name.as_deref());
    let pos_name = profile
        .au_info
        .get(&positive.to_string())
        .and_then(|entry| entry.name.as_deref());
    let pair = profile
        .continuum_pairs
        .get(&negative.to_string())
        .and_then(|entry| entry.as_ref());
    let axis = pair.and_then(|entry| entry.axis.as_deref());
    let derived = match (neg_name, pos_name) {
        (Some(left), Some(right)) => {
            let left_tokens: Vec<&str> = left.split_whitespace().collect();
            let right_tokens: Vec<&str> = right.split_whitespace().collect();
            let common = left_tokens
                .iter()
                .zip(right_tokens)
                .take_while(|(a, b)| a.eq_ignore_ascii_case(b))
                .map(|entry| *entry.0)
                .collect::<Vec<_>>()
                .join(" ");
            let lower = common.to_ascii_lowercase();
            let has_semantic_direction = lower
                .split_whitespace()
                .any(|token| matches!(token, "turn" | "look" | "tilt" | "horizontal" | "vertical"));
            if common.is_empty() {
                None
            } else if axis.is_some_and(|axis| !lower.contains(axis)) && !has_semantic_direction {
                Some(format!("{} {}", common, title_case_stem(axis.unwrap())))
            } else {
                Some(common)
            }
        }
        _ => None,
    };
    let auto = pair.and_then(|pair| {
        let axis = pair.axis.as_deref()?;
        let node = pair.node.as_deref()?;
        let bone_name = resolve_bone_name(profile, node)
            .or_else(|| profile.bone_nodes.get(node).cloned())
            .unwrap_or_else(|| node.to_string());
        Some(format!(
            "{} {}",
            human_bone_label(profile, &bone_name),
            title_case_stem(axis)
        ))
    });
    if stored
        .as_ref()
        .is_some_and(|label| auto.as_ref().is_none_or(|generated| generated != label))
    {
        return stored;
    }
    derived.or(stored).or(auto)
}

fn apply_axis_update(
    mut profile: ProfileData,
    bone_name: &str,
    axis: Axis,
    update: &Map<String, Value>,
) -> ProfileData {
    let node = ensure_node(&mut profile, bone_name);
    let existing_negative_ids = semantic_ids(&profile, &node, axis, Direction::Negative);
    let existing_positive_ids = semantic_ids(&profile, &node, axis, Direction::Positive);
    let current = get_axis_state(&profile, bone_name, axis).unwrap_or(BoneAxisState {
        axis,
        channel: axis.channel().to_string(),
        node_key: node.clone(),
        positive_au_id: None,
        negative_au_id: None,
        positive_max_degrees: None,
        negative_max_degrees: None,
        positive_scale: None,
        negative_scale: None,
    });
    let channel = update
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or(&current.channel)
        .to_string();
    let negative_id = update_option_u32(update, "negativeAuId", current.negative_au_id);
    let positive_id = update_option_u32(update, "positiveAuId", current.positive_au_id);
    let negative_degrees = negative_id.map(|_| {
        normalize_degrees(update_option_f64(
            update,
            "negativeMaxDegrees",
            current.negative_max_degrees,
        ))
    });
    let positive_degrees = positive_id.map(|_| {
        normalize_degrees(update_option_f64(
            update,
            "positiveMaxDegrees",
            current.positive_max_degrees,
        ))
    });
    let negative_scale =
        update_option_scale(update, "negativeScale", current.negative_scale).unwrap_or(-1);
    let positive_scale =
        update_option_scale(update, "positiveScale", current.positive_scale).unwrap_or(1);
    let mut negative_selector_ids = if update.contains_key("negativeAuId") {
        negative_id.into_iter().collect::<Vec<_>>()
    } else {
        existing_negative_ids.clone()
    };
    let mut positive_selector_ids = if update.contains_key("positiveAuId") {
        positive_id.into_iter().collect::<Vec<_>>()
    } else {
        existing_positive_ids.clone()
    };
    negative_selector_ids.retain(|id| Some(*id) != positive_id);
    positive_selector_ids.retain(|id| Some(*id) != negative_id);
    negative_selector_ids.dedup();
    positive_selector_ids.dedup();

    let mut ids = Vec::new();
    for id in existing_negative_ids
        .iter()
        .chain(&existing_positive_ids)
        .chain(&negative_selector_ids)
        .chain(&positive_selector_ids)
        .copied()
    {
        push_unique(&mut ids, id);
    }
    let relevant_channels = [current.channel.as_str(), channel.as_str()];
    let previous_bindings = ids
        .iter()
        .filter_map(|id| {
            profile
                .au_to_bones
                .get(&id.to_string())
                .and_then(|bindings| {
                    bindings.iter().find(|binding| {
                        binding.node == node
                            && matches!(binding.channel.as_str(), "rx" | "ry" | "rz")
                            && relevant_channels.contains(&binding.channel.as_str())
                    })
                })
                .cloned()
                .map(|binding| (*id, binding))
        })
        .collect::<HashMap<_, _>>();
    let previous_negative = current
        .negative_au_id
        .and_then(|id| previous_bindings.get(&id))
        .cloned();
    let previous_positive = current
        .positive_au_id
        .and_then(|id| previous_bindings.get(&id))
        .cloned();
    for id in &ids {
        let key = id.to_string();
        if let Some(bindings) = profile.au_to_bones.get_mut(&key) {
            bindings.retain(|binding| {
                !(binding.node == node && relevant_channels.contains(&binding.channel.as_str()))
            });
            if bindings.is_empty() {
                profile.au_to_bones.remove(&key);
            }
        }
    }
    let mut add = |id: u32, scale: f64, degrees: f64, previous: Option<&BoneBindingData>| {
        profile
            .au_to_bones
            .entry(id.to_string())
            .or_default()
            .push(BoneBindingData {
                node: node.clone(),
                channel: channel.clone(),
                scale,
                max_degrees: Some(degrees),
                max_units: None,
                side: previous.and_then(|entry| entry.side.clone()),
                extensions: Map::new(),
            });
    };
    for id in &negative_selector_ids {
        let previous = previous_bindings.get(id).or(previous_negative.as_ref());
        let degrees = if Some(*id) == negative_id {
            negative_degrees
        } else {
            previous.and_then(|entry| entry.max_degrees)
        };
        if let Some(degrees) = degrees {
            let scale = if Some(*id) == negative_id {
                negative_scale as f64
            } else {
                previous
                    .map(|entry| entry.scale)
                    .unwrap_or(negative_scale as f64)
            };
            add(*id, scale, degrees, previous);
        }
    }
    for id in &positive_selector_ids {
        let previous = previous_bindings.get(id).or(previous_positive.as_ref());
        let degrees = if Some(*id) == positive_id {
            positive_degrees
        } else {
            previous.and_then(|entry| entry.max_degrees)
        };
        if let Some(degrees) = degrees {
            let scale = if Some(*id) == positive_id {
                positive_scale as f64
            } else {
                previous
                    .map(|entry| entry.scale)
                    .unwrap_or(positive_scale as f64)
            };
            add(*id, scale, degrees, previous);
        }
    }
    remove_axis_metadata(&mut profile, &node, axis);
    if let (Some(negative), Some(positive)) = (negative_id, positive_id) {
        if negative != positive {
            profile.continuum_pairs.insert(
                negative.to_string(),
                Some(ContinuumPairData {
                    pair_id: positive,
                    is_negative: true,
                    axis: Some(axis.key().to_string()),
                    node: Some(node.clone()),
                    extensions: Map::new(),
                }),
            );
            profile.continuum_pairs.insert(
                positive.to_string(),
                Some(ContinuumPairData {
                    pair_id: negative,
                    is_negative: false,
                    axis: Some(axis.key().to_string()),
                    node: Some(node.clone()),
                    extensions: Map::new(),
                }),
            );
            let label = format!(
                "{} {}",
                title_case_stem(&strip_affixes(&profile, bone_name)),
                axis.label()
            );
            profile
                .continuum_labels
                .insert(format!("{negative}-{positive}"), label);
        }
    }
    upsert_composite(
        &mut profile,
        &node,
        axis,
        &channel,
        negative_selector_ids.clone(),
        positive_selector_ids.clone(),
        Some(
            negative_selector_ids
                .into_iter()
                .chain(positive_selector_ids)
                .collect(),
        ),
    );
    profile
}

fn next_au_id(profile: &ProfileData) -> u32 {
    profile
        .au_to_bones
        .keys()
        .chain(profile.au_to_morphs.keys())
        .chain(profile.au_info.keys())
        .chain(profile.continuum_pairs.keys())
        .filter_map(|value| value.parse::<u32>().ok())
        .chain(
            profile
                .continuum_pairs
                .values()
                .filter_map(|value| value.as_ref().map(|pair| pair.pair_id)),
        )
        .max()
        .unwrap_or(0)
        + 1
}

fn human_bone_label(profile: &ProfileData, bone_name: &str) -> String {
    title_case_stem(&tokenize(&strip_affixes(profile, bone_name)).join("_"))
}

fn create_axis_au(
    mut profile: ProfileData,
    bone_name: &str,
    axis: Axis,
    direction: Direction,
    name: Option<&str>,
) -> Value {
    let node = ensure_node(&mut profile, bone_name);
    let id = next_au_id(&profile);
    let label = name
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{} {} {}",
                human_bone_label(&profile, bone_name),
                axis.label(),
                direction.label(axis)
            )
        });
    let lower = format!("{node} {bone_name}").to_ascii_lowercase();
    let area = if ["jaw", "mouth", "lip", "tongue", "chin"]
        .iter()
        .any(|token| lower.contains(token))
    {
        "Lower"
    } else {
        "Upper"
    };
    profile.au_info.insert(
        id.to_string(),
        AuInfoData {
            id: Some(id.to_string()),
            name: Some(label),
            muscular_basis: None,
            links: Vec::new(),
            face_area: Some(area.to_string()),
            face_part: Some(JOINT_CONTROL_SECTION.to_string()),
            extensions: Map::new(),
        },
    );
    json!({ "auId": id, "profile": profile })
}

fn is_eye_node(node: &str) -> bool {
    matches!(node, "EYE_L" | "EYE_R")
        || tokenize(node)
            .iter()
            .any(|token| token == "eye" || token == "eyes")
}

fn bilateral_context(
    profile: &mut ProfileData,
    bone_name: &str,
    axis: Axis,
) -> Option<BilateralContext> {
    let selected_node = ensure_node(profile, bone_name);
    let (selected_side, selected_stem) = chiral_match(&selected_node, bone_name);
    let selected_side = selected_side?;
    let mut counterpart = None;
    for (node, name) in &profile.bone_nodes {
        if node == &selected_node {
            continue;
        }
        let (side, stem) = chiral_match(node, name);
        if side.is_some_and(|side| side != selected_side) && stem == selected_stem {
            counterpart = Some((node.clone(), name.clone(), side.unwrap()));
            break;
        }
    }
    let (other_node, other_name, _) = counterpart?;
    let selected_name = resolve_bone_name(profile, &selected_node)
        .or_else(|| profile.bone_nodes.get(&selected_node).cloned())
        .unwrap_or_else(|| bone_name.to_string());
    let other_resolved = resolve_bone_name(profile, &other_node)
        .or_else(|| profile.bone_nodes.get(&other_node).cloned())
        .unwrap_or(other_name);
    let (left_node_key, left_bone_name, right_node_key, right_bone_name, selected_scope) =
        if selected_side == "left" {
            (
                selected_node,
                selected_name,
                other_node,
                other_resolved,
                Scope::Left,
            )
        } else {
            (
                other_node,
                other_resolved,
                selected_node,
                selected_name,
                Scope::Right,
            )
        };
    let left_channel = get_axis_state(profile, &left_bone_name, axis)
        .map(|state| state.channel)
        .unwrap_or_else(|| axis.channel().to_string());
    let right_channel = get_axis_state(profile, &right_bone_name, axis)
        .map(|state| state.channel)
        .unwrap_or_else(|| axis.channel().to_string());
    Some(BilateralContext {
        family_label: title_case_stem(&selected_stem),
        selected_side: selected_scope,
        left_bone_name,
        left_node_key,
        right_bone_name,
        right_node_key,
        left_channel,
        right_channel,
    })
}

fn rotation_binding<'a>(
    profile: &'a ProfileData,
    au_id: u32,
    node: &str,
    channel: &str,
) -> Option<&'a BoneBindingData> {
    profile
        .au_to_bones
        .get(&au_id.to_string())?
        .iter()
        .find(|binding| binding.node == node && binding.channel == channel)
}

fn bilateral_ids(
    profile: &ProfileData,
    context: &BilateralContext,
    axis: Axis,
    direction: Direction,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let left = semantic_ids(profile, &context.left_node_key, axis, direction);
    let right = semantic_ids(profile, &context.right_node_key, axis, direction);
    let mut shared = left
        .iter()
        .chain(&right)
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|id| {
            rotation_binding(profile, *id, &context.left_node_key, &context.left_channel).is_some()
                && rotation_binding(
                    profile,
                    *id,
                    &context.right_node_key,
                    &context.right_channel,
                )
                .is_some()
        })
        .collect::<Vec<_>>();
    if direction == Direction::Positive {
        let shared_negative = bilateral_ids(profile, context, axis, Direction::Negative).0;
        shared.retain(|id| !shared_negative.contains(id));
    }
    let left_only = left.into_iter().filter(|id| !shared.contains(id)).collect();
    let right_only = right
        .into_iter()
        .filter(|id| !shared.contains(id))
        .collect();
    (shared, left_only, right_only)
}

fn scope_state(
    profile: &ProfileData,
    context: &BilateralContext,
    axis: Axis,
    scope: Scope,
) -> ScopeState {
    let (shared_negative, left_negative, right_negative) =
        bilateral_ids(profile, context, axis, Direction::Negative);
    let (shared_positive, left_positive, right_positive) =
        bilateral_ids(profile, context, axis, Direction::Positive);
    let ids = |shared: &[u32], left: &[u32], right: &[u32]| match scope {
        Scope::Shared => shared.first().copied(),
        Scope::Left => left.first().copied(),
        Scope::Right => right.first().copied(),
    };
    let negative = ids(&shared_negative, &left_negative, &right_negative);
    let positive = ids(&shared_positive, &left_positive, &right_positive);
    let binding = |id: Option<u32>, side: Scope| -> Option<&BoneBindingData> {
        let id = id?;
        match side {
            Scope::Left => {
                rotation_binding(profile, id, &context.left_node_key, &context.left_channel)
            }
            Scope::Right => {
                rotation_binding(profile, id, &context.right_node_key, &context.right_channel)
            }
            Scope::Shared => None,
        }
    };
    let negative_left = (scope != Scope::Right)
        .then(|| binding(negative, Scope::Left))
        .flatten();
    let negative_right = (scope != Scope::Left)
        .then(|| binding(negative, Scope::Right))
        .flatten();
    let positive_left = (scope != Scope::Right)
        .then(|| binding(positive, Scope::Left))
        .flatten();
    let positive_right = (scope != Scope::Left)
        .then(|| binding(positive, Scope::Right))
        .flatten();
    ScopeState {
        scope,
        label: match scope {
            Scope::Shared => "Both",
            Scope::Left => "Left only",
            Scope::Right => "Right only",
        }
        .to_string(),
        negative_au_id: negative,
        positive_au_id: positive,
        negative_max_degrees: negative_left
            .or(negative_right)
            .and_then(|binding| binding.max_degrees),
        positive_max_degrees: positive_left
            .or(positive_right)
            .and_then(|binding| binding.max_degrees),
        negative_scale: DirectionScaleState {
            left: negative_left.map(|binding| binding.scale.signum() as i8),
            right: negative_right.map(|binding| binding.scale.signum() as i8),
        },
        positive_scale: DirectionScaleState {
            left: positive_left.map(|binding| binding.scale.signum() as i8),
            right: positive_right.map(|binding| binding.scale.signum() as i8),
        },
    }
}

fn bilateral_state(profile: &ProfileData, bone_name: &str, axis: Axis) -> Option<BilateralState> {
    let mut working = profile.clone();
    let context = bilateral_context(&mut working, bone_name, axis)?;
    Some(BilateralState {
        axis,
        family_label: context.family_label.clone(),
        left_bone_name: context.left_bone_name.clone(),
        left_node_key: context.left_node_key.clone(),
        right_bone_name: context.right_bone_name.clone(),
        right_node_key: context.right_node_key.clone(),
        selected_side: match context.selected_side {
            Scope::Left => "left",
            Scope::Right => "right",
            Scope::Shared => "shared",
        }
        .to_string(),
        shared: scope_state(&working, &context, axis, Scope::Shared),
        left: scope_state(&working, &context, axis, Scope::Left),
        right: scope_state(&working, &context, axis, Scope::Right),
    })
}

fn apply_scope_update(state: &mut ScopeState, update: &Map<String, Value>) {
    state.negative_au_id = update_option_u32(update, "negativeAuId", state.negative_au_id);
    state.positive_au_id = update_option_u32(update, "positiveAuId", state.positive_au_id);
    state.negative_max_degrees = state.negative_au_id.map(|_| {
        normalize_degrees(update_option_f64(
            update,
            "negativeMaxDegrees",
            state.negative_max_degrees,
        ))
    });
    state.positive_max_degrees = state.positive_au_id.map(|_| {
        normalize_degrees(update_option_f64(
            update,
            "positiveMaxDegrees",
            state.positive_max_degrees,
        ))
    });
    let shared_negative = update_option_scale(update, "negativeScale", None);
    let shared_positive = update_option_scale(update, "positiveScale", None);
    if let Some(value) = update_option_scale(update, "negativeLeftScale", shared_negative) {
        state.negative_scale.left = Some(value);
    }
    if let Some(value) = update_option_scale(update, "negativeRightScale", shared_negative) {
        state.negative_scale.right = Some(value);
    }
    if let Some(value) = update_option_scale(update, "positiveLeftScale", shared_positive) {
        state.positive_scale.left = Some(value);
    }
    if let Some(value) = update_option_scale(update, "positiveRightScale", shared_positive) {
        state.positive_scale.right = Some(value);
    }
}

fn apply_bilateral_update(
    mut profile: ProfileData,
    bone_name: &str,
    axis: Axis,
    scope: Scope,
    update: &Map<String, Value>,
) -> ProfileData {
    let Some(context) = bilateral_context(&mut profile, bone_name, axis) else {
        return profile;
    };
    let Some(mut state) = bilateral_state(&profile, bone_name, axis) else {
        return profile;
    };
    let selected = match scope {
        Scope::Shared => &mut state.shared,
        Scope::Left => &mut state.left,
        Scope::Right => &mut state.right,
    };
    apply_scope_update(selected, update);
    let channel = update
        .get("channel")
        .and_then(Value::as_str)
        .map(str::to_string);
    let left_channel = channel.clone().unwrap_or(context.left_channel.clone());
    let right_channel = channel.unwrap_or(context.right_channel.clone());

    let desired = [&state.shared, &state.left, &state.right];
    let desired_ids = desired
        .iter()
        .flat_map(|state| [state.negative_au_id, state.positive_au_id])
        .flatten()
        .collect::<HashSet<_>>();
    let existing_ids = [
        semantic_ids(&profile, &context.left_node_key, axis, Direction::Negative),
        semantic_ids(&profile, &context.left_node_key, axis, Direction::Positive),
        semantic_ids(&profile, &context.right_node_key, axis, Direction::Negative),
        semantic_ids(&profile, &context.right_node_key, axis, Direction::Positive),
    ]
    .concat();
    let relevant = existing_ids
        .into_iter()
        .chain(desired_ids)
        .collect::<HashSet<_>>();
    for id in &relevant {
        let key = id.to_string();
        if let Some(bindings) = profile.au_to_bones.get_mut(&key) {
            bindings.retain(|binding| {
                !((binding.node == context.left_node_key || binding.node == context.right_node_key)
                    && matches!(binding.channel.as_str(), "rx" | "ry" | "rz"))
            });
            if bindings.is_empty() {
                profile.au_to_bones.remove(&key);
            }
        }
    }
    remove_axis_metadata(&mut profile, &context.left_node_key, axis);
    remove_axis_metadata(&mut profile, &context.right_node_key, axis);

    let mut add_binding =
        |id: u32, node: &str, channel: &str, scale: i8, degrees: f64, side: &str| {
            profile
                .au_to_bones
                .entry(id.to_string())
                .or_default()
                .push(BoneBindingData {
                    node: node.to_string(),
                    channel: channel.to_string(),
                    scale: scale as f64,
                    max_degrees: Some(degrees),
                    max_units: None,
                    side: Some(side.to_string()),
                    extensions: Map::new(),
                });
        };
    for entry in desired {
        let sides: &[Scope] = match entry.scope {
            Scope::Shared => &[Scope::Left, Scope::Right],
            Scope::Left => &[Scope::Left],
            Scope::Right => &[Scope::Right],
        };
        for side in sides {
            let (node, channel, side_name) = match side {
                Scope::Left => (&context.left_node_key, &left_channel, "left"),
                Scope::Right => (&context.right_node_key, &right_channel, "right"),
                Scope::Shared => unreachable!(),
            };
            if let (Some(id), Some(degrees)) = (entry.negative_au_id, entry.negative_max_degrees) {
                let scale = match side {
                    Scope::Left => entry.negative_scale.left,
                    Scope::Right => entry.negative_scale.right,
                    Scope::Shared => None,
                }
                .unwrap_or(-1);
                add_binding(
                    id,
                    node,
                    channel,
                    scale,
                    normalize_degrees(Some(degrees)),
                    side_name,
                );
            }
            if let (Some(id), Some(degrees)) = (entry.positive_au_id, entry.positive_max_degrees) {
                let scale = match side {
                    Scope::Left => entry.positive_scale.left,
                    Scope::Right => entry.positive_scale.right,
                    Scope::Shared => None,
                }
                .unwrap_or(1);
                add_binding(
                    id,
                    node,
                    channel,
                    scale,
                    normalize_degrees(Some(degrees)),
                    side_name,
                );
            }
        }
    }

    let left_negative = [state.shared.negative_au_id, state.left.negative_au_id]
        .into_iter()
        .flatten()
        .collect();
    let left_positive = [state.shared.positive_au_id, state.left.positive_au_id]
        .into_iter()
        .flatten()
        .collect();
    let right_negative = [state.shared.negative_au_id, state.right.negative_au_id]
        .into_iter()
        .flatten()
        .collect();
    let right_positive = [state.shared.positive_au_id, state.right.positive_au_id]
        .into_iter()
        .flatten()
        .collect();
    upsert_composite(
        &mut profile,
        &context.left_node_key,
        axis,
        &left_channel,
        left_negative,
        left_positive,
        Some(
            [
                state.left.negative_au_id,
                state.left.positive_au_id,
                state.shared.negative_au_id,
                state.shared.positive_au_id,
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
    );
    upsert_composite(
        &mut profile,
        &context.right_node_key,
        axis,
        &right_channel,
        right_negative,
        right_positive,
        Some(
            [
                state.right.negative_au_id,
                state.right.positive_au_id,
                state.shared.negative_au_id,
                state.shared.positive_au_id,
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
    );
    for entry in [&state.shared, &state.left, &state.right] {
        let (Some(negative), Some(positive)) = (entry.negative_au_id, entry.positive_au_id) else {
            continue;
        };
        if negative == positive {
            continue;
        }
        let node = if entry.scope == Scope::Right {
            &context.right_node_key
        } else {
            &context.left_node_key
        };
        profile.continuum_pairs.insert(
            negative.to_string(),
            Some(ContinuumPairData {
                pair_id: positive,
                is_negative: true,
                axis: Some(axis.key().to_string()),
                node: Some(node.clone()),
                extensions: Map::new(),
            }),
        );
        profile.continuum_pairs.insert(
            positive.to_string(),
            Some(ContinuumPairData {
                pair_id: negative,
                is_negative: false,
                axis: Some(axis.key().to_string()),
                node: Some(node.clone()),
                extensions: Map::new(),
            }),
        );
        let label = match entry.scope {
            Scope::Shared => format!("{} {}", context.family_label, axis.label()),
            Scope::Left => format!("Left {} {}", context.family_label, axis.label()),
            Scope::Right => format!("Right {} {}", context.family_label, axis.label()),
        };
        profile
            .continuum_labels
            .insert(format!("{negative}-{positive}"), label);
    }
    profile
}

fn au_bone_state(profile: &ProfileData, au_id: u32) -> Value {
    let bindings = profile
        .au_to_bones
        .get(&au_id.to_string())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|binding| matches!(binding.channel.as_str(), "rx" | "ry" | "rz"))
        .collect::<Vec<_>>();
    let primary = bindings.first();
    let pair = profile
        .continuum_pairs
        .get(&au_id.to_string())
        .and_then(|entry| entry.as_ref());
    let bone_name = primary.and_then(|binding| {
        resolve_bone_name(profile, &binding.node)
            .or_else(|| profile.bone_nodes.get(&binding.node).cloned())
            .or_else(|| Some(binding.node.clone()))
    });
    let axis = pair
        .and_then(|entry| entry.axis.as_deref())
        .and_then(|axis| serde_json::from_value(json!(axis)).ok())
        .or_else(|| primary.and_then(|binding| Axis::from_channel(&binding.channel)))
        .unwrap_or(Axis::Pitch);
    let state = bone_name
        .as_deref()
        .and_then(|name| get_axis_state(profile, name, axis));
    let direction = if state.as_ref().and_then(|state| state.negative_au_id) == Some(au_id)
        || pair.is_some_and(|entry| entry.is_negative)
        || primary.is_some_and(|binding| binding.scale < 0.0)
    {
        Direction::Negative
    } else {
        Direction::Positive
    };
    json!({
        "auId": au_id,
        "boneName": bone_name,
        "nodeKey": primary.map(|binding| binding.node.clone()).or_else(|| pair.and_then(|entry| entry.node.clone())),
        "axis": axis,
        "direction": direction,
        "channel": primary.map(|binding| binding.channel.clone()),
        "maxDegrees": primary.and_then(|binding| binding.max_degrees),
        "oppositeAuId": state.as_ref().and_then(|state| if direction == Direction::Negative { state.positive_au_id } else { state.negative_au_id }),
        "oppositeMaxDegrees": state.as_ref().and_then(|state| if direction == Direction::Negative { state.positive_max_degrees } else { state.negative_max_degrees }),
        "hasBinding": primary.is_some(),
        "hasMultipleBindings": bindings.len() > 1,
    })
}

fn remove_au_rotation_bindings(profile: &mut ProfileData, au_id: u32) {
    let key = au_id.to_string();
    if let Some(bindings) = profile.au_to_bones.get_mut(&key) {
        bindings.retain(|binding| !matches!(binding.channel.as_str(), "rx" | "ry" | "rz"));
        if bindings.is_empty() {
            profile.au_to_bones.remove(&key);
        }
    }
    let paired = profile
        .continuum_pairs
        .get(&key)
        .and_then(|entry| entry.as_ref())
        .map(|entry| entry.pair_id);
    profile.continuum_pairs.remove(&key);
    if let Some(pair) = paired {
        profile.continuum_pairs.remove(&pair.to_string());
        profile
            .continuum_labels
            .remove(&format!("{}-{}", au_id.min(pair), au_id.max(pair)));
    }
    for composite in &mut profile.composite_rotations {
        for axis in [Axis::Pitch, Axis::Yaw, Axis::Roll] {
            if let Some(config) = axis_config_mut(composite, axis) {
                config.aus.retain(|id| *id != au_id);
                let negative = selector_values(&config.negative)
                    .into_iter()
                    .filter(|id| *id != au_id)
                    .collect();
                let positive = selector_values(&config.positive)
                    .into_iter()
                    .filter(|id| *id != au_id)
                    .collect();
                config.negative = selector(negative);
                config.positive = selector(positive);
                if config.aus.is_empty() {
                    *axis_config_mut(composite, axis) = None;
                }
            }
        }
    }
    profile
        .composite_rotations
        .retain(|entry| entry.pitch.is_some() || entry.yaw.is_some() || entry.roll.is_some());
}

fn bone_au_options(profile: &ProfileData) -> Vec<Value> {
    let mut ids = profile
        .au_to_bones
        .keys()
        .chain(profile.au_info.keys())
        .chain(profile.continuum_pairs.keys())
        .filter_map(|id| id.parse::<u32>().ok())
        .collect::<BTreeSet<_>>();
    let mut result = vec![json!({ "value": "", "label": "Unassigned" })];
    for id in std::mem::take(&mut ids) {
        let info = profile.au_info.get(&id.to_string());
        let joint = info.and_then(|info| info.face_part.as_deref()) == Some(JOINT_CONTROL_SECTION);
        let pair = profile
            .continuum_pairs
            .get(&id.to_string())
            .and_then(|entry| entry.as_ref());
        let original_name = info.and_then(|info| info.name.clone()).unwrap_or_default();
        let display = if let Some(pair) = pair {
            let (negative, positive) = if pair.is_negative {
                (id, pair.pair_id)
            } else {
                (pair.pair_id, id)
            };
            continuum_label(profile, negative, positive).map(|label| {
                format!(
                    "{} {}",
                    label,
                    Direction::from(pair.is_negative).label(
                        pair.axis
                            .as_deref()
                            .and_then(|axis| serde_json::from_value(json!(axis)).ok())
                            .unwrap_or(Axis::Pitch)
                    )
                )
            })
        } else {
            None
        }
        .or_else(|| (!original_name.is_empty()).then(|| original_name.clone()))
        .unwrap_or_default();
        let prefix = if joint { "Joint" } else { "AU" };
        let label = if display.is_empty() {
            format!("{prefix} {id}")
        } else {
            format!("{prefix} {id} - {display}")
        };
        let mut detail_parts = Vec::new();
        if pair.is_some() && !original_name.is_empty() && original_name != display {
            detail_parts.push(original_name);
        }
        if joint {
            detail_parts.push(JOINT_CONTROL_SECTION.to_string());
        } else if let Some(face_part) = info.and_then(|info| info.face_part.clone()) {
            detail_parts.push(face_part);
        }
        let detail = (!detail_parts.is_empty()).then(|| detail_parts.join(" · "));
        result.push(json!({ "value": id.to_string(), "label": label, "detail": detail }));
    }
    result
}

impl From<bool> for Direction {
    fn from(negative: bool) -> Self {
        if negative {
            Direction::Negative
        } else {
            Direction::Positive
        }
    }
}

fn merge_json(base: &Value, override_value: &Value) -> Value {
    match (base, override_value) {
        (Value::Object(base), Value::Object(overrides)) => {
            let mut result = base.clone();
            for (key, value) in overrides {
                let merged = result
                    .get(key)
                    .map(|current| merge_json(current, value))
                    .unwrap_or_else(|| value.clone());
                result.insert(key.clone(), merged);
            }
            Value::Object(result)
        }
        (_, value) => value.clone(),
    }
}

fn merge_regions(base: Option<&Value>, overrides: Option<&Value>) -> Option<Value> {
    if base.is_none() && overrides.is_none() {
        return None;
    }
    let mut result = Vec::<Value>::new();
    let mut indices = HashMap::<String, usize>::new();
    for region in base
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(overrides.and_then(Value::as_array).into_iter().flatten())
    {
        let Some(name) = region.get("name").and_then(Value::as_str) else {
            continue;
        };
        if let Some(index) = indices.get(name).copied() {
            result[index] = merge_json(&result[index], region);
        } else {
            indices.insert(name.to_string(), result.len());
            result.push(region.clone());
        }
    }
    Some(Value::Array(result))
}

fn normalize_region_tree(regions: Value, disabled: &[String]) -> Value {
    let disabled = disabled.iter().cloned().collect::<HashSet<_>>();
    let mut regions = regions
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|region| {
            region
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !disabled.contains(name))
        })
        .collect::<Vec<_>>();
    let names = regions
        .iter()
        .filter_map(|region| region.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for region in &mut regions {
        let Some(object) = region.as_object_mut() else {
            continue;
        };
        if object
            .get("parent")
            .and_then(Value::as_str)
            .is_some_and(|parent| !names.contains(parent))
        {
            object.remove("parent");
        }
        if let Some(children) = object.get("children").and_then(Value::as_array) {
            let filtered = children
                .iter()
                .filter(|child| child.as_str().is_some_and(|name| names.contains(name)))
                .cloned()
                .collect::<Vec<_>>();
            if filtered.is_empty() {
                object.remove("children");
            } else {
                object.insert("children".to_string(), Value::Array(filtered));
            }
        }
    }
    Value::Array(regions)
}

fn canonical_annotation_regions(config: &Value) -> Option<Value> {
    let nested = config.get("profile").and_then(Value::as_object);
    merge_regions(
        nested.and_then(|profile| profile.get("annotationRegions")),
        config.get("annotationRegions"),
    )
}

fn legacy_runtime_regions(config: &Value) -> Option<Value> {
    config
        .get("regions")
        .and_then(Value::as_array)
        .filter(|regions| !regions.is_empty())
        .map(|regions| Value::Array(regions.clone()))
}

fn order_regions(extended: &Value, prioritized: &[Option<&Value>]) -> Value {
    let extended = extended.as_array().cloned().unwrap_or_default();
    let by_name = extended
        .iter()
        .filter_map(|region| Some((region.get("name")?.as_str()?.to_string(), region.clone())))
        .collect::<HashMap<_, _>>();
    let mut ordered_names = Vec::new();
    for regions in prioritized
        .iter()
        .filter_map(|regions| regions.and_then(Value::as_array))
    {
        for region in regions {
            if let Some(name) = region.get("name").and_then(Value::as_str) {
                if !ordered_names.iter().any(|entry| entry == name) {
                    ordered_names.push(name.to_string());
                }
            }
        }
    }
    for region in &extended {
        if let Some(name) = region.get("name").and_then(Value::as_str) {
            if !ordered_names.iter().any(|entry| entry == name) {
                ordered_names.push(name.to_string());
            }
        }
    }
    Value::Array(
        ordered_names
            .into_iter()
            .filter_map(|name| by_name.get(&name).cloned())
            .collect(),
    )
}

fn preset_id(config: &Value) -> Option<String> {
    [
        "profilePresetId",
        "presetId",
        "baseProfileId",
        "auPresetType",
    ]
    .into_iter()
    .find_map(|key| config.get(key).and_then(Value::as_str))
    .map(str::to_string)
}

fn extract_profile_overrides(config: &Value) -> Value {
    let top = config.as_object().cloned().unwrap_or_default();
    let nested = top
        .get("profile")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut overrides = Map::new();
    for key in PROFILE_OVERRIDE_KEYS {
        if *key == "annotationRegions" {
            let canonical = merge_regions(nested.get(*key), top.get(*key));
            let fallback = top
                .get("regions")
                .filter(|regions| {
                    regions
                        .as_array()
                        .is_some_and(|regions| !regions.is_empty())
                })
                .cloned();
            if let Some(value) = canonical.or(fallback) {
                overrides.insert((*key).to_string(), value);
            }
            continue;
        }
        match (nested.get(*key), top.get(*key)) {
            (Some(base), Some(value)) => {
                let merged = if base.is_object() && value.is_object() {
                    let mut object = base.as_object().cloned().unwrap_or_default();
                    object.extend(value.as_object().cloned().unwrap_or_default());
                    Value::Object(object)
                } else {
                    value.clone()
                };
                overrides.insert((*key).to_string(), merged);
            }
            (Some(value), None) | (None, Some(value)) => {
                overrides.insert((*key).to_string(), value.clone());
            }
            (None, None) => {}
        }
    }
    Value::Object(overrides)
}

fn extend_profile_config(config: Value) -> Result<Value, String> {
    let Some(id) = preset_id(&config) else {
        return Ok(config);
    };
    if id == "custom" {
        return Ok(config);
    }
    let canonical = if id == "skeletal" {
        "fish"
    } else {
        id.as_str()
    };
    let base = presets::load_profile(canonical)?;
    let canonical_regions = canonical_annotation_regions(&config);
    let legacy_regions = legacy_runtime_regions(&config);
    let preset_region_names = base
        .annotation_regions
        .iter()
        .map(|region| region.name.clone())
        .collect::<HashSet<_>>();
    let overrides = extract_profile_overrides(&config);
    let patch = parse_profile_patch(&overrides.to_string())?;
    let merged = extend_preset_with_profile(base, patch);
    let mut merged_value = serde_json::to_value(merged).map_err(|error| error.to_string())?;
    let disabled = overrides
        .get("disabledRegions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(regions) = merged_value.get("annotationRegions").cloned() {
        let normalized = normalize_region_tree(regions, &disabled);
        let normalized_names = normalized
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|region| region.get("name").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        let legacy_extras = if canonical_regions.is_some() {
            legacy_regions
                .as_ref()
                .and_then(Value::as_array)
                .map(|regions| {
                    Value::Array(
                        regions
                            .iter()
                            .filter(|region| {
                                region
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| {
                                        !preset_region_names.contains(name)
                                            && !normalized_names.contains(name)
                                    })
                            })
                            .cloned()
                            .collect(),
                    )
                })
        } else {
            None
        };
        let merged_regions = merge_regions(Some(&normalized), legacy_extras.as_ref())
            .map(|regions| normalize_region_tree(regions, &disabled))
            .unwrap_or_else(|| normalized.clone());
        let ordered = if canonical_regions.is_some() {
            order_regions(
                &merged_regions,
                &[Some(&normalized), legacy_extras.as_ref()],
            )
        } else {
            order_regions(
                &merged_regions,
                &[legacy_regions.as_ref(), Some(&normalized)],
            )
        };
        if let Some(object) = merged_value.as_object_mut() {
            object.insert("annotationRegions".to_string(), ordered.clone());
            object.insert("regions".to_string(), ordered);
        }
    }
    Ok(merge_json(&config, &merged_value))
}

fn profile_view(profile: &ProfileData, op: &str, payload: &Value) -> Result<Value, String> {
    match op {
        "profile.getMeshNamesForAU" => {
            let id = value_field(payload, "auId")?.as_u64().unwrap_or(0) as u32;
            let view = crate::profile::resolve_profile_view(profile);
            Ok(json!(view
                .au_mesh_names
                .get(&id.to_string())
                .cloned()
                .unwrap_or_default()))
        }
        "profile.getMeshNamesForViseme" => Ok(json!(
            crate::profile::resolve_profile_view(profile).viseme_mesh_names
        )),
        "profile.hasLeftRightMorphs" => {
            let id = value_field(payload, "auId")?
                .as_u64()
                .unwrap_or(0)
                .to_string();
            let result = profile
                .au_to_morphs
                .get(&id)
                .and_then(|entry| entry.as_ref())
                .is_some_and(|entry| !entry.left.is_empty() && !entry.right.is_empty());
            Ok(json!(result))
        }
        "profile.isMixedAU" => {
            let id = value_field(payload, "auId")?
                .as_u64()
                .unwrap_or(0)
                .to_string();
            let morphs = profile
                .au_to_morphs
                .get(&id)
                .and_then(|entry| entry.as_ref())
                .is_some_and(|entry| {
                    !entry.left.is_empty() || !entry.right.is_empty() || !entry.center.is_empty()
                });
            let bones = profile
                .au_to_bones
                .get(&id)
                .is_some_and(|entry| !entry.is_empty());
            Ok(json!(morphs && bones))
        }
        "profile.resolveBoneNames" => {
            let names = value_field(payload, "names")?
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut result = Vec::new();
            for name in names.iter().filter_map(Value::as_str) {
                if let Some(base) = profile.bone_nodes.get(name) {
                    let resolved =
                        resolve_bone_name(profile, name).unwrap_or_else(|| name.to_string());
                    for candidate in [resolved, base.clone()] {
                        if !result.contains(&candidate) {
                            result.push(candidate);
                        }
                    }
                } else if !result.iter().any(|entry| entry == name) {
                    result.push(name.to_string());
                }
            }
            Ok(json!(result))
        }
        _ => Err(format!("Unknown profile query \"{op}\"")),
    }
}

fn execute(request: Request) -> Result<Value, String> {
    let payload = request.payload;
    match request.op.as_str() {
        "preset.get" => {
            let id = string_field(&payload, "id")?;
            let canonical = if id == "skeletal" {
                "fish"
            } else {
                id.as_str()
            };
            let json = presets::preset_json(canonical)?;
            serde_json::from_str(json).map_err(|error| format!("Invalid embedded preset: {error}"))
        }
        "preset.list" => Ok(json!(presets::list_preset_ids())),
        "profile.resolve" => {
            let profile = profile_field(&payload)?;
            serde_json::to_value(crate::profile::resolve_profile_view(&profile))
                .map_err(|error| error.to_string())
        }
        "profile.getPresetId" => Ok(json!(preset_id(value_field(&payload, "config")?))),
        "profile.extractOverrides" => {
            Ok(extract_profile_overrides(value_field(&payload, "config")?))
        }
        "profile.extendConfig" => extend_profile_config(value_field(&payload, "config")?.clone()),
        "profile.mergeRegions" => {
            Ok(merge_regions(payload.get("base"), payload.get("override")).unwrap_or(Value::Null))
        }
        "profile.normalizeRegions" => {
            let disabled = payload
                .get("disabledNames")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(normalize_region_tree(
                value_field(&payload, "regions")?.clone(),
                &disabled,
            ))
        }
        "profile.mergePreset" => {
            let base: ProfileData = serde_json::from_value(value_field(&payload, "base")?.clone())
                .map_err(|error| format!("Invalid base profile: {error}"))?;
            let extension = parse_profile_patch(&value_field(&payload, "extension")?.to_string())?;
            serde_json::to_value(extend_preset_with_profile(&base, extension))
                .map_err(|error| error.to_string())
        }
        "name.fuzzyMatch" => Ok(json!(fuzzy_name_match(
            &string_field(&payload, "objectName")?,
            &string_field(&payload, "targetName")?,
            payload.get("suffixPattern").and_then(Value::as_str),
        ))),
        op if op.starts_with("profile.") => {
            let profile = profile_field(&payload)?;
            profile_view(&profile, op, &payload)
        }
        "bone.constants" => Ok(json!({
            "jointControlSection": JOINT_CONTROL_SECTION,
            "defaultBoneMaxDegrees": DEFAULT_BONE_MAX_DEGREES,
            "defaultAxisToChannel": { "pitch": "rx", "yaw": "ry", "roll": "rz" }
        })),
        "bone.isMaxDegreesOnlyUpdate" => {
            let update = object(value_field(&payload, "update")?);
            Ok(json!(
                !update.is_empty()
                    && update
                        .keys()
                        .all(|key| { key == "negativeMaxDegrees" || key == "positiveMaxDegrees" })
            ))
        }
        "bone.findNodeKey" => {
            let profile = profile_field(&payload)?;
            Ok(json!(find_node_key(
                &profile,
                &string_field(&payload, "boneName")?
            )))
        }
        "bone.ensureNodeKey" => {
            let mut profile = profile_field(&payload)?;
            let key = ensure_node(&mut profile, &string_field(&payload, "boneName")?);
            Ok(json!({ "nodeKey": key, "boneNodes": profile.bone_nodes }))
        }
        "bone.ensureBilateralNodeKeys" => {
            let mut profile = profile_field(&payload)?;
            ensure_node(&mut profile, &string_field(&payload, "leftBoneName")?);
            ensure_node(&mut profile, &string_field(&payload, "rightBoneName")?);
            serde_json::to_value(profile).map_err(|error| error.to_string())
        }
        "bone.resolveBoneName" => {
            let profile = profile_field(&payload)?;
            Ok(json!(resolve_bone_name(
                &profile,
                &string_field(&payload, "nodeKey")?
            )))
        }
        "bone.stripAffixes" => {
            let profile = profile_field(&payload)?;
            Ok(json!(strip_affixes(
                &profile,
                &string_field(&payload, "boneName")?
            )))
        }
        "bone.inferChiralPair" => {
            let names = value_field(&payload, "boneNames")?
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(
                infer_chiral_pair(&names, &string_field(&payload, "selectedBoneName")?)
                    .unwrap_or(Value::Null),
            )
        }
        "bone.formatAxisLabel" => Ok(json!(axis_field(&payload)?.label())),
        "bone.formatDirectionLabel" => {
            let axis = axis_field(&payload)?;
            let direction: Direction =
                serde_json::from_value(value_field(&payload, "direction")?.clone())
                    .map_err(|error| error.to_string())?;
            Ok(json!(direction.label(axis)))
        }
        "bone.getAxisFromChannel" => Ok(json!(Axis::from_channel(&string_field(
            &payload, "channel"
        )?))),
        "bone.getAxisState" => {
            let profile = profile_field(&payload)?;
            Ok(json!(get_axis_state(
                &profile,
                &string_field(&payload, "boneName")?,
                axis_field(&payload)?
            )))
        }
        "bone.resolveAxisChannel" => {
            let profile = profile_field(&payload)?;
            let bone_name = string_field(&payload, "boneName")?;
            let axis = axis_field(&payload)?;
            Ok(json!(get_axis_state(&profile, &bone_name, axis)
                .map(|state| state.channel)
                .unwrap_or_else(|| axis.channel().to_string())))
        }
        "bone.getBilateralAxisState" => {
            let profile = profile_field(&payload)?;
            Ok(json!(bilateral_state(
                &profile,
                &string_field(&payload, "boneName")?,
                axis_field(&payload)?,
            )))
        }
        "bone.getAUBindingState" => {
            let profile = profile_field(&payload)?;
            let id = value_field(&payload, "auId")?.as_u64().unwrap_or(0) as u32;
            Ok(au_bone_state(&profile, id))
        }
        "bone.inferEyeScope" => {
            let profile = profile_field(&payload)?;
            let binding = value_field(&payload, "binding")?;
            let node = string_field(binding, "nodeKey")?;
            if !is_eye_node(&node) {
                return Ok(Value::Null);
            }
            let ids = ["negativeAuId", "positiveAuId"]
                .into_iter()
                .filter_map(|key| binding.get(key).and_then(Value::as_u64))
                .map(|id| id as u32)
                .collect::<Vec<_>>();
            let mut sides = HashSet::new();
            for id in ids {
                for entry in profile
                    .au_to_bones
                    .get(&id.to_string())
                    .into_iter()
                    .flatten()
                {
                    if is_eye_node(&entry.node) {
                        if let (Some(side), _, _) = chiral(&entry.node) {
                            sides.insert(side);
                        }
                    }
                }
            }
            if sides.contains("left") && sides.contains("right") {
                Ok(json!("Both Eyes"))
            } else {
                let (side, _, _) = chiral(&node);
                Ok(match (node.as_str(), side) {
                    ("EYE_L", _) | (_, Some("left")) => json!("Left Eye Only"),
                    ("EYE_R", _) | (_, Some("right")) => json!("Right Eye Only"),
                    _ => Value::Null,
                })
            }
        }
        "bone.inferEyeFamily" => {
            let binding = value_field(&payload, "binding")?;
            let node = string_field(binding, "nodeKey")?;
            if !is_eye_node(&node) {
                Ok(Value::Null)
            } else {
                let axis: Axis = serde_json::from_value(value_field(binding, "axis")?.clone())
                    .map_err(|error| error.to_string())?;
                Ok(match axis {
                    Axis::Yaw => json!("Horizontal Gaze"),
                    Axis::Pitch => json!("Vertical Gaze"),
                    Axis::Roll => Value::Null,
                })
            }
        }
        "bone.applyAxisUpdate" => {
            let profile = profile_field(&payload)?;
            let next = apply_axis_update(
                profile,
                &string_field(&payload, "boneName")?,
                axis_field(&payload)?,
                &object(value_field(&payload, "update")?),
            );
            serde_json::to_value(next).map_err(|error| error.to_string())
        }
        "bone.applyBilateralAxisUpdate" => {
            let profile = profile_field(&payload)?;
            let scope: Scope = serde_json::from_value(value_field(&payload, "scope")?.clone())
                .map_err(|error| error.to_string())?;
            let next = apply_bilateral_update(
                profile,
                &string_field(&payload, "boneName")?,
                axis_field(&payload)?,
                scope,
                &object(value_field(&payload, "update")?),
            );
            serde_json::to_value(next).map_err(|error| error.to_string())
        }
        "bone.applyAUBindingUpdate" => {
            let mut profile = profile_field(&payload)?;
            let id = value_field(&payload, "auId")?.as_u64().unwrap_or(0) as u32;
            let update = value_field(&payload, "update")?;
            remove_au_rotation_bindings(&mut profile, id);
            let Some(bone_name) = update.get("boneName").and_then(Value::as_str) else {
                return serde_json::to_value(profile).map_err(|error| error.to_string());
            };
            let axis: Axis = serde_json::from_value(value_field(update, "axis")?.clone())
                .map_err(|error| error.to_string())?;
            let direction: Direction =
                serde_json::from_value(value_field(update, "direction")?.clone())
                    .map_err(|error| error.to_string())?;
            let max_degrees = update.get("maxDegrees").cloned().unwrap_or(Value::Null);
            let axis_update = match direction {
                Direction::Negative => json!({
                    "negativeAuId": id,
                    "negativeMaxDegrees": max_degrees,
                }),
                Direction::Positive => json!({
                    "positiveAuId": id,
                    "positiveMaxDegrees": max_degrees,
                }),
            };
            let next =
                apply_axis_update(profile, bone_name, axis, axis_update.as_object().unwrap());
            serde_json::to_value(next).map_err(|error| error.to_string())
        }
        "bone.createAxisAU" => {
            let profile = profile_field(&payload)?;
            let direction: Direction =
                serde_json::from_value(value_field(&payload, "direction")?.clone())
                    .map_err(|error| error.to_string())?;
            Ok(create_axis_au(
                profile,
                &string_field(&payload, "boneName")?,
                axis_field(&payload)?,
                direction,
                payload.get("name").and_then(Value::as_str),
            ))
        }
        "bone.createBilateralAxisAU" => {
            let mut profile = profile_field(&payload)?;
            let bone_name = string_field(&payload, "boneName")?;
            let axis = axis_field(&payload)?;
            let scope: Scope = serde_json::from_value(value_field(&payload, "scope")?.clone())
                .map_err(|error| error.to_string())?;
            let direction: Direction =
                serde_json::from_value(value_field(&payload, "direction")?.clone())
                    .map_err(|error| error.to_string())?;
            let Some(context) = bilateral_context(&mut profile, &bone_name, axis) else {
                return Ok(create_axis_au(
                    profile,
                    &bone_name,
                    axis,
                    direction,
                    payload.get("name").and_then(Value::as_str),
                ));
            };
            let id = next_au_id(&profile);
            let root = match scope {
                Scope::Shared => format!("Both {}", context.family_label),
                Scope::Left => format!("Left {}", context.family_label),
                Scope::Right => format!("Right {}", context.family_label),
            };
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} {} {}", root, axis.label(), direction.label(axis)));
            profile.au_info.insert(
                id.to_string(),
                AuInfoData {
                    id: Some(id.to_string()),
                    name: Some(name),
                    muscular_basis: None,
                    links: Vec::new(),
                    face_area: Some("Upper".to_string()),
                    face_part: Some(JOINT_CONTROL_SECTION.to_string()),
                    extensions: Map::new(),
                },
            );
            Ok(json!({ "auId": id, "profile": profile }))
        }
        "bone.buildAUOptions" => {
            let profile = profile_field(&payload)?;
            Ok(json!(bone_au_options(&profile)))
        }
        "bone.isJointControlInfo" => Ok(json!(
            payload
                .get("info")
                .and_then(|info| info.get("facePart"))
                .and_then(Value::as_str)
                == Some(JOINT_CONTROL_SECTION)
        )),
        "bone.resolveContinuumLabel" => {
            let profile = profile_field(&payload)?;
            let negative = value_field(&payload, "negativeAuId")?.as_u64().unwrap_or(0) as u32;
            let positive = value_field(&payload, "positiveAuId")?.as_u64().unwrap_or(0) as u32;
            Ok(json!(continuum_label(&profile, negative, positive)))
        }
        "bone.classifyJointControl" => {
            let mut profile = profile_field(&payload)?;
            let id = value_field(&payload, "auId")?.as_u64().unwrap_or(0) as u32;
            let key = id.to_string();
            let mut info = profile.au_info.get(&key).cloned().unwrap_or_default();
            info.id.get_or_insert_with(|| key.clone());
            info.face_part = Some(JOINT_CONTROL_SECTION.to_string());
            profile.au_info.insert(key, info);
            serde_json::to_value(profile).map_err(|error| error.to_string())
        }
        other => Err(format!("Unknown Embody core request \"{other}\"")),
    }
}

/// Execute a host-neutral Embody operation using JSON in and JSON out.
/// This keeps CLJS and other browser hosts off the Rust data structures while
/// ensuring all profile semantics execute inside Wasm.
#[wasm_bindgen]
pub fn embody_request(request_json: &str) -> Result<String, JsError> {
    let request: Request = deserialize_json(request_json, "Invalid Embody request JSON")
        .map_err(|error| JsError::new(&error))?;
    let value = execute(request).map_err(|error| JsError::new(&error))?;
    serde_json::to_string(&value)
        .map_err(|error| JsError::new(&format!("Failed to serialize Embody response: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(op: &str, payload: Value) -> Value {
        execute(Request {
            op: op.to_string(),
            payload,
        })
        .unwrap()
    }

    fn profile() -> Value {
        json!({
            "name": "Test",
            "auToMorphs": {},
            "auToBones": {},
            "boneNodes": { "HEAD": "Head", "EYE_L": "Eye_L", "EYE_R": "Eye_R" },
            "morphToMesh": {},
            "visemeKeys": []
        })
    }

    #[test]
    fn authors_single_axis_bindings_and_continuum() {
        let result = request(
            "bone.applyAxisUpdate",
            json!({
                "profile": profile(),
                "boneName": "Head",
                "axis": "yaw",
                "update": {
                    "negativeAuId": 51,
                    "positiveAuId": 52,
                    "negativeMaxDegrees": 30,
                    "positiveMaxDegrees": 35
                }
            }),
        );
        assert_eq!(result["auToBones"]["51"][0]["channel"], "ry");
        assert_eq!(result["auToBones"]["51"][0]["scale"], -1.0);
        assert_eq!(result["continuumPairs"]["52"]["pairId"], 51);
        assert_eq!(result["continuumLabels"]["51-52"], "Head Yaw");
    }

    #[test]
    fn infers_chiral_pairs() {
        let result = request(
            "bone.inferChiralPair",
            json!({
                "boneNames": ["Head", "L_Hand", "R_Hand"],
                "selectedBoneName": "R_Hand"
            }),
        );
        assert_eq!(result["leftBoneName"], "L_Hand");
        assert_eq!(result["selectedSide"], "right");
        assert_eq!(result["familyLabel"], "Hand");
    }

    #[test]
    fn keeps_generated_custom_node_names_stable() {
        let result = request(
            "bone.ensureNodeKey",
            json!({
                "profile": profile(),
                "boneName": "Jaw.001"
            }),
        );
        assert_eq!(result["nodeKey"], "Jaw.001");
        assert_eq!(result["boneNodes"]["Jaw.001"], "Jaw.001");
    }

    #[test]
    fn recovers_shared_bilateral_ids_from_pair_metadata() {
        let profile: ProfileData = serde_json::from_value(json!({
            "name": "Test",
            "auToMorphs": {},
            "auToBones": {
                "61": [
                    { "node": "EYE_L", "channel": "rz", "scale": -1, "maxDegrees": 25, "side": "left" },
                    { "node": "EYE_R", "channel": "rz", "scale": -1, "maxDegrees": 25, "side": "right" }
                ],
                "62": [
                    { "node": "EYE_L", "channel": "rz", "scale": 1, "maxDegrees": 25, "side": "left" },
                    { "node": "EYE_R", "channel": "rz", "scale": 1, "maxDegrees": 25, "side": "right" }
                ],
                "65": [{ "node": "EYE_L", "channel": "rz", "scale": -1, "maxDegrees": 20, "side": "left" }],
                "66": [{ "node": "EYE_L", "channel": "rz", "scale": 1, "maxDegrees": 20, "side": "left" }],
                "69": [{ "node": "EYE_R", "channel": "rz", "scale": -1, "maxDegrees": 20, "side": "right" }],
                "70": [{ "node": "EYE_R", "channel": "rz", "scale": 1, "maxDegrees": 20, "side": "right" }]
            },
            "boneNodes": { "EYE_L": "Eye_L", "EYE_R": "Eye_R" },
            "morphToMesh": {},
            "visemeKeys": [],
            "compositeRotations": [
                { "node": "EYE_L", "pitch": null, "yaw": { "aus": [61, 62, 65, 66], "axis": "rz", "negative": 65, "positive": 66 }, "roll": null },
                { "node": "EYE_R", "pitch": null, "yaw": { "aus": [61, 62, 69, 70], "axis": "rz", "negative": 69, "positive": 70 }, "roll": null }
            ],
            "continuumPairs": {
                "61": { "pairId": 62, "isNegative": true, "axis": "yaw", "node": "EYE_L" },
                "62": { "pairId": 61, "isNegative": false, "axis": "yaw", "node": "EYE_L" },
                "65": { "pairId": 66, "isNegative": true, "axis": "yaw", "node": "EYE_L" },
                "66": { "pairId": 65, "isNegative": false, "axis": "yaw", "node": "EYE_L" },
                "69": { "pairId": 70, "isNegative": true, "axis": "yaw", "node": "EYE_R" },
                "70": { "pairId": 69, "isNegative": false, "axis": "yaw", "node": "EYE_R" }
            }
        }))
        .unwrap();
        let state = bilateral_state(&profile, "Eye_R", Axis::Yaw).unwrap();
        assert_eq!(state.shared.negative_au_id, Some(61));
        assert_eq!(state.shared.positive_au_id, Some(62));
        assert_eq!(state.left.negative_au_id, Some(65));
        assert_eq!(state.right.positive_au_id, Some(70));
    }
}
