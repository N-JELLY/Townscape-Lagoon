import { SpawnPoint } from '@xrift/world-components'
import { Suspense } from 'react'
import { AmbientAudio } from './components/AmbientAudio'
import { SkyDome } from './components/SkyDome'
import { TownscaperTown } from './components/TownscaperTown'

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

// Triplex でスポーン位置を調整したいとき、一時的に true にするとマゼンタのハンドルが見える。
const SHOW_TRIPLEX_SPAWN_HANDLE = false

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const TOWN_SCALE = 3

  return (
    <group position={position} scale={scale}>
      {/* テラス広場が世界の y=0 (スポーンの床の高さ) に来るよう内在的に持ち上げる */}
      <group position={[0, 4.36, 0]}>
      <SkyDome radius={450} />

      {/* 環境音。音源は public/852826__kkenny101__gentle-ocean-waves-loop.wav */}
      <AmbientAudio volume={0.28} />

      {/* 注意: これらのライトは Townscaper の街には影響しない (街は専用シェーダで自己ライティングし、シーンライトを使わない)。 */}
      {/* アバターや、他のクリエイターが追加する標準マテリアルのオブジェクト向けの環境光。街の陰影を変えたい場合は TownscaperTown の townLight を編集する。 */}
      <ambientLight color="#cfeef5" intensity={1.15} />
      <hemisphereLight args={['#e8fbff', '#78aeb8', 1.15]} />
      {/* 平行光源の色・位置・強度は暖色ハイライトの方向を決める (標準マテリアル用) */}
      <directionalLight color="#ffe2b6" position={[8, 16, 7]} intensity={0.85} />

      <Suspense fallback={null}>
        <TownscaperTown scale={TOWN_SCALE} />
      </Suspense>

      {/* Triplex の調整点: SpawnAnchor を直接移動・回転する。Y 回転がスポーン時の向き(ヨー)を決める。 */}
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
