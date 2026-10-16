use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraRelativeAngles {
    yaw_degrees: f64,
    pitch_degrees: f64,
}

fn camera_relative_angles(
    character_position: &[f32],
    character_quaternion: &[f32],
    camera_position: &[f32],
) -> Result<CameraRelativeAngles, &'static str> {
    if character_position.len() != 3 || camera_position.len() != 3 || character_quaternion.len() != 4 {
        return Err("Expected two XYZ positions and one XYZW quaternion");
    }
    if !character_position.iter().chain(character_quaternion).chain(camera_position).all(|value| value.is_finite()) {
        return Err("Positions and quaternion must contain only finite values");
    }
    let mut quaternion = [0.0; 4];
    for index in 0..4 { quaternion[index] = character_quaternion[index] as f64; }
    let length = quaternion.iter().map(|value| value * value).sum::<f64>().sqrt();
    if length == 0.0 { return Err("Character quaternion must be nonzero"); }
    quaternion = quaternion.map(|value| value / length);
    let offset = [0, 1, 2].map(|index| camera_position[index] as f64 - character_position[index] as f64);
    if offset.iter().all(|value| *value == 0.0) { return Err("Camera and character positions must differ"); }
    let [x, y, z, w] = quaternion;
    let inverse_axis = [-x, -y, -z];
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let first = cross(inverse_axis, offset);
    let second = cross(inverse_axis, first);
    let local = [0, 1, 2].map(|index| offset[index] + 2.0 * (w * first[index] + second[index]));
    Ok(CameraRelativeAngles {
        yaw_degrees: local[0].atan2(local[2]).to_degrees(),
        pitch_degrees: local[1].atan2(local[0].hypot(local[2])).to_degrees(),
    })
}

/// Camera bearing from character-local +Z front/+Y up. Positions share a world
/// frame; the character quaternion is XYZW. Invalid or coincident inputs reject.
#[wasm_bindgen]
pub fn measure_camera_relative_angles_json(
    character_position: &[f32],
    character_quaternion: &[f32],
    camera_position: &[f32],
) -> Result<String, JsError> {
    let angles = camera_relative_angles(character_position, character_quaternion, camera_position)
        .map_err(|error| JsError::new(error))?;
    serde_json::to_string(&angles).map_err(|error| JsError::new(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: f64, expected: f64) { assert!((actual - expected).abs() < 1e-5, "{actual} != {expected}"); }

    #[test]
    fn reports_signed_yaw_and_pitch_from_world_offset() {
        for (camera, yaw, pitch) in [
            ([1.0, 2.0, 4.0], 0.0, 0.0),
            ([2.0, 2.0, 3.0], 90.0, 0.0),
            ([0.0, 2.0, 3.0], -90.0, 0.0),
            ([1.0, 3.0, 3.0], 0.0, 90.0),
            ([1.0, 1.0, 3.0], 0.0, -90.0),
            ([2.0, 3.0, 4.0], 45.0, (1.0_f64 / 2.0_f64.sqrt()).atan().to_degrees()),
            ([2.0, 2.0, 2.0], 135.0, 0.0),
        ] {
            let angles = camera_relative_angles(&[1.0, 2.0, 3.0], &[0.0, 0.0, 0.0, 1.0], &camera).unwrap();
            near(angles.yaw_degrees, yaw);
            near(angles.pitch_degrees, pitch);
        }
    }

    #[test]
    fn uses_inverse_character_rotation_and_normalizes_nonunit_quaternions() {
        let half = std::f32::consts::FRAC_PI_4;
        let rotation = [0.0, 3.0 * half.sin(), 0.0, 3.0 * half.cos()];
        let ahead = camera_relative_angles(&[5.0, 1.0, -3.0], &rotation, &[7.0, 1.0, -3.0]).unwrap();
        near(ahead.yaw_degrees, 0.0);
        near(ahead.pitch_degrees, 0.0);
        let left = camera_relative_angles(&[5.0, 1.0, -3.0], &rotation, &[5.0, 1.0, -1.0]).unwrap();
        near(left.yaw_degrees, -90.0);
        let rolled = camera_relative_angles(&[0.0; 3], &[0.0, 0.0, half.sin(), half.cos()], &[1.0, 0.0, 1.0]).unwrap();
        near(rolled.yaw_degrees, 0.0);
        near(rolled.pitch_degrees, -45.0);
    }

    #[test]
    fn rejects_undefined_geometry_instead_of_reporting_zero() {
        let origin = [0.0; 3];
        let identity = [0.0, 0.0, 0.0, 1.0];
        let ahead = [0.0, 0.0, 1.0];
        assert!(camera_relative_angles(&origin, &identity, &origin).is_err());
        assert!(camera_relative_angles(&origin, &[0.0; 4], &ahead).is_err());
        assert!(camera_relative_angles(&[], &identity, &ahead).is_err());
        assert!(camera_relative_angles(&origin, &identity[..3], &ahead).is_err());
        assert!(camera_relative_angles(&origin, &identity, &ahead[..2]).is_err());
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(camera_relative_angles(&[invalid, 0.0, 0.0], &identity, &ahead).is_err());
            assert!(camera_relative_angles(&origin, &[0.0, invalid, 0.0, 1.0], &ahead).is_err());
            assert!(camera_relative_angles(&origin, &identity, &[0.0, 0.0, invalid]).is_err());
        }
    }

    #[test]
    fn finite_f32_extremes_do_not_overflow_intermediate_geometry() {
        let angles = camera_relative_angles(&[-f32::MAX, 0.0, 0.0],
            &[0.0, 0.0, 0.0, f32::MAX], &[f32::MAX, 0.0, f32::MAX]).unwrap();
        near(angles.yaw_degrees, 2.0_f64.atan().to_degrees());
        near(angles.pitch_degrees, 0.0);
    }
}
