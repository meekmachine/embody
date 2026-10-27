use wasm_bindgen::prelude::*;

use crate::math::finite_or;

pub const HAIR_CONFIG_STRIDE: u32 = 11;
pub const HAIR_STATE_STRIDE: u32 = 4;
pub const HAIR_HEAD_STATE_STRIDE: u32 = 5;
pub const HAIR_MORPH_OUTPUT_STRIDE: u32 = 6;

const MAX_DT_SECONDS: f32 = 0.1;
const MAX_VELOCITY: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct HairPhysicsConfig {
    mass: f32,
    stiffness: f32,
    damping: f32,
    gravity: f32,
    head_influence: f32,
    wind_enabled: bool,
    wind_strength: f32,
    wind_direction_x: f32,
    wind_direction_z: f32,
    wind_turbulence: f32,
    wind_frequency: f32,
}

impl Default for HairPhysicsConfig {
    fn default() -> Self {
        Self {
            mass: 1.0,
            stiffness: 15.0,
            damping: 0.8,
            gravity: 9.8,
            head_influence: 0.5,
            wind_enabled: false,
            wind_strength: 0.0,
            wind_direction_x: 1.0,
            wind_direction_z: 0.0,
            wind_turbulence: 0.2,
            wind_frequency: 0.5,
        }
    }
}

impl HairPhysicsConfig {
    fn from_values(values: &[f32], base: Self) -> Self {
        Self {
            mass: finite_or(*values.get(0).unwrap_or(&base.mass), base.mass),
            stiffness: finite_or(*values.get(1).unwrap_or(&base.stiffness), base.stiffness),
            damping: finite_or(*values.get(2).unwrap_or(&base.damping), base.damping),
            gravity: finite_or(*values.get(3).unwrap_or(&base.gravity), base.gravity),
            head_influence: finite_or(
                *values.get(4).unwrap_or(&base.head_influence),
                base.head_influence,
            ),
            wind_enabled: finite_or(
                *values.get(5).unwrap_or(&(base.wind_enabled as u8 as f32)),
                0.0,
            ) >= 0.5,
            wind_strength: finite_or(
                *values.get(6).unwrap_or(&base.wind_strength),
                base.wind_strength,
            ),
            wind_direction_x: finite_or(
                *values.get(7).unwrap_or(&base.wind_direction_x),
                base.wind_direction_x,
            ),
            wind_direction_z: finite_or(
                *values.get(8).unwrap_or(&base.wind_direction_z),
                base.wind_direction_z,
            ),
            wind_turbulence: finite_or(
                *values.get(9).unwrap_or(&base.wind_turbulence),
                base.wind_turbulence,
            ),
            wind_frequency: finite_or(
                *values.get(10).unwrap_or(&base.wind_frequency),
                base.wind_frequency,
            ),
        }
    }

    fn to_values(self) -> Box<[f32]> {
        vec![
            self.mass,
            self.stiffness,
            self.damping,
            self.gravity,
            self.head_influence,
            if self.wind_enabled { 1.0 } else { 0.0 },
            self.wind_strength,
            self.wind_direction_x,
            self.wind_direction_z,
            self.wind_turbulence,
            self.wind_frequency,
        ]
        .into_boxed_slice()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct HairPhysicsState {
    x: f32,
    z: f32,
    vx: f32,
    vz: f32,
}

impl HairPhysicsState {
    fn to_values(self) -> Box<[f32]> {
        vec![self.x, self.z, self.vx, self.vz].into_boxed_slice()
    }
}

/// The character runtime's continuous response. This uses the same spring,
/// damping and inertial forces as the packed compatibility solver below, but
/// advances from renderer deltas and retains momentum across head retargets.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct HairResponse {
    state: HairPhysicsState,
    gravity_pitch: f32,
    gravity_velocity: f32,
    time: f64,
    previous_head: Option<[f32; 2]>,
}

const RESPONSE_MAX_ELAPSED: f64 = 0.25;
const RESPONSE_SUBSTEP: f64 = 1.0 / 120.0;

// Implicit spring integration remains stable for finite, nonnegative profile
// stiffness/damping, including very large values. Dynamics use unit mass;
// profile inertia is an angular-velocity force gain, not a second clock.
fn response_spring_step(
    position: &mut f32, velocity: &mut f32, target: f64, force: f64,
    stiffness: f64, damping: f64, dt: f64,
) {
    let next_velocity = (f64::from(*velocity)
        + dt * (stiffness * (target - f64::from(*position)) + force))
        / (1.0 + damping * dt + stiffness * dt * dt);
    *velocity = next_velocity.clamp(-f64::from(MAX_VELOCITY), f64::from(MAX_VELOCITY)) as f32;
    *position = (f64::from(*position) + f64::from(*velocity) * dt).clamp(-1.0, 1.0) as f32;
}

impl HairResponse {
    pub(crate) fn reprime_head(&mut self) {
        self.previous_head = None;
    }

