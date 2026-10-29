use super::{decode_animation, decode_pose};
use serde_json::{json, Value};

#[test]
fn historical_pose_preserves_side_settings_and_unrelated_data() {
    let source = json!({"label":"turn", "bones":{"custom":1}, "semanticPose":{"version":1,"controls":[
        {"controlId":"body.headTurn","negative":{"intensity":0.5,"balance":-1,"morphStrength":0.3}}
    ]}});
    let decoded = decode_pose(source.clone(), &Value::Null).unwrap();
    assert_eq!(decoded["aus"]["51"], 0.5);
    assert_eq!(decoded["auBalances"]["51"], -1);
    assert_eq!(decoded["auMixWeights"]["51"], 0.3);
    assert_eq!(decoded["bones"], source["bones"]);
    assert!(decoded.get("semanticPose").is_none());
    assert!(source.get("semanticPose").is_some());
}

#[test]
fn explicit_metadata_is_authoritative_even_when_empty() {
    let pose = json!({"semanticPose":{"controls":[{"controlId":"body.headTurn","positive":{"intensity":1}}]}});
    assert!(decode_pose(pose.clone(), &json!({"bodyControls":{}})).is_err());
    let decoded = decode_pose(pose, &json!({"bodyControls":{"body.headTurn":{"positiveAuId":8001}}})).unwrap();
    assert_eq!(decoded["aus"]["8001"], 1);
    assert!(decoded["aus"].get("52").is_none());
}

#[test]
fn conflicting_pose_values_settings_and_opposites_are_rejected() {
    let legacy = json!({"controls":[{"controlId":"body.headTurn","positive":{"intensity":1,"balance":1}}]});
    assert!(decode_pose(json!({"aus":{"52":0.5},"semanticPose":legacy}), &Value::Null).unwrap_err().contains("conflicts"));
    assert!(decode_pose(json!({"auBalances":{"52":-1},"semanticPose":legacy}), &Value::Null).unwrap_err().contains("side settings"));
    assert!(decode_pose(json!({"aus":{"51":1},"semanticPose":legacy}), &Value::Null).unwrap_err().contains("opposing"));
    assert!(decode_pose(json!({"aus":{"52":1.0},"semanticPose":legacy}), &Value::Null).is_ok());
}

#[test]
fn animation_keeps_keyframes_metadata_and_existing_channels() {
    let frames = json!([{"time":0.125,"intensity":0.7,"inherit":true}]);
    let animation = json!({"name":"look", "channels":[{"target":{"type":"viseme","id":1},"keyframes":[]}],
        "semanticAnimation":{"version":1,"tracks":[{"controlId":"body.eyeLook","direction":"negative","balance":-1,"morphStrength":0.2,"keyframes":frames}]}});
    let out = decode_animation(animation.clone(), &Value::Null).unwrap();
    assert_eq!(out["curves"]["64"], frames);
    assert_eq!(out["balanceMap"]["64"], -1);
    assert_eq!(out["mixWeights"]["64"], 0.2);
    assert_eq!(out["channels"], animation["channels"]);
    assert!(out.get("semanticAnimation").is_none());
    let mut conflict = animation;
    conflict["curves"] = json!({"64":frames});
    assert!(decode_animation(conflict, &Value::Null).unwrap_err().contains("conflicts"));
}

#[test]
fn unknown_names_and_directions_fail_without_reclassifying_custom_ids() {
    let animation = json!({"semanticAnimation":{"tracks":[{"controlId":"unknown","direction":"positive","keyframes":[]}]}});
    assert!(decode_animation(animation, &Value::Null).is_err());
    let invalid = json!({"semanticAnimation":{"tracks":[{"controlId":"body.headTurn","direction":"sideways","keyframes":[]}]}});
    assert!(decode_animation(invalid, &Value::Null).is_err());
    let fish = json!({"aus":{"26":0.6,"30":0.4},"label":"fins"});
    assert_eq!(decode_pose(fish.clone(), &Value::Null).unwrap(), fish);
}


#[test]
fn animation_rejects_conflicting_side_settings_without_replacing_saved_data() {
    let original = json!({"label":"keep", "semanticAnimation":{"tracks":[{
        "controlId":"body.headTurn", "direction":"positive", "keyframes":[],
        "balance":1, "morphStrength":0.25
    }]}});
    for (field, value) in [("balanceMap", -1.0), ("mixWeights", 0.75)] {
        let mut conflict = original.clone();
        conflict[field] = json!({"52":value, "999":0.4});
        assert!(decode_animation(conflict.clone(), &Value::Null)
            .unwrap_err().contains("side settings"));
        assert_eq!(conflict[field]["52"], value);
        assert!(conflict.get("semanticAnimation").is_some());
    }
    let mut equal = original;
    equal["balanceMap"] = json!({"52":1.0,"999":-0.5});
    equal["mixWeights"] = json!({"52":0.25,"999":0.4});
    let decoded = decode_animation(equal, &Value::Null).unwrap();
    assert_eq!(decoded["balanceMap"], json!({"52":1,"999":-0.5}));
    assert_eq!(decoded["mixWeights"], json!({"52":0.25,"999":0.4}));
    assert_eq!(decoded["curves"]["52"], json!([]));
}
