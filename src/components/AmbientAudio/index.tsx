import { useEffect } from 'react'
import { useXRift } from '@xrift/world-components'

/**
 * 環境音のループ再生。
 *
 * デフォルトでは public/852826__kkenny101__gentle-ocean-waves-loop.wav を再生する。
 * Townscaper ワールドを作る時は、同名ファイルを差し替えるか file を変更する。
 *
 * ファイルが無い場合は警告を出してスキップするだけで、ワールドは壊れない。
 * ブラウザの自動再生制限のため、再生開始は「最初のユーザー操作」まで
 * 遅延することがある (XRift 本番ではワールド入場時のクリックで即開始される)。
 */

export interface AmbientAudioProps {
  /** public/ からの相対パス */
  file?: string
  /** 音量 (0〜1) の調整点 */
  volume?: number
}

export const AmbientAudio: React.FC<AmbientAudioProps> = ({
  file = '852826__kkenny101__gentle-ocean-waves-loop.wav',
  volume = 0.28,
}) => {
  const { baseUrl } = useXRift()

  useEffect(() => {
    const audio = new Audio(`${baseUrl}${file}`)
    audio.loop = true
    audio.volume = volume
    audio.preload = 'auto'
    audio.addEventListener('error', () => {
      console.warn(
        `[AmbientAudio] ${file} が読み込めません。public/ に音源を配置してください (無くてもワールドは動作します)。`,
      )
    })

    // 再生開始。自動再生制限で失敗したら初回のユーザー操作で再試行する。
    // (再生済みの Audio に play() を重ねても害はない)
    const tryPlay = () => {
      if (audio.error) return
      audio.play().catch(() => {
        /* ユーザー操作待ち。pointerdown/keydown で再試行される */
      })
    }
    tryPlay()
    window.addEventListener('pointerdown', tryPlay)
    window.addEventListener('keydown', tryPlay)

    return () => {
      window.removeEventListener('pointerdown', tryPlay)
      window.removeEventListener('keydown', tryPlay)
      audio.pause()
      audio.src = ''
    }
  }, [baseUrl, file, volume])

  return null
}
