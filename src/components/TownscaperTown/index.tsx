import { useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { useXRift } from '@xrift/world-components'

/**
 * TownscaperのOBJエクスポートを専用シェーダで表示するコンポーネント。
 *
 * TownscaperのOBJは通常のUVモデルではなく、以下の特殊構造を持つ:
 *  - UVのuの整数部 = ペイント色のパレット番号 (TownPalette.png の16色)
 *  - TownColor.png のRGBはディテール、αがパレット色との合成比率
 *  - "every odd pixel is a line": 64セル格子をデコードし奇数テクセルを罫線として読む
 *  - Windowsグループは壁に半埋めされた「カッター用の箱ボリューム」
 *    → ステンシルパリティでくり抜き、内面(フレーム/ガラス)だけを描く
 *
 * 参考: https://reindernijhoff.net/2021/11/townscapers-rendering-style-in-webgl/
 */

// 水面・反射で使う色の調整点
const DEEP_COLOR = new THREE.Color(0x3f7280) // 反射・深い水の色味 (uDeepColor 用)
// 水の色は1色に統一する (index.html と同じ考え方)。反射のフェード先・水底(deepWater)・
// 遠景水面(farWater) を全部この色にすると、水面の高さが一致していても継ぎ目やパッチが出ない。
const REFLECTION_WATER_COLOR = new THREE.Color(0x4aaab5) // 統一する水色 (ラグーンのティール)

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uWaterY;
  varying vec2 vUV;
  varying vec3 vNormal;
  varying vec3 vWorld;

  void main() {
    vUV = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);

    #ifdef REFLECTION
      // 反射像の揺らぎ: 水面から深いほど強く歪ませる。
      // Y は動かさない (discard 境界がギザつくため)。XZ のみ。
      // 調整点: amp が揺らぎの強さ、係数 (0.55/0.42) が波長、uTime 係数が速度。
      float dy = wp.y - uWaterY;
      float depth = clamp(abs(dy), 0.0, 6.0);
      float amp = 0.04 + depth * 0.06;
      wp.x += sin(wp.z * 0.55 + uTime * 1.25) * amp;
      wp.z += cos(wp.x * 0.42 + uTime * 1.05) * amp * 0.8;
    #endif

    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uColorTex;
  uniform sampler2D uPaletteTex;
  uniform sampler2D uMaterialTex;
  uniform float uTime;
  uniform float uPaletteY;
  uniform float uWaterY;
  uniform vec3  uDeepColor;
  uniform vec3  uWaterColor;
  varying vec2 vUV;
  varying vec3 vNormal;
  varying vec3 vWorld;

  // 彩度調整: 輝度を軸に色を伸縮する (s>1 で鮮やか)
  vec3 adjustSaturation(vec3 color, float s) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return max(vec3(0.0), mix(vec3(luma), color, s));
  }

  vec3 townLight(vec3 color, vec3 normal) {
    color *= color;
    // トゥーン調ライティングの調整点:
    // - sunDir/fillDir はライト方向。
    // - 下の vec3 の各項がアンビエント・太陽・空バウンス・フィルの色。
    vec3 sunDir = normalize(vec3(0.45, 0.75, 0.28));
    vec3 fillDir = normalize(vec3(-0.55, 0.35, -0.45));
    float sun = smoothstep(-0.25, 0.85, dot(normal, sunDir));
    float toonSun = mix(floor(sun * 3.0) / 3.0, sun, 0.55);
    float sky = smoothstep(-0.45, 0.95, normal.y);
    float fill = smoothstep(-0.35, 0.8, dot(normal, fillDir));
    // 夏の直射日光の配合: 太陽を主役 (強く暖色) にし、アンビエントは低め・青めにして
    // 日向と日陰のコントラストを立てる。アンビエントを上げすぎると全体がパステル化する。
    vec3 light =
      vec3(0.30, 0.36, 0.42) +
      toonSun * vec3(1.5, 1.5, 1.5) +
      sky * vec3(0.10, 0.20, 0.26) +
      fill * vec3(0.06, 0.14, 0.20);
    vec3 lit = sqrt(max(color * light, vec3(0.0)));
    // ハイライト圧縮は弱めに (強いと明色が白へ寄り彩度が落ちる)
    lit = mix(lit, vec3(1.0) - exp(-lit * 1.25), 0.18);
    // 彩度を持ち上げて夏の日差しの鮮やかさを出す
    lit = adjustSaturation(lit, 1.32);
    // 黒の持ち上げは最小限に (大きいと影が白ちゃける)
    return clamp(lit + vec3(0.012, 0.014, 0.016), 0.0, 1.0);
  }

  void main() {
    vec3 normal = normalize(vNormal);
    #ifdef WINDOW_LINING
      // 窓ボックスはwindingが不統一なため、windingでなくOBJの法線属性(常に箱の内向き)でカリングする。
      // カメラから見て奥を向いた面(出っ張った蓋・手前側の側面)を落とし、凹んだ内面だけを残す。
      if (dot(normal, vWorld - cameraPosition) > 0.0) discard;
    #elif defined(REFLECTION)
      // 鏡像は scale.y=-1 でwindingが反転し gl_FrontFacing が逆になる。
      // 法線属性はミラー変換で既に正しい向きなのでそのまま使う。
    #else
      if (!gl_FrontFacing) normal = -normal;
    #endif

    vec2 absuv = floor(abs(vUV * 128.0) + 0.5) / 128.0;
    vec2 uv = fract(vUV + 0.5 / 128.0);

    uv *= 64.0;
    vec2 w = fwidth(uv);
    const float d = 0.025;
    uv = floor(uv) * 2.0 - 0.5
       + smoothstep(vec2(1.0 - d) - w, vec2(1.0 - d), fract(uv))
       + smoothstep(vec2(d), vec2(d) + w, fract(uv));
    uv /= 128.0;

    vec4 detailCol = texture2D(uColorTex, uv);
    vec3 material = texture2D(uMaterialTex, absuv).rgb;
    vec3 baseCol = texture2D(uPaletteTex, vec2(absuv.x / 16.0, uPaletteY)).rgb;

    if (material.g > 0.4) {
      baseCol = mix(1.0 - baseCol, vec3(1.0, 0.5, 0.3), 0.75);
    }

    vec3 col = mix(baseCol, detailCol.rgb, detailCol.a);

    #ifdef REFLECTION
      if (vWorld.y > uWaterY - 0.001) discard;
      #ifdef FENCING
        if (detailCol.a < 0.4) discard;
        col = detailCol.rgb;
      #endif
      // フェードはα(透明度)ではなく「色を水色へ溶かす」方式で行う。
      // 透明ブレンドにすると描画順の都合で水面シートの色が反射の上に乗らず、
      // 反射部分だけ水の被膜が剥がれたような見た目になるため、不透明のまま色で溶かす。
      // フェード距離の調整点: 6.0 (ワールドm)。水底プレーン(deepWater)の深さと
      // 揃える。深部で完全に uWaterColor へ溶かすので、そこと同色の水底に
      // 反射が吸い込まれ、切れ目が出ない。
      float dy = uWaterY - vWorld.y;
      float depthFade = smoothstep(0.0, 6.0, dy);
      // 0.45〜1.0: 水面直下は反射をはっきり残し、深部は水底と同じ水色へ完全に溶かす。
      vec3 rcol = mix(col, uWaterColor, 0.45 + 0.55 * depthFade);
      gl_FragColor = vec4(rcol, 1.0);
      return;
    #endif

    #ifdef WATER
      float wy = vUV.y * 128.0 - 58.0;
      // 水面アニメの調整点: 58〜73 が TownColor の水帯、1.5 はスクロール速度。
      float waveV = mod(wy - uTime * 1.5, 15.0) / 128.0 + 58.0 / 128.0;
      vec4 waterDetailCol = texture2D(uColorTex, vec2(vUV.x, waveV));
      // 波紋は乗算で合成 (1.8倍で正規化: 泡の白は明るく、青は水色を軽く沈める)
      col = mix(baseCol, waterDetailCol.rgb, waterDetailCol.a);
    #endif

    #ifdef FENCING
      if (detailCol.a < 0.4) discard;
      gl_FragColor = vec4(detailCol.rgb, 1.0);
      return;
    #endif

    col = townLight(col, normal);

    #ifdef WATER
      float shore = 1.0 - smoothstep(0.0, 16.0, wy);
      // 水面の不透明度の調整点: 小さいほど反射・空が透け、大きいほど海がのっぺりする。
      float alpha = mix(0.16, 0.34, shore);
      gl_FragColor = vec4(col, alpha);
    #else
      gl_FragColor = vec4(col, 1.0);
    #endif
  }
