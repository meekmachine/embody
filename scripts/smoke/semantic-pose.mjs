// Historical CI entry point: saved numeric AU curves use the single ordinary compiler.
import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
const wasm=await initEmbodyCore();const core=new wasm.RuntimeCore(0);
const profile={auInfo:{8001:{name:'Authored flex',faceArea:'Body',facePart:'Body'}},
  auToBones:{8001:[{node:'Arm',channel:'rx',scale:1,maxDegrees:90,side:'left'}]},
  auToMorphs:{8001:{left:['Flex'],right:[],center:[]}},
  compositeRotations:[{node:'Arm',pitch:{aus:[8001],axis:'rx'}}],morphToMesh:{body:['Skin']}};
const model={bones:[{id:1,name:'Arm'}],meshes:[{id:2,name:'Skin',morphTargetIds:[3]}],morphTargets:[{id:3,meshId:2,name:'Flex',hostIndex:0}]};
try {
  core.configure_with_profile(JSON.stringify(profile),JSON.stringify(model));
  core.set_au(8001,.3,-1);core.set_au_mix_weight(8001,.8);
  const clip=JSON.parse(core.build_clip('mapped-au',JSON.stringify({8001:[{time:0,intensity:0},{time:1,intensity:.5}]}),JSON.stringify({balanceMap:{8001:-1},mixWeights:{8001:.25}})));
  assert(clip.tracks.some(track=>track.target.kind==='boneTransform'));
  assert(clip.tracks.some(track=>track.target.kind==='morphTarget'&&track.values.includes(.125)));
  assert(Math.abs(core.get_au(8001)-.3)<1e-6);assert.equal(core.get_au_balance(8001),-1);
  assert(Math.abs(core.get_au_mix_weight(8001)-.8)<1e-6);
  assert.throws(()=>core.build_clip('', '{}','{}'));
  assert(Math.abs(core.get_au(8001)-.3)<1e-6);
} finally {core.free();}
