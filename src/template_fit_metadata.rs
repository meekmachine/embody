use wasm_bindgen::prelude::*;

const METADATA_FLOAT_LEN: usize = 15;
const SCHEMA_VERSION_INDEX: usize = 0;
const METADATA_KIND_INDEX: usize = 1;
const TEMPLATE_LOOKUP_STATUS_INDEX: usize = 2;
const FIT_STATUS_INDEX: usize = 3;
const VERTICAL_AXIS_INDEX: usize = 4;
const VERTICAL_ANCHOR_INDEX: usize = 5;
const FIT_SCALE_INDEX: usize = 6;
const TRANSLATE_X_INDEX: usize = 7;
const TRANSLATE_Y_INDEX: usize = 8;
const TRANSLATE_Z_INDEX: usize = 9;
const SOLVER_CONFIDENCE_INDEX: usize = 10;
const MANUAL_SCALE_MULTIPLIER_INDEX: usize = 11;
const MANUAL_OFFSET_X_INDEX: usize = 12;
const MANUAL_OFFSET_Y_INDEX: usize = 13;
const MANUAL_OFFSET_Z_INDEX: usize = 14;

const SCHEMA_VERSION: i32 = 1;
const GENERATED_TEMPLATE_FIT_KIND: i32 = 1;
const TEMPLATE_LOOKUP_KNOWN: i32 = 1;
const TEMPLATE_LOOKUP_UNKNOWN: i32 = 2;
const FIT_STATUS_SOLVED: i32 = 1;
const FIT_STATUS_MANUALLY_ADJUSTED: i32 = 2;
const EPSILON: f32 = 1e-5;
const MAX_ID_LEN: usize = 128;

const VALIDATION_OK: u32 = 0;
const ERR_MISSING_FIELDS: u32 = 1 << 0;
const ERR_UNSUPPORTED_VERSION: u32 = 1 << 1;
const ERR_NOT_GENERATED_TEMPLATE_FIT: u32 = 1 << 2;
const ERR_INVALID_TEMPLATE_LOOKUP_STATUS: u32 = 1 << 3;
const ERR_UNKNOWN_TEMPLATE: u32 = 1 << 4;
const ERR_INVALID_FIT_STATUS: u32 = 1 << 5;
const ERR_INVALID_VERTICAL_AXIS: u32 = 1 << 6;
const ERR_INVALID_VERTICAL_ANCHOR: u32 = 1 << 7;
const ERR_INVALID_SCALE: u32 = 1 << 8;
const ERR_INVALID_TRANSLATION: u32 = 1 << 9;
const ERR_INVALID_CONFIDENCE: u32 = 1 << 10;
const ERR_INVALID_MANUAL_ADJUSTMENT: u32 = 1 << 11;
const ERR_INVALID_TEMPLATE_ID: u32 = 1 << 12;
const ERR_INVALID_SOURCE_CHARACTER_ID: u32 = 1 << 13;

#[derive(Clone, Debug, PartialEq)]
pub struct GeneratedTemplateSkeletonFitMetadata {
    pub schema_version: u8,
    pub template_id: String,
    pub source_character_id: String,
    pub template_lookup_status: u8,
    pub fit_status: u8,
    pub vertical_axis: u8,
    pub vertical_anchor: u8,
    pub fit_scale: f32,
    pub fit_translation: [f32; 3],
    pub solver_confidence: f32,
    pub manual_scale_multiplier: f32,
    pub manual_translation_offset: [f32; 3],
}

/// Validate generated template skeleton fit metadata from a compact Wasm ABI.
///
/// String inputs carry host-owned ids. The packed f32 slice layout is:
/// [schema_version, metadata_kind, template_lookup_status, fit_status,
///  vertical_axis, vertical_anchor, fit_scale, translate_x, translate_y,
///  translate_z, solver_confidence, manual_scale_multiplier, manual_offset_x,
///  manual_offset_y, manual_offset_z].
///
/// `metadata_kind` must be 1, which identifies generated template fit metadata
/// and keeps it separate from imported rig, skinning, or bind-pose data.
///
/// The return value is a compact bitmask. 0 means valid.
#[wasm_bindgen]
pub fn validate_generated_template_fit_metadata(
    template_id: &str,
    source_character_id: &str,
    metadata: &[f32],
) -> u32 {
    match GeneratedTemplateSkeletonFitMetadata::from_wasm_inputs(
        template_id,
        source_character_id,
        metadata,
    ) {
        Ok(_) => VALIDATION_OK,
        Err(result) => result,
    }
}