    pub(crate) fn add_impulse(&mut self, horizontal: f32, vertical: f32) -> Result<(), String> {
        if !horizontal.is_finite() || !vertical.is_finite() {
            return Err("Hair response impulse requires finite horizontal and vertical values.".into());
        }
        self.state.vx = (f64::from(self.state.vx) + f64::from(horizontal))
            .clamp(-f64::from(MAX_VELOCITY), f64::from(MAX_VELOCITY)) as f32;
        self.state.vz = (f64::from(self.state.vz) + f64::from(vertical))
            .clamp(-f64::from(MAX_VELOCITY), f64::from(MAX_VELOCITY)) as f32;
        Ok(())
    }

    pub(crate) fn advance(
        &mut self, config: &crate::hair_curves::HairPlaybackConfig,
        head: Option<[f32; 2]>, dt_seconds: f64,
    ) -> Result<(), String> {
        if !dt_seconds.is_finite() || dt_seconds < 0.0 {
            return Err("Hair response dtSeconds must be finite and nonnegative.".into());
        }
        if !config.enabled {
            *self = Self::default();
            return Ok(());
        }
        if dt_seconds == 0.0 {
            // Binding may prime at zero delta. Once primed, a zero-delta frame
            // cannot consume motion that belongs to the next advancing frame.
            if self.previous_head.is_none() { self.previous_head = head; }
            return Ok(());
        }
        let (yaw_velocity, pitch_velocity) = match (self.previous_head, head) {
            (Some(previous), Some(current)) if dt_seconds <= RESPONSE_MAX_ELAPSED => {
                let yaw_delta = (f64::from(current[0]) - f64::from(previous[0])
                    + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)
                    - std::f64::consts::PI;
                let limit = f64::from(f32::MAX);
                ((yaw_delta / dt_seconds).clamp(-limit, limit),
                    (f64::from(current[1] - previous[1]) / dt_seconds).clamp(-limit, limit))
            }
            _ => (0.0, 0.0),
        };
        // A suspended renderer has no observed trajectory through its gap.
        // Re-prime the head, retain momentum, and settle at most 250 ms; never
        // turn that unobserved interval into a fresh angular-velocity impulse.
        self.previous_head = head;
        let elapsed = dt_seconds.min(RESPONSE_MAX_ELAPSED);
        let steps = (elapsed / RESPONSE_SUBSTEP).ceil().max(1.0) as u32;
        let dt = elapsed / f64::from(steps);
        let curves = &config.curves;
        let stiffness = f64::from(curves.stiffness);
        let damping = f64::from(curves.damping);
        let pitch = f64::from(head.map_or(0.0, |pose| pose[1])) * f64::from(config.direction.pitch_sign);
        let inertia_x = -yaw_velocity * f64::from(config.inertia) * f64::from(config.direction.yaw_sign) * 2.0;
        let inertia_z = -pitch_velocity * f64::from(config.inertia) * f64::from(config.direction.pitch_sign) * 2.0;
        for _ in 0..steps {
            self.time += dt;
            let idle = (self.time * f64::from(curves.idle_sway_speed) * std::f64::consts::TAU).sin()
                * f64::from(curves.idle_sway_amount);
            let wind_phase = self.time * f64::from(curves.wind_frequency) * std::f64::consts::TAU;
            let wind_wave = wind_phase.sin() + (wind_phase * 1.7).sin() * 0.3
                + (wind_phase * 3.3).sin() * f64::from(curves.wind_turbulence) * 0.2;
            let wind = wind_wave * f64::from(curves.wind_strength) * 0.1;
            response_spring_step(&mut self.state.x, &mut self.state.vx,
                idle + wind * f64::from(curves.wind_direction_x), inertia_x, stiffness, damping, dt);
            response_spring_step(&mut self.state.z, &mut self.state.vz,
                wind * f64::from(curves.wind_direction_z),
                inertia_z + f64::from(config.gravity) * pitch.sin() * 0.1, stiffness, damping, dt);
            response_spring_step(&mut self.gravity_pitch, &mut self.gravity_velocity,
                (pitch * f64::from(config.gravity)).clamp(-1.0, 1.0), 0.0, stiffness, damping, dt);
        }
        Ok(())
    }

