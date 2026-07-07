import { SpawnPoint } from '@xrift/world-components'
import { Suspense } from 'react'
import { SkyDome } from './components/SkyDome'
import { TownscaperTown } from './components/TownscaperTown'

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

// Set true temporarily in Triplex if you want a visible magenta handle.
const SHOW_TRIPLEX_SPAWN_HANDLE = false

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const TOWN_SCALE = 3

  return (
    <group position={position} scale={scale}>
      {/* Intrinsic lift so the terrace plaza sits at world y=0 (spawn floor level). */}
      <group position={[0, 4.36, 0]}>
      <SkyDome radius={450} />

      {/* Lighting tune points: ambient = flat blue fill, hemisphere = sky/sea fill, directional = warm sun. */}
      {/* Raise ambient/hemisphere for softer toon shadows; lower them for stronger contrast. */}
      <ambientLight color="#cfeef5" intensity={1.15} />
      <hemisphereLight args={['#e8fbff', '#78aeb8', 1.15]} />
      {/* Directional color/position/intensity control the warm highlight direction. */}
      <directionalLight color="#ffe2b6" position={[8, 16, 7]} intensity={0.85} />

      <Suspense fallback={null}>
        <TownscaperTown scale={TOWN_SCALE} />
      </Suspense>

      {/* Triplex tune point: move/rotate SpawnAnchor directly. Y rotation controls spawn yaw. */}
      <group name="SpawnAnchor" position={[24.61, -4.35, -5.75]} rotation={[0, -1.107, 0]}>
        <group visible={false} position={[0.530000000000001, 2.39, 0.38]} rotation={[3.141592653589793, 0, -3.141592653589793]}>
          <SpawnPoint />
        </group>
        <mesh name="TriplexSpawnHandle" visible={SHOW_TRIPLEX_SPAWN_HANDLE}>
          <boxGeometry args={[0.45, 0.08, 0.45]} />
          <meshBasicMaterial color="#ff4fb8" transparent opacity={0.7} depthWrite={false} />
        </mesh>
      </group>
      </group>
    </group>
  )
}
