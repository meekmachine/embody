// assets/appearance/hair-color-presets.json
var hair_color_presets_default = {
  natural_black: { name: "Natural Black", baseColor: "#1a1a1a", emissive: "#000000", emissiveIntensity: 0 },
  natural_brown: { name: "Natural Brown", baseColor: "#4a3728", emissive: "#000000", emissiveIntensity: 0 },
  natural_blonde: { name: "Natural Blonde", baseColor: "#e6c78a", emissive: "#000000", emissiveIntensity: 0 },
  natural_red: { name: "Natural Red", baseColor: "#8b3a3a", emissive: "#000000", emissiveIntensity: 0 },
  natural_gray: { name: "Natural Gray", baseColor: "#9e9e9e", emissive: "#000000", emissiveIntensity: 0 },
  natural_white: { name: "Natural White", baseColor: "#f5f5f5", emissive: "#000000", emissiveIntensity: 0 },
  neon_blue: { name: "Neon Blue", baseColor: "#00ffff", emissive: "#0000ff", emissiveIntensity: 0.8 },
  neon_pink: { name: "Neon Pink", baseColor: "#ff00ff", emissive: "#ff1493", emissiveIntensity: 0.8 },
  neon_green: { name: "Neon Green", baseColor: "#00ff00", emissive: "#00ff00", emissiveIntensity: 0.8 },
  electric_purple: { name: "Electric Purple", baseColor: "#9d00ff", emissive: "#9d00ff", emissiveIntensity: 0.6 },
  fire_orange: { name: "Fire Orange", baseColor: "#ff6600", emissive: "#ff3300", emissiveIntensity: 0.7 }
};