    /// Signed sway and smoothed gravity pitch; profile mapping stays in the
    /// runtime's hair curve module rather than in a renderer adapter.
    pub(crate) fn offsets(&self) -> [f32; 3] {
        [self.state.x, self.state.z, self.gravity_pitch]
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct HeadState {
    yaw: f32,
    pitch: f32,
    yaw_velocity: f32,
    pitch_velocity: f32,
}

impl HeadState {
    fn from_values(values: &[f32]) -> Self {
        Self {
            yaw: finite_or(*values.get(0).unwrap_or(&0.0), 0.0),
            pitch: finite_or(*values.get(1).unwrap_or(&0.0), 0.0),
            yaw_velocity: finite_or(*values.get(3).unwrap_or(&0.0), 0.0),
            pitch_velocity: finite_or(*values.get(4).unwrap_or(&0.0), 0.0),
        }
    }
}

#[wasm_bindgen]
pub fn hair_config_stride() -> u32 {
    HAIR_CONFIG_STRIDE
}

#[wasm_bindgen]
pub fn hair_state_stride() -> u32 {
    HAIR_STATE_STRIDE
}

#[wasm_bindgen]
pub fn hair_head_state_stride() -> u32 {
    HAIR_HEAD_STATE_STRIDE
}

#[wasm_bindgen]
pub fn hair_morph_output_stride() -> u32 {
    HAIR_MORPH_OUTPUT_STRIDE
}

#[wasm_bindgen]
pub fn default_hair_physics_config_values() -> Box<[f32]> {
    HairPhysicsConfig::default().to_values()
}

#[wasm_bindgen]
pub struct HairPhysicsSolver {
    config: HairPhysicsConfig,
    state: HairPhysicsState,
    time: f32,
    prev_head_yaw: f32,
    prev_head_pitch: f32,
}

#[wasm_bindgen]
impl HairPhysicsSolver {
    #[wasm_bindgen(constructor)]
    pub fn new(config_values: &[f32]) -> HairPhysicsSolver {
        HairPhysicsSolver {
            config: HairPhysicsConfig::from_values(config_values, HairPhysicsConfig::default()),
            state: HairPhysicsState::default(),
            time: 0.0,
            prev_head_yaw: 0.0,
            prev_head_pitch: 0.0,
        }
    }

    pub fn update(&mut self, dt: f32, head_values: &[f32]) -> Box<[f32]> {
        let dt = finite_or(dt, 0.0);
        if dt <= 0.0 || dt > MAX_DT_SECONDS {
            return self.compute_morph_output();
        }

        let head = HeadState::from_values(head_values);
        self.time += dt;

        let head_yaw_vel = if head.yaw_velocity != 0.0 {
            head.yaw_velocity
        } else {
            (head.yaw - self.prev_head_yaw) / dt
        };
        let head_pitch_vel = if head.pitch_velocity != 0.0 {
            head.pitch_velocity
        } else {
            (head.pitch - self.prev_head_pitch) / dt
        };

        self.prev_head_yaw = head.yaw;
        self.prev_head_pitch = head.pitch;

        let spring_fx = -self.config.stiffness * self.state.x;
        let spring_fz = -self.config.stiffness * self.state.z;
        let damp_fx = -self.config.damping * self.state.vx;
        let damp_fz = -self.config.damping * self.state.vz;
        let gravity_fz = self.config.gravity * head.pitch.sin() * 0.1;
        let inertia_fx = -head_yaw_vel * self.config.head_influence * self.config.mass * 2.0;
        let inertia_fz = -head_pitch_vel * self.config.head_influence * self.config.mass * 2.0;

        let (wind_fx, wind_fz) = self.wind_force();

        let total_fx = spring_fx + damp_fx + inertia_fx + wind_fx;
        let total_fz = spring_fz + damp_fz + gravity_fz + inertia_fz + wind_fz;
        let mass = if self.config.mass.abs() <= f32::EPSILON {
            HairPhysicsConfig::default().mass
        } else {
            self.config.mass
        };

        self.state.vx = (self.state.vx + total_fx / mass * dt).clamp(-MAX_VELOCITY, MAX_VELOCITY);
        self.state.vz = (self.state.vz + total_fz / mass * dt).clamp(-MAX_VELOCITY, MAX_VELOCITY);
        self.state.x = (self.state.x + self.state.vx * dt).clamp(-1.0, 1.0);
        self.state.z = (self.state.z + self.state.vz * dt).clamp(-1.0, 1.0);

        self.compute_morph_output()
    }

    pub fn set_config(&mut self, config_values: &[f32]) {
        self.config = HairPhysicsConfig::from_values(config_values, self.config);
    }

    pub fn get_config(&self) -> Box<[f32]> {
        self.config.to_values()
    }

    pub fn get_state(&self) -> Box<[f32]> {
        self.state.to_values()
    }

    pub fn reset(&mut self) {
        self.state = HairPhysicsState::default();
        self.time = 0.0;
        self.prev_head_yaw = 0.0;
        self.prev_head_pitch = 0.0;
    }
}

impl HairPhysicsSolver {
    fn wind_force(&self) -> (f32, f32) {
        if !self.config.wind_enabled || self.config.wind_strength <= 0.0 {
            return (0.0, 0.0);
        }

        let wind_phase = self.time * self.config.wind_frequency * std::f32::consts::PI * 2.0;
        let wind_oscillation = wind_phase.sin();
        let turbulence_phase = self.time * self.config.wind_frequency * 3.7;
        let turbulence = turbulence_phase.sin() * self.config.wind_turbulence;

        (
            self.config.wind_strength
                * self.config.wind_direction_x
                * (0.5 + 0.5 * wind_oscillation)
                + turbulence * (-self.config.wind_direction_z),
            self.config.wind_strength
                * self.config.wind_direction_z
                * (0.5 + 0.5 * wind_oscillation)
                + turbulence * self.config.wind_direction_x,
        )
    }

    fn compute_morph_output(&self) -> Box<[f32]> {
        let left = 0.0_f32.max(-self.state.x);
        let right = 0.0_f32.max(self.state.x);
        let front = 0.0_f32.max(self.state.z);

        vec![left, right, front, left, right, front].into_boxed_slice()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn continuous_config() -> crate::hair_curves::HairPlaybackConfig {
        crate::hair_curves::normalize_config(&crate::hair_curves::HairPlaybackConfig::default(), &serde_json::json!({
            "enabled":true,"inertia":1,"gravity":0,"idleSwayAmount":0,"stiffness":15,"damping":8
        })).unwrap()
    }

    #[test]
    fn continuous_head_retargets_preserve_position_velocity_and_zero_delta_does_not_consume_motion() {
        let config = continuous_config();
        let mut response = HairResponse::default();
        response.advance(&config, Some([0.6, 0.0]), 0.0).unwrap();
        assert_eq!(response.offsets(), [0.0; 3]); // Initial nonneutral head primes, without a kick.
        response.advance(&config, Some([0.7, 0.0]), 1.0 / 60.0).unwrap();
        assert!(response.state.vx < 0.0);
        let before = response.clone();
        response.advance(&config, Some([-0.5, 0.0]), 0.0).unwrap();
        assert_eq!(response, before);
        response.advance(&config, Some([0.7, 0.0]), 1.0 / 60.0).unwrap();
        assert!(response.state.x < before.state.x); // Momentum continues after head movement stops.
        assert!(response.state.vx < 0.0);
        let moving = response.state.x;
        response.advance(&config, Some([0.69, 0.0]), 1.0 / 60.0).unwrap();
        assert!(response.state.x < 0.0);
        assert!((response.state.x - moving).abs() < 0.02); // A reversal does not replace spring state.
    }

    #[test]
    fn continuous_response_wraps_yaw_and_suppresses_unobserved_gap_impulses() {
        let config = continuous_config();
        let mut wrapped = HairResponse::default();
        let mut local = HairResponse::default();
        wrapped.advance(&config, Some([std::f32::consts::PI - 0.01, 0.0]), 0.0).unwrap();
        local.advance(&config, Some([0.0, 0.0]), 0.0).unwrap();
        wrapped.advance(&config, Some([-std::f32::consts::PI + 0.01, 0.0]), 0.02).unwrap();
        local.advance(&config, Some([0.02, 0.0]), 0.02).unwrap();
        assert!((wrapped.state.vx - local.state.vx).abs() < 1e-5);
        assert!(wrapped.state.vx < 0.0);
        let mut stationary_gap = wrapped.clone();
        stationary_gap.advance(&config, Some([-std::f32::consts::PI + 0.01, 0.0]), 10.0).unwrap();
        wrapped.advance(&config, Some([1.0, 0.0]), 10.0).unwrap();
        assert_eq!(wrapped.state, stationary_gap.state); // Preserve and settle existing momentum only.
        assert_eq!(wrapped.time, stationary_gap.time);
        assert!(wrapped.state.to_values().iter().all(|value| value.is_finite()));
    }

    #[test]
    fn continuous_response_rejects_bad_time_atomically_and_keeps_extreme_finite_inputs_bounded() {
        let mut config = continuous_config();
        let mut response = HairResponse::default();
        response.advance(&config, Some([0.0, 0.0]), 0.0).unwrap();
        let before = response.clone();
        for dt in [-0.01, f64::INFINITY, f64::NAN] {
            assert!(response.advance(&config, Some([1.0, 1.0]), dt).is_err());
            assert_eq!(response, before);
        }
        config.inertia = f32::MAX;
        config.gravity = f32::MAX;
        config.curves.stiffness = f32::MAX;
        config.curves.damping = f32::MAX;
        response.advance(&config, Some([1.0, 1.0]), f64::MIN_POSITIVE).unwrap();
        response.advance(&config, Some([-1.0, -1.0]), 0.1).unwrap();
        assert!(response.offsets().iter().all(|value| value.is_finite() && value.abs() <= 1.0));
        assert!(response.state.to_values().iter().all(|value| value.is_finite()));
    }

    #[test]
    fn stationary_pitch_settles_gravity_and_ambient_motion_uses_the_same_response() {
        let mut config = continuous_config();
        config.gravity = 1.0;
        let mut response = HairResponse::default();
        response.advance(&config, Some([0.0, 0.4]), 0.0).unwrap();
        for _ in 0..600 { response.advance(&config, Some([0.0, 0.4]), 1.0 / 120.0).unwrap(); }
        assert!((response.gravity_pitch - 0.4).abs() < 0.001);
        assert!(response.gravity_velocity.abs() < 0.001);
        assert!(response.state.vx.abs() < 1e-6);
        let pitched = response.gravity_pitch;
        response.advance(&config, Some([0.0, 0.0]), 1.0 / 120.0).unwrap();
        assert!(response.gravity_pitch < pitched && response.gravity_pitch > 0.3);

        config.gravity = 0.0;
        config.curves.idle_sway_amount = 0.2;
        config.curves.idle_sway_speed = 1.0;
        config.curves.wind_strength = 0.8;
        config.curves.wind_direction_x = 0.0;
        config.curves.wind_direction_z = 1.0;
        let mut ambient = HairResponse::default();
        for _ in 0..30 { ambient.advance(&config, None, 1.0 / 60.0).unwrap(); }
        assert!(ambient.state.x.abs() > 0.001);
        assert!(ambient.state.z.abs() > 0.001);
        assert_eq!(ambient.previous_head, None);
    }

    #[test]
    fn impulse_injection_preserves_phase_head_and_position_and_rejects_invalid_pairs() {
        let config = continuous_config();
        let mut response = HairResponse::default();
        response.advance(&config, Some([0.4, 0.2]), 1.0 / 60.0).unwrap();
        let before = response.clone();
        for impulse in [(1.0, f32::NAN), (f32::INFINITY, 0.0)] {
            assert!(response.add_impulse(impulse.0, impulse.1).is_err());
            assert_eq!(response, before);
        }
        response.add_impulse(0.5, -0.25).unwrap();
        assert_eq!(response.state.x, before.state.x);
        assert_eq!(response.state.z, before.state.z);
        assert_eq!(response.time, before.time);
        assert_eq!(response.previous_head, before.previous_head);
        assert_eq!((response.state.vx, response.state.vz), (0.5, -0.25));
        response.add_impulse(f32::MAX, -f32::MAX).unwrap();
        assert_eq!((response.state.vx, response.state.vz), (MAX_VELOCITY, -MAX_VELOCITY));
    }

    #[test]
    fn continuous_direction_and_spring_tuning_change_response_without_restarting_it() {
        let mut config = continuous_config();
        config.gravity = 1.0;
        let mut reversed_config = config.clone();
        reversed_config.direction.yaw_sign = -1.0;
        reversed_config.direction.pitch_sign = -1.0;
        let mut forward = HairResponse::default();
        let mut reversed = HairResponse::default();
        forward.advance(&config, Some([0.0,0.0]), 0.0).unwrap();
        reversed.advance(&reversed_config, Some([0.0,0.0]), 0.0).unwrap();
        forward.advance(&config, Some([0.1,0.1]), 0.02).unwrap();
        reversed.advance(&reversed_config, Some([0.1,0.1]), 0.02).unwrap();
        for (a, b) in forward.offsets().iter().zip(reversed.offsets()) { assert!((*a + b).abs() < 1e-6); }
        let mut free = forward.clone();
        let mut free_config = config.clone();
        free_config.curves.stiffness = 0.0;
        free_config.curves.damping = 0.0;
        for _ in 0..12 {
            forward.advance(&config, Some([0.1,0.1]), 1.0 / 120.0).unwrap();
            free.advance(&free_config, Some([0.1,0.1]), 1.0 / 120.0).unwrap();
        }
        assert!(forward.state.vx.abs() < free.state.vx.abs());

        let mut wind_config = continuous_config();
        wind_config.curves.wind_strength = 1.0;
        wind_config.curves.wind_direction_x = -1.0;
        wind_config.curves.wind_direction_z = 1.0;
        let mut steady = HairResponse::default();
        let mut turbulent = HairResponse::default();
        let mut turbulent_config = wind_config.clone();
        turbulent_config.curves.wind_turbulence = 2.0;
        turbulent_config.curves.wind_frequency = 1.5;
        for _ in 0..20 {
            steady.advance(&wind_config, None, 1.0 / 60.0).unwrap();
            turbulent.advance(&turbulent_config, None, 1.0 / 60.0).unwrap();
        }
        assert!(steady.state.x < 0.0 && steady.state.z > 0.0);
        assert_ne!(steady.state, turbulent.state);
    }

    #[test]
    fn exposes_hair_strides() {
        assert_eq!(hair_config_stride(), 11);
        assert_eq!(hair_state_stride(), 4);
        assert_eq!(hair_head_state_stride(), 5);
        assert_eq!(hair_morph_output_stride(), 6);
    }

    #[test]
    fn returns_defaults() {
        assert_eq!(
            &*default_hair_physics_config_values(),
            &[1.0, 15.0, 0.8, 9.8, 0.5, 0.0, 0.0, 1.0, 0.0, 0.2, 0.5]
        );
    }

    #[test]
    fn skips_bad_delta_times() {
        let mut solver = HairPhysicsSolver::new(&[]);
        assert_eq!(
            &*solver.update(0.0, &[1.0, 1.0, 0.0, 10.0, 10.0]),
            &[0.0; 6]
        );
        assert_eq!(
            &*solver.update(0.2, &[1.0, 1.0, 0.0, 10.0, 10.0]),
            &[0.0; 6]
        );
    }

    #[test]
    fn updates_from_head_yaw_inertia() {
        let mut solver = HairPhysicsSolver::new(&[]);
        let output = solver.update(0.016, &[0.0, 0.0, 0.0, 1.0, 0.0]);
        assert!(output[0] > 0.0);
        assert_eq!(output[1], 0.0);
    }

    #[test]
    fn resets_state() {
        let mut solver = HairPhysicsSolver::new(&[]);
        solver.update(0.016, &[0.0, 0.0, 0.0, 1.0, 0.0]);
        assert_ne!(&*solver.get_state(), &[0.0; 4]);
        solver.reset();
        assert_eq!(&*solver.get_state(), &[0.0; 4]);
    }
}
