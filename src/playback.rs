//! Renderer-neutral playback lifecycle. Native animation libraries own every
//! sample, clock, interpolation and blend; this module only validates requests
//! and returns commands/resources and exactly-once terminal events.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::clip::ClipIR;

static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    model_key: String,
    profile_key: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum FinalPose {
    #[default]
    Release,
    Hold,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BlendMode {
    #[default]
    Normal,
    Additive,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum LoopMode {
    #[default]
    Once,
    Repeat,
    PingPong,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoopSettings {
    #[serde(default)]
    mode: LoopMode,
    count: Option<u32>,
}

impl LoopSettings {
    fn validated(mut self, duration_seconds: f64) -> Result<Self, String> {
        if self.count == Some(0) {
            return Err("Loop count must be a positive integer or null for unbounded looping.".into());
        }
        if self.mode == LoopMode::Once {
            if self.count.is_some_and(|count| count != 1) {
                return Err("Once playback accepts only an omitted count or count 1.".into());
            }
            self.count = Some(1);
        } else if duration_seconds == 0.0 {
            return Err("Zero-duration clips support only once playback.".into());
        }
        Ok(self)
    }
}

fn one() -> f64 { 1.0 }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlayOptions {
    replace: Option<String>,
    start_seconds: Option<f64>,
    #[serde(default = "one")]
    speed: f64,
    #[serde(default = "one")]
    weight: f64,
    #[serde(default)]
    blend_mode: BlendMode,
    #[serde(default, rename = "loop")]
    looping: LoopSettings,
    #[serde(default)]
    final_pose: FinalPose,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSettings {
    start_seconds: f64,
    speed: f64,
    weight: f64,
    blend_mode: BlendMode,
    #[serde(rename = "loop")]
    looping: LoopSettings,
    final_pose: FinalPose,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Control {
    // Empty struct variants preserve deny_unknown_fields. Serde's internally
    // tagged unit variants otherwise discard unexpected command parameters.
    Pause {},
    Resume {},
    Stop {},
    Seek { seconds: f64 },
    SetSpeed { speed: f64 },
    SetWeight { weight: f64 },
    SetBlendMode { #[serde(rename = "blendMode")] blend_mode: BlendMode },
    SetLoop { #[serde(rename = "loop")] looping: LoopSettings },
    SetFinalPose { #[serde(rename = "finalPose")] final_pose: FinalPose },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum NativeEvent {
    Completed { handle: String },
    Cancelled { handle: String },
    Error { handle: String, message: String },
}

impl NativeEvent {
    fn handle(&self) -> &str {
        match self {
            Self::Completed { handle } | Self::Cancelled { handle } | Self::Error { handle, .. } => handle,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum NativeCommand {
    Play { handle: String, binding: Binding, clip: ClipIR, settings: NativeSettings },
    Control { handle: String, control: Control },
    // Release includes stopping the action, detaching callbacks, and freeing
    // action/clip resources. It must also cancel pending native materialization.
    Release { handle: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent {
    Completed { handle: String },
    Cancelled { handle: String, reason: &'static str },
    Error { handle: String, message: String },
}

#[derive(Debug, Default, Serialize)]
struct Batch {
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<String>,
    commands: Vec<NativeCommand>,
    events: Vec<TerminalEvent>,
}

impl Batch {
    fn json(self) -> Result<String, JsError> {
        serde_json::to_string(&self).map_err(|error| JsError::new(&error.to_string()))
    }
}

#[derive(Debug)]
struct PlaybackResource {
    duration_seconds: f64,
    final_pose: FinalPose,
    completed: bool,
}

/// A command protocol for one bound model/profile, not an animation evaluator.
/// Dispatch each returned batch in order, then feed native events to `notify`.
/// Before `free`, dispatch `dispose` to release engine-owned resources.
#[wasm_bindgen]
pub struct NativePlaybackSession {
    session: u32,
    generation: u64,
    next_handle: u64,
    binding: Option<Binding>,
    resources: BTreeMap<String, PlaybackResource>,
    disposed: bool,
}

#[wasm_bindgen]
impl NativePlaybackSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<NativePlaybackSession, JsError> {
        Self::create().map_err(|error| JsError::new(&error))
    }

    /// Always starts a new generation, even if the identity labels are reused.
    /// Hosts must call this on every model/profile replacement before new play.
    pub fn rebind(&mut self, model_key: &str, profile_key: &str) -> Result<String, JsError> {
        self.rebind_inner(model_key, profile_key).map_err(|error| JsError::new(&error))?.json()
    }

    /// Takes concrete ClipIR from RuntimeCore compilation or baked-clip intake.
    /// Semantic strength must already be compiled into the clip; weight is the
    /// native action's contribution and never changes compiled samples.
    pub fn play(&mut self, clip_json: &str, options_json: &str) -> Result<String, JsError> {
        self.play_inner(clip_json, options_json).map_err(|error| JsError::new(&error))?.json()
    }

    pub fn control(&mut self, handle: &str, control_json: &str) -> Result<String, JsError> {
        self.control_inner(handle, control_json).map_err(|error| JsError::new(&error))?.json()
    }

    /// Late/duplicate/foreign well-formed notifications return an empty batch.
    /// A native error after held completion releases resources without emitting
    /// a second terminal event.
    pub fn notify(&mut self, native_event_json: &str) -> Result<String, JsError> {
        self.notify_inner(native_event_json).map_err(|error| JsError::new(&error))?.json()
    }

    pub fn dispose(&mut self) -> Result<String, JsError> {
        self.dispose_inner().json()
    }
}

impl NativePlaybackSession {
    fn create() -> Result<Self, String> {
        let session = NEXT_SESSION.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "Playback session identity exhausted.".to_string())?;
        Ok(Self {
            session, generation: 0, next_handle: 0, binding: None,
            resources: BTreeMap::new(), disposed: false,
        })
    }

    fn ensure_open(&self) -> Result<(), String> {
        if self.disposed { Err("Playback session is disposed.".into()) } else { Ok(()) }
    }

    fn resource(&self, handle: &str) -> Result<&PlaybackResource, String> {
        self.ensure_open()?;
        self.resources.get(handle).ok_or_else(|| "Unknown, foreign or stale playback handle.".into())
    }

    fn release(&mut self, handle: &str, reason: &'static str, batch: &mut Batch) {
        if let Some(resource) = self.resources.remove(handle) {
            batch.commands.push(NativeCommand::Release { handle: handle.into() });
            if !resource.completed {
                batch.events.push(TerminalEvent::Cancelled { handle: handle.into(), reason });
            }
        }
    }

    fn release_all(&mut self, reason: &'static str) -> Batch {
        let mut batch = Batch::default();
        for (handle, resource) in std::mem::take(&mut self.resources) {
            batch.commands.push(NativeCommand::Release { handle: handle.clone() });
            if !resource.completed {
                batch.events.push(TerminalEvent::Cancelled { handle, reason });
            }
        }
        batch
    }

    fn rebind_inner(&mut self, model_key: &str, profile_key: &str) -> Result<Batch, String> {
        self.ensure_open()?;
        if model_key.trim().is_empty() || profile_key.trim().is_empty() {
            return Err("Model and profile keys must be nonempty.".into());
        }
        let generation = self.generation.checked_add(1).ok_or("Playback generation exhausted.")?;
        let batch = self.release_all("rebound");
        self.generation = generation;
        self.binding = Some(Binding { model_key: model_key.into(), profile_key: profile_key.into() });
        Ok(batch)
    }

    fn play_inner(&mut self, clip_json: &str, options_json: &str) -> Result<Batch, String> {
        self.ensure_open()?;
        let binding = self.binding.clone().ok_or("Bind a model and profile before playback.")?;
        let clip: ClipIR = parse(clip_json, "ClipIR")?;
        validate_clip(&clip)?;
        let options: PlayOptions = parse(options_json, "play options")?;
        validate_speed(options.speed)?;
        validate_weight(options.weight)?;
        let start_seconds = options.start_seconds.unwrap_or(if options.speed < 0.0 { clip.duration_seconds } else { 0.0 });
        validate_seek(start_seconds, clip.duration_seconds)?;
        let looping = options.looping.validated(clip.duration_seconds)?;
        if let Some(replaced) = &options.replace { self.resource(replaced)?; }
        let next_handle = self.next_handle.checked_add(1).ok_or("Playback handle identity exhausted.")?;
        // Handles are opaque to connectors. Never reuse one, including after
        // completion: discarded records require no ever-growing tombstone set.
        let handle = format!("p{}.g{}.h{}", self.session, self.generation, next_handle);
        let mut batch = Batch { handle: Some(handle.clone()), ..Batch::default() };
        // Every fallible validation is above replacement; invalid plays must
        // leave both the old action and its resource ownership unchanged.
        if let Some(replaced) = options.replace { self.release(&replaced, "replaced", &mut batch); }
        self.next_handle = next_handle;
        self.resources.insert(handle.clone(), PlaybackResource {
            duration_seconds: clip.duration_seconds, final_pose: options.final_pose, completed: false,
        });
        batch.commands.push(NativeCommand::Play {
            handle, binding, clip,
            settings: NativeSettings {
                start_seconds, speed: options.speed, weight: options.weight, blend_mode: options.blend_mode,
                looping, final_pose: options.final_pose,
            },
        });
        Ok(batch)
    }

    fn control_inner(&mut self, handle: &str, control_json: &str) -> Result<Batch, String> {
        let resource = self.resource(handle)?;
        let mut control: Control = parse(control_json, "playback control")?;
        match &mut control {
            Control::Seek { seconds } => validate_seek(*seconds, resource.duration_seconds)?,
            Control::SetSpeed { speed } => validate_speed(*speed)?,
            Control::SetWeight { weight } => validate_weight(*weight)?,
            Control::SetLoop { looping } => *looping = looping.clone().validated(resource.duration_seconds)?,
            _ => {},
        }
        let release_held = resource.completed && matches!(control, Control::SetFinalPose { final_pose: FinalPose::Release });
        if resource.completed && !release_held && !matches!(control, Control::Stop { .. }) {
            return Err("Completed held playback supports only stop or finalPose release.".into());
        }
        let mut batch = Batch::default();
        if matches!(control, Control::Stop { .. }) || release_held {
            self.release(handle, "stopped", &mut batch);
        } else {
            if let Control::SetFinalPose { final_pose } = &control {
                self.resources.get_mut(handle).expect("validated resource").final_pose = *final_pose;
            }
            batch.commands.push(NativeCommand::Control { handle: handle.into(), control });
        }
        Ok(batch)
    }

    fn notify_inner(&mut self, event_json: &str) -> Result<Batch, String> {
        let event: NativeEvent = parse(event_json, "native playback event")?;
        if let NativeEvent::Error { message, .. } = &event {
            if message.trim().is_empty() { return Err("Native error message must be nonempty.".into()); }
        }
        let handle = event.handle().to_string();
        let mut batch = Batch::default();
        let Some(resource) = self.resources.get(&handle) else { return Ok(batch); };
        if resource.completed {
            if !matches!(event, NativeEvent::Completed { .. }) {
                self.release(&handle, "native", &mut batch);
            }
            return Ok(batch);
        }
        let hold = matches!(event, NativeEvent::Completed { .. }) && resource.final_pose == FinalPose::Hold;
        let terminal = match event {
            NativeEvent::Completed { handle } => TerminalEvent::Completed { handle },
            NativeEvent::Cancelled { handle } => TerminalEvent::Cancelled { handle, reason: "native" },
            NativeEvent::Error { handle, message } => TerminalEvent::Error { handle, message },
        };
        if hold {
            self.resources.get_mut(&handle).expect("validated resource").completed = true;
        } else {
            self.resources.remove(&handle);
            batch.commands.push(NativeCommand::Release { handle });
        }
        batch.events.push(terminal);
        Ok(batch)
    }

    fn dispose_inner(&mut self) -> Batch {
        let batch = self.release_all("disposed");
        self.binding = None;
        self.disposed = true;
        batch
    }
}

fn parse<T: serde::de::DeserializeOwned>(json: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|error| format!("Invalid {label}: {error}"))
}

fn validate_speed(speed: f64) -> Result<(), String> {
    if !speed.is_finite() {
        Err("Playback speed must be finite; zero and negative native speeds are supported.".into())
    } else { Ok(()) }
}

fn validate_weight(weight: f64) -> Result<(), String> {
    if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
        Err("Native playback weight must be finite and in [0, 1].".into())
    } else { Ok(()) }
}

fn validate_seek(seconds: f64, duration_seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || !(0.0..=duration_seconds).contains(&seconds) {
        Err(format!("Playback position must be finite and in [0, {duration_seconds}] seconds."))
    } else { Ok(()) }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ConcreteTarget {
    MorphTarget { #[serde(rename = "meshId")] _mesh_id: u32, #[serde(rename = "morphTargetId")] _morph_target_id: u32 },
    BoneTransform { #[serde(rename = "boneId")] _bone_id: u32, property: Option<String> },
    ObjectTransform { #[serde(rename = "objectId")] _object_id: u32, property: Option<String> },
    MeshVisibility { #[serde(rename = "meshId")] _mesh_id: u32 },
}

fn transform_type(property: Option<&str>) -> Result<(&'static str, &'static str), String> {
    match property.unwrap_or("rotation") {
        "rotation" | "quaternion" => Ok(("quat", "quaternion")),
        "position" => Ok(("vec3", "position")),
        "scale" => Ok(("vec3", "scale")),
        other => Err(format!("Unsupported concrete transform property {other:?}.")),
    }
}

fn validate_clip(clip: &ClipIR) -> Result<(), String> {
    if clip.name.trim().is_empty() || !clip.duration_seconds.is_finite() || clip.duration_seconds < 0.0 {
        return Err("ClipIR requires a nonempty name and finite nonnegative durationSeconds.".into());
    }
    if clip.tracks.is_empty() { return Err("ClipIR requires at least one concrete track.".into()); }
    let mut channels = HashSet::new();
    for channel in &clip.channels {
        if channel.kind.trim().is_empty() || !channels.insert(channel.id) {
            return Err("ClipIR channels require unique IDs and nonempty kinds.".into());
        }
    }
    let mut track_ids = HashSet::new();
    for track in &clip.tracks {
        let fail = |message: &str| format!("Invalid ClipIR track {}: {message}", track.id);
        if !track_ids.insert(track.id) || !channels.contains(&track.channel_id) {
            return Err(fail("track IDs must be unique and channelId must exist."));
        }
        let target: ConcreteTarget = serde_json::from_value(track.target.clone()).map_err(|error| fail(&error.to_string()))?;
        let expected_type = match target {
            ConcreteTarget::MorphTarget { .. } | ConcreteTarget::MeshVisibility { .. } => "scalar",
            ConcreteTarget::BoneTransform { property, .. } => {
                transform_type(property.as_deref()).map_err(|error| fail(&error))?.0
            },
            ConcreteTarget::ObjectTransform { property, .. } => {
                transform_type(property.as_deref()).map_err(|error| fail(&error))?.0
            },
        };
        if track.value_type != expected_type {
            return Err(fail("valueType must match its concrete target."));
        }
        let size = match expected_type { "scalar" => 1, "vec3" => 3, "quat" => 4, _ => unreachable!() };
        if track.times.is_empty() || track.values.len() != track.times.len().saturating_mul(size) {
            return Err(fail("times and values must contain matching nonempty samples."));
        }
        // Native clips may deliberately end before their final key. Preserve
        // that authored cutoff and equal-time jumps instead of rewriting them.
        if track.times.iter().any(|time| !time.is_finite() || *time < 0.0)
            || track.times.windows(2).any(|pair| pair[0] > pair[1])
            || track.values.iter().any(|value| !value.is_finite()) {
            return Err(fail("samples must be finite, with nonnegative nondecreasing times."));
        }
        if !matches!(track.interpolation.as_deref(), None | Some("linear") | Some("step")) {
            return Err(fail("interpolation must be linear, step or omitted."));
        }
        if expected_type == "quat" && track.values.chunks_exact(4).any(|q| {
            let norm_squared: f64 = q.iter().map(|v| v * v).sum();
            !norm_squared.is_finite() || (norm_squared - 1.0).abs() > 1e-3
        }) {
            return Err(fail("quaternion samples must have unit length."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn clip() -> Value {
        json!({"name":"smile","durationSeconds":1.0,"channels":[{"id":1,"kind":"face"}],
            "tracks":[{"id":1,"channelId":1,"target":{"kind":"morphTarget","meshId":2,"morphTargetId":3},
                "valueType":"scalar","times":[0.0,1.0],"values":[0.0,0.7],"interpolation":"linear"}]})
    }

    fn session() -> NativePlaybackSession {
        let mut session = NativePlaybackSession::create().unwrap();
        session.rebind_inner("model", "profile-v1").unwrap();
        session
    }

    fn play(session: &mut NativePlaybackSession, options: Value) -> Batch {
        session.play_inner(&clip().to_string(), &options.to_string()).unwrap()
    }

    fn notify(session: &mut NativePlaybackSession, handle: &str, kind: &str) -> Batch {
        session.notify_inner(&json!({"type":kind,"handle":handle}).to_string()).unwrap()
    }

    fn value(batch: Batch) -> Value { serde_json::to_value(batch).unwrap() }

    #[test]
    fn play_passes_concrete_clip_and_native_settings_without_sampling() {
        let mut session = session();
        let batch = value(play(&mut session, json!({"speed":-2,"weight":0.25,"loop":{"mode":"pingPong","count":3},"finalPose":"hold"})));
        assert_eq!(batch["commands"][0]["clip"], clip());
        assert_eq!(batch["commands"][0]["binding"], json!({"modelKey":"model","profileKey":"profile-v1"}));
        assert_eq!(batch["commands"][0]["settings"], json!({"startSeconds":1.0,"speed":-2.0,"weight":0.25,"blendMode":"normal","loop":{"mode":"pingPong","count":3},"finalPose":"hold"}));
        let handle = batch["handle"].as_str().unwrap();
        for control in [json!({"type":"pause"}),json!({"type":"resume"}),json!({"type":"seek","seconds":0.5}),
            json!({"type":"setSpeed","speed":-0.5}),json!({"type":"setSpeed","speed":0}),json!({"type":"setWeight","weight":0}),
            json!({"type":"setBlendMode","blendMode":"additive"}),
            json!({"type":"setLoop","loop":{"mode":"repeat"}}),json!({"type":"setFinalPose","finalPose":"release"})] {
            let batch = value(session.control_inner(handle, &control.to_string()).unwrap());
            assert_eq!(batch["commands"][0]["type"], "control");
            assert_eq!(batch["events"], json!([]));
        }
        assert_eq!(session.resources.len(), 1);
    }

    #[test]
    fn replacement_is_explicit_and_invalid_play_preserves_old_resource() {
        let mut session = session();
        let first = play(&mut session, json!({})).handle.unwrap();
        let overlap = play(&mut session, json!({})).handle.unwrap();
        assert_eq!(session.resources.len(), 2);
        for options in [json!({"replace":first,"speed":"fast"}),json!({"replace":first,"weight":2}),
            json!({"replace":first,"startSeconds":2}),json!({"replace":first,"intensity":0.5}),
            json!({"replace":first,"loop":{"mode":"once","count":2}}),json!({"replace":"foreign"})] {
            assert!(session.play_inner(&clip().to_string(), &options.to_string()).is_err());
            assert_eq!(session.resources.len(), 2);
            assert!(session.resource(&first).is_ok());
        }
        let replaced = value(play(&mut session, json!({"replace":first})));
        assert_eq!(replaced["commands"][0], json!({"type":"release","handle":first}));
        assert_eq!(replaced["events"], json!([{"type":"cancelled","handle":first,"reason":"replaced"}]));
        assert!(session.resource(&first).is_err());
        assert!(session.resource(&overlap).is_ok());
        assert!(notify(&mut session, &first, "completed").events.is_empty());
    }

    #[test]
    fn terminal_notifications_are_exactly_once_and_records_are_reclaimed() {
        let mut session = session();
        for _ in 0..100 {
            let handle = play(&mut session, json!({})).handle.unwrap();
            let batch = value(notify(&mut session, &handle, "completed"));
            assert_eq!(batch["commands"], json!([{"type":"release","handle":handle}]));
            assert_eq!(batch["events"], json!([{"type":"completed","handle":handle}]));
            assert!(notify(&mut session, &handle, "completed").events.is_empty());
            assert!(session.resources.is_empty());
        }
        let handle = play(&mut session, json!({})).handle.unwrap();
        let stopped = value(session.control_inner(&handle, r#"{"type":"stop"}"#).unwrap());
        assert_eq!(stopped["events"][0]["reason"], "stopped");
        assert!(notify(&mut session, &handle, "cancelled").events.is_empty());
        assert!(session.control_inner(&handle, r#"{"type":"stop"}"#).is_err());
        let handle = play(&mut session, json!({})).handle.unwrap();
        let failed = value(session.notify_inner(&json!({"type":"error","handle":handle,"message":"unsupported binding"}).to_string()).unwrap());
        assert_eq!(failed["events"][0]["type"], "error");
        assert_eq!(failed["events"][0]["message"], "unsupported binding");
        assert!(session.resources.is_empty());
    }

    #[test]
    fn held_completion_releases_without_a_second_terminal_event() {
        let mut session = session();
        for release in ["stop", "release", "error", "cancelled", "replace", "rebind", "dispose"] {
            let handle = play(&mut session, json!({"finalPose":"hold"})).handle.unwrap();
            let done = notify(&mut session, &handle, "completed");
            assert_eq!(done.events.len(), 1);
            assert!(done.commands.is_empty());
            assert!(notify(&mut session, &handle, "completed").commands.is_empty());
            assert!(session.control_inner(&handle, r#"{"type":"resume"}"#).is_err());
            let batch = match release {
                "stop" => session.control_inner(&handle, r#"{"type":"stop"}"#).unwrap(),
                "release" => session.control_inner(&handle, r#"{"type":"setFinalPose","finalPose":"release"}"#).unwrap(),
                "error" => session.notify_inner(&json!({"type":"error","handle":handle,"message":"device lost"}).to_string()).unwrap(),
                "cancelled" => notify(&mut session, &handle, "cancelled"),
                "replace" => play(&mut session, json!({"replace":handle})),
                "rebind" => session.rebind_inner("model", "profile-v2").unwrap(),
                _ => session.dispose_inner(),
            };
            // A replacement left an active resource; remove it before the next case.
            if release == "replace" { session.dispose_inner(); session = super::tests::session(); }
            assert!(batch.events.is_empty());
            assert!(matches!(&batch.commands[0], NativeCommand::Release { handle: released } if released == &handle));
        }
    }

    #[test]
    fn model_or_profile_rebind_and_disposal_reject_handles_and_late_events() {
        let mut session = session();
        let mut foreign = super::tests::session();
        let old = play(&mut session, json!({})).handle.unwrap();
        let other = play(&mut foreign, json!({})).handle.unwrap();
        assert_ne!(old, other);
        assert!(session.control_inner(&other, r#"{"type":"pause"}"#).is_err());
        assert!(notify(&mut session, &other, "completed").events.is_empty());
        assert!(session.rebind_inner("", "profile").is_err());
        assert!(session.resource(&old).is_ok());
        let rebound = value(session.rebind_inner("model", "profile-v2").unwrap());
        assert_eq!(rebound["events"][0]["reason"], "rebound");
        let current = play(&mut session, json!({})).handle.unwrap();
        assert_ne!(old, current);
        assert!(notify(&mut session, &old, "completed").events.is_empty());
        assert!(session.resource(&current).is_ok());
        let disposed = value(session.dispose_inner());
        assert_eq!(disposed["events"][0]["reason"], "disposed");
        assert!(session.dispose_inner().commands.is_empty());
        assert!(notify(&mut session, &current, "completed").events.is_empty());
        assert!(session.control_inner(&current, r#"{"type":"pause"}"#).is_err());
        assert!(session.rebind_inner("model", "profile").is_err());
        assert!(session.play_inner(&clip().to_string(), "{}").is_err());
    }

    #[test]
    fn invalid_controls_and_clips_do_not_cancel_or_mutate_resources() {
        let mut session = session();
        let handle = play(&mut session, json!({})).handle.unwrap();
        for control in [json!({"type":"seek","seconds":-1}),json!({"type":"seek","seconds":2}),
            json!({"type":"setWeight","weight":1.01}),json!({"type":"setSpeed","speed":"fast"}),
            json!({"type":"setLoop","loop":{"mode":"repeat","count":0}}),
            json!({"type":"pause","fadeSeconds":1}),json!({"type":"unknown"})] {
            assert!(session.control_inner(&handle, &control.to_string()).is_err());
            assert!(session.resource(&handle).is_ok());
        }
        for invalid in [
            { let mut c=clip(); c["durationSeconds"]=json!(-1); c },
            { let mut c=clip(); c["tracks"][0]["times"]=json!([1,0]); c },
            { let mut c=clip(); c["tracks"][0]["values"]=json!([0]); c },
            { let mut c=clip(); c["tracks"][0]["channelId"]=json!(2); c },
            { let mut c=clip(); c["tracks"][0]["target"]=json!({"kind":"au","id":12}); c },
            { let mut c=clip(); c["tracks"][0]["valueType"]=json!("vec3"); c },
            { let mut c=clip(); c["tracks"][0]["interpolation"]=json!("cubic"); c },
        ] {
            assert!(session.play_inner(&invalid.to_string(), &json!({"replace":handle}).to_string()).is_err());
            assert!(session.resource(&handle).is_ok());
        }
        let mut compiled: ClipIR = serde_json::from_value(clip()).unwrap();
        compiled.tracks[0].values[0] = f64::NAN;
        assert!(validate_clip(&compiled).is_err());
        assert!(validate_speed(f64::INFINITY).is_err());
        assert!(validate_weight(f64::NAN).is_err());
        assert!(validate_seek(f64::INFINITY, 1.0).is_err());
    }

    #[test]
    fn zero_duration_once_can_hold_but_looping_is_rejected() {
        let mut session = session();
        let mut zero = clip();
        zero["durationSeconds"] = json!(0);
        zero["tracks"][0]["times"] = json!([0]);
        zero["tracks"][0]["values"] = json!([0.7]);
        let handle = session.play_inner(&zero.to_string(), r#"{"finalPose":"hold"}"#).unwrap().handle.unwrap();
        assert!(session.control_inner(&handle, r#"{"type":"setLoop","loop":{"mode":"repeat"}}"#).is_err());
        assert!(session.play_inner(&zero.to_string(), r#"{"loop":{"mode":"pingPong","count":2}}"#).is_err());
        assert_eq!(notify(&mut session, &handle, "completed").events.len(), 1);
        assert_eq!(session.resources.len(), 1);
    }

    #[test]
    fn native_equal_time_keys_shared_targets_and_explicit_duration_are_preserved() {
        let mut session = session();
        let mut native = clip();
        native["durationSeconds"] = json!(0.75);
        native["tracks"][0]["times"] = json!([0.0, 0.5, 0.5, 1.0]);
        native["tracks"][0]["values"] = json!([0.0, 0.2, 0.8, 1.0]);
        let mut contribution = native["tracks"][0].clone();
        contribution["id"] = json!(2);
        native["tracks"].as_array_mut().unwrap().push(contribution);
        let result = value(session.play_inner(&native.to_string(), r#"{"speed":0,"blendMode":"additive"}"#).unwrap());
        assert_eq!(result["commands"][0]["clip"], native);
        assert_eq!(result["commands"][0]["settings"]["speed"].as_f64(), Some(0.0));
        assert_eq!(result["commands"][0]["settings"]["blendMode"], "additive");
    }
}
