//! Validated clip inventory for host-owned animation playback.
//!
//! This module stores authored/compiled tracks and their source metadata. It
//! deliberately has no actions, playheads, sampling, fading, or frame updates;
//! Three AnimationMixer (or another host animation library) owns those states.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::clip::ClipIR;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlendMode {
    Replace,
    Additive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub channel: String,
    pub track_count: usize,
    pub playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<BlendMode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub name: String,
    pub duration: f32,
    pub track_count: usize,
    pub source: String,
    pub channels: Vec<ChannelInfo>,
}

#[derive(Debug, Clone)]
struct StoredClip {
    clip: ClipIR,
    source: String,
}

impl StoredClip {
    fn new(clip: ClipIR, source: &str) -> Result<Self, String> {
        validate_clip(&clip)?;
        Ok(Self {
            clip,
            source: source.to_string(),
        })
    }
}

#[derive(Debug, Default)]
pub struct ClipRegistry {
    clips: BTreeMap<String, StoredClip>,
}

impl ClipRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_clip(&mut self, clip: ClipIR, source: &str) -> Result<(), String> {
        let stored = StoredClip::new(clip, source)?;
        self.clips.insert(stored.clip.name.clone(), stored);
        Ok(())
    }

    pub fn replace_clips(&mut self, clips: Vec<ClipIR>, source: &str) -> Result<(), String> {
        // A malformed replacement must not discard the existing inventory.
        let replacements = clips
            .into_iter()
            .map(|clip| StoredClip::new(clip, source))
            .collect::<Result<Vec<_>, _>>()?;
        self.clips.retain(|_, clip| clip.source != source);
        for stored in replacements {
            self.clips.insert(stored.clip.name.clone(), stored);
        }
        Ok(())
    }

    pub fn remove_clip(&mut self, name: &str) -> bool {
        self.clips.remove(name).is_some()
    }

    pub fn clip(&self, name: &str) -> Option<&ClipIR> {
        self.clips.get(name).map(|stored| &stored.clip)
    }

    pub fn list(&self) -> Vec<ClipInfo> {
        self.clips.values().map(clip_info).collect()
    }
}

fn validate_clip(clip: &ClipIR) -> Result<(), String> {
    if clip.name.trim().is_empty() {
        return Err("Animation clip name cannot be empty.".to_string());
    }
    if !clip.duration_seconds.is_finite() || clip.duration_seconds < 0.0 {
        return Err(format!(
            "Animation clip \"{}\" has an invalid duration.",
            clip.name
        ));
    }
    for track in &clip.tracks {
        if track.times.is_empty()
            || track.times.len() * value_size(&track.value_type)? != track.values.len()
        {
            return Err(format!(
                "Animation clip \"{}\" has an invalid track {}.",
                clip.name, track.id
            ));
        }
        if track.times.windows(2).any(|pair| pair[0] > pair[1]) {
            return Err(format!(
                "Animation clip \"{}\" track {} keyframes are not sorted.",
                clip.name, track.id
            ));
        }
    }
    Ok(())
}

fn value_size(value_type: &str) -> Result<usize, String> {
    match value_type {
        "scalar" => Ok(1),
        "vec3" => Ok(3),
        "quat" => Ok(4),
        other => Err(format!("Unknown clip track value type \"{other}\".")),
    }
}

fn channel_info(stored: &StoredClip) -> Vec<ChannelInfo> {
    let mut counts = BTreeMap::<String, usize>::new();
    let channel_names = stored
        .clip
        .channels
        .iter()
        .map(|channel| (channel.id, channel.kind.clone()))
        .collect::<HashMap<_, _>>();
    for track in &stored.clip.tracks {
        let channel = channel_names
            .get(&track.channel_id)
            .cloned()
            .unwrap_or_else(|| "face".to_string());
        *counts.entry(channel).or_default() += 1;
    }
    ["face", "body", "scene", "custom"]
        .into_iter()
        .filter_map(|channel| {
            let count = counts.remove(channel)?;
            let playable = channel != "custom";
            Some(ChannelInfo {
                channel: channel.to_string(),
                track_count: count,
                playable,
                blend_mode: playable.then_some(if channel == "face" {
                    BlendMode::Additive
                } else {
                    BlendMode::Replace
                }),
            })
        })
        .collect()
}