// assets/templates/jonathan-cc-base.json
var jonathan_cc_base_default = {
  id: "jonathan-cc-base",
  sourceCharacterId: "jonathan",
  sourceAsset: "frontend/public/characters/jonathan_new.glb",
  sourceSkinName: "Armature",
  bones: [
    {
      name: "CC_Base_BoneRoot",
      parent: null,
      translation: [
        0,
        0,
        0
      ]
    },
    {
      name: "CC_Base_Hip",
      parent: "CC_Base_BoneRoot",
      translation: [
        0,
        0,
        102.33650207519531
      ]
    },
    {
      name: "CC_Base_Pelvis",
      parent: "CC_Base_Hip",
      translation: [
        -3790411029074318e-30,
        30517578125e-15,
        -7.908884072094224e-7
      ]
    },
    {
      name: "CC_Base_L_Thigh",
      parent: "CC_Base_Pelvis",
      translation: [
        9.953155517578125,
        -1.789858102798462,
        -1.3750107288360596
      ]
    },
    {
      name: "CC_Base_L_Calf",
      parent: "CC_Base_L_Thigh",
      translation: [
        0.0010912826983258128,
        47.572593688964844,
        -25631440803408623e-20
      ]
    },
    {
      name: "CC_Base_L_Foot",
      parent: "CC_Base_L_Calf",
      translation: [
        0.012946736067533493,
        47.30466842651367,
        0.0028991601429879665
      ]
    },
    {
      name: "CC_Base_L_ToeBaseShareBone",
      parent: "CC_Base_L_Foot",
      translation: [
        -15205750241875648e-20,
        15.384612083435059,
        8890032768249512e-20
      ]
    },
    {
      name: "CC_Base_L_ToeBase",
      parent: "CC_Base_L_Foot",
      translation: [
        -15205750241875648e-20,
        15.384612083435059,
        8890032768249512e-20
      ]
    },
    {
      name: "CC_Base_L_PinkyToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -2.8338863849639893,
        0.00474335253238678,
        -0.449185848236084
      ]
    },
    {
      name: "CC_Base_L_RingToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -1.4594630002975464,
        1.165667176246643,
        -0.024081647396087646
      ]
    },
    {
      name: "CC_Base_L_MidToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -5848705768585205e-21,
        2.3142271041870117,
        5245208740234375e-20
      ]
    },
    {
      name: "CC_Base_L_IndexToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        1.5948846340179443,
        2.64426851272583,
        0.3221862316131592
      ]
    },
    {
      name: "CC_Base_L_BigToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        3.8480422496795654,
        2.5877017974853516,
        0.018612831830978394
      ]
    },
    {
      name: "CC_Base_L_CalfTwist01",
      parent: "CC_Base_L_Calf",
      translation: [
        -9258394129574299e-21,
        4678964614868164e-21,
        -3.073364496231079e-8
      ]
    },
    {
      name: "CC_Base_L_CalfTwist02",
      parent: "CC_Base_L_CalfTwist01",
      translation: [
        0.008389605209231377,
        23.652305603027344,
        0.0010145818814635277
      ]
    },
    {
      name: "CC_Base_L_KneeShareBone",
      parent: "CC_Base_L_Calf",
      translation: [
        -9258394129574299e-21,
        4678964614868164e-21,
        -3.073364496231079e-8
      ]
    },
    {
      name: "CC_Base_L_ThighTwist01",
      parent: "CC_Base_L_Thigh",
      translation: [
        -5.249967216514051e-8,
        -446811318397522e-19,
        7050111889839172e-22
      ]
    },
    {
      name: "CC_Base_L_ThighTwist02",
      parent: "CC_Base_L_ThighTwist01",
      translation: [
        5524034495465457e-19,
        23.786300659179688,
        3187847323715687e-20
      ]
    },
    {
      name: "CC_Base_R_Thigh",
      parent: "CC_Base_Pelvis",
      translation: [
        -9.953006744384766,
        -1.7889251708984375,
        -1.3763487339019775
      ]
    },
    {
      name: "CC_Base_R_Calf",
      parent: "CC_Base_R_Thigh",
      translation: [
        -0.001107644522562623,
        47.52029800415039,
        4845880903303623e-20
      ]
    },
    {
      name: "CC_Base_R_KneeShareBone",
      parent: "CC_Base_R_Calf",
      translation: [
        -7073394954204559e-21,
        -2518296241760254e-21,
        19818544387817383e-22
      ]
    },
    {
      name: "CC_Base_R_Foot",
      parent: "CC_Base_R_Calf",
      translation: [
        -0.011737369000911713,
        47.35129928588867,
        -0.0035943761467933655
      ]
    },
    {
      name: "CC_Base_R_ToeBase",
      parent: "CC_Base_R_Foot",
      translation: [
        23105042055249214e-20,
        15.38337230682373,
        45359134674072266e-20
      ]
    },
    {
      name: "CC_Base_R_BigToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -3.848090648651123,
        2.587796926498413,
        0.018401414155960083
      ]
    },
    {
      name: "CC_Base_R_PinkyToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        2.8339407444000244,
        0.005379915237426758,
        -0.4495028853416443
      ]
    },
    {
      name: "CC_Base_R_RingToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        1.4595259428024292,
        1.1659480333328247,
        -0.02425825595855713
      ]
    },
    {
      name: "CC_Base_R_IndexToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -1.59493887424469,
        2.64436674118042,
        0.32200416922569275
      ]
    },
    {
      name: "CC_Base_R_MidToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -912696123123169e-20,
        2.3142714500427246,
        1671910285949707e-20
      ]
    },
    {
      name: "CC_Base_R_ToeBaseShareBone",
      parent: "CC_Base_R_Foot",
      translation: [
        23105042055249214e-20,
        15.38337230682373,
        45359134674072266e-20
      ]
    },
    {
      name: "CC_Base_R_CalfTwist01",
      parent: "CC_Base_R_Calf",
      translation: [
        -7073394954204559e-21,
        -2518296241760254e-21,
        19818544387817383e-22
      ]
    },
    {
      name: "CC_Base_R_CalfTwist02",
      parent: "CC_Base_R_CalfTwist01",
      translation: [
        -0.005310218781232834,
        23.675636291503906,
        -0.0015991628170013428
      ]
    },
    {
      name: "CC_Base_R_ThighTwist01",
      parent: "CC_Base_R_Thigh",
      translation: [
        30152787076076493e-22,
        -12714415788650513e-21,
        -5.024485290050507e-7
      ]
    },
    {
      name: "CC_Base_R_ThighTwist02",
      parent: "CC_Base_R_ThighTwist01",
      translation: [
        -532150617800653e-18,
        23.760181427001953,
        -5566661711782217e-19
      ]
    },
    {
      name: "CC_Base_Waist",
      parent: "CC_Base_Hip",
      translation: [
        0,
        7.9917144775390625,
        1.035797119140625
      ]
    },
    {
      name: "CC_Base_Spine01",
      parent: "CC_Base_Waist",
      translation: [
        12880583372901905e-29,
        4.44435453414917,
        36954879760742188e-22
      ]
    },
    {
      name: "CC_Base_Spine02",
      parent: "CC_Base_Spine01",
      translation: [
        13552527156068805e-36,
        14.241397857666016,
        -852346420288086e-20
      ]
    },
    {
      name: "CC_Base_NeckTwist01",
      parent: "CC_Base_Spine02",
      translation: [
        -1075023646990303e-21,
        29.157955169677734,
        44345855712890625e-21
      ]
    },
    {
      name: "CC_Base_NeckTwist02",
      parent: "CC_Base_NeckTwist01",
      translation: [
        8672486728755757e-24,
        3.354764223098755,
        13446807861328125e-20
      ]
    },
    {
      name: "CC_Base_Head",
      parent: "CC_Base_NeckTwist02",
      translation: [
        41776246507652104e-20,
        3.995985746383667,
        -1358989356958773e-20
      ]
    },
    {
      name: "CC_Base_FacialBone",
      parent: "CC_Base_Head",
      translation: [
        5114753065527111e-26,
        15347271983046085e-21,
        -7390974587906385e-21
      ]
    },
    {
      name: "CC_Base_JawRoot",
      parent: "CC_Base_FacialBone",
      translation: [
        1.856170654296875,
        2.3725814819335938,
        -0.026499934494495392
      ]
    },
    {
      name: "CC_Base_Tongue01",
      parent: "CC_Base_JawRoot",
      translation: [
        3.4788222312927246,
        1.3013767004013062,
        0.001722173416055739
      ]
    },
    {
      name: "CC_Base_Tongue02",
      parent: "CC_Base_Tongue01",
      translation: [
        1.211624026298523,
        7291115616681054e-20,
        23348256945610046e-22
      ]
    },
    {
      name: "CC_Base_Tongue03",
      parent: "CC_Base_Tongue02",
      translation: [
        1.8075196743011475,
        4838673339691013e-19,
        1673889346420765e-20
      ]
    },
    {
      name: "CC_Base_Teeth02",
      parent: "CC_Base_JawRoot",
      translation: [
        3.509425640106201,
        1.6364113092422485,
        0.025405975058674812
      ]
    },
    {
      name: "CC_Base_R_Eye",
      parent: "CC_Base_FacialBone",
      translation: [
        7.916625499725342,
        8.004108428955078,
        -3.399050235748291
      ]
    },
    {
      name: "CC_Base_L_Eye",
      parent: "CC_Base_FacialBone",
      translation: [
        7.864105701446533,
        7.835659027099609,
        3.473083019256592
      ]
    },
    {
      name: "CC_Base_UpperJaw",
      parent: "CC_Base_FacialBone",
      translation: [
        3.261932373046875,
        6.942871570587158,
        -0.02468101494014263
      ]
    },
    {
      name: "CC_Base_Teeth01",
      parent: "CC_Base_UpperJaw",
      translation: [
        0.09780752658843994,
        0.021660717204213142,
        0.023386476561427116
      ]
    },
    {
      name: "CC_Base_L_Clavicle",
      parent: "CC_Base_Spine02",
      translation: [
        5.846743106842041,
        22.913326263427734,
        0.15851521492004395
      ]
    },
    {
      name: "CC_Base_L_Upperarm",
      parent: "CC_Base_L_Clavicle",
      translation: [
        6332993507385254e-20,
        13.675213813781738,
        40340423583984375e-20
      ]
    },
    {
      name: "CC_Base_L_Forearm",
      parent: "CC_Base_L_Upperarm",
      translation: [
        -0.0021000131964683533,
        29.648496627807617,
        5214959383010864e-19
      ]
    },
    {
      name: "CC_Base_L_ForearmTwist01",
      parent: "CC_Base_L_Forearm",
      translation: [
        -2450495958328247e-20,
        -63749030232429504e-22,
        5811452865600586e-21
      ]
    },
    {
      name: "CC_Base_L_ForearmTwist02",
      parent: "CC_Base_L_ForearmTwist01",
      translation: [
        -0.0017938688397407532,
        12.154339790344238,
        -0.0031246542930603027
      ]
    },
    {
      name: "CC_Base_L_ElbowShareBone",
      parent: "CC_Base_L_Forearm",
      translation: [
        -2450495958328247e-20,
        -63749030232429504e-22,
        5811452865600586e-21
      ]
    },
    {
      name: "CC_Base_L_Hand",
      parent: "CC_Base_L_Forearm",
      translation: [
        -0.0032659247517585754,
        24.308786392211914,
        -0.0040430426597595215
      ]
    },
    {
      name: "CC_Base_L_Pinky1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.8387796878814697,
        9.643739700317383,
        -1.8876361846923828
      ]
    },
    {
      name: "CC_Base_L_Pinky2",
      parent: "CC_Base_L_Pinky1",
      translation: [
        396043062210083e-18,
        3.0504348278045654,
        -1811981201171875e-19
      ]
    },
    {
      name: "CC_Base_L_Pinky3",
      parent: "CC_Base_L_Pinky2",
      translation: [
        38370490074157715e-21,
        1.9355652332305908,
        -3510713577270508e-20
      ]
    },
    {
      name: "CC_Base_L_Ring1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.0010117590427398682,
        9.706981658935547,
        0.0030269622802734375
      ]
    },
    {
      name: "CC_Base_L_Ring2",
      parent: "CC_Base_L_Ring1",
      translation: [
        -1965165138244629e-19,
        4.398406982421875,
        -5393028259277344e-19
      ]
    },
    {
      name: "CC_Base_L_Ring3",
      parent: "CC_Base_L_Ring2",
      translation: [
        -8174926042556763e-19,
        3.074361801147461,
        6477683782577515e-19
      ]
    },
    {
      name: "CC_Base_L_Mid1",
      parent: "CC_Base_L_Hand",
      translation: [
        -0.6153436303138733,
        9.996679306030273,
        1.9597835540771484
      ]
    },
    {
      name: "CC_Base_L_Mid2",
      parent: "CC_Base_L_Mid1",
      translation: [
        -2244412899017334e-19,
        4.767321586608887,
        -41157007217407227e-21
      ]
    },
    {
      name: "CC_Base_L_Mid3",
      parent: "CC_Base_L_Mid2",
      translation: [
        -0.0010398924350738525,
        3.306338310241699,
        -8061528205871582e-19
      ]
    },
    {
      name: "CC_Base_L_Index1",
      parent: "CC_Base_L_Hand",
      translation: [
        -0.4277152717113495,
        9.799840927124023,
        4.421895980834961
      ]
    },
    {
      name: "CC_Base_L_Index2",
      parent: "CC_Base_L_Index1",
      translation: [
        -0.001440480351448059,
        4.649103164672852,
        0.001256398856639862
      ]
    },
    {
      name: "CC_Base_L_Index3",
      parent: "CC_Base_L_Index2",
      translation: [
        -5395412445068359e-19,
        2.933397054672241,
        52034854888916016e-21
      ]
    },
    {
      name: "CC_Base_L_Thumb1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.4729442000389099,
        1.4073847532272339,
        2.9682064056396484
      ]
    },
    {
      name: "CC_Base_L_Thumb2",
      parent: "CC_Base_L_Thumb1",
      translation: [
        -3701448440551758e-20,
        7.252772331237793,
        -34561753273010254e-20
      ]
    },
    {
      name: "CC_Base_L_Thumb3",
      parent: "CC_Base_L_Thumb2",
      translation: [
        -9371936321258545e-19,
        3.2246363162994385,
        -3355741500854492e-19
      ]
    },
    {
      name: "CC_Base_L_UpperarmTwist01",
      parent: "CC_Base_L_Upperarm",
      translation: [
        -24765729904174805e-21,
        -8791685104370117e-21,
        -4850327968597412e-21
      ]
    },
    {
      name: "CC_Base_L_UpperarmTwist02",
      parent: "CC_Base_L_UpperarmTwist01",
      translation: [
        -5109608173370361e-20,
        14.824237823486328,
        -4093348979949951e-20
      ]
    },
    {
      name: "CC_Base_L_RibsTwist",
      parent: "CC_Base_Spine02",
      translation: [
        12.37477970123291,
        4.240516662597656,
        11.340028762817383
      ]
    },
    {
      name: "CC_Base_L_Breast",
      parent: "CC_Base_L_RibsTwist",
      translation: [
        15254845493473113e-21,
        1.999998688697815,
        8869566954672337e-20
      ]
    },
    {
      name: "CC_Base_R_RibsTwist",
      parent: "CC_Base_Spine02",
      translation: [
        -12.366527557373047,
        4.255687236785889,
        11.342021942138672
      ]
    },
    {
      name: "CC_Base_R_Breast",
      parent: "CC_Base_R_RibsTwist",
      translation: [
        -14992387150414288e-21,
        1.9999765157699585,
        698570511303842e-19
      ]
    },
    {
      name: "CC_Base_R_Clavicle",
      parent: "CC_Base_Spine02",
      translation: [
        -5.847836017608643,
        22.913354873657227,
        0.158738374710083
      ]
    },
    {
      name: "CC_Base_R_Upperarm",
      parent: "CC_Base_R_Clavicle",
      translation: [
        -38962066173553467e-20,
        13.675079345703125,
        13494491577148438e-20
      ]
    },
    {
      name: "CC_Base_R_Forearm",
      parent: "CC_Base_R_Upperarm",
      translation: [
        0.0014372840523719788,
        29.647546768188477,
        -34911930561065674e-20
      ]
    },
    {
      name: "CC_Base_R_ElbowShareBone",
      parent: "CC_Base_R_Forearm",
      translation: [
        4427880048751831e-20,
        -5062669515609741e-21,
        19073486328125e-19
      ]
    },
    {
      name: "CC_Base_R_ForearmTwist01",
      parent: "CC_Base_R_Forearm",
      translation: [
        4427880048751831e-20,
        -5062669515609741e-21,
        19073486328125e-19
      ]
    },
    {
      name: "CC_Base_R_ForearmTwist02",
      parent: "CC_Base_R_ForearmTwist01",
      translation: [
        0.0017296746373176575,
        12.154948234558105,
        -0.0021570324897766113
      ]
    },
    {
      name: "CC_Base_R_Hand",
      parent: "CC_Base_R_Forearm",
      translation: [
        0.0013648197054862976,
        24.31002426147461,
        -3132820129394531e-19
      ]
    },
    {
      name: "CC_Base_R_Ring1",
      parent: "CC_Base_R_Hand",
      translation: [
        73462724685668945e-22,
        9.707071304321289,
        -7748603820800781e-19
      ]
    },
    {
      name: "CC_Base_R_Ring2",
      parent: "CC_Base_R_Ring1",
      translation: [
        15947222709655762e-20,
        4.398307800292969,
        -6395876407623291e-19
      ]
    },
    {
      name: "CC_Base_R_Ring3",
      parent: "CC_Base_R_Ring2",
      translation: [
        -0.0010596513748168945,
        3.074486494064331,
        -25691837072372437e-20
      ]
    },
    {
      name: "CC_Base_R_Mid1",
      parent: "CC_Base_R_Hand",
      translation: [
        0.6159845590591431,
        9.997448921203613,
        1.9559621810913086
      ]
    },
    {
      name: "CC_Base_R_Mid2",
      parent: "CC_Base_R_Mid1",
      translation: [
        445440411567688e-18,
        4.767148494720459,
        -16441941261291504e-20
      ]
    },
    {
      name: "CC_Base_R_Mid3",
      parent: "CC_Base_R_Mid2",
      translation: [
        12923777103424072e-20,
        3.306414842605591,
        5930662155151367e-20
      ]
    },
    {
      name: "CC_Base_R_Thumb1",
      parent: "CC_Base_R_Hand",
      translation: [
        -0.4736732244491577,
        1.408708095550537,
        2.9675445556640625
      ]
    },
    {
      name: "CC_Base_R_Thumb2",
      parent: "CC_Base_R_Thumb1",
      translation: [
        3608446568250656e-19,
        7.252943515777588,
        -981692224740982e-18
      ]
    },
    {
      name: "CC_Base_R_Thumb3",
      parent: "CC_Base_R_Thumb2",
      translation: [
        -9268522262573242e-21,
        3.2248055934906006,
        4887580871582031e-20
      ]
    },
    {
      name: "CC_Base_R_Index1",
      parent: "CC_Base_R_Hand",
      translation: [
        0.4276627004146576,
        9.801568984985352,
        4.418048858642578
      ]
    },
    {
      name: "CC_Base_R_Index2",
      parent: "CC_Base_R_Index1",
      translation: [
        0.001061864197254181,
        4.648791790008545,
        6793588399887085e-19
      ]
    },
    {
      name: "CC_Base_R_Index3",
      parent: "CC_Base_R_Index2",
      translation: [
        -6211921572685242e-19,
        2.9368622303009033,
        -16835331916809082e-20
      ]
    },
    {
      name: "CC_Base_R_Pinky1",
      parent: "CC_Base_R_Hand",
      translation: [
        -0.837287962436676,
        9.643238067626953,
        -1.891557216644287
      ]
    },
    {
      name: "CC_Base_R_Pinky2",
      parent: "CC_Base_R_Pinky1",
      translation: [
        -3053247928619385e-19,
        3.050346851348877,
        -22897124290466309e-20
      ]
    },
    {
      name: "CC_Base_R_Pinky3",
      parent: "CC_Base_R_Pinky2",
      translation: [
        -6973743438720703e-21,
        1.9355270862579346,
        15944242477416992e-22
      ]
    },
    {
      name: "CC_Base_R_UpperarmTwist01",
      parent: "CC_Base_R_Upperarm",
      translation: [
        4403293132781982e-21,
        33676624298095703e-22,
        -2473592758178711e-21
      ]
    },
    {
      name: "CC_Base_R_UpperarmTwist02",
      parent: "CC_Base_R_UpperarmTwist01",
      translation: [
        -0.0015784502029418945,
        14.823780059814453,
        -3107339143753052e-19
      ]
    }
  ]
};

