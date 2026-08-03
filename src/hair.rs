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
