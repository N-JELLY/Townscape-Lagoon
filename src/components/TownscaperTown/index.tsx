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

// Color tune points used by water and reflections.
const DEEP_COLOR = new THREE.Color(0x3f7280) // reflection/deep-water tint
const OCEAN_COLOR = new THREE.Color(0x3f8794) // large far-water plane color

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
      // Reflection wobble tune points:
      // - fade controls distortion strength.
      // - waveA/B/C multipliers control frequency and speed.
      float dy = wp.y - uWaterY;
      float depth = clamp(abs(dy), 0.0, 4.0);
      float fade = 0.035 + depth * 0.032;
      float waveA = sin(wp.z * 0.78 + uTime * 0.72);
      float waveB = cos((wp.x + wp.z) * 0.46 - uTime * 0.55);
      float waveC = sin((wp.x - wp.z) * 0.62 + uTime * 0.44);
      wp.x += (waveA + waveB * 0.55) * fade;
      wp.z += (cos(wp.x * 0.58 + uTime * 0.48) + waveC * 0.35) * fade * 0.75;
      wp.y += (waveB - waveC) * fade * 0.30;
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
  varying vec2 vUV;
  varying vec3 vNormal;
  varying vec3 vWorld;

  vec3 townLight(vec3 color, vec3 normal) {
    color *= color;
    // Toon lighting tune points:
    // - sunDir/fillDir set light direction.
    // - vec3 light terms below set ambient, sun, sky bounce, and fill colors.
    vec3 sunDir = normalize(vec3(0.45, 0.75, 0.28));
    vec3 fillDir = normalize(vec3(-0.55, 0.35, -0.45));
    float sun = smoothstep(-0.25, 0.85, dot(normal, sunDir));
    float toonSun = mix(floor(sun * 3.0) / 3.0, sun, 0.55);
    float sky = smoothstep(-0.45, 0.95, normal.y);
    float fill = smoothstep(-0.35, 0.8, dot(normal, fillDir));
    vec3 light =
      vec3(0.58, 0.68, 0.72) +
      toonSun * vec3(0.82, 0.67, 0.48) +
      sky * vec3(0.20, 0.34, 0.40) +
      fill * vec3(0.12, 0.26, 0.32);
    vec3 lit = sqrt(max(color * light, vec3(0.0)));
    lit = mix(lit, vec3(1.0) - exp(-lit * 1.25), 0.45);
    return clamp(lit + vec3(0.025, 0.03, 0.035), 0.0, 1.0);
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
      float depthFade = smoothstep(0.0, 4.0, abs(vWorld.y - uWaterY));
      // Reflection tint tune point: higher mix values make reflections bluer and less literal.
      vec3 rcol = mix(col, uDeepColor, 0.82 + 0.14 * depthFade);
      // Reflection darkness tune point: lower values make distant/deeper reflections sink into the water.
      rcol *= mix(0.70, 0.48, depthFade);
      gl_FragColor = vec4(rcol, 1.0);
      return;
    #endif

    #ifdef WATER
      float wy = vUV.y * 128.0 - 58.0;
      // Water animation tune point: 58..73 is the TownColor water band; 1.5 is scroll speed.
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
      // Water alpha tune point: lower values show more reflection/sky, higher values make the sea flatter.
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

  // Mirroring changes triangle winding, so swap b/c to keep front faces and lighting correct.
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
    // depthWrite必須: 無いと鏡像の隠面が消えず裏側のポリゴンが透けて見える
    // Reflection material tune point: color/tint lives in the REFLECTION shader block above.
    const reflectionMaterial = makeMaterial({ REFLECTION: '' }, { depthWrite: false })

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
      windowLiningMaterial,
    ]

    // --- OBJの組み立て ---
    const group = sourceObj.clone(true)
    // Townscaper OBJ appears mirrored in XRift; mirror geometry data, not parent scale,
    // so normals, stencils, reflections, and generated colliders all stay aligned.
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
      const mirrored = new THREE.Mesh(meshes[name].geometry, reflectionMaterial)
      mirrored.renderOrder = -1
      reflectionGroup.add(mirrored)
    }
    reflectionGroup.scale.y = -1
    reflectionGroup.position.y = 2 * localWaterY
    group.add(reflectionGroup)

    // 深い水の底
    // 遠景の水面 (OBJの水メッシュは島の周囲だけなので外側を大きな面で埋める)
    const farWater = new THREE.Mesh(
      new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        // Far-water tune point: this is the single large non-animated ocean sheet.
        color: OCEAN_COLOR,
        transparent: true,
        // Higher opacity hides sky/reflection bleed; lower opacity makes the water feel glassier.
        opacity: 0.88,
        depthWrite: false,
      }),
    )
    // Keep this slightly below the OBJ Water mesh to avoid z-fighting and a visible second sea layer.
    farWater.position.y = waterY - 0.035
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

    return { group, animatedMaterials, colliderGroup, waterY }
  }, [sourceObj, colorTex, paletteTex, materialTex, gl])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    built.animatedMaterials.forEach((m) => {
      m.uniforms.uTime.value = t
    })
  })

  return (
    <group position={position} scale={scale}>
      <primitive object={built.group} />
      {/* Colliders: OBJ groups House and Sand only. */}
      <RigidBody type="fixed" colliders="trimesh" includeInvisible friction={1} restitution={0}>
        <primitive object={built.colliderGroup} />
      </RigidBody>
      <RigidBody type="fixed" friction={1} restitution={0}>
        <CuboidCollider args={[80, 0.1, 80]} position={[0, built.waterY - 0.1, 0]} />
      </RigidBody>
    </group>
  )
}
