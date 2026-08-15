//! Profile-aware screen-space gaze geometry.
//!
//! Hosts own scene objects and reduce them to packed camera/model facts. This
//! module reconstructs a viewer target on the rendered-camera plane, measures
//! the trajectory from the character's eye origin, converts it to model-local
//! angles, and distributes those angles across the rig's head and eye AUs.

use wasm_bindgen::prelude::*;

use crate::annotation_camera::{distance3, quat_or_identity, read_vec3, rotate_by_quat, sub3};
use crate::profile::{deserialize_json, ProfileData};

pub const SCREEN_SPACE_GAZE_SOLUTION_STRIDE: u32 = 14;

const DEFAULT_VERTICAL_FOV_DEGREES: f32 = 45.0;
const DEFAULT_ASPECT: f32 = 1.0;
const DEFAULT_HEAD_YAW_DEGREES: f32 = 60.0;
const DEFAULT_HEAD_PITCH_DEGREES: f32 = 30.0;
const DEFAULT_EYE_YAW_DEGREES: f32 = 25.0;
const DEFAULT_EYE_PITCH_DEGREES: f32 = 20.0;
const DEFAULT_VIEWER_VERTICAL_FOV_DEGREES: f32 = 50.0;
const DEFAULT_VIEWER_ASPECT: f32 = 4.0 / 3.0;
const DEFAULT_VIEWER_DEPTH: f32 = 0.8;
const EPSILON: f32 = 1.0e-5;

#[wasm_bindgen]
pub fn screen_space_gaze_solution_stride() -> u32 {
    SCREEN_SPACE_GAZE_SOLUTION_STRIDE
}

#[derive(Clone, Copy, Debug)]
struct GazeLimits {
    head_yaw: f32,
    head_pitch: f32,
    eye_yaw: f32,
    eye_pitch: f32,
}

impl Default for GazeLimits {
    fn default() -> Self {
        Self {
            head_yaw: DEFAULT_HEAD_YAW_DEGREES,
            head_pitch: DEFAULT_HEAD_PITCH_DEGREES,
            eye_yaw: DEFAULT_EYE_YAW_DEGREES,
            eye_pitch: DEFAULT_EYE_PITCH_DEGREES,
        }
    }
}

fn finite_positive(value: f32, fallback: f32) -> f32 {
    if value.is_finite() && value > EPSILON {
        value
    } else {
        fallback
    }
}

fn pair_max_degrees(profile: &ProfileData, ids: &[u32], fallback: f32) -> f32 {
    let maximum = ids
        .iter()
        .filter_map(|id| profile.au_to_bones.get(&id.to_string()))
        .flat_map(|bindings| bindings.iter())
        .filter_map(|binding| binding.max_degrees)
        .map(|value| value.abs() as f32)
        .filter(|value| value.is_finite() && *value > EPSILON)
        .fold(0.0_f32, f32::max);
    finite_positive(maximum, fallback)
}

fn gaze_limits(profile: &ProfileData) -> GazeLimits {
    GazeLimits {
        head_yaw: pair_max_degrees(profile, &[51, 52], DEFAULT_HEAD_YAW_DEGREES),
        head_pitch: pair_max_degrees(profile, &[53, 54], DEFAULT_HEAD_PITCH_DEGREES),
        eye_yaw: pair_max_degrees(profile, &[61, 62], DEFAULT_EYE_YAW_DEGREES),
        eye_pitch: pair_max_degrees(profile, &[63, 64], DEFAULT_EYE_PITCH_DEGREES),
    }
}

fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(value: [f32; 3], scale: f32) -> [f32; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn inverse_unit_quat(values: &[f32]) -> [f32; 4] {
    let q = quat_or_identity(values);
    [-q[0], -q[1], -q[2], q[3]]
}

fn direction_angles_degrees(from: [f32; 3], to: [f32; 3], inverse_model: [f32; 4]) -> [f32; 2] {
    let local = rotate_by_quat(inverse_model, sub3(to, from));
    let horizontal = (local[0] * local[0] + local[2] * local[2]).sqrt();
    if horizontal <= EPSILON && local[1].abs() <= EPSILON {
        return [0.0, 0.0];
    }
    [
        local[0].atan2(local[2]).to_degrees(),
        local[1].atan2(horizontal.max(EPSILON)).to_degrees(),
    ]
}

fn shortest_angle_delta_degrees(target: f32, origin: f32) -> f32 {
    let mut delta = (target - origin) % 360.0;
    if delta > 180.0 {
        delta -= 360.0;
    } else if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

fn clamp_signed_ratio(value: f32, maximum: f32) -> f32 {
    (value / finite_positive(maximum, 1.0)).clamp(-1.0, 1.0)
}

fn allocate_axis(
    total_degrees: f32,
    camera_degrees: f32,
    head_max: f32,
    eye_max: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    wrap: bool,
) -> [f32; 2] {
    if !head_enabled {
        return [
            if eyes_enabled {
                total_degrees.clamp(-eye_max, eye_max)
            } else {
                0.0
            },
            0.0,
        ];
    }
    if !eyes_enabled {
        return [0.0, total_degrees.clamp(-head_max, head_max)];
    }

    // The head first faces the rendered camera. Source motion within the
    // camera frame is then split: eyes lead while the head follows a smaller
    // share. Any eye overflow is handed back to the head so the combined
    // trajectory remains exact until the rig reaches its authored limits.
    let source_delta = if wrap {
        shortest_angle_delta_degrees(total_degrees, camera_degrees)
    } else {
        total_degrees - camera_degrees
    };
    let desired_head = camera_degrees + source_delta * head_follow_fraction.clamp(0.0, 1.0);
    let mut head = desired_head.clamp(-head_max, head_max);
    let mut eye = (total_degrees - head).clamp(-eye_max, eye_max);
    let residual = total_degrees - (head + eye);
    if residual.abs() > EPSILON {
        head = (head + residual).clamp(-head_max, head_max);
        eye = (total_degrees - head).clamp(-eye_max, eye_max);
    }
    [eye, head]
}

fn allocate_axis_camera_locked(
    total_degrees: f32,
    camera_degrees: f32,
    head_max: f32,
    eye_max: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    wrap: bool,
) -> [f32; 2] {
    if !head_enabled {
        return [
            if eyes_enabled {
                total_degrees.clamp(-eye_max, eye_max)
            } else {
                0.0
            },
            0.0,
        ];
    }

    let head = camera_degrees.clamp(-head_max, head_max);
    if !eyes_enabled {
        return [0.0, head];
    }

    let eye_delta = if wrap {
        shortest_angle_delta_degrees(total_degrees, head)
    } else {
        total_degrees - head
    };
    [eye_delta.clamp(-eye_max, eye_max), head]
}

fn solution_from_world_target(
    viewer_target: [f32; 3],
    camera: [f32; 3],
    origin: [f32; 3],
    model_quaternion: &[f32],
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let inverse_model = inverse_unit_quat(model_quaternion);
    let [total_yaw, total_pitch] = direction_angles_degrees(origin, viewer_target, inverse_model);
    let [camera_yaw, camera_pitch] = direction_angles_degrees(origin, camera, inverse_model);
    let [eye_yaw, head_yaw] = if lock_head_to_camera {
        allocate_axis_camera_locked(
            total_yaw,
            camera_yaw,
            limits.head_yaw,
            limits.eye_yaw,
            eyes_enabled,
            head_enabled,
            true,
        )
    } else {
        allocate_axis(
            total_yaw,
            camera_yaw,
            limits.head_yaw,
            limits.eye_yaw,
            eyes_enabled,
            head_enabled,
            head_follow_fraction,
            true,
        )
    };
    let [eye_pitch, head_pitch] = if lock_head_to_camera {
        allocate_axis_camera_locked(
            total_pitch,
            camera_pitch,
            limits.head_pitch,
            limits.eye_pitch,
            eyes_enabled,
            head_enabled,
            false,
        )
    } else {
        allocate_axis(
            total_pitch,
            camera_pitch,
            limits.head_pitch,
            limits.eye_pitch,
            eyes_enabled,
            head_enabled,
            head_follow_fraction,
            false,
        )
    };

    let active_yaw_capacity = (if head_enabled { limits.head_yaw } else { 0.0 })
        + (if eyes_enabled { limits.eye_yaw } else { 0.0 });
    let active_pitch_capacity = (if head_enabled { limits.head_pitch } else { 0.0 })
        + (if eyes_enabled { limits.eye_pitch } else { 0.0 });
    let distance = distance3(origin, camera).max(EPSILON);

    // FACS left/right is subject-relative. With Embody's canonical +Z front,
    // model-local +X is the character's left, so horizontal outputs invert the
    // geometric yaw sign. Positive pitch remains up.
    [
        -clamp_signed_ratio(total_yaw, active_yaw_capacity),
        clamp_signed_ratio(total_pitch, active_pitch_capacity),
        -clamp_signed_ratio(eye_yaw, limits.eye_yaw),
        clamp_signed_ratio(eye_pitch, limits.eye_pitch),
        -clamp_signed_ratio(head_yaw, limits.head_yaw),
        clamp_signed_ratio(head_pitch, limits.head_pitch),
        -total_yaw,
        total_pitch,
        -camera_yaw,
        camera_pitch,
        distance,
        viewer_target[0],
        viewer_target[1],
        viewer_target[2],
    ]
}

#[allow(clippy::too_many_arguments)]
fn solve(
    screen_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    vertical_fov_degrees: f32,
    aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let camera = read_vec3(camera_position, 0);
    let origin = read_vec3(gaze_origin, 0);
    let distance = distance3(origin, camera).max(EPSILON);
    let fov = finite_positive(vertical_fov_degrees, DEFAULT_VERTICAL_FOV_DEGREES)
        .clamp(1.0, 179.0)
        .to_radians();
    let aspect = finite_positive(aspect, DEFAULT_ASPECT);
    let half_height = distance * (fov / 2.0).tan();
    let half_width = half_height * aspect;
    let screen_x = screen_target
        .first()
        .copied()
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0);
    let screen_y = screen_target
        .get(1)
        .copied()
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0);

    let camera_quat = quat_or_identity(camera_quaternion);
    let camera_right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
    let camera_up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
    let viewer_target = add3(
        add3(camera, scale3(camera_right, screen_x * half_width)),
        scale3(camera_up, screen_y * half_height),
    );

    solution_from_world_target(
        viewer_target,
        camera,
        origin,
        model_quaternion,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        false,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
fn solve_viewer(
    viewer_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    viewer_vertical_fov_degrees: f32,
    viewer_aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let camera = read_vec3(camera_position, 0);
    let origin = read_vec3(gaze_origin, 0);
    let fov = finite_positive(
        viewer_vertical_fov_degrees,
        DEFAULT_VIEWER_VERTICAL_FOV_DEGREES,
    )
    .clamp(1.0, 179.0)
    .to_radians();
    let aspect = finite_positive(viewer_aspect, DEFAULT_VIEWER_ASPECT);
    let viewer_depth = viewer_target
        .get(2)
        .copied()
        .unwrap_or(DEFAULT_VIEWER_DEPTH)
        .clamp(0.2, 10.0);
    let half_height = viewer_depth * (fov / 2.0).tan();
    let half_width = half_height * aspect;
    let viewer_x = viewer_target
        .first()
        .copied()
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0);
    let viewer_y = viewer_target
        .get(1)
        .copied()
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0);

    let camera_quat = quat_or_identity(camera_quaternion);
    let camera_right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
    let camera_up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
    // Three.js cameras look down local -Z. A real viewer is behind the rendered
    // camera/lens, on local +Z, so webcam image offsets must be placed on that
    // side of the camera instead of on the rendered image plane.
    let camera_back = rotate_by_quat(camera_quat, [0.0, 0.0, 1.0]);
    let world_viewer_target = add3(
        add3(
            add3(camera, scale3(camera_right, viewer_x * half_width)),
            scale3(camera_up, viewer_y * half_height),
        ),
        scale3(camera_back, viewer_depth),
    );

    solution_from_world_target(
        world_viewer_target,
        camera,
        origin,
        model_quaternion,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        lock_head_to_camera,
        limits,
    )
}

