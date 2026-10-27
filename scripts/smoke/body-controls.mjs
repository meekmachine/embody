// Historical filename retained by CI; coverage now exercises actual AU mapping descriptors.
import assert from 'node:assert/strict';
import { initEmbodyCore, getAUDescriptors } from '@lovelace_lol/embody/wasm';
const wasm=await initEmbodyCore();
const request=(op,payload)=>JSON.parse(wasm.embody_request(JSON.stringify({op,payload})));
const profile=request('preset.get',{id:'cc4'});
assert.equal(profile.bodyControls,undefined);
const descriptors=getAUDescriptors(profile);
const ids=new Set([...Object.keys(profile.auInfo??{}),...Object.keys(profile.auToBones??{}),...Object.keys(profile.auToMorphs??{})].map(Number));
assert.equal(descriptors.length,ids.size);
assert(descriptors.every(row=>ids.has(row.auId)));
const core=new wasm.RuntimeCore(0);
try {
  core.configure_with_preset('cc4','{}',JSON.stringify({bones:[{id:1,name:'CC_Base_L_Forearm'},{id:2,name:'CC_Base_R_Forearm'}]}));
  const elbow=JSON.parse(core.get_au_descriptors_json()).find(row=>row.auId===1001);
  assert.equal(elbow.hasBones,true);assert.equal(elbow.bilateral,true);
  core.set_au(1001,.5,-1);core.set_au(12,.8,0);core.set_au_mix_weight(1001,.25);
  const frame=Array.from(core.evaluate_active_bone_frame());
  assert(frame.some(value=>Math.abs(value)>0));
  core.set_au(1001,0,0);assert.equal(core.get_au(1001),0);assert(Math.abs(core.get_au(12)-.8)<1e-6);
  assert.equal(core.get_au_mix_weight(1001),.25);
} finally {core.free();}