`

function configureMagicTexture(tex: THREE.Texture, nearest: boolean): THREE.Texture {
  tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter
  tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter
  tex.generateMipmaps = false // 128pxアトラスのパッチ間ブリーディング防止
  tex.wrapS = THREE.RepeatWrapping // u>1 (パレット番号) 対策
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace // シェーダ内で独自にガンマ処理するため生値で
  tex.needsUpdate = true
  return tex
}

function swapGeometryVertices(geometry: THREE.BufferGeometry, a: number, b: number): void {
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute
    for (let component = 0; component < attribute.itemSize; component++) {
      const tmp = attribute.getComponent(a, component)
      attribute.setComponent(a, component, attribute.getComponent(b, component))
      attribute.setComponent(b, component, tmp)
    }
    attribute.needsUpdate = true
  }
}

function mirrorGeometryX(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone()
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined

  if (position) {
    for (let i = 0; i < position.count; i++) {
      position.setX(i, -position.getX(i))
    }
    position.needsUpdate = true
  }

  if (normal) {
    for (let i = 0; i < normal.count; i++) {
      normal.setX(i, -normal.getX(i))
    }
    normal.needsUpdate = true
  }

  // ミラーで三角形の巻き順が反転するため、b/c を入れ替えて表面と陰影を正しく保つ
  const index = geometry.getIndex()
  if (index) {
    const array = index.array
    for (let i = 0; i < array.length; i += 3) {
      const tmp = array[i + 1]
      array[i + 1] = array[i + 2]
      array[i + 2] = tmp
    }
    index.needsUpdate = true
  } else {
    for (let i = 0; i < (position?.count ?? 0); i += 3) {
      swapGeometryVertices(geometry, i + 1, i + 2)
    }
  }

  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

export interface TownscaperTownProps {
  position?: [number, number, number]
  /** 1でOBJ原寸。人が歩くには3前後を推奨 */
  scale?: number
}

export const TownscaperTown: React.FC<TownscaperTownProps> = ({
  position = [0, 2.16, 0],
  scale = 1,
}) => {
  const { baseUrl } = useXRift()
  const gl = useThree((state) => state.gl)

  const sourceObj = useLoader(OBJLoader, `${baseUrl}Town.obj`)
  const [colorTex, paletteTex, materialTex] = useLoader(THREE.TextureLoader, [
    `${baseUrl}TownColor.png`,
    `${baseUrl}TownPalette.png`,
    `${baseUrl}TownMaterial.png`,
  ])

  const built = useMemo(() => {
    configureMagicTexture(colorTex, false) // detailはLinear (罫線デコードのAAに必要)
    configureMagicTexture(paletteTex, true)
    configureMagicTexture(materialTex, true)

    const uniforms = () => ({
      uColorTex: { value: colorTex },
      uPaletteTex: { value: paletteTex },
      uMaterialTex: { value: materialTex },
      uTime: { value: 0 },
      uPaletteY: { value: 0.25 },
      uWaterY: { value: 0 },
      uDeepColor: { value: DEEP_COLOR },
      uWaterColor: { value: REFLECTION_WATER_COLOR },
    })
    const makeMaterial = (
      defines: Record<string, string>,
      opts: Partial<THREE.ShaderMaterialParameters> = {},
    ) =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        defines,
        side: THREE.DoubleSide,
        ...opts,
        uniforms: uniforms(),
      })

    const townMaterial = makeMaterial({})
    const waterMaterial = makeMaterial({ WATER: '' }, { transparent: true, depthWrite: false })
    const fenceMaterial = makeMaterial({ FENCING: '' })
    // 反射は不透明で描く (index.html と同じ最小構成): 透明にすると水面シートの色が
    // 反射の上に乗らず見た目が崩れる。depthWrite はデフォルト(true)のまま。
    // polygonOffset 等の小細工は入れない — 入れると深度がずれて反射が汚くなる。
    const reflectionMaterial = makeMaterial({ REFLECTION: '' })
    const reflectionFenceMaterial = makeMaterial({ REFLECTION: '', FENCING: '' })

    // --- 窓・ドアのくり抜き (ステンシルパリティ方式 / Carmack's reverse系) ---
    // ホストのWebGLコンテキストにステンシルバッファが無い場合はデプスリセットが
    // 全画面に効いて壊れるため、劣化フォールバック(depthFunc=GREATER)に切り替える。
    const contextAttributes = gl.getContext().getContextAttributes()
    const hasStencil = contextAttributes ? contextAttributes.stencil === true : false

    const stencilHoleTest = hasStencil
      ? {
        stencilWrite: true,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilRef: 0,
        stencilZPass: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp,
        stencilFail: THREE.KeepStencilOp,
      }
      : {}

    const stencilParityMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...(hasStencil
        ? {
          stencilWrite: true,
          stencilFunc: THREE.AlwaysStencilFunc,
          stencilZPass: THREE.InvertStencilOp,
          stencilZFail: THREE.KeepStencilOp,
          stencilFail: THREE.KeepStencilOp,
        }
        : {}),
    })

    const depthResetMaterial = new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.99999, 1.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      ...stencilHoleTest,
    })

    const windowLiningMaterial = makeMaterial({ WINDOW_LINING: '' }, {
      side: THREE.DoubleSide,
      ...stencilHoleTest,
      // ステンシルが使えない場合: 壁より奥の内面をGREATERで描く。
      // 奥の壁の窓が稀に透ける劣化はあるが、窓自体は正しく凹んで見える
      ...(hasStencil ? {} : { depthFunc: THREE.GreaterDepth, depthWrite: false }),
    })

    const animatedMaterials = [
      townMaterial,
      waterMaterial,
      fenceMaterial,
      reflectionMaterial,
      reflectionFenceMaterial,
      windowLiningMaterial,
    ]

    // --- OBJの組み立て ---
    const group = sourceObj.clone(true)
    // Townscaper の OBJ は XRift 上で鏡像になる。親スケールではなくジオメトリ自体を反転し、
    // 法線・ステンシル・反射・生成コライダーの整合をすべて保つ。
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.geometry = mirrorGeometryX(mesh.geometry)
      }
    })
    const box = new THREE.Box3().setFromObject(group)
    const center = box.getCenter(new THREE.Vector3())
    group.position.sub(center)

    const meshes: Record<string, THREE.Mesh> = {}
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes[child.name] = child as THREE.Mesh
    })

    // 水面の高さ (グループローカル)
    let localWaterY = 0
    if (meshes.Water) {
      meshes.Water.geometry.computeBoundingBox()
      localWaterY = meshes.Water.geometry.boundingBox!.max.y
    }
    const waterY = localWaterY + group.position.y
    animatedMaterials.forEach((m) => {
      m.uniforms.uWaterY.value = waterY
    })

    group.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || /windows/i.test(child.name)) return
      const mesh = child as THREE.Mesh
      mesh.material = /water/i.test(mesh.name)
        ? waterMaterial
        : /fencing/i.test(mesh.name)
          ? fenceMaterial
          : townMaterial
      if (/water/i.test(mesh.name)) mesh.renderOrder = 2
    })

    // 窓のくり抜き3パス
    if (meshes.Windows) {
      meshes.Windows.material = stencilParityMaterial
      meshes.Windows.renderOrder = 10
      meshes.Windows.frustumCulled = false

      if (hasStencil) {
        const depthReset = new THREE.Mesh(
          new THREE.BufferGeometry().setAttribute(
            'position',
            new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
          ),
          depthResetMaterial,
        )
        depthReset.frustumCulled = false
        depthReset.renderOrder = 11
        group.add(depthReset)
      } else {
        meshes.Windows.visible = false // パリティパス自体が不要
      }

      const lining = new THREE.Mesh(meshes.Windows.geometry, windowLiningMaterial)
      lining.renderOrder = 12
      group.add(lining)
    }

    // --- 水面反射: 街をY反転した鏡像を水面下に描く (レンダーターゲット不要でVR向き) ---
    const reflectionGroup = new THREE.Group()
    for (const name of ['House', 'Fencing', 'Plants', 'Props', 'Birds']) {
      if (!meshes[name]) continue
      const mirrored = new THREE.Mesh(
        meshes[name].geometry,
        name === 'Fencing' ? reflectionFenceMaterial : reflectionMaterial,
      )
      mirrored.renderOrder = -1
      reflectionGroup.add(mirrored)
    }
    reflectionGroup.scale.y = -1
    reflectionGroup.position.y = 2 * localWaterY
    group.add(reflectionGroup)

    // 水底の色ベース: 反射の背後を埋める単なる「背景色」のプレーン。
    // depthWrite無効が重要: デプスを書くと、視線が斜めのとき遠くの (まだフェード
    // し切っていない) 鏡像より先にこの板に当たり、反射が板のラインでスパッと
    // 切れてしまう。デプスを書かなければ反射は常にこの上に描かれ、フェードし切った
    // 鏡像は板と同色 (REFLECTION_WATER_COLOR) なので自然に消える。
    // 板自体も「2枚目の水面」として認識されなくなる。
    // 半径は SkyDome (450) に合わせて拡大 (150 * TOWN_SCALE3 = 450)。円の縁を地平線に隠す。
    const deepWater = new THREE.Mesh(
      new THREE.CircleGeometry(150, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: REFLECTION_WATER_COLOR, depthWrite: false }),
    )
    deepWater.position.y = localWaterY - 2
    deepWater.renderOrder = -2
    group.add(deepWater)

    // 遠景の水面 (OBJの水メッシュは島の周囲だけなので外側を大きな面で埋める)。
    // index.html と同じく deepWater・反射フェード先と「同一色」にして継ぎ目を消す。
    // 色が揃っていれば deepWater との高さ差や円の縁が出ても見えなくなる。
    // 深度書き込みはしないので同一面でも z-fighting は起きない。
    // 半径は deepWater と揃えて地平線まで届かせ、円の縁の線を隠す。
    const farWater = new THREE.Mesh(
      new THREE.CircleGeometry(150, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: REFLECTION_WATER_COLOR,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    )
    farWater.position.y = localWaterY - 0.002
    farWater.renderOrder = 1
    group.add(farWater)

    // --- 物理コライダー用ジオメトリ (歩ける場所: 建物・砂浜・小物・フェンス) ---
    const colliderGroup = new THREE.Group()
    colliderGroup.visible = false
    for (const name of ['House', 'Sand']) {
      if (!meshes[name]) continue
      const collider = new THREE.Mesh(meshes[name].geometry)
      collider.position.copy(group.position)
      colliderGroup.add(collider)
    }

    return { group, animatedMaterials, colliderGroup, waterY, localWaterY }
  }, [sourceObj, colorTex, paletteTex, materialTex, gl])

  const waterPoint = useMemo(() => new THREE.Vector3(), [])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    built.group.updateWorldMatrix(true, false)
    const worldWaterY = built.group.localToWorld(waterPoint.set(0, built.localWaterY, 0)).y
    built.animatedMaterials.forEach((m) => {
      m.uniforms.uTime.value = t
      m.uniforms.uWaterY.value = worldWaterY
    })
  })

  return (
    <group position={position} scale={scale}>
      <primitive object={built.group} />
      {/* コライダー: OBJ の House と Sand グループのみ */}
      <RigidBody type="fixed" colliders="trimesh" includeInvisible friction={1} restitution={0}>
        <primitive object={built.colliderGroup} />
      </RigidBody>
      <RigidBody type="fixed" friction={1} restitution={0}>
        <CuboidCollider args={[80, 0.1, 80]} position={[0, built.waterY - 0.1, 0]} />
      </RigidBody>
    </group>
  )
}
