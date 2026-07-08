import { useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { useXRift } from '@xrift/world-components'

export interface SkyDomeProps {
  radius?: number
}

export const SkyDome: React.FC<SkyDomeProps> = ({ radius = 450 }) => {
  const { baseUrl } = useXRift()
  // スカイボックス画像の差し替え点: 季節・時間帯・天気の雰囲気を変えたいときはこのアセットを差し替える。
  const texture = useLoader(THREE.TextureLoader, `${baseUrl}summer-toon-skybox.png`)

  useMemo(() => {
    // PNG に描かれた色をそのまま使う (下のマテリアルでトーンマッピングは無効にしている)。
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
  }, [texture])

  return (
    <mesh renderOrder={-10}>
      <sphereGeometry args={[radius, 64, 32]} />
      {/* toneMapped=false でレンダラーの露出変化により空画像が暗くならないようにする */}
      <meshBasicMaterial map={texture} side={THREE.BackSide} fog={false} toneMapped={false} />
    </mesh>
  )
}
