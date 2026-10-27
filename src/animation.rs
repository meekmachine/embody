//! Source clip catalog and native channel metadata. Playback belongs to the connector.
use std::collections::{BTreeMap, HashMap};
use serde::{Deserialize, Serialize};
use crate::clip::ClipIR;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlendMode {
    Replace,
    Additive,
}

impl Default for BlendMode {
    fn default() -> Self {
        Self::Replace
    }
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
struct StoredClip { clip: ClipIR, source: String }

#[derive(Debug, Default)]
pub struct ClipRegistry { clips: BTreeMap<String, StoredClip> }
impl ClipRegistry {
    pub fn new() -> Self { Self::default() }
    pub fn insert_clip(&mut self, clip: ClipIR, source: &str) -> Result<(), String> {
        validate_clip(&clip)?;
        self.clips.insert(clip.name.clone(), StoredClip { clip, source: source.into() });
        Ok(())
    }
    pub fn replace_clips(&mut self, clips: Vec<ClipIR>, source: &str) -> Result<(), String> {
        // Validate every input before replacing any existing source.
        for clip in &clips { validate_clip(clip)?; }
        self.clips.retain(|_, entry| entry.source != source);
        for clip in clips { self.insert_clip(clip, source)?; }
        Ok(())
    }
    pub fn remove_clip(&mut self, name: &str) -> bool { self.clips.remove(name).is_some() }
    #[cfg(test)]
    pub fn clip(&self, name: &str) -> Option<&ClipIR> { self.clips.get(name).map(|entry| &entry.clip) }
    pub fn list(&self) -> Vec<ClipInfo> { self.clips.values().map(clip_info).collect() }
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