impl GeneratedTemplateSkeletonFitMetadata {
    pub fn from_wasm_inputs(
        template_id: &str,
        source_character_id: &str,
        metadata: &[f32],
    ) -> Result<Self, u32> {
        let mut result = VALIDATION_OK;

        if !is_valid_id(template_id) {
            result |= ERR_INVALID_TEMPLATE_ID;
        }
        if !is_valid_id(source_character_id) {
            result |= ERR_INVALID_SOURCE_CHARACTER_ID;
        }
        if metadata.len() < METADATA_FLOAT_LEN {
            result |= ERR_MISSING_FIELDS;
        }

        let schema_version = code_at(metadata, SCHEMA_VERSION_INDEX);
        if schema_version != Some(SCHEMA_VERSION) {
            result |= ERR_UNSUPPORTED_VERSION;
        }

        let metadata_kind = code_at(metadata, METADATA_KIND_INDEX);
        if metadata_kind != Some(GENERATED_TEMPLATE_FIT_KIND) {
            result |= ERR_NOT_GENERATED_TEMPLATE_FIT;
        }

        let template_lookup_status = code_at(metadata, TEMPLATE_LOOKUP_STATUS_INDEX);
        match template_lookup_status {
            Some(TEMPLATE_LOOKUP_KNOWN) => {}
            Some(TEMPLATE_LOOKUP_UNKNOWN) => result |= ERR_UNKNOWN_TEMPLATE,
            _ => result |= ERR_INVALID_TEMPLATE_LOOKUP_STATUS,
        }

        let fit_status = code_at(metadata, FIT_STATUS_INDEX);
        if !matches!(
            fit_status,
            Some(FIT_STATUS_SOLVED | FIT_STATUS_MANUALLY_ADJUSTED)
        ) {
            result |= ERR_INVALID_FIT_STATUS;
        }

        let vertical_axis = code_at(metadata, VERTICAL_AXIS_INDEX);
        if !matches!(vertical_axis, Some(0..=2)) {
            result |= ERR_INVALID_VERTICAL_AXIS;
        }

        let vertical_anchor = code_at(metadata, VERTICAL_ANCHOR_INDEX);
        if !matches!(vertical_anchor, Some(0..=2)) {
            result |= ERR_INVALID_VERTICAL_ANCHOR;
        }

        let fit_scale = metadata.get(FIT_SCALE_INDEX).copied().unwrap_or(f32::NAN);
        if !fit_scale.is_finite() || fit_scale <= EPSILON {
            result |= ERR_INVALID_SCALE;
        }

        let fit_translation = [
            metadata.get(TRANSLATE_X_INDEX).copied().unwrap_or(f32::NAN),
            metadata.get(TRANSLATE_Y_INDEX).copied().unwrap_or(f32::NAN),
            metadata.get(TRANSLATE_Z_INDEX).copied().unwrap_or(f32::NAN),
        ];
        if fit_translation.iter().any(|value| !value.is_finite()) {
            result |= ERR_INVALID_TRANSLATION;
        }

        let solver_confidence = metadata
            .get(SOLVER_CONFIDENCE_INDEX)
            .copied()
            .unwrap_or(f32::NAN);
        if !solver_confidence.is_finite() || !(0.0..=1.0).contains(&solver_confidence) {
            result |= ERR_INVALID_CONFIDENCE;
        }

        let manual_scale_multiplier = metadata
            .get(MANUAL_SCALE_MULTIPLIER_INDEX)
            .copied()
            .unwrap_or(f32::NAN);
        let manual_translation_offset = [
            metadata
                .get(MANUAL_OFFSET_X_INDEX)
                .copied()
                .unwrap_or(f32::NAN),
            metadata
                .get(MANUAL_OFFSET_Y_INDEX)
                .copied()
                .unwrap_or(f32::NAN),
            metadata
                .get(MANUAL_OFFSET_Z_INDEX)
                .copied()
                .unwrap_or(f32::NAN),
        ];
        if !manual_scale_multiplier.is_finite()
            || manual_scale_multiplier <= EPSILON
            || manual_translation_offset
                .iter()
                .any(|value| !value.is_finite())
        {
            result |= ERR_INVALID_MANUAL_ADJUSTMENT;
        }

        if result != VALIDATION_OK {
            return Err(result);
        }

        Ok(Self {
            schema_version: schema_version.unwrap() as u8,
            template_id: template_id.to_owned(),
            source_character_id: source_character_id.to_owned(),
            template_lookup_status: template_lookup_status.unwrap() as u8,
            fit_status: fit_status.unwrap() as u8,
            vertical_axis: vertical_axis.unwrap() as u8,
            vertical_anchor: vertical_anchor.unwrap() as u8,
            fit_scale,
            fit_translation,
            solver_confidence,
            manual_scale_multiplier,
            manual_translation_offset,
        })
    }
}