fn clip_info(stored: &StoredClip) -> ClipInfo {
    ClipInfo {
        name: stored.clip.name.clone(),
        duration: stored.clip.duration_seconds as f32,
        track_count: stored.clip.tracks.len(),
        source: stored.source.clone(),
        channels: channel_info(stored),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::{ClipChannel, ClipTrackIR};
    use serde_json::json;

    fn morph_clip(name: &str) -> ClipIR {
        ClipIR {
            id: None,
            name: name.to_string(),
            duration_seconds: 1.0,
            channels: vec![ClipChannel {
                id: 1,
                kind: "face".to_string(),
                name: None,
            }],
            tracks: vec![ClipTrackIR {
                id: 1,
                channel_id: 1,
                target: json!({ "kind": "morphTarget", "meshId": 2, "morphTargetId": 3 }),
                value_type: "scalar".to_string(),
                times: vec![0.0, 1.0],
                values: vec![0.0, 1.0],
                interpolation: Some("linear".to_string()),
                inherit_start: true,
                source_name: Some("authored-morph".to_string()),
            }],
            metadata: Some(json!({ "author": "saved-animation" })),
        }
    }

    #[test]
    fn registry_preserves_host_tracks_and_inventory_metadata() {
        let mut registry = ClipRegistry::new();
        let clip = morph_clip("smile");
        registry.insert_clip(clip.clone(), "snippet").unwrap();

        assert_eq!(
            serde_json::to_value(registry.clip("smile").unwrap()).unwrap(),
            serde_json::to_value(clip).unwrap()
        );
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            json!([{
                "name": "smile", "duration": 1.0, "trackCount": 1,
                "source": "snippet",
                "channels": [{
                    "channel": "face", "trackCount": 1,
                    "playable": true, "blendMode": "additive"
                }]
            }])
        );
    }

    #[test]
    fn replacing_baked_clips_preserves_other_sources() {
        let mut registry = ClipRegistry::new();
        registry.insert_clip(morph_clip("old"), "baked").unwrap();
        registry.insert_clip(morph_clip("smile"), "snippet").unwrap();
        registry.replace_clips(vec![morph_clip("new")], "baked").unwrap();

        assert!(registry.clip("old").is_none());
        assert!(registry.clip("smile").is_some());
        assert!(registry.clip("new").is_some());
        assert!(registry.remove_clip("new"));
        assert!(!registry.remove_clip("new"));
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn invalid_replacement_preserves_the_complete_previous_inventory() {
        let mut registry = ClipRegistry::new();
        registry.insert_clip(morph_clip("old"), "baked").unwrap();
        registry.insert_clip(morph_clip("smile"), "snippet").unwrap();
        let before = serde_json::to_value(registry.list()).unwrap();
        let mut invalid = morph_clip("invalid");
        invalid.tracks[0].values.pop();

        assert!(registry
            .replace_clips(vec![morph_clip("new"), invalid.clone()], "baked")
            .is_err());
        assert_eq!(serde_json::to_value(registry.list()).unwrap(), before);
        assert!(registry.clip("new").is_none());
        invalid.name = "old".to_string();
        assert!(registry.insert_clip(invalid, "baked").is_err());
        assert_eq!(registry.clip("old").unwrap().tracks[0].values, vec![0.0, 1.0]);
    }

    #[test]
    fn inventory_reports_host_channel_support_without_sampling_tracks() {
        let mut registry = ClipRegistry::new();
        let mut clip = morph_clip("mixed");
        for (id, kind) in [(2, "body"), (3, "scene"), (4, "custom")] {
            clip.channels.push(ClipChannel {
                id,
                kind: kind.to_string(),
                name: None,
            });
            let mut track = clip.tracks[0].clone();
            track.id = id;
            track.channel_id = id;
            clip.tracks.push(track);
        }
        registry.insert_clip(clip, "baked").unwrap();
        let inventory = registry.list();
        let channels = &inventory[0].channels;
        assert_eq!(channels.len(), 4);
        assert_eq!(channels[0].blend_mode, Some(BlendMode::Additive));
        assert_eq!(channels[1].blend_mode, Some(BlendMode::Replace));
        assert_eq!(channels[2].blend_mode, Some(BlendMode::Replace));
        assert!(!channels[3].playable);
        assert_eq!(channels[3].blend_mode, None);
    }
}
