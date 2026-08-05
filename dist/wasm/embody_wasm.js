/* @ts-self-types="./embody_wasm.d.ts" */

/**
 * Spherical camera flight between two camera poses.
 *
 * Mirrors the DPthree camera transition: orbital interpolation with a
 * pullback arc so large rotations do not pass through the model.
 * `sample(elapsed_ms)` returns
 * `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
 */
export class CameraFlight {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CameraFlightFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_cameraflight_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    duration_ms() {
        const ret = wasm.cameraflight_duration_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {Float32Array} start_position
     * @param {Float32Array} start_target
     * @param {Float32Array} end_position
     * @param {Float32Array} end_target
     * @param {number} duration_ms
     */
    constructor(start_position, start_target, end_position, end_target, duration_ms) {
        const ptr0 = passArrayF32ToWasm0(start_position, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(start_target, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF32ToWasm0(end_position, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF32ToWasm0(end_target, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.cameraflight_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, duration_ms);
        this.__wbg_ptr = ret;
        CameraFlightFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} elapsed_ms
     * @returns {Float32Array}
     */
    sample(elapsed_ms) {
        const ret = wasm.cameraflight_sample(this.__wbg_ptr, elapsed_ms);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) CameraFlight.prototype[Symbol.dispose] = CameraFlight.prototype.free;

/**
 * Full 360-degree eased orbit around a center point.
 * `sample(elapsed_ms)` returns
 * `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
 */
export class CameraOrbit {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CameraOrbitFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_cameraorbit_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    duration_ms() {
        const ret = wasm.cameraorbit_duration_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {Float32Array} center
     * @param {number} radius
     * @param {number} height
     * @param {number} duration_ms
     */
    constructor(center, radius, height, duration_ms) {
        const ptr0 = passArrayF32ToWasm0(center, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.cameraorbit_new(ptr0, len0, radius, height, duration_ms);
        this.__wbg_ptr = ret;
        CameraOrbitFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} elapsed_ms
     * @returns {Float32Array}
     */
    sample(elapsed_ms) {
        const ret = wasm.cameraorbit_sample(this.__wbg_ptr, elapsed_ms);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) CameraOrbit.prototype[Symbol.dispose] = CameraOrbit.prototype.free;

export class HairPhysicsSolver {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HairPhysicsSolverFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_hairphysicssolver_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    get_config() {
        const ret = wasm.hairphysicssolver_get_config(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    get_state() {
        const ret = wasm.hairphysicssolver_get_state(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {Float32Array} config_values
     */
    constructor(config_values) {
        const ptr0 = passArrayF32ToWasm0(config_values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hairphysicssolver_new(ptr0, len0);
        this.__wbg_ptr = ret;
        HairPhysicsSolverFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    reset() {
        wasm.hairphysicssolver_reset(this.__wbg_ptr);
    }
    /**
     * @param {Float32Array} config_values
     */
    set_config(config_values) {
        const ptr0 = passArrayF32ToWasm0(config_values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.hairphysicssolver_set_config(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} dt
     * @param {Float32Array} head_values
     * @returns {Float32Array}
     */
    update(dt, head_values) {
        const ptr0 = passArrayF32ToWasm0(head_values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hairphysicssolver_update(this.__wbg_ptr, dt, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
}
if (Symbol.dispose) HairPhysicsSolver.prototype[Symbol.dispose] = HairPhysicsSolver.prototype.free;

/**
 * Host-neutral live morph runtime. Owns AU/viseme/mix state and emits packed
 * morph frame deltas. Engine objects never enter this struct.
 */
export class RuntimeCore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RuntimeCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_runtimecore_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    active_transition_count() {
        const ret = wasm.runtimecore_active_transition_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    static au_morph_binding_stride() {
        const ret = wasm.runtimecore_au_morph_binding_stride();
        return ret >>> 0;
    }
    /**
     * @param {string} clip_name
     * @param {string} curves_json
     * @param {string} options_json
     * @returns {string}
     */
    build_clip(clip_name, curves_json, options_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(curves_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_build_clip(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * @param {string} clip_name
     * @param {string} channels_json
     * @param {string} options_json
     * @returns {string}
     */
    build_typed_clip(clip_name, channels_json, options_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(channels_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_build_typed_clip(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * @param {string} clip_name
     * @returns {boolean}
     */
    cleanup_snippet(clip_name) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_cleanup_snippet(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    clear() {
        wasm.runtimecore_clear(this.__wbg_ptr);
    }
    clear_transitions() {
        wasm.runtimecore_clear_transitions(this.__wbg_ptr);
    }
    /**
     * Configure the core from the profile and model descriptor JSON hosts
     * already have. All binding compilation (mesh/morph/bone name resolution,
     * composite axes, translations, jaw, viseme slots, mix defaults,
     * continuum pairs) happens here, inside the core.
     * @param {string} profile_json
     * @param {string} model_json
     */
    configure(profile_json, model_json) {
        const ptr0 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_configure(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure from an embedded preset id + optional override JSON + model
     * descriptor JSON. The CC4 (etc.) preset data lives in the Wasm core;
     * hosts only pass the preset id and overrides.
     * @param {string} preset_id
     * @param {string} override_json
     * @param {string} model_json
     */
    configure_with_preset(preset_id, override_json, model_json) {
        const ptr0 = passStringToWasm0(preset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(override_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_configure_with_preset(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure from a resolved profile without applying an embedded preset.
     *
     * The profile must contain runtime mappings, but mappings that do not match
     * the current model are non-fatal. The character can still render and be
     * repaired in the authoring UI without silently substituting a preset.
     * @param {string} profile_json
     * @param {string} model_json
     */
    configure_with_profile(profile_json, model_json) {
        const ptr0 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_configure_with_profile(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Host-owned crossfade marker. Rust does not lerp; the host mixer should fade.
     * @param {string} clip_name
     * @param {number} _duration
     * @param {string} options_json
     * @returns {string}
     */
    crossfade_to(clip_name, _duration, options_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_crossfade_to(this.__wbg_ptr, ptr0, len0, _duration, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    drain_animation_events() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.runtimecore_drain_animation_events(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Same rows as `evaluate_bone_frame_delta`, but only bones an active AU,
     * translation, or viseme jaw value is currently rotating or moving.
     * Neutral bones are omitted (no rest reset), so hosts can re-apply this
     * after mixer playback without freezing clip-driven bones (Loom3 parity).
     * @returns {Float32Array}
     */
    evaluate_active_bone_frame() {
        const ret = wasm.runtimecore_evaluate_active_bone_frame(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Same rows as `evaluate_morph_frame_delta`, but only channels with a
     * non-zero live value. Hosts re-apply this after mixer playback so live
     * AU/viseme state wins over clip tracks (Loom3 parity) without resetting
     * channels the mixer owns.
     * @returns {Float32Array}
     */
    evaluate_active_morph_frame() {
        const ret = wasm.runtimecore_evaluate_active_morph_frame(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Packed bone FrameDelta rows: `[bone_id, px, py, pz, qx, qy, qz, qw, flags] * N`
     * flags: bit0 = has_position, bit1 = has_rotation. Composite rotations are
     * relative to rest, AU-driven translations are added to rest position, and
     * viseme jaw rotation is applied as an absolute packed frame write.
     * @returns {Float32Array}
     */
    evaluate_bone_frame_delta() {
        const ret = wasm.runtimecore_evaluate_bone_frame_delta(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Packed morph FrameDelta rows: `[mesh_id, morph_target_id, value, mode] * N`
     * Live AU/viseme/direct morph state only — clip playback is host-owned.
     * @returns {Float32Array}
     */
    evaluate_morph_frame_delta() {
        const ret = wasm.runtimecore_evaluate_morph_frame_delta(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Scene extras for live state. Clip-driven scale/visibility/object writes
     * are owned by the host mixer, so this returns an empty frame.
     * @returns {string}
     */
    evaluate_scene_frame() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.runtimecore_evaluate_scene_frame(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get_animation_clips() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.runtimecore_get_animation_clips(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} clip_name
     * @returns {string}
     */
    get_animation_state(clip_name) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_get_animation_state(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} id
     * @returns {number}
     */
    get_au(id) {
        const ret = wasm.runtimecore_get_au(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * @param {number} neg_au
     * @param {number} pos_au
     * @returns {number}
     */
    get_continuum(neg_au, pos_au) {
        const ret = wasm.runtimecore_get_continuum(this.__wbg_ptr, neg_au, pos_au);
        return ret;
    }
    /**
     * @returns {string}
     */
    get_playing_animations() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.runtimecore_get_playing_animations(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} clips_json
     */
    load_animation_clips(clips_json) {
        const ptr0 = passStringToWasm0(clips_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_load_animation_clips(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Packed rows: `[au_id, side, mesh_id, morph_target_id, weight] * N`
     * side: 0=left, 1=right, 2=center
     * @param {Float32Array} values
     */
    load_au_morph_bindings(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_au_morph_bindings(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Packed rows: `[bone_id, px, py, pz, qx, qy, qz, qw] * N`
     * @param {Float32Array} values
     */
    load_bone_rest_transforms(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_bone_rest_transforms(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Packed rows: `[au_id, bone_id, axis(0=x,1=y,2=z), scale, max_units] * N`
     * @param {Float32Array} values
     */
    load_bone_translations(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_bone_translations(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Variable-length blocks, one per composite axis:
     * header `[bone_id, axis, has_directional, value_rows, binding_rows, 0, 0, 0]`,
     * then value rows `[au_id, group, side] * value_rows`,
     * then binding rows `[au_id, group, side, channel, scale, max_degrees] * binding_rows`.
     * Axes must be packed grouped per bone in application order (yaw, pitch, roll).
     * @param {Float32Array} values
     */
    load_composite_axes(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_composite_axes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Packed row: `[bone_id, channel, scale, max_degrees]`; empty slice clears.
     * @param {Float32Array} values
     */
    load_jaw_binding(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_jaw_binding(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Float32Array} values
     */
    load_viseme_jaw_amounts(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_viseme_jaw_amounts(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Packed rows: `[viseme_index, mesh_id, morph_target_id, weight] * N`
     * @param {Float32Array} values
     */
    load_viseme_morph_bindings(values) {
        const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_load_viseme_morph_bindings(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} viseme_slot_count
     */
    constructor(viseme_slot_count) {
        const ret = wasm.runtimecore_new(viseme_slot_count);
        this.__wbg_ptr = ret;
        RuntimeCoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    pause_all_animations() {
        wasm.runtimecore_pause_all_animations(this.__wbg_ptr);
    }
    /**
     * @param {string} clip_name
     */
    pause_animation(clip_name) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_pause_animation(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Registry lookup only. Host animation libraries own play/lerp; this returns
     * a host-owned action id marker when the clip exists in the registry.
     * @param {string} clip_name
     * @param {string} _options_json
     * @returns {string}
     */
    play_animation(clip_name, _options_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(_options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_play_animation(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @param {string} clip_name
     * @param {string} curves_json
     * @param {string} options_json
     * @returns {string}
     */
    play_snippet(clip_name, curves_json, options_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(curves_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_play_snippet(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * @param {string} clip_name
     * @param {string} channels_json
     * @param {string} options_json
     * @returns {string}
     */
    play_typed_snippet(clip_name, channels_json, options_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(channels_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.runtimecore_play_typed_snippet(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * @param {string} clip_json
     * @param {string} source
     */
    register_animation_clip(clip_json, source) {
        const ptr0 = passStringToWasm0(clip_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_register_animation_clip(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} clip_name
     * @returns {boolean}
     */
    remove_animation_clip(clip_name) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_remove_animation_clip(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    resume_all_animations() {
        wasm.runtimecore_resume_all_animations(this.__wbg_ptr);
    }
    /**
     * @param {string} clip_name
     */
    resume_animation(clip_name) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_resume_animation(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} clip_name
     * @param {number} time
     */
    seek_animation(clip_name, time) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_seek_animation(this.__wbg_ptr, ptr0, len0, time);
    }
    /**
     * @param {string} clip_name
     * @param {string} blend_mode
     */
    set_animation_blend_mode(clip_name, blend_mode) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(blend_mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_set_animation_blend_mode(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} clip_name
     * @param {number} intensity
     */
    set_animation_intensity(clip_name, intensity) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_set_animation_intensity(this.__wbg_ptr, ptr0, len0, intensity);
    }
    /**
     * @param {string} clip_name
     * @param {string} loop_mode
     */
    set_animation_loop_mode(clip_name, loop_mode) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(loop_mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_set_animation_loop_mode(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} clip_name
     * @param {number} repeat_count
     */
    set_animation_repeat_count(clip_name, repeat_count) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_set_animation_repeat_count(this.__wbg_ptr, ptr0, len0, repeat_count);
    }
    /**
     * @param {string} clip_name
     * @param {boolean} reverse
     */
    set_animation_reverse(clip_name, reverse) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_set_animation_reverse(this.__wbg_ptr, ptr0, len0, reverse);
    }
    /**
     * @param {string} clip_name
     * @param {number} speed
     */
    set_animation_speed(clip_name, speed) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_set_animation_speed(this.__wbg_ptr, ptr0, len0, speed);
    }
    /**
     * @param {number} time_scale
     */
    set_animation_time_scale(time_scale) {
        wasm.runtimecore_set_animation_time_scale(this.__wbg_ptr, time_scale);
    }
    /**
     * @param {number} id
     * @param {number} value
     * @param {number} balance
     */
    set_au(id, value, balance) {
        wasm.runtimecore_set_au(this.__wbg_ptr, id, value, balance);
    }
    /**
     * @param {number} id
     * @param {number} weight
     */
    set_au_mix_weight(id, weight) {
        wasm.runtimecore_set_au_mix_weight(this.__wbg_ptr, id, weight);
    }
    /**
     * Continuum-aware AU set. Negative values route through the configured
     * continuum pair (e.g. eyes left/right) exactly like the legacy runtime.
     * @param {number} id
     * @param {number} value
     * @param {number} balance
     */
    set_au_signed(id, value, balance) {
        wasm.runtimecore_set_au_signed(this.__wbg_ptr, id, value, balance);
    }
    /**
     * @param {number} neg_au
     * @param {number} pos_au
     * @param {number} value
     * @param {number} balance
     */
    set_continuum(neg_au, pos_au, value, balance) {
        wasm.runtimecore_set_continuum(this.__wbg_ptr, neg_au, pos_au, value, balance);
    }
    /**
     * @param {Uint32Array} ids
     */
    set_mixed_aus(ids) {
        const ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_set_mixed_aus(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} morph_name
     * @param {number} value
     * @param {string} mesh_names_json
     * @returns {number}
     */
    set_morph(morph_name, value, mesh_names_json) {
        const ptr0 = passStringToWasm0(morph_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mesh_names_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_set_morph(this.__wbg_ptr, ptr0, len0, value, ptr1, len1);
        return ret >>> 0;
    }
    /**
     * @param {number} morph_index
     * @param {number} value
     * @param {string} mesh_names_json
     * @returns {number}
     */
    set_morph_index(morph_index, value, mesh_names_json) {
        const ptr0 = passStringToWasm0(mesh_names_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_set_morph_index(this.__wbg_ptr, morph_index, value, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * @param {number} index
     * @param {number} value
     */
    set_viseme(index, value) {
        wasm.runtimecore_set_viseme(this.__wbg_ptr, index, value);
    }
    /**
     * @param {number} index
     * @param {number} jaw_scale
     */
    set_viseme_jaw_scale(index, jaw_scale) {
        wasm.runtimecore_set_viseme_jaw_scale(this.__wbg_ptr, index, jaw_scale);
    }
    /**
     * @param {number} count
     */
    set_viseme_slot_count(count) {
        wasm.runtimecore_set_viseme_slot_count(this.__wbg_ptr, count);
    }
    stop_all_animations() {
        wasm.runtimecore_stop_all_animations(this.__wbg_ptr);
    }
    /**
     * @param {string} clip_name
     */
    stop_animation(clip_name) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.runtimecore_stop_animation(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set an AU immediately. Duration is ignored — host mixers own timed fades.
     * @param {number} id
     * @param {number} to
     * @param {number} _duration_ms
     * @param {number} balance
     */
    transition_au(id, to, _duration_ms, balance) {
        wasm.runtimecore_transition_au(this.__wbg_ptr, id, to, _duration_ms, balance);
    }
    /**
     * Set morph(s) immediately. Duration is ignored — host mixers own timed fades.
     * @param {string} morph_name
     * @param {number} to
     * @param {number} _duration_ms
     * @param {string} mesh_names_json
     * @returns {number}
     */
    transition_morph(morph_name, to, _duration_ms, mesh_names_json) {
        const ptr0 = passStringToWasm0(morph_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mesh_names_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_transition_morph(this.__wbg_ptr, ptr0, len0, to, _duration_ms, ptr1, len1);
        return ret >>> 0;
    }
    /**
     * Set morph index target(s) immediately. Duration is ignored.
     * @param {number} morph_index
     * @param {number} to
     * @param {number} _duration_ms
     * @param {string} mesh_names_json
     * @returns {number}
     */
    transition_morph_index(morph_index, to, _duration_ms, mesh_names_json) {
        const ptr0 = passStringToWasm0(mesh_names_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_transition_morph_index(this.__wbg_ptr, morph_index, to, _duration_ms, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Set a viseme immediately. Duration is ignored — host mixers own timed fades.
     * @param {number} index
     * @param {number} to
     * @param {number} _duration_ms
     * @param {number} jaw_scale
     */
    transition_viseme(index, to, _duration_ms, jaw_scale) {
        wasm.runtimecore_transition_viseme(this.__wbg_ptr, index, to, _duration_ms, jaw_scale);
    }
    /**
     * Tick hook for hosts. Clip playback/lerp lives in the host animation
     * library; Rust only exposes live AU/viseme state for packed frames.
     * @param {number} _dt_seconds
     * @returns {number}
     */
    update(_dt_seconds) {
        const ret = wasm.runtimecore_update(this.__wbg_ptr, _dt_seconds);
        return ret >>> 0;
    }
    /**
     * @param {string} clip_name
     * @param {string} params_json
     * @returns {boolean}
     */
    update_clip_params(clip_name, params_json) {
        const ptr0 = passStringToWasm0(clip_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_update_clip_params(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {number}
     */
    static viseme_morph_binding_stride() {
        const ret = wasm.runtimecore_viseme_morph_binding_stride();
        return ret >>> 0;
    }
    /**
     * @param {string} slot_id
     * @returns {number}
     */
    viseme_slot_index(slot_id) {
        const ptr0 = passStringToWasm0(slot_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.runtimecore_viseme_slot_index(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) RuntimeCore.prototype[Symbol.dispose] = RuntimeCore.prototype.free;

/**
 * Analyze xyz vertex positions for a rough humanoid proportion signal.
 *
 * Input is a packed xyz buffer. `vertical_axis` is 0 for x, 1 for y, and 2 for z.
 * Invalid or incomplete vertices are ignored.
 *
 * Output layout:
 * [min_x, min_y, min_z, max_x, max_y, max_z,
 *  center_x, center_y, center_z,
 *  span_x, span_y, span_z,
 *  vertical_height, cross_axis_wide_span, cross_axis_narrow_span,
 *  humanoid_likelihood]
 * @param {Float32Array} vertices
 * @param {number} vertical_axis
 * @returns {Float32Array}
 */
export function analyze_mesh_proportions(vertices, vertical_axis) {
    const ptr0 = passArrayF32ToWasm0(vertices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.analyze_mesh_proportions(ptr0, len0, vertical_axis);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {string} model_json
 * @param {string} clips_json
 * @param {string} profile_json
 * @param {string} options_json
 * @returns {string}
 */
export function analyze_model_descriptor(model_json, clips_json, profile_json, options_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(clips_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.analyze_model_descriptor(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * @returns {number}
 */
export function annotation_camera_framing_stride() {
    const ret = wasm.annotation_camera_framing_stride();
    return ret >>> 0;
}

/**
 * Build head-pitch gravity hair morph curves.
 * @param {string} config_json
 * @returns {string}
 */
export function build_hair_gravity_curves(config_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.build_hair_gravity_curves(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Build idle/wind hair morph curves (JSON map of morphKey -> [{time,intensity}]).
 * @param {string} config_json
 * @param {number} duration_sec
 * @returns {string}
 */
export function build_hair_idle_curves(config_json, duration_sec) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.build_hair_idle_curves(ptr0, len0, duration_sec);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Build a directional hair impulse curve set.
 * @param {string} config_json
 * @param {number} duration_sec
 * @param {number} horizontal
 * @param {number} vertical
 * @returns {string}
 */
export function build_hair_impulse_curves(config_json, duration_sec, horizontal, vertical) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.build_hair_impulse_curves(ptr0, len0, duration_sec, horizontal, vertical);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {number}
 */
export function camera_flight_sample_stride() {
    const ret = wasm.camera_flight_sample_stride();
    return ret >>> 0;
}

/**
 * Compile a clip track input (JSON) into host-neutral ClipIR JSON.
 * @param {string} input_json
 * @returns {string}
 */
export function compile_clip(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compile_clip(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compile named intensity curves (JSON) into host-neutral ClipIR JSON.
 * @param {string} input_json
 * @returns {string}
 */
export function compile_clip_curves(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compile_clip_curves(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compose user-facing manual adjustments onto a solved skeleton fit.
 *
 * `fit` must start with [scale, translate_x, translate_y, translate_z]. The
 * output preserves those four fields after multiplying scale and adding offsets.
 * @param {Float32Array} fit
 * @param {number} scale_multiplier
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {number} offset_z
 * @returns {Float32Array}
 */
export function compose_template_fit_adjustment(fit, scale_multiplier, offset_x, offset_y, offset_z) {
    const ptr0 = passArrayF32ToWasm0(fit, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compose_template_fit_adjustment(ptr0, len0, scale_multiplier, offset_x, offset_y, offset_z);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {number} fit_scale
 * @param {Float32Array} fit_translation
 * @param {number} manual_scale
 * @param {Float32Array} manual_translation
 * @returns {Float32Array}
 */
export function compose_template_skeleton_fit_transform(fit_scale, fit_translation, manual_scale, manual_translation) {
    const ptr0 = passArrayF32ToWasm0(fit_translation, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(manual_translation, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.compose_template_skeleton_fit_transform(fit_scale, ptr0, len0, manual_scale, ptr1, len1);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * @param {string} template_json
 * @returns {Float64Array}
 */
export function compute_humanoid_skeleton_template_rest_bounds(template_json) {
    const ptr0 = passStringToWasm0(template_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_humanoid_skeleton_template_rest_bounds(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @returns {number}
 */
export function core_abi_version() {
    const ret = wasm.core_abi_version();
    return ret >>> 0;
}

/**
 * @param {string} template_json
 * @returns {string}
 */
export function create_validation_skeleton_json(template_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(template_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.create_validation_skeleton_json(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {string}
 */
export function default_hair_color_appearance_json() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.default_hair_color_appearance_json();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @returns {Float32Array}
 */
export function default_hair_physics_config_values() {
    const ret = wasm.default_hair_physics_config_values();
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Execute a host-neutral Embody operation using JSON in and JSON out.
 * This keeps CLJS and other browser hosts off the Rust data structures while
 * ensuring all profile semantics execute inside Wasm.
 * @param {string} request_json
 * @returns {string}
 */
export function embody_request(request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.embody_request(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} model_json
 * @param {string} options_json
 * @returns {string}
 */
export function extract_humanoid_skeleton_template_json(model_json, options_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.extract_humanoid_skeleton_template_json(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @param {string} model_json
 * @param {string} clips_json
 * @returns {string}
 */
export function extract_model_data_json(model_json, clips_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(clips_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.extract_model_data_json(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Padding factor for a focus target of the given max dimension.
 * @param {number} size
 * @param {number} close_up_padding
 * @param {number} zoom_padding
 * @param {number} full_body_padding
 * @returns {number}
 */
export function focus_padding_factor(size, close_up_padding, zoom_padding, full_body_padding) {
    const ret = wasm.focus_padding_factor(size, close_up_padding, zoom_padding, full_body_padding);
    return ret;
}

/**
 * @param {string} id
 * @returns {string}
 */
export function get_humanoid_skeleton_template_json(id) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_humanoid_skeleton_template_json(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Return the embedded preset JSON for a preset id (intake source of truth).
 * @param {string} preset_id
 * @returns {string}
 */
export function get_preset_json(preset_id) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(preset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_preset_json(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {string}
 */
export function hair_color_presets_json() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.hair_color_presets_json();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @returns {number}
 */
export function hair_config_stride() {
    const ret = wasm.hair_config_stride();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function hair_head_state_stride() {
    const ret = wasm.hair_head_state_stride();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function hair_morph_output_stride() {
    const ret = wasm.hair_morph_output_stride();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function hair_state_stride() {
    const ret = wasm.hair_state_stride();
    return ret >>> 0;
}

/**
 * True when the Wasm core ships the given preset id.
 * @param {string} preset_id
 * @returns {boolean}
 */
export function has_preset(preset_id) {
    const ptr0 = passStringToWasm0(preset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.has_preset(ptr0, len0);
    return ret !== 0;
}

/**
 * @param {string} template_json
 * @returns {string}
 */
export function humanoid_skeleton_template_bone_names(template_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(template_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.humanoid_skeleton_template_bone_names(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {string}
 */
export function list_humanoid_skeleton_templates_json() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.list_humanoid_skeleton_templates_json();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Canonical embedded preset ids available inside the Wasm core.
 * @returns {string[]}
 */
export function list_presets() {
    const ret = wasm.list_presets();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @returns {number}
 */
export function marker_endpoint_stride() {
    const ret = wasm.marker_endpoint_stride();
    return ret >>> 0;
}

/**
 * Marker show/hide animation factors at normalized time `t` in `[0, 1]`.
 * Returns `[itemOpacityFactor, labelScaleFactor, lineOpacityFactor]`.
 * @param {boolean} visible
 * @param {number} t
 * @returns {Float32Array}
 */
export function marker_visibility_animation_factors(visible, t) {
    const ret = wasm.marker_visibility_animation_factors(visible, t);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @returns {number}
 */
export function marker_visibility_factors_stride() {
    const ret = wasm.marker_visibility_factors_stride();
    return ret >>> 0;
}

/**
 * Merge overrides onto an embedded preset. Hosts that still need a JS Profile
 * object for Mixer callbacks can use this; the runtime configure path should
 * prefer `RuntimeCore.configure_with_preset`.
 * @param {string} preset_id
 * @param {string} override_json
 * @returns {string}
 */
export function merge_embedded_preset(preset_id, override_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(preset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(override_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.merge_embedded_preset(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Merge a base preset profile with an extension profile (both JSON strings)
 * using the engine's preset extension rules. Returns the merged profile JSON.
 * @param {string} base_json
 * @param {string} extension_json
 * @returns {string}
 */
export function merge_preset_profile(base_json, extension_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(base_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(extension_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.merge_preset_profile(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @returns {number}
 */
export function mesh_proportions_stride() {
    const ret = wasm.mesh_proportions_stride();
    return ret >>> 0;
}

/**
 * @param {number} angle
 * @returns {number}
 */
export function normalize_camera_angle_degrees(angle) {
    const ret = wasm.normalize_camera_angle_degrees(angle);
    return ret;
}

/**
 * @param {string} value_json
 * @param {string} fallback_json
 * @returns {string}
 */
export function normalize_hair_color_appearance_json(value_json, fallback_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fallback_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.normalize_hair_color_appearance_json(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @param {Uint32Array} mesh_ids
 * @param {Uint32Array} morph_target_ids
 * @param {Float32Array} values
 * @param {Uint8Array} modes
 * @returns {Float32Array}
 */
export function pack_morph_frame_delta(mesh_ids, morph_target_ids, values, modes) {
    const ptr0 = passArray32ToWasm0(mesh_ids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(morph_target_ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(modes, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.pack_morph_frame_delta(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    var v5 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v5;
}

/**
 * @returns {number}
 */
export function packed_bone_frame_delta_stride() {
    const ret = wasm.packed_bone_frame_delta_stride();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function packed_morph_frame_delta_stride() {
    const ret = wasm.packed_morph_frame_delta_stride();
    return ret >>> 0;
}

/**
 * Whether a marker with a preferred viewing angle should show for the
 * current camera orbit angle. Angles are degrees around the model Y axis.
 * @param {number | null} [marker_angle]
 * @param {number | null} [current_camera_angle]
 * @param {number | null} [range_degrees]
 * @returns {boolean}
 */
export function passes_marker_camera_angle_gate(marker_angle, current_camera_angle, range_degrees) {
    const ret = wasm.passes_marker_camera_angle_gate(isLikeNone(marker_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(marker_angle), isLikeNone(current_camera_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(current_camera_angle), isLikeNone(range_degrees) ? Number.MAX_SAFE_INTEGER : Math.fround(range_degrees));
    return ret !== 0;
}

/**
 * Auto camera angle for small offset focus targets (eye closeups).
 * Returns `undefined` when no auto angle applies.
 * @param {number} horizontal_offset
 * @param {Float32Array} focus_size
 * @param {Float32Array} model_size
 * @returns {number | undefined}
 */
export function resolve_auto_closeup_angle(horizontal_offset, focus_size, model_size) {
    const ptr0 = passArrayF32ToWasm0(focus_size, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(model_size, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.resolve_auto_closeup_angle(horizontal_offset, ptr0, len0, ptr1, len1);
    return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
}

/**
 * Merge an embedded preset with sparse overrides, then return the resolved
 * routing/metadata view for host adapters.
 * @param {string} preset_id
 * @param {string} override_json
 * @returns {string}
 */
export function resolve_embedded_profile_view(preset_id, override_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(preset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(override_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.resolve_embedded_profile_view(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Direction the camera should approach from when focusing a region.
 * @param {Float32Array} model_quat
 * @param {number} effective_angle
 * @param {boolean} has_explicit_angle
 * @param {boolean} world_angle_space
 * @returns {Float32Array}
 */
export function resolve_focus_camera_direction(model_quat, effective_angle, has_explicit_angle, world_angle_space) {
    const ptr0 = passArrayF32ToWasm0(model_quat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.resolve_focus_camera_direction(ptr0, len0, effective_angle, has_explicit_angle, world_angle_space);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Resolve profile routing/metadata answers that hosts need without making
 * hosts duplicate profile semantics in JavaScript.
 * @param {string} profile_json
 * @returns {string}
 */
export function resolve_profile_view(profile_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.resolve_profile_view(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Clip a marker leader line (clip-space start/end, `[x, y, z, w]` each) to a
 * safe viewport rectangle. Returns `[visible, lineScale]` where `lineScale`
 * is the fraction of the line that stays on screen.
 * @param {Float32Array} start_clip
 * @param {Float32Array} end_clip
 * @param {number} safe_x
 * @param {number} safe_y
 * @param {number | null} [min_length_ratio]
 * @returns {Float32Array}
 */
export function resolve_viewport_constrained_line_scale(start_clip, end_clip, safe_x, safe_y, min_length_ratio) {
    const ptr0 = passArrayF32ToWasm0(start_clip, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(end_clip, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.resolve_viewport_constrained_line_scale(ptr0, len0, ptr1, len1, safe_x, safe_y, isLikeNone(min_length_ratio) ? Number.MAX_SAFE_INTEGER : Math.fround(min_length_ratio));
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Safe NDC bounds that keep a screen-space label plus a pixel gutter fully
 * on screen. Returns `[safeX, safeY]`.
 * @param {number} label_scale_x
 * @param {number} label_scale_y
 * @param {number} projection_x_scale
 * @param {number} projection_y_scale
 * @param {number} viewport_width
 * @param {number} viewport_height
 * @param {number | null} [edge_padding_px]
 * @returns {Float32Array}
 */
export function resolve_viewport_safe_bounds(label_scale_x, label_scale_y, projection_x_scale, projection_y_scale, viewport_width, viewport_height, edge_padding_px) {
    const ret = wasm.resolve_viewport_safe_bounds(label_scale_x, label_scale_y, projection_x_scale, projection_y_scale, viewport_width, viewport_height, isLikeNone(edge_padding_px) ? Number.MAX_SAFE_INTEGER : Math.fround(edge_padding_px));
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Sinusoidal arc leader line points between two world positions.
 * Returns `(segments + 1) * 3` floats.
 * @param {Float32Array} start
 * @param {Float32Array} end
 * @param {number} segments
 * @returns {Float32Array}
 */
export function sample_marker_arc_curve(start, end, segments) {
    const ptr0 = passArrayF32ToWasm0(start, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(end, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sample_marker_arc_curve(ptr0, len0, ptr1, len1, segments);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Quadratic bezier leader line points between two world positions.
 * Returns `(segments + 1) * 3` floats.
 * @param {Float32Array} start
 * @param {Float32Array} end
 * @param {number} segments
 * @returns {Float32Array}
 */
export function sample_marker_bezier_curve(start, end, segments) {
    const ptr0 = passArrayF32ToWasm0(start, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(end, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sample_marker_bezier_curve(ptr0, len0, ptr1, len1, segments);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Separates overlapping marker endpoints while preserving each marker's
 * surface anchor and leader-line length.
 *
 * `starts` and `ends` are packed `[x, y, z, ...]` arrays. The output includes
 * one endpoint for every complete start/end pair. Proximity and rotation
 * constants match DPthree's marker layout, scaled to the current model height.
 * @param {Float32Array} starts
 * @param {Float32Array} ends
 * @param {Float32Array} model_center
 * @param {number} model_height
 * @returns {Float32Array}
 */
export function separate_overlapping_marker_endpoints(starts, ends, model_center, model_height) {
    const ptr0 = passArrayF32ToWasm0(starts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(ends, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(model_center, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.separate_overlapping_marker_endpoints(ptr0, len0, ptr1, len1, ptr2, len2, model_height);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Solo/expand/angle visibility rule for a marker.
 *
 * * `hidden_child` - the marker is a collapsed child of an expandable region.
 * * `soloed` - solo state: 0 = no solo, 1 = this marker is soloed,
 *   2 = another marker is soloed.
 * @param {boolean} hidden_child
 * @param {number} soloed
 * @param {number | null} [marker_angle]
 * @param {number | null} [current_camera_angle]
 * @returns {boolean}
 */
export function should_show_marker(hidden_child, soloed, marker_angle, current_camera_angle) {
    const ret = wasm.should_show_marker(hidden_child, soloed, isLikeNone(marker_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(marker_angle), isLikeNone(current_camera_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(current_camera_angle));
    return ret !== 0;
}

/**
 * @param {number} axis
 * @param {number} degrees
 * @param {number} value
 * @param {number} scale
 * @returns {Float32Array}
 */
export function solve_axis_quaternion(axis, degrees, value, scale) {
    const ret = wasm.solve_axis_quaternion(axis, degrees, value, scale);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @param {number} base
 * @param {number} balance
 * @returns {Float32Array}
 */
export function solve_bilateral_values(base, balance) {
    const ret = wasm.solve_bilateral_values(base, balance);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Solve the camera framing for a focus target.
 *
 * * `focus_bounds` - `[centerX, centerY, centerZ, sizeX, sizeY, sizeZ]` of the focus box.
 * * `model_bounds` - same layout for the whole model, or empty when unavailable.
 * * `model_quat` - model world quaternion `[x, y, z, w]`, or empty for identity.
 * * `camera_angle` - explicit region camera angle (degrees), or `undefined`.
 * * `world_angle_space` - whether `camera_angle` is a world-space angle.
 *
 * Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
 * @param {Float32Array} focus_bounds
 * @param {Float32Array} model_bounds
 * @param {Float32Array} model_quat
 * @param {number} fov_deg
 * @param {number} aspect
 * @param {number} min_distance
 * @param {number} close_up_padding
 * @param {number} zoom_padding
 * @param {number} full_body_padding
 * @param {number | null | undefined} override_padding
 * @param {number | null | undefined} camera_angle
 * @param {boolean} world_angle_space
 * @returns {Float32Array}
 */
export function solve_focus_framing(focus_bounds, model_bounds, model_quat, fov_deg, aspect, min_distance, close_up_padding, zoom_padding, full_body_padding, override_padding, camera_angle, world_angle_space) {
    const ptr0 = passArrayF32ToWasm0(focus_bounds, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(model_bounds, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(model_quat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.solve_focus_framing(ptr0, len0, ptr1, len1, ptr2, len2, fov_deg, aspect, min_distance, close_up_padding, zoom_padding, full_body_padding, isLikeNone(override_padding) ? Number.MAX_SAFE_INTEGER : Math.fround(override_padding), isLikeNone(camera_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(camera_angle), world_angle_space);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Solve the hero full-body framing.
 *
 * * `box_min` / `box_max` - model bounding box corners.
 *
 * Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
 * @param {Float32Array} box_min
 * @param {Float32Array} box_max
 * @param {Float32Array} model_quat
 * @param {number} fov_deg
 * @param {number} aspect
 * @param {number} min_distance
 * @param {number} full_body_padding
 * @param {number | null | undefined} override_padding
 * @param {number | null | undefined} camera_angle
 * @param {boolean} world_angle_space
 * @returns {Float32Array}
 */
export function solve_full_body_framing(box_min, box_max, model_quat, fov_deg, aspect, min_distance, full_body_padding, override_padding, camera_angle, world_angle_space) {
    const ptr0 = passArrayF32ToWasm0(box_min, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(box_max, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(model_quat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.solve_full_body_framing(ptr0, len0, ptr1, len1, ptr2, len2, fov_deg, aspect, min_distance, full_body_padding, isLikeNone(override_padding) ? Number.MAX_SAFE_INTEGER : Math.fround(override_padding), isLikeNone(camera_angle) ? Number.MAX_SAFE_INTEGER : Math.fround(camera_angle), world_angle_space);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * @param {Float32Array} values
 * @param {Float32Array} balances
 * @param {Float32Array} mix_weights
 * @returns {Float32Array}
 */
export function solve_morph_batch(values, balances, mix_weights) {
    const ptr0 = passArrayF32ToWasm0(values, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(balances, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(mix_weights, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.solve_morph_batch(ptr0, len0, ptr1, len1, ptr2, len2);
    var v4 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Solve a uniform scale and translation for placing a template skeleton inside a mesh.
 *
 * `template_bounds` is [min_x, min_y, min_z, max_x, max_y, max_z] in the
 * template skeleton's rest-pose coordinate space. `vertical_axis` is 0, 1, or 2.
 * `vertical_anchor` controls vertical placement: 0 aligns mins, 1 aligns centers,
 * 2 aligns maxes.
 *
 * Output layout:
 * [scale, translate_x, translate_y, translate_z,
 *  mesh_humanoid_likelihood, mesh_height, template_height,
 *  mesh_cross_axis_wide_span, template_cross_axis_wide_span, status]
 *
 * `status` is 1 for solved, 0 for invalid mesh input, and -1 for invalid template
 * bounds. This does not compute skin weights, inverse bind matrices, or pose
 * retargeting.
 * @param {Float32Array} mesh_vertices
 * @param {Float32Array} template_bounds
 * @param {number} vertical_axis
 * @param {number} vertical_anchor
 * @returns {Float32Array}
 */
export function solve_template_skeleton_fit(mesh_vertices, template_bounds, vertical_axis, vertical_anchor) {
    const ptr0 = passArrayF32ToWasm0(mesh_vertices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(template_bounds, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.solve_template_skeleton_fit(ptr0, len0, ptr1, len1, vertical_axis, vertical_anchor);
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * @returns {number}
 */
export function template_skeleton_fit_solution_stride() {
    const ret = wasm.template_skeleton_fit_solution_stride();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function template_skeleton_fit_transform_stride() {
    const ret = wasm.template_skeleton_fit_transform_stride();
    return ret >>> 0;
}

/**
 * Validate generated template skeleton fit metadata from a compact Wasm ABI.
 *
 * String inputs carry host-owned ids. The packed f32 slice layout is:
 * [schema_version, metadata_kind, template_lookup_status, fit_status,
 *  vertical_axis, vertical_anchor, fit_scale, translate_x, translate_y,
 *  translate_z, solver_confidence, manual_scale_multiplier, manual_offset_x,
 *  manual_offset_y, manual_offset_z].
 *
 * `metadata_kind` must be 1, which identifies generated template fit metadata
 * and keeps it separate from imported rig, skinning, or bind-pose data.
 *
 * The return value is a compact bitmask. 0 means valid.
 * @param {string} template_id
 * @param {string} source_character_id
 * @param {Float32Array} metadata
 * @returns {number}
 */
export function validate_generated_template_fit_metadata(template_id, source_character_id, metadata) {
    const ptr0 = passStringToWasm0(template_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(source_character_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(metadata, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.validate_generated_template_fit_metadata(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret >>> 0;
}

/**
 * Validate an authored profile against a renderer-neutral model descriptor.
 * Three.js objects are reduced to this descriptor by the thin host adapter;
 * all mapping analysis and correction generation stays in Rust.
 * @param {string} profile_json
 * @param {string} model_json
 * @param {string} options_json
 * @returns {string}
 */
export function validate_profile_model(profile_json, model_json, options_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.validate_profile_model(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * World-space camera direction for a model-relative camera angle.
 * `model_quat` is the model's world quaternion `[x, y, z, w]`
 * (pass an empty slice for identity).
 * @param {Float32Array} model_quat
 * @param {number} camera_angle
 * @returns {Float32Array}
 */
export function world_direction_for_camera_angle(model_quat, camera_angle) {
    const ptr0 = passArrayF32ToWasm0(model_quat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.world_direction_for_camera_angle(ptr0, len0, camera_angle);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_ef53bc310eb298a0: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./embody_wasm_bg.js": import0,
    };
}

const CameraFlightFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cameraflight_free(ptr, 1));
const CameraOrbitFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cameraorbit_free(ptr, 1));
const HairPhysicsSolverFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_hairphysicssolver_free(ptr, 1));
const RuntimeCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_runtimecore_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('embody_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