// wasm/index.ts
var EMBODY_CORE_ABI_VERSION = 1;
var PACKED_MORPH_FRAME_DELTA_STRIDE = 4;
var PACKED_BONE_FRAME_DELTA_STRIDE = 9;
var HAIR_CONFIG_STRIDE = 11;
var HAIR_STATE_STRIDE = 4;
var HAIR_HEAD_STATE_STRIDE = 5;
var HAIR_MORPH_OUTPUT_STRIDE = 6;
var MESH_PROPORTIONS_STRIDE = 16;
var TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = 10;
var TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = 4;
var ANNOTATION_CAMERA_FRAMING_STRIDE = 7;
var CAMERA_FLIGHT_SAMPLE_STRIDE = 7;
var MARKER_VISIBILITY_FACTORS_STRIDE = 3;
var MARKER_ENDPOINT_STRIDE = 3;
var HAIR_COLOR_PRESETS = hair_color_presets_default;
var DEFAULT_HAIR_COLOR_APPEARANCE = hair_color_presets_default.natural_brown;
var JONATHAN_HUMANOID_SKELETON_TEMPLATE = jonathan_cc_base_default;
var HUMANOID_SKELETON_TEMPLATES = [JONATHAN_HUMANOID_SKELETON_TEMPLATE];
var pending = null;
var loaded = null;
async function initEmbodyCore() {
  if (!pending) {
    pending = load().catch((error) => {
      pending = null;
      loaded = null;
      throw error;
    });
  }
  return pending;
}
var getEmbodyCore = initEmbodyCore;
function requireInitializedEmbodyCore() {
  if (!loaded) throw new Error("Embody Wasm core is not initialized. Await initEmbodyCore() first.");
  return loaded;
}
function resetEmbodyCoreForTests() {
  pending = null;
  loaded = null;
}
async function load() {
  const resolveAsset = (path) => new URL(path, import.meta.url);
  const moduleUrl = resolveAsset("./wasm/embody_wasm.js").href;
  const binaryUrl = resolveAsset("./wasm/embody_wasm_bg.wasm");
  const core = await import(
    /* @vite-ignore */
    moduleUrl
  );
  if (typeof core.default === "function") {
    let input = binaryUrl;
    if (globalThis.process?.versions?.node && binaryUrl.protocol === "file:") {
      const fsSpecifier = "node:fs/promises";
      const urlSpecifier = "node:url";
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import(
          /* @vite-ignore */
          fsSpecifier
        ),
        import(
          /* @vite-ignore */
          urlSpecifier
        )
      ]);
      input = await readFile(fileURLToPath(binaryUrl));
    }
    await core.default({ module_or_path: input });
  }
  if (core.core_abi_version() !== EMBODY_CORE_ABI_VERSION) {
    throw new Error(`Unsupported Embody Wasm ABI version ${core.core_abi_version()}.`);
  }
  loaded = core;
  return core;
}

// wasm/auto.ts
await initEmbodyCore();

export { ANNOTATION_CAMERA_FRAMING_STRIDE, CAMERA_FLIGHT_SAMPLE_STRIDE, DEFAULT_HAIR_COLOR_APPEARANCE, EMBODY_CORE_ABI_VERSION, HAIR_COLOR_PRESETS, HAIR_CONFIG_STRIDE, HAIR_HEAD_STATE_STRIDE, HAIR_MORPH_OUTPUT_STRIDE, HAIR_STATE_STRIDE, HUMANOID_SKELETON_TEMPLATES, JONATHAN_HUMANOID_SKELETON_TEMPLATE, MARKER_ENDPOINT_STRIDE, MARKER_VISIBILITY_FACTORS_STRIDE, MESH_PROPORTIONS_STRIDE, PACKED_BONE_FRAME_DELTA_STRIDE, PACKED_MORPH_FRAME_DELTA_STRIDE, TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE, TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE, getEmbodyCore, initEmbodyCore, requireInitializedEmbodyCore, resetEmbodyCoreForTests };
//# sourceMappingURL=wasm.js.map
//# sourceMappingURL=wasm.js.map