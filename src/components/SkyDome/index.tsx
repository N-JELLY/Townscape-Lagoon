import { useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { useXRift } from '@xrift/world-components'

export interface SkyDomeProps {
  radius?: number
}

export const SkyDome: React.FC<SkyDomeProps> = ({ radius = 450 }) => {
  const { baseUrl } = useXRift()
  // Skybox artwork tune point: replace this asset for a different season/time/weather mood.
  const texture = useLoader(THREE.TextureLoader, `${baseUrl}summer-toon-skybox.png`)

  useMemo(() => {
    // Keep skybox colors authored in the PNG; tone mapping is disabled on the material below.
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
      {/* toneMapped=false keeps the sky image from being dimmed by renderer exposure changes. */}
      <meshBasicMaterial map={texture} side={THREE.BackSide} fog={false} toneMapped={false} />
    </mesh>
  )
}
