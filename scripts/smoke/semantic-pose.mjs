import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
const wasm = await initEmbodyCore();
const core = new wasm.RuntimeCore(0);
const model = { bones: [{id:1,name:'CC_Base_L_Forearm'},{id:2,name:'CC_Base_R_Forearm'}],
  meshes:[{id:3,name:'CC_Base_Body',morphTargetIds:[4,5]}],morphTargets:[
  {id:4,meshId:3,name:'LL_Body_Bicep_Flex_L',hostIndex:0},{id:5,meshId:3,name:'LL_Body_Bicep_Flex_R',hostIndex:1}] };
try {
  core.configure_with_preset('cc4','{}',JSON.stringify(model));
  const catalog=JSON.parse(core.get_semantic_pose_catalog_json());
  const elbow=catalog.find(c=>c.id==='body.elbowFlex');
  assert.equal(catalog.length,58);assert.equal(elbow.positive.available,true);
  assert(elbow.boneNames.includes('CC_Base_L_Forearm'));assert(elbow.morphNames.includes('LL_Body_Bicep_Flex_L'));
  const pose={version:1,controls:[{controlId:elbow.id,positive:{intensity:.5,balance:-1,morphStrength:.25}}]};
  core.set_au(12,.4,0);core.apply_semantic_pose_json(JSON.stringify(pose));
  const saved=core.capture_semantic_pose_json();
  assert.equal(core.get_au_mix_weight(elbow.positive.auId),.25);
  const morph=Array.from(core.evaluate_active_morph_frame());assert.equal(morph[2],.125);
  for(const bad of [
    {...pose,version:2},
    {version:1,controls:[...pose.controls,{controlId:'unknown',positive:{intensity:1}}]},
    {version:1,controls:[{controlId:elbow.id,positive:{intensity:1.1}}]},
    {version:1,controls:[{controlId:elbow.id,positive:{intensity:1,morphStrength:-1}}]},
  ]) { assert.throws(()=>core.apply_semantic_pose_json(JSON.stringify(bad)));assert.equal(core.capture_semantic_pose_json(),saved); }
  const normalized=JSON.parse(core.validate_semantic_pose_json(JSON.stringify({version:1,controls:[{controlId:'body.torsoTwist',negative:{intensity:.2}}]})));
  assert.equal(normalized.controls[0].negative.balance,0);assert.equal(core.capture_semantic_pose_json(),saved);
  const animation={version:1,durationSeconds:2,tracks:[{controlId:elbow.id,direction:'positive',balance:-1,morphStrength:.25,keyframes:[{time:0,intensity:0},{time:1,intensity:.5},{time:2,intensity:0}]}]};
  const clip=JSON.parse(core.build_semantic_clip('flex',JSON.stringify(animation),'{}'));
  assert(clip.tracks.some(t=>t.target.kind==='boneTransform'));assert(clip.tracks.some(t=>t.target.kind==='morphTarget'&&t.values.includes(.125)));
  assert.equal(core.capture_semantic_pose_json(),saved);
  assert.throws(()=>core.build_semantic_clip('invalid',JSON.stringify({...animation,tracks:[{...animation.tracks[0],controlId:'body.kneeBend'}]}),'{}'));
  core.clear();core.apply_semantic_pose_json(saved);assert.equal(core.capture_semantic_pose_json(),saved);
  core.configure_with_preset('cc4','{}','{}');core.apply_semantic_pose_json(saved); // portable state on an incomplete rig
  assert.equal(JSON.parse(core.get_semantic_pose_catalog_json()).some(c=>c.positive.available),false);
} finally {core.free();}
console.log('Semantic pose catalog, atomic validation, capture/reload and compiled motion passed');
