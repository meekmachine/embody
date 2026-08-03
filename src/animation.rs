use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::clip::{ClipIR, ClipTrackIR};

const EPSILON: f32 = 1.0e-6;

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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LoopMode {
    Once,
    Repeat,
    Pingpong,
}

impl Default for LoopMode {
    fn default() -> Self {
        Self::Repeat
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayOptions {
    pub speed: Option<f32>,
    pub playback_rate: Option<f32>,
    pub intensity: Option<f32>,
    pub weight: Option<f32>,
    pub mixer_weight: Option<f32>,
    #[serde(rename = "loop")]
    pub loop_enabled: Option<bool>,
    pub loop_mode: Option<LoopMode>,
    pub repeat_count: Option<u32>,
    pub reverse: bool,
    pub balance: f32,
    pub blend_mode: BlendMode,
    pub easing: String,
    pub crossfade_duration: Option<f32>,
    pub clamp_when_finished: bool,
    pub start_time: Option<f32>,
    pub source: Option<String>,
}

impl Default for PlayOptions {
    fn default() -> Self {
        Self {
            speed: None,
            playback_rate: None,
            intensity: None,
            weight: None,
            mixer_weight: None,
            loop_enabled: None,
            loop_mode: None,
            repeat_count: None,
            reverse: false,
            balance: 0.0,
            blend_mode: BlendMode::Replace,
            easing: "linear".to_string(),
            crossfade_duration: None,
            clamp_when_finished: true,
            start_time: None,
            source: None,
        }
    }
}

impl PlayOptions {
    fn speed(&self) -> f32 {
        self.speed
            .or(self.playback_rate)
            .filter(|value| value.is_finite())
            .unwrap_or(1.0)
            .abs()
    }

    fn weight(&self) -> f32 {
        self.weight
            .or(self.intensity)
            .or(self.mixer_weight)
            .filter(|value| value.is_finite())
            .unwrap_or(1.0)
            .max(0.0)
    }

    fn loop_mode(&self) -> LoopMode {
        if self.loop_enabled == Some(false) {
            return LoopMode::Once;
        }
        self.loop_mode.unwrap_or_else(|| {
            if self.loop_enabled == Some(true) {
                LoopMode::Repeat
            } else {
                LoopMode::Repeat
            }
        })
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationState {
    pub name: String,
    pub action_id: String,
    pub source: String,
    pub is_playing: bool,
    pub is_paused: bool,
    pub time: f32,
    pub duration: f32,
    pub speed: f32,
    pub playback_rate: f32,
    pub reverse: bool,
    pub weight: f32,
    pub balance: f32,
    pub requested_blend_mode: BlendMode,
    pub blend_mode: BlendMode,
    pub channels: Vec<ChannelInfo>,
    pub easing: String,
    #[serde(rename = "loop")]
    pub loop_enabled: bool,
    pub loop_mode: LoopMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_count: Option<u32>,
    pub is_looping: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ScalarBlend {
    pub replace_sum: f32,
    pub replace_weight: f32,
    pub additive: f32,
}

impl ScalarBlend {
    fn push(&mut self, value: f32, reference: f32, weight: f32, mode: BlendMode) {
        if weight <= EPSILON {
            return;
        }
        match mode {
            BlendMode::Replace => {
                self.replace_sum += value * weight;
                self.replace_weight += weight;
            }
            BlendMode::Additive => self.additive += (value - reference) * weight,
        }
    }

    pub fn resolve(&self, base: f32) -> f32 {
        let replaced = if self.replace_weight <= EPSILON {
            base
        } else if self.replace_weight < 1.0 {
            base * (1.0 - self.replace_weight) + self.replace_sum
        } else {
            self.replace_sum / self.replace_weight
        };
        replaced + self.additive
    }
}

#[derive(Debug, Clone, Default)]
pub struct VectorBlend {
    pub replace_sum: [f32; 3],
    pub replace_weight: f32,
    pub additive: [f32; 3],
}

impl VectorBlend {
    fn push(&mut self, value: &[f32], reference: &[f32], weight: f32, mode: BlendMode) {
        if value.len() < 3 || weight <= EPSILON {
            return;
        }
        match mode {
            BlendMode::Replace => {
                for index in 0..3 {
                    self.replace_sum[index] += value[index] * weight;
                }
                self.replace_weight += weight;
            }
            BlendMode::Additive => {
                for index in 0..3 {
                    self.additive[index] +=
                        (value[index] - reference.get(index).copied().unwrap_or(0.0)) * weight;
                }
            }
        }
    }

    pub fn resolve(&self, base: [f32; 3]) -> [f32; 3] {
        let mut resolved = base;
        for index in 0..3 {
            resolved[index] = if self.replace_weight <= EPSILON {
                base[index]
            } else if self.replace_weight < 1.0 {
                base[index] * (1.0 - self.replace_weight) + self.replace_sum[index]
            } else {
                self.replace_sum[index] / self.replace_weight
            } + self.additive[index];
        }
        resolved
    }
}

#[derive(Debug, Clone, Default)]
pub struct QuaternionBlend {
    replace_values: Vec<([f32; 4], f32)>,
    additive_values: Vec<([f32; 4], f32)>,
}

impl QuaternionBlend {
    fn push(&mut self, value: &[f32], reference: &[f32], weight: f32, mode: BlendMode) {
        if value.len() < 4 || weight <= EPSILON {
            return;
        }
        let value = normalize_quat([value[0], value[1], value[2], value[3]]);
        match mode {
            BlendMode::Replace => self.replace_values.push((value, weight)),
            BlendMode::Additive => {
                let reference = if reference.len() >= 4 {
                    normalize_quat([reference[0], reference[1], reference[2], reference[3]])
                } else {
                    [0.0, 0.0, 0.0, 1.0]
                };
                self.additive_values
                    .push((multiply_quat(inverse_quat(reference), value), weight));
            }
        }
    }

    pub fn resolve(&self, base: [f32; 4]) -> [f32; 4] {
        let mut resolved = normalize_quat(base);
        let replace_weight: f32 = self.replace_values.iter().map(|(_, weight)| *weight).sum();
        if replace_weight > EPSILON {
            let target = weighted_quat(&self.replace_values);
            resolved = if replace_weight < 1.0 {
                nlerp_quat(resolved, target, replace_weight)
            } else {
                target
            };
        }
        for (delta, weight) in &self.additive_values {
            let weighted = nlerp_quat([0.0, 0.0, 0.0, 1.0], *delta, *weight);
            resolved = multiply_quat(resolved, weighted);
        }
        resolved
    }
}

#[derive(Debug, Clone, Default)]
pub struct AnimationSample {
    pub aus: HashMap<u32, ScalarBlend>,
    pub au_balances: HashMap<u32, f32>,
    pub visemes: HashMap<u32, ScalarBlend>,
    pub morphs: HashMap<(u32, u32), ScalarBlend>,
    pub bone_positions: HashMap<u32, VectorBlend>,
    pub bone_rotations: HashMap<u32, QuaternionBlend>,
    pub bone_scales: HashMap<u32, VectorBlend>,
    pub object_positions: HashMap<u32, VectorBlend>,
    pub object_rotations: HashMap<u32, QuaternionBlend>,
    pub object_scales: HashMap<u32, VectorBlend>,
    pub mesh_visibility: HashMap<u32, ScalarBlend>,
}

#[derive(Debug, Clone)]
enum Target {
    Au { id: u32, balance: Option<f32> },
    Viseme { id: u32 },
    Morph { mesh_id: u32, morph_target_id: u32 },
    Bone { bone_id: u32, property: String },
    Object { object_id: u32, property: String },
    MeshVisibility { mesh_id: u32 },
    Unsupported,
}

impl Target {
    fn parse(value: &Value) -> Self {
        let kind = value
            .get("kind")
            .or_else(|| value.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "au" => value
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| Target::Au {
                    id: id as u32,
                    balance: value
                        .get("balance")
                        .and_then(Value::as_f64)
                        .map(|v| v as f32),
                })
                .unwrap_or(Target::Unsupported),
            "viseme" | "lipSync" => value
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| Target::Viseme { id: id as u32 })
                .unwrap_or(Target::Unsupported),
            "morphTarget" => match (
                value.get("meshId").and_then(Value::as_u64),
                value.get("morphTargetId").and_then(Value::as_u64),
            ) {
                (Some(mesh_id), Some(morph_target_id)) => Target::Morph {
                    mesh_id: mesh_id as u32,
                    morph_target_id: morph_target_id as u32,
                },
                _ => Target::Unsupported,
            },
            "boneTransform" => match (
                value.get("boneId").and_then(Value::as_u64),
                value.get("property").and_then(Value::as_str),
            ) {
                (Some(bone_id), Some(property)) => Target::Bone {
                    bone_id: bone_id as u32,
                    property: property.to_string(),
                },
                _ => Target::Unsupported,
            },
            "objectTransform" => match (
                value.get("objectId").and_then(Value::as_u64),
                value.get("property").and_then(Value::as_str),
            ) {
                (Some(object_id), Some(property)) => Target::Object {
                    object_id: object_id as u32,
                    property: property.to_string(),
                },
                _ => Target::Unsupported,
            },
            "meshVisibility" => value
                .get("meshId")
                .and_then(Value::as_u64)
                .map(|mesh_id| Target::MeshVisibility {
                    mesh_id: mesh_id as u32,
                })
                .unwrap_or(Target::Unsupported),
            _ => Target::Unsupported,
        }
    }
}

#[derive(Debug, Clone)]
struct StoredClip {
    clip: ClipIR,
    source: String,
    keyframe_times: Vec<f32>,
}

impl StoredClip {
    fn new(clip: ClipIR, source: String) -> Result<Self, String> {
        validate_clip(&clip)?;
        let mut keyframe_times = clip
            .tracks
            .iter()
            .flat_map(|track| track.times.iter().copied())
            .filter(|time| time.is_finite() && *time >= 0.0)
            .map(|time| time as f32)
            .collect::<Vec<_>>();
        keyframe_times.sort_by(f32::total_cmp);
        keyframe_times.dedup_by(|left, right| (*left - *right).abs() <= EPSILON);
        Ok(Self {
            clip,
            source,
            keyframe_times,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct Fade {
    from: f32,
    to: f32,
    duration: f32,
    elapsed: f32,
    stop_when_finished: bool,
}

#[derive(Debug, Clone)]
struct Action {
    id: String,
    clip_name: String,
    source: String,
    time: f32,
    speed: f32,
    reverse: bool,
    pingpong_direction: f32,
    weight: f32,
    balance: f32,
    blend_mode: BlendMode,
    easing: String,
    loop_mode: LoopMode,
    repeat_count: Option<u32>,
    iterations: u32,
    playing: bool,
    paused: bool,
    clamp_when_finished: bool,
    fade: Option<Fade>,
    inherited: HashMap<u32, Vec<f32>>,
}

impl Action {
    fn effective_weight(&self) -> f32 {
        let factor = self.fade.map_or(1.0, |fade| {
            if fade.duration <= EPSILON {
                fade.to
            } else {
                let progress = (fade.elapsed / fade.duration).clamp(0.0, 1.0);
                fade.from + (fade.to - fade.from) * progress
            }
        });
        self.weight * factor
    }
}

#[derive(Debug, Default)]
pub struct AnimationCore {
    clips: BTreeMap<String, StoredClip>,
    actions: BTreeMap<String, Action>,
    events: Vec<Value>,
    next_action_id: u64,
    time_scale: f32,
}

impl AnimationCore {
    pub fn new() -> Self {
        Self {
            time_scale: 1.0,
            ..Self::default()
        }
    }

    pub fn insert_clip(&mut self, clip: ClipIR, source: &str) -> Result<(), String> {
        let name = clip.name.clone();
        self.clips
            .insert(name, StoredClip::new(clip, source.to_string())?);
        Ok(())
    }

    pub fn replace_clips(&mut self, clips: Vec<ClipIR>, source: &str) -> Result<(), String> {
        self.stop_all();
        self.clips.retain(|_, clip| clip.source != source);
        for clip in clips {
            self.insert_clip(clip, source)?;
        }
        Ok(())
    }

    pub fn remove_clip(&mut self, name: &str) -> bool {
        self.stop(name);
        self.clips.remove(name).is_some()
    }

    pub fn clip(&self, name: &str) -> Option<&ClipIR> {
        self.clips.get(name).map(|stored| &stored.clip)
    }

    pub fn list(&self) -> Vec<ClipInfo> {
        self.clips.values().map(clip_info).collect()
    }

    pub fn play<F>(
        &mut self,
        name: &str,
        options: PlayOptions,
        mut current_value: F,
    ) -> Result<String, String>
    where
        F: FnMut(&Value) -> Vec<f32>,
    {
        let stored = self
            .clips
            .get(name)
            .ok_or_else(|| format!("Unknown animation clip \"{name}\"."))?;
        let duration = stored.clip.duration_seconds.max(0.0) as f32;
        let reverse = options.reverse;
        let start_time = options.start_time.unwrap_or_else(|| {
            if reverse && options.loop_mode() == LoopMode::Once {
                duration
            } else {
                0.0
            }
        });
        let mut inherited = HashMap::new();
        for track in &stored.clip.tracks {
            if track.inherit_start {
                inherited.insert(track.id, current_value(&track.target));
            }
        }
        let source = options
            .source
            .clone()
            .unwrap_or_else(|| stored.source.clone());
        let crossfade = options.crossfade_duration.unwrap_or(0.0).max(0.0);
        let loop_mode = options.loop_mode();
        if crossfade > EPSILON {
            self.fade_out_all(crossfade);
        } else {
            self.actions.remove(name);
        }
        self.next_action_id += 1;
        let id = format!("{}:{}", name, self.next_action_id);
        let fade = (crossfade > EPSILON).then_some(Fade {
            from: 0.0,
            to: 1.0,
            duration: crossfade,
            elapsed: 0.0,
            stop_when_finished: false,
        });
        self.actions.insert(
            name.to_string(),
            Action {
                id: id.clone(),
                clip_name: name.to_string(),
                source,
                time: start_time.clamp(0.0, duration),
                speed: options.speed(),
                reverse,
                pingpong_direction: if reverse { -1.0 } else { 1.0 },
                weight: options.weight(),
                balance: options.balance.clamp(-1.0, 1.0),
                blend_mode: options.blend_mode,
                easing: options.easing,
                loop_mode,
                repeat_count: options.repeat_count,
                iterations: 0,
                playing: true,
                paused: false,
                clamp_when_finished: options.clamp_when_finished,
                fade,
                inherited,
            },
        );
        Ok(id)
    }

    pub fn update(&mut self, dt_seconds: f32) {
        if !dt_seconds.is_finite() || dt_seconds <= 0.0 {
            return;
        }
        let dt = dt_seconds * self.time_scale.max(0.0);
        let clip_meta = self
            .clips
            .iter()
            .map(|(name, stored)| {
                (
                    name.clone(),
                    (
                        stored.clip.duration_seconds as f32,
                        stored.keyframe_times.clone(),
                    ),
                )
            })
            .collect::<HashMap<_, _>>();
        let mut events = Vec::new();
        let mut finished = Vec::new();

        for action in self.actions.values_mut() {
            advance_fade(action, dt);
            if action.fade.is_none() && action.effective_weight() <= EPSILON {
                finished.push(action.clip_name.clone());
                continue;
            }
            if !action.playing || action.paused {
                continue;
            }
            let Some((duration, keyframes)) = clip_meta.get(&action.clip_name) else {
                continue;
            };
            let previous = action.time;
            let signed_speed = action.speed * action.pingpong_direction;
            action.time += dt * signed_speed;
            advance_action(action, *duration, previous, keyframes, &mut events);
        }

        for name in finished {
            self.actions.remove(&name);
        }
        self.events.extend(events);
    }

    pub fn sample(&self) -> AnimationSample {
        let mut result = AnimationSample::default();
        for action in self.actions.values() {
            if !action.playing && !action.clamp_when_finished {
                continue;
            }
            let Some(stored) = self.clips.get(&action.clip_name) else {
                continue;
            };
            let weight = action.effective_weight();
            if weight <= EPSILON {
                continue;
            }
            let channels = stored
                .clip
                .channels
                .iter()
                .map(|channel| (channel.id, channel.kind.as_str()))
                .collect::<HashMap<_, _>>();
            for track in &stored.clip.tracks {
                let channel = channels.get(&track.channel_id).copied().unwrap_or("face");
                if channel == "custom" {
                    continue;
                }
                let target = Target::parse(&track.target);
                if matches!(target, Target::Unsupported) {
                    continue;
                }
                let value = sample_track(
                    track,
                    action.time,
                    action.inherited.get(&track.id).map(Vec::as_slice),
                );
                let reference = sample_track(
                    track,
                    0.0,
                    action.inherited.get(&track.id).map(Vec::as_slice),
                );
                let mode = if channel == "face" {
                    action.blend_mode
                } else {
                    BlendMode::Replace
                };
                push_sample(
                    &mut result,
                    target,
                    &value,
                    &reference,
                    weight,
                    mode,
                    action.balance,
                );
            }
        }
        result
    }

    pub fn stop(&mut self, name: &str) {
        self.actions.remove(name);
    }

    pub fn stop_all(&mut self) {
        self.actions.clear();
    }

    pub fn pause(&mut self, name: &str, paused: bool) {
        if let Some(action) = self.actions.get_mut(name) {
            action.paused = paused;
        }
    }

    pub fn pause_all(&mut self, paused: bool) {
        for action in self.actions.values_mut() {
            action.paused = paused;
        }
    }

    pub fn set_speed(&mut self, name: &str, speed: f32) {
        if let Some(action) = self.actions.get_mut(name) {
            if speed.is_finite() {
                action.speed = speed.abs();
                action.reverse = speed < 0.0;
                action.pingpong_direction = if action.reverse { -1.0 } else { 1.0 };
            }
        }
    }

    pub fn set_weight(&mut self, name: &str, weight: f32) {
        if let Some(action) = self.actions.get_mut(name) {
            if weight.is_finite() {
                action.weight = weight.max(0.0);
            }
        }
    }

    pub fn set_loop(&mut self, name: &str, mode: LoopMode, repeat_count: Option<u32>) {
        if let Some(action) = self.actions.get_mut(name) {
            action.loop_mode = mode;
            action.repeat_count = repeat_count;
        }
    }

    pub fn set_reverse(&mut self, name: &str, reverse: bool) {
        if let Some(action) = self.actions.get_mut(name) {
            if action.reverse != reverse {
                action.reverse = reverse;
                action.pingpong_direction *= -1.0;
            }
        }
    }

    pub fn set_blend_mode(&mut self, name: &str, mode: BlendMode) {
        if let Some(action) = self.actions.get_mut(name) {
            action.blend_mode = mode;
        }
    }

    pub fn seek(&mut self, name: &str, time: f32) {
        let Some(action) = self.actions.get_mut(name) else {
            return;
        };
        let duration = self
            .clips
            .get(name)
            .map(|stored| stored.clip.duration_seconds as f32)
            .unwrap_or(0.0);
        action.time = time.clamp(0.0, duration);
        self.events.push(json!({
            "type": "seek",
            "actionId": action.id,
            "clipName": name,
            "currentTime": action.time,
            "duration": duration,
            "iteration": action.iterations,
        }));
    }

    pub fn set_time_scale(&mut self, scale: f32) {
        if scale.is_finite() {
            self.time_scale = scale.max(0.0);
        }
    }

    pub fn state(&self, name: &str) -> Option<AnimationState> {
        let action = self.actions.get(name)?;
        let stored = self.clips.get(name)?;
        Some(action_state(action, stored))
    }

    pub fn playing(&self) -> Vec<AnimationState> {
        self.actions
            .values()
            .filter_map(|action| {
                self.clips
                    .get(&action.clip_name)
                    .map(|clip| action_state(action, clip))
            })
            .collect()
    }

    pub fn drain_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.events)
    }

    pub fn fade_out_all(&mut self, duration: f32) {
        for action in self.actions.values_mut() {
            action.fade = Some(Fade {
                from: action
                    .fade
                    .map(|fade| {
                        if fade.duration <= EPSILON {
                            fade.to
                        } else {
                            let progress = (fade.elapsed / fade.duration).clamp(0.0, 1.0);
                            fade.from + (fade.to - fade.from) * progress
                        }
                    })
                    .unwrap_or(1.0),
                to: 0.0,
                duration: duration.max(EPSILON),
                elapsed: 0.0,
                stop_when_finished: true,
            });
        }
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

fn sample_track(track: &ClipTrackIR, time: f32, inherited: Option<&[f32]>) -> Vec<f32> {
    let size = value_size(&track.value_type).unwrap_or(1);
    if track.times.is_empty() || track.values.len() < size {
        return vec![0.0; size];
    }
    let first = track.times[0] as f32;
    if time <= first {
        return inherited
            .filter(|value| value.len() == size)
            .map(|value| value.to_vec())
            .unwrap_or_else(|| {
                track.values[..size]
                    .iter()
                    .map(|value| *value as f32)
                    .collect()
            });
    }
    let last_index = track.times.len() - 1;
    if time >= track.times[last_index] as f32 {
        let offset = last_index * size;
        return track.values[offset..offset + size]
            .iter()
            .map(|value| *value as f32)
            .collect();
    }
    let right = track
        .times
        .partition_point(|candidate| (*candidate as f32) <= time)
        .min(last_index);
    let left = right.saturating_sub(1);
    let left_time = track.times[left] as f32;
    let right_time = track.times[right] as f32;
    let progress = if right_time - left_time <= EPSILON {
        1.0
    } else {
        ((time - left_time) / (right_time - left_time)).clamp(0.0, 1.0)
    };
    let left_values = if left == 0 {
        inherited.filter(|value| value.len() == size)
    } else {
        None
    };
    let interpolation = track.interpolation.as_deref().unwrap_or("linear");
    if interpolation == "step" {
        return left_values.map(|value| value.to_vec()).unwrap_or_else(|| {
            let offset = left * size;
            track.values[offset..offset + size]
                .iter()
                .map(|value| *value as f32)
                .collect()
        });
    }
    let mut a = Vec::with_capacity(size);
    let mut b = Vec::with_capacity(size);
    for component in 0..size {
        a.push(
            left_values
                .and_then(|value| value.get(component).copied())
                .unwrap_or(track.values[left * size + component] as f32),
        );
        b.push(track.values[right * size + component] as f32);
    }
    if track.value_type == "quat" {
        return nlerp_quat([a[0], a[1], a[2], a[3]], [b[0], b[1], b[2], b[3]], progress).to_vec();
    }
    a.iter()
        .zip(b.iter())
        .map(|(left, right)| left + (right - left) * progress)
        .collect()
}

fn push_sample(
    result: &mut AnimationSample,
    target: Target,
    value: &[f32],
    reference: &[f32],
    weight: f32,
    mode: BlendMode,
    action_balance: f32,
) {
    match target {
        Target::Au { id, balance } => {
            result.aus.entry(id).or_default().push(
                value.first().copied().unwrap_or(0.0),
                reference.first().copied().unwrap_or(0.0),
                weight,
                mode,
            );
            result
                .au_balances
                .insert(id, balance.unwrap_or(action_balance).clamp(-1.0, 1.0));
        }
        Target::Viseme { id } => result.visemes.entry(id).or_default().push(
            value.first().copied().unwrap_or(0.0),
            reference.first().copied().unwrap_or(0.0),
            weight,
            mode,
        ),
        Target::Morph {
            mesh_id,
            morph_target_id,
        } => result
            .morphs
            .entry((mesh_id, morph_target_id))
            .or_default()
            .push(
                value.first().copied().unwrap_or(0.0),
                reference.first().copied().unwrap_or(0.0),
                weight,
                mode,
            ),
        Target::Bone { bone_id, property } => match property.as_str() {
            "position" => result
                .bone_positions
                .entry(bone_id)
                .or_default()
                .push(value, reference, weight, mode),
            "rotation" => result
                .bone_rotations
                .entry(bone_id)
                .or_default()
                .push(value, reference, weight, mode),
            "scale" => result
                .bone_scales
                .entry(bone_id)
                .or_default()
                .push(value, reference, weight, mode),
            _ => {}
        },
        Target::Object {
            object_id,
            property,
        } => match property.as_str() {
            "position" => result
                .object_positions
                .entry(object_id)
                .or_default()
                .push(value, reference, weight, mode),
            "rotation" => result
                .object_rotations
                .entry(object_id)
                .or_default()
                .push(value, reference, weight, mode),
            "scale" => result
                .object_scales
                .entry(object_id)
                .or_default()
                .push(value, reference, weight, mode),
            _ => {}
        },
        Target::MeshVisibility { mesh_id } => {
            result.mesh_visibility.entry(mesh_id).or_default().push(
                value.first().copied().unwrap_or(0.0),
                reference.first().copied().unwrap_or(0.0),
                weight,
                BlendMode::Replace,
            )
        }
        Target::Unsupported => {}
    }
}

fn advance_fade(action: &mut Action, dt: f32) {
    let Some(mut fade) = action.fade else {
        return;
    };
    fade.elapsed += dt;
    if fade.elapsed + EPSILON >= fade.duration {
        action.fade = None;
        if fade.stop_when_finished {
            action.weight = 0.0;
            action.playing = false;
        }
    } else {
        action.fade = Some(fade);
    }
}

fn advance_action(
    action: &mut Action,
    duration: f32,
    previous: f32,
    keyframes: &[f32],
    events: &mut Vec<Value>,
) {
    if duration <= EPSILON {
        action.time = 0.0;
        complete_action(action, duration, events);
        return;
    }
    let forward = action.pingpong_direction >= 0.0;
    let crossed_boundary = if forward {
        action.time >= duration
    } else {
        action.time <= 0.0
    };
    let bounded_time = action.time.clamp(0.0, duration);
    emit_keyframes(action, previous, bounded_time, keyframes, events);
    if !crossed_boundary {
        action.time = bounded_time;
        return;
    }

    match action.loop_mode {
        LoopMode::Once => {
            action.time = if forward { duration } else { 0.0 };
            complete_action(action, duration, events);
        }
        LoopMode::Repeat => {
            action.iterations += 1;
            if action
                .repeat_count
                .is_some_and(|count| action.iterations >= count)
            {
                action.time = if forward { duration } else { 0.0 };
                complete_action(action, duration, events);
                return;
            }
            let overflow = if forward {
                action.time - duration
            } else {
                -action.time
            };
            action.time = if forward {
                overflow.rem_euclid(duration)
            } else {
                duration - overflow.rem_euclid(duration)
            };
            events.push(loop_event(action, duration));
        }
        LoopMode::Pingpong => {
            action.iterations += 1;
            if action
                .repeat_count
                .is_some_and(|count| action.iterations >= count)
            {
                action.time = if forward { duration } else { 0.0 };
                complete_action(action, duration, events);
                return;
            }
            let overflow = if forward {
                action.time - duration
            } else {
                -action.time
            };
            action.pingpong_direction *= -1.0;
            action.time = if forward {
                (duration - overflow).clamp(0.0, duration)
            } else {
                overflow.clamp(0.0, duration)
            };
            events.push(loop_event(action, duration));
        }
    }
}

fn emit_keyframes(action: &Action, from: f32, to: f32, keyframes: &[f32], events: &mut Vec<Value>) {
    let forward = to >= from;
    for (index, keyframe) in keyframes.iter().enumerate() {
        let crossed = if forward {
            *keyframe > from + EPSILON && *keyframe <= to + EPSILON
        } else {
            *keyframe < from - EPSILON && *keyframe >= to - EPSILON
        };
        if crossed {
            events.push(json!({
                "type": "keyframe",
                "actionId": action.id,
                "clipName": action.clip_name,
                "keyframeIndex": index,
                "totalKeyframes": keyframes.len(),
                "currentTime": *keyframe,
                "duration": to.max(from).max(*keyframe),
                "iteration": action.iterations,
            }));
        }
    }
}

fn complete_action(action: &mut Action, duration: f32, events: &mut Vec<Value>) {
    action.playing = false;
    action.paused = false;
    events.push(json!({
        "type": "completed",
        "actionId": action.id,
        "clipName": action.clip_name,
        "currentTime": action.time,
        "duration": duration,
        "iteration": action.iterations,
    }));
}

fn loop_event(action: &Action, duration: f32) -> Value {
    json!({
        "type": "loop",
        "actionId": action.id,
        "clipName": action.clip_name,
        "currentTime": action.time,
        "duration": duration,
        "iteration": action.iterations,
    })
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

fn action_state(action: &Action, stored: &StoredClip) -> AnimationState {
    let channels = channel_info(stored);
    let aggregate_blend = if action.blend_mode == BlendMode::Additive
        && channels
            .iter()
            .any(|channel| channel.channel == "face" && channel.playable)
    {
        BlendMode::Additive
    } else {
        BlendMode::Replace
    };
    AnimationState {
        name: action.clip_name.clone(),
        action_id: action.id.clone(),
        source: action.source.clone(),
        is_playing: action.playing && !action.paused,
        is_paused: action.paused,
        time: action.time,
        duration: stored.clip.duration_seconds as f32,
        speed: action.speed,
        playback_rate: action.speed,
        reverse: action.reverse,
        weight: action.weight,
        balance: action.balance,
        requested_blend_mode: action.blend_mode,
        blend_mode: aggregate_blend,
        channels,
        easing: action.easing.clone(),
        loop_enabled: action.loop_mode != LoopMode::Once,
        loop_mode: action.loop_mode,
        repeat_count: action.repeat_count,
        is_looping: action.loop_mode != LoopMode::Once,
    }
}

fn weighted_quat(values: &[([f32; 4], f32)]) -> [f32; 4] {
    let Some((first, _)) = values.first() else {
        return [0.0, 0.0, 0.0, 1.0];
    };
    let mut sum = [0.0; 4];
    for (value, weight) in values {
        let sign = if dot_quat(*first, *value) < 0.0 {
            -1.0
        } else {
            1.0
        };
        for index in 0..4 {
            sum[index] += value[index] * *weight * sign;
        }
    }
    normalize_quat(sum)
}

fn dot_quat(left: [f32; 4], right: [f32; 4]) -> f32 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3]
}

fn normalize_quat(value: [f32; 4]) -> [f32; 4] {
    let length = dot_quat(value, value).sqrt();
    if length <= EPSILON {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [
        value[0] / length,
        value[1] / length,
        value[2] / length,
        value[3] / length,
    ]
}

fn inverse_quat(value: [f32; 4]) -> [f32; 4] {
    [-value[0], -value[1], -value[2], value[3]]
}

fn multiply_quat(left: [f32; 4], right: [f32; 4]) -> [f32; 4] {
    normalize_quat([
        left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
        left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
        left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
        left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
    ])
}

fn nlerp_quat(left: [f32; 4], mut right: [f32; 4], amount: f32) -> [f32; 4] {
    if dot_quat(left, right) < 0.0 {
        right = [-right[0], -right[1], -right[2], -right[3]];
    }
    let amount = amount.clamp(0.0, 1.0);
    normalize_quat([
        left[0] + (right[0] - left[0]) * amount,
        left[1] + (right[1] - left[1]) * amount,
        left[2] + (right[2] - left[2]) * amount,
        left[3] + (right[3] - left[3]) * amount,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::{ClipChannel, ClipTrackIR};

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
                interpolation: None,
                inherit_start: false,
                source_name: None,
            }],
            metadata: None,
        }
    }

    #[test]
    fn samples_and_completes_once_playback() {
        let mut core = AnimationCore::new();
        core.insert_clip(morph_clip("smile"), "baked").unwrap();
        core.play(
            "smile",
            PlayOptions {
                loop_mode: Some(LoopMode::Once),
                ..PlayOptions::default()
            },
            |_| vec![0.0],
        )
        .unwrap();
        core.update(0.5);
        let sample = core.sample();
        assert!((sample.morphs[&(2, 3)].resolve(0.0) - 0.5).abs() < 1.0e-5);
        core.update(0.5);
        assert!(!core.state("smile").unwrap().is_playing);
        assert_eq!(core.drain_events().last().unwrap()["type"], "completed");
    }

    #[test]
    fn additive_uses_first_frame_as_reference() {
        let mut clip = morph_clip("pose");
        clip.tracks[0].values = vec![0.4, 0.9];
        let mut core = AnimationCore::new();
        core.insert_clip(clip, "baked").unwrap();
        core.play(
            "pose",
            PlayOptions {
                blend_mode: BlendMode::Additive,
                loop_mode: Some(LoopMode::Once),
                ..PlayOptions::default()
            },
            |_| vec![0.0],
        )
        .unwrap();
        core.seek("pose", 1.0);
        assert!((core.sample().morphs[&(2, 3)].resolve(0.2) - 0.7).abs() < 1.0e-5);
    }

    #[test]
    fn inherited_start_captures_live_value() {
        let mut clip = morph_clip("inherit");
        clip.tracks[0].inherit_start = true;
        let mut core = AnimationCore::new();
        core.insert_clip(clip, "snippet").unwrap();
        core.play("inherit", PlayOptions::default(), |_| vec![0.4])
            .unwrap();
        core.seek("inherit", 0.5);
        assert!((core.sample().morphs[&(2, 3)].resolve(0.0) - 0.7).abs() < 1.0e-5);
    }

    #[test]
    fn pingpong_reverses_at_the_boundary() {
        let mut core = AnimationCore::new();
        core.insert_clip(morph_clip("ping"), "baked").unwrap();
        core.play(
            "ping",
            PlayOptions {
                loop_mode: Some(LoopMode::Pingpong),
                ..PlayOptions::default()
            },
            |_| vec![0.0],
        )
        .unwrap();
        core.update(1.25);
        assert!((core.state("ping").unwrap().time - 0.75).abs() < 1.0e-5);
    }

    #[test]
    fn scene_object_tracks_are_sampled_with_replace_blending() {
        let clip = ClipIR {
            id: None,
            name: "camera".to_string(),
            duration_seconds: 1.0,
            channels: vec![ClipChannel {
                id: 3,
                kind: "scene".to_string(),
                name: None,
            }],
            tracks: vec![ClipTrackIR {
                id: 1,
                channel_id: 3,
                target: json!({ "kind": "objectTransform", "objectId": 9, "property": "position" }),
                value_type: "vec3".to_string(),
                times: vec![0.0, 1.0],
                values: vec![0.0, 0.0, 0.0, 2.0, 4.0, 6.0],
                interpolation: None,
                inherit_start: false,
                source_name: None,
            }],
            metadata: None,
        };
        let mut core = AnimationCore::new();
        core.insert_clip(clip, "baked").unwrap();
        core.play(
            "camera",
            PlayOptions {
                blend_mode: BlendMode::Additive,
                loop_mode: Some(LoopMode::Once),
                ..PlayOptions::default()
            },
            |_| vec![0.0, 0.0, 0.0],
        )
        .unwrap();
        core.seek("camera", 0.5);
        assert_eq!(
            core.sample().object_positions[&9].resolve([10.0, 10.0, 10.0]),
            [1.0, 2.0, 3.0]
        );
        let info = core.list();
        assert!(info[0].channels[0].playable);
        assert_eq!(info[0].channels[0].blend_mode, Some(BlendMode::Replace));
    }
}
