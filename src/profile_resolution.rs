//! Anatomical role and exact model-name resolution shared by AU/profile evaluation.
use crate::profile::ProfileData;

/// A binding may target a standard role. The characterization selects its
/// profile node key, whose existing prefix/suffix mapping selects the rig bone.
pub(crate) fn node_key<'a>(profile: &'a ProfileData, node: &'a str) -> &'a str {
    profile.humanoid_characterization.as_ref()
        .filter(|mapping| mapping.schema_version == 1 && mapping.standard == "VRMC_vrm-1.0")
        .and_then(|mapping| mapping.roles.get(node))
        .map(|role| role.node_key.as_str())
        .unwrap_or(node)
}

pub(crate) fn exact_bone_name<'a>(profile: &'a ProfileData, node: &str) -> Option<&'a str> {
    let mapping = profile.humanoid_characterization.as_ref()?;
    let role = mapping.roles.get(node).or_else(|| mapping.roles.values().find(|role| role.node_key == node))?;
    let exact = role.exact_bone_name.as_deref()?;
    (profile.bone_nodes.get(&role.node_key).map(String::as_str) == Some(exact)).then_some(exact)
}

pub(crate) fn configured_bone_name(profile: &ProfileData, node: &str) -> String {
    if let Some(exact) = exact_bone_name(profile, node) { return exact.to_string(); }
    let key = node_key(profile, node);
    let base = profile.bone_nodes.get(key).map(String::as_str).unwrap_or(key);
    let prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let suffix = profile.bone_suffix.as_deref().unwrap_or("");
    format!("{}{}{}", if base.starts_with(prefix) { "" } else { prefix }, base,
        if base.ends_with(suffix) { "" } else { suffix })
}