/// Solve a screen-space eye target against rendered-camera and character-eye
/// geometry using the profile's authored AU rotation limits.
///
/// Output layout (14 floats): combined target x/y, eye target x/y, head target
/// x/y, total yaw/pitch degrees, camera-center yaw/pitch degrees, eye-to-camera
/// distance, and viewer-target world x/y/z.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_screen_space_gaze(
    profile_json: &str,
    screen_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    vertical_fov_degrees: f32,
    aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve(
        screen_target,
        camera_position,
        camera_quaternion,
        gaze_origin,
        model_quaternion,
        vertical_fov_degrees,
        aspect,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        gaze_limits(&profile),
    )
    .to_vec()
    .into_boxed_slice())
}

/// Solve a webcam/user target against the rendered camera. `viewer_target` is
/// x/y in webcam NDC and z as estimated viewer distance behind the rendered
/// camera in meters. Unlike screen-space solve, the target is placed behind the
/// rendered camera/lens so oblique character-camera angles still converge on
/// the user's eye position.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_viewer_space_gaze(
    profile_json: &str,
    viewer_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    viewer_vertical_fov_degrees: f32,
    viewer_aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve_viewer(
        viewer_target,
        camera_position,
        camera_quaternion,
        gaze_origin,
        model_quaternion,
        viewer_vertical_fov_degrees,
        viewer_aspect,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        lock_head_to_camera,
        gaze_limits(&profile),
    )
    .to_vec()
    .into_boxed_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc4_profile() -> &'static ProfileData {
        crate::presets::load_profile("cc4").expect("cc4 preset")
    }

    fn solve_cc4(
        screen: &[f32],
        camera: &[f32],
        camera_quat: &[f32],
        origin: &[f32],
        model_quat: &[f32],
    ) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
        solve(
            screen,
            camera,
            camera_quat,
            origin,
            model_quat,
            90.0,
            1.0,
            true,
            true,
            0.35,
            gaze_limits(cc4_profile()),
        )
    }

    fn solve_viewer_cc4(
        viewer: &[f32],
        camera: &[f32],
        camera_quat: &[f32],
        origin: &[f32],
        model_quat: &[f32],
        lock_head_to_camera: bool,
    ) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
        solve_viewer(
            viewer,
            camera,
            camera_quat,
            origin,
            model_quat,
            90.0,
            1.0,
            true,
            true,
            0.35,
            lock_head_to_camera,
            gaze_limits(cc4_profile()),
        )
    }

    #[test]
    fn centered_front_camera_is_neutral_and_reports_eye_distance() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!(result[0].abs() < 1.0e-6);
        assert!(result[2].abs() < 1.0e-6);
        assert!(result[4].abs() < 1.0e-6);
        assert!((result[10] - 3.0).abs() < 1.0e-6);
        assert!((result[11] - 0.0).abs() < 1.0e-6);
        assert!((result[12] - 1.6).abs() < 1.0e-6);
        assert!((result[13] - 3.0).abs() < 1.0e-6);
    }

    #[test]
    fn camera_center_turns_the_head_to_face_the_camera() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[3.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!((result[8] + 45.0).abs() < 1.0e-4);
        assert!((result[4] + 0.75).abs() < 1.0e-4);
        assert!(result[2].abs() < 1.0e-4);
    }

    #[test]
    fn screen_motion_uses_projection_and_splits_eye_lead_from_head_follow() {
        let result = solve_cc4(
            &[0.5, 0.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        // A 90-degree vertical FOV at aspect 1 makes x=0.5 a 26.565-degree
        // target. Eyes lead 65% while the head follows 35%.
        assert!((result[6] + 26.56505).abs() < 1.0e-3);
        assert!((result[2] + 0.69069).abs() < 1.0e-3);
        assert!((result[4] + 0.15496).abs() < 1.0e-3);
    }

    #[test]
    fn eye_overflow_reaches_full_range_after_head_saturates() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[1000.0, 1.6, 87.4887],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!((result[4] + 1.0).abs() < 1.0e-3);
        assert!((result[2] + 1.0).abs() < 1.0e-3);
        assert!((result[0] + 1.0).abs() < 1.0e-3);
    }

    #[test]
    fn viewer_space_places_the_user_behind_the_rendered_camera() {
        let result = solve_viewer_cc4(
            &[0.5, 0.0, 1.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            true,
        );

        // x=0.5 at a 1m viewer distance and 90-degree webcam FOV is 0.5m to
        // camera-right, one meter behind the rendered camera: (0.5, 1.6, 4).
        // The head stays camera-facing while the eyes take the off-center
        // viewer delta.
        assert!((result[6] + 7.125016).abs() < 1.0e-3);
        assert!((result[2] + 0.285).abs() < 1.0e-3);
        assert!(result[4].abs() < 1.0e-4);
        assert!((result[11] - 0.5).abs() < 1.0e-4);
        assert!((result[12] - 1.6).abs() < 1.0e-4);
        assert!((result[13] - 4.0).abs() < 1.0e-4);
    }

    #[test]
    fn viewer_space_respects_oblique_rendered_camera_orientation() {
        let half_yaw = (std::f32::consts::FRAC_PI_4 / 2.0).sin();
        let half_w = (std::f32::consts::FRAC_PI_4 / 2.0).cos();
        let result = solve_viewer_cc4(
            &[0.0, 0.0, 1.0],
            &[3.0, 1.6, 3.0],
            &[0.0, half_yaw, 0.0, half_w],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            true,
        );
        let expected = 3.0 + std::f32::consts::FRAC_1_SQRT_2;

        // The user is behind the camera lens along the rendered camera's
        // local +Z/back vector, so an off-front virtual camera still produces
        // the same camera-facing head baseline.
        assert!((result[8] + 45.0).abs() < 1.0e-3);
        assert!((result[4] + 0.75).abs() < 1.0e-3);
        assert!(result[2].abs() < 1.0e-4);
        assert!((result[11] - expected).abs() < 1.0e-3);
        assert!((result[13] - expected).abs() < 1.0e-3);
    }

    #[test]
    fn camera_locked_viewer_space_does_not_hand_eye_overflow_to_the_head() {
        let result = solve_viewer(
            &[1.0, 0.0, 1.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            150.0,
            1.0,
            true,
            true,
            0.35,
            true,
            gaze_limits(cc4_profile()),
        );

        assert!((result[2] + 1.0).abs() < 1.0e-4);
        assert!(result[4].abs() < 1.0e-4);
    }

    #[test]
    fn model_orientation_changes_the_local_trajectory() {
        let half = (std::f32::consts::FRAC_PI_2 / 2.0).sin();
        let half_w = (std::f32::consts::FRAC_PI_2 / 2.0).cos();
        let result = solve_cc4(
            &[0.0, 0.0],
            &[3.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, half, 0.0, half_w],
        );
        assert!(result[8].abs() < 1.0e-4);
    }
}
