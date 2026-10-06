use super::geometry::{number, text};
use super::{error, parse};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// Browser timers only wake this state machine. Rust owns deadlines, expiry,
/// manual overrides, repeated preview starts, and one-shot end notifications.
#[wasm_bindgen]
pub struct AnnotationLifecycle {
    active: bool,
    reveal: Option<f64>,
    end: Option<f64>,
    duration: f64,
    style: String,
    mode: String,
    disposed: bool,
}
#[wasm_bindgen]
impl AnnotationLifecycle {
    #[wasm_bindgen(constructor)]
    pub fn new(mode: &str, default_duration_ms: f64) -> AnnotationLifecycle {
        Self {
            active: false,
            reveal: None,
            end: None,
            duration: if default_duration_ms.is_finite() {
                default_duration_ms.max(0.)
            } else {
                if mode == "preview" {
                    1200.
                } else {
                    5000.
                }
            },
            style: "3d".into(),
            mode: mode.into(),
            disposed: false,
        }
    }
    pub fn command(
        &mut self,
        operation: &str,
        options_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        let options = parse(options_json).map_err(error)?;
        self.execute(operation, &options, now_ms)
            .map(|v| v.to_string())
            .map_err(error)
    }
    pub fn deadline(&self) -> Option<f64> {
        match (self.reveal, self.end) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
}
impl AnnotationLifecycle {
    pub(super) fn execute(
        &mut self,
        operation: &str,
        options: &Value,
        now: f64,
    ) -> Result<Value, String> {
        if !now.is_finite() {
            return Err("Annotation lifecycle time must be finite".into());
        }
        if self.disposed {
            return Ok(json!([]));
        }
        let mut effects = Vec::new();
        match operation {
            "manual" => {
                self.reveal = None;
                self.end = None;
                self.active = options["visible"].as_bool().unwrap_or(false);
                effects.push(json!({"kind":"visibility","visible":self.active}));
            }
            "prepare" => {
                self.reveal = None;
                self.end = None;
                self.active = false;
                effects.push(json!({"kind":"visibility","visible":false}));
            }
            "reveal" => {
                let delay = number(options, "revealDelayMs", 0.).max(0.) as f64;
                self.reveal = Some(now + delay);
                self.end = Some(
                    now + delay
                        + number(options, "durationMs", self.duration as f32).max(0.) as f64,
                );
                self.style = options["markerStyle"].as_str().unwrap_or("3d").into();
            }
            "start" => {
                if options["disabled"] != true {
                    let was = self.active;
                    self.active = true;
                    if !was || options["forceRefresh"] == true {
                        effects.push(json!({"kind":"previewStart"}))
                    }
                    let duration = number(options, "durationMs", self.duration as f32) as f64;
                    self.end = if duration > 0. {
                        Some(now + duration)
                    } else {
                        None
                    };
                }
            }
            "scheduleEnd" => {
                let duration = number(options, "durationMs", self.duration as f32) as f64;
                self.end = if duration > 0. && self.active {
                    Some(now + duration)
                } else {
                    None
                };
            }
            "end" | "dispose" | "reset" => {
                self.reveal = None;
                self.end = None;
                if self.active && self.mode == "preview" {
                    effects.push(json!({"kind":"previewEnd"}))
                }
                self.active = false;
                if operation == "dispose" {
                    self.disposed = true
                }
            }
            "tick" => (),
            _ => {
                return Err(format!(
                    "Unknown annotation lifecycle operation {operation}"
                ))
            }
        }
        if self.reveal.is_some_and(|time| time <= now) {
            self.reveal = None;
            self.active = true;
            effects.push(json!({"kind":"style","style":self.style}));
            effects.push(json!({"kind":"visibility","visible":true}));
        }
        if self.end.is_some_and(|time| time <= now) {
            self.end = None;
            if self.active {
                self.active = false;
                effects.push(if self.mode == "preview" {
                    json!({"kind":"previewEnd"})
                } else {
                    json!({"kind":"visibility","visible":false})
                });
            }
        }
        Ok(json!(effects))
    }
}
pub(super) fn reveal_options(config: &Value) -> Value {
    json!({"markerStyle":if text(config,"markerStyle").is_empty(){"3d"}else{text(config,"markerStyle")},"revealDelayMs":if config["playIntroOnLoad"]==true{4500}else{120}})
}