fn code_at(metadata: &[f32], index: usize) -> Option<i32> {
    let value = *metadata.get(index)?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    if value < i32::MIN as f32 || value > i32::MAX as f32 {
        return None;
    }
    Some(value as i32)
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':' | b'@')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_metadata() -> Vec<f32> {
        vec![
            SCHEMA_VERSION as f32,
            GENERATED_TEMPLATE_FIT_KIND as f32,
            TEMPLATE_LOOKUP_KNOWN as f32,
            FIT_STATUS_SOLVED as f32,
            1.0,
            0.0,
            0.018,
            0.1,
            -0.2,
            0.3,
            0.82,
            1.0,
            0.0,
            0.05,
            -0.01,
        ]
    }

    #[test]
    fn accepts_valid_generated_template_fit_metadata() {
        let result = validate_generated_template_fit_metadata(
            "humanoid-template:v1",
            "character-123",
            &valid_metadata(),
        );

        assert_eq!(result, VALIDATION_OK);
    }

    #[test]
    fn parses_serializable_metadata_fields() {
        let metadata = GeneratedTemplateSkeletonFitMetadata::from_wasm_inputs(
            "humanoid-template:v1",
            "character-123",
            &valid_metadata(),
        )
        .expect("valid metadata should parse");

        assert_eq!(metadata.schema_version, 1);
        assert_eq!(metadata.template_id, "humanoid-template:v1");
        assert_eq!(metadata.source_character_id, "character-123");
        assert_eq!(metadata.fit_status, FIT_STATUS_SOLVED as u8);
        assert_eq!(metadata.vertical_axis, 1);
        assert_eq!(metadata.vertical_anchor, 0);
        assert_eq!(metadata.fit_translation, [0.1, -0.2, 0.3]);
        assert_eq!(metadata.manual_translation_offset, [0.0, 0.05, -0.01]);
    }

    #[test]
    fn rejects_real_skinning_or_rig_metadata_kind() {
        let mut metadata = valid_metadata();
        metadata[METADATA_KIND_INDEX] = 2.0;

        let result = validate_generated_template_fit_metadata(
            "humanoid-template:v1",
            "character-123",
            &metadata,
        );

        assert_has(result, ERR_NOT_GENERATED_TEMPLATE_FIT);
    }

    #[test]
    fn rejects_non_finite_fit_values() {
        let mut metadata = valid_metadata();
        metadata[FIT_SCALE_INDEX] = f32::INFINITY;
        metadata[TRANSLATE_Y_INDEX] = f32::NEG_INFINITY;
        metadata[SOLVER_CONFIDENCE_INDEX] = f32::NAN;
        metadata[MANUAL_OFFSET_Z_INDEX] = f32::NAN;

        let result = validate_generated_template_fit_metadata(
            "humanoid-template:v1",
            "character-123",
            &metadata,
        );

        assert_has(result, ERR_INVALID_SCALE);
        assert_has(result, ERR_INVALID_TRANSLATION);
        assert_has(result, ERR_INVALID_CONFIDENCE);
        assert_has(result, ERR_INVALID_MANUAL_ADJUSTMENT);
    }

    #[test]
    fn rejects_invalid_codes() {
        let mut metadata = valid_metadata();
        metadata[FIT_STATUS_INDEX] = 9.0;
        metadata[VERTICAL_AXIS_INDEX] = 3.0;
        metadata[VERTICAL_ANCHOR_INDEX] = -1.0;

        let result = validate_generated_template_fit_metadata(
            "humanoid-template:v1",
            "character-123",
            &metadata,
        );

        assert_has(result, ERR_INVALID_FIT_STATUS);
        assert_has(result, ERR_INVALID_VERTICAL_AXIS);
        assert_has(result, ERR_INVALID_VERTICAL_ANCHOR);
    }

    #[test]
    fn reports_unknown_template_and_unsupported_version() {
        let mut metadata = valid_metadata();
        metadata[SCHEMA_VERSION_INDEX] = 2.0;
        metadata[TEMPLATE_LOOKUP_STATUS_INDEX] = TEMPLATE_LOOKUP_UNKNOWN as f32;

        let result = validate_generated_template_fit_metadata(
            "humanoid-template:v2",
            "character-123",
            &metadata,
        );

        assert_has(result, ERR_UNSUPPORTED_VERSION);
        assert_has(result, ERR_UNKNOWN_TEMPLATE);
    }

    #[test]
    fn rejects_invalid_ids_and_missing_fields() {
        let result = validate_generated_template_fit_metadata(
            "bad template id",
            "",
            &valid_metadata()[0..4],
        );

        assert_has(result, ERR_INVALID_TEMPLATE_ID);
        assert_has(result, ERR_INVALID_SOURCE_CHARACTER_ID);
        assert_has(result, ERR_MISSING_FIELDS);
    }

    fn assert_has(result: u32, flag: u32) {
        assert_eq!(result & flag, flag, "expected {result} to include {flag}");
    }
}
